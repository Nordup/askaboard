import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { boardToScreen, clampZoom, clampPercentRegion, elementBounds, percentRegion, screenToBoard, strokeBounds, strokeIntersectsPolygon, translateStrokes, unionRegions, zoomAt } from './geometry';
import { selectionAsPercent } from './capture';
import { applySceneUpdate, sceneBounds, TutorScene } from './scene';
import type { BoardScene, Stroke } from '../types';

describe('board coordinate transforms', () => {
  it('round trips logical points at a persisted camera', () => {
    const camera={center:[-200,300] as [number,number],zoom:1.75};
    const viewport:[number,number]=[1224,976]; const point:[number,number]=[11,-78];
    expect(screenToBoard(boardToScreen(point,viewport,camera),viewport,camera)).toEqual(point);
  });

  it('zooms around the pointer anchor and clamps to the supported scale', () => {
    const camera={center:[0,0] as [number,number],zoom:1};const pointer:[number,number]=[100,700];const viewport:[number,number]=[1000,800];
    const anchor=screenToBoard(pointer,viewport,camera);const next=zoomAt(camera,pointer,viewport,2.4);
    expect(next.zoom).toBe(2.4);expect(screenToBoard(pointer,viewport,next)).toEqual(anchor);expect(clampZoom(8)).toBe(3);
  });
});

describe('overview and selected-region geometry', () => {
  it('maps selection bounds to the same overview percentages and back', () => {
    const extent={x:100,y:200,width:1000,height:500};const selection={x:300,y:250,width:250,height:100};
    const percent=selectionAsPercent(selection,extent);
    expect(percent).toEqual({x:20,y:10,width:25,height:20});
    expect(percentRegion(extent,percent)).toEqual(selection);
    expect(percentRegion(extent,{x:-10,y:95,width:30,height:20})).toEqual({x:100,y:675,width:200,height:25});
    expect(clampPercentRegion({x:-10,y:95,width:30,height:20})).toEqual({x:0,y:95,width:20,height:5});
    expect(selectionAsPercent({x:0,y:650,width:500,height:100},extent)).toEqual({x:0,y:90,width:40,height:10});
  });

  it('unions learner ink and tutor element extents across scene kinds', () => {
    const scene:BoardScene={elements:[
      {id:'a',kind:'rectangle',x:10,y:20,width:30,height:40,style:{stroke_width:4}},
      {id:'b',kind:'circle',cx:100,cy:100,radius:12,style:{stroke_width:2}},
      {id:'c',kind:'line',x1:-20,y1:5,x2:0,y2:10,style:{stroke_width:2}},
    ]};
    expect(elementBounds(scene.elements[1])).toEqual({x:87,y:87,width:26,height:26});
    expect(sceneBounds(scene)).toEqual({x:-21,y:4,width:134,height:109});
    expect(unionRegions([sceneBounds(scene),{x:200,y:200,width:1,height:1}])).toEqual({x:-21,y:4,width:222,height:197});
  });

  it('includes pressure-expanded stroke bounds for capture framing', () => {
    const stroke:Stroke={id:'stroke',tool:'pen',color:'#0A0A0A',width:8,points:[
      {x:5,y:8,pressure:.2,time:1},{x:25,y:18,pressure:1,time:2},
    ]};
    expect(strokeBounds(stroke)).toEqual({x:1,y:4,width:28,height:18});
  });

  it('handles dense boards with stable linear stroke bounds and whole-stroke snapshots', () => {
    const strokes:Stroke[]=Array.from({length:1200},(_,i)=>({id:`s${i}`,tool:'pen',color:'#111',width:2,points:[
      {x:i*3,y:-i,pressure:.3,time:i},{x:i*3+2,y:-i+1,pressure:1,time:i+1},
    ]}));
    const extent=unionRegions(strokes.map(strokeBounds));
    expect(extent).toEqual({x:-1,y:-1200,width:3601,height:1202});
    expect(strokes.map(s=>s.id).filter((_,i)=>i%2===0)).toHaveLength(600);
  });

  it('selects whole strokes that cross or sit within the lasso boundary tolerance',()=>{
    const polygon: [number,number][]=[[0,0],[20,0],[20,20],[0,20]];
    const stroke=(id:string,a:[number,number],b:[number,number],width=2):Stroke=>({id,tool:'pen',color:'#111',width,points:[{x:a[0],y:a[1],pressure:1,time:1},{x:b[0],y:b[1],pressure:1,time:2}]});
    expect(strokeIntersectsPolygon(stroke('cross',[-5,10],[25,10]),polygon)).toBe(true);
    expect(strokeIntersectsPolygon(stroke('inside',[4,4],[12,12]),polygon)).toBe(true);
    expect(strokeIntersectsPolygon(stroke('edge',[-5,-1],[25,-1],4),polygon)).toBe(true);
    expect(strokeIntersectsPolygon(stroke('outside',[-5,-5],[-1,-1]),polygon)).toBe(false);
  });

  it('translates only selected strokes immutably for one history transaction',()=>{
    const strokes:Stroke[]=[{id:'a',tool:'pen',color:'#111',width:4,points:[{x:1,y:2,pressure:.4,time:1}]},{id:'b',tool:'highlighter',color:'#ff0',width:8,points:[{x:10,y:20,pressure:1,time:2}]}];
    const moved=translateStrokes(strokes,new Set(['a']),[5,-3]);
    expect(moved[0].points[0]).toMatchObject({x:6,y:-1});expect(moved[1]).toBe(strokes[1]);expect(strokes[0].points[0]).toMatchObject({x:1,y:2});
    expect(translateStrokes(moved,new Set(['a']),[-5,3])[0].points[0]).toMatchObject({x:1,y:2});
  });

  it('applies board updates in server order and preserves replaced ids in z order', () => {
    const original:BoardScene={elements:[{id:'first',kind:'text',x:0,y:0,text:'old'},{id:'second',kind:'line',x1:0,y1:0,x2:1,y2:1}]};
    const changed=applySceneUpdate(original,{deletes:['second'],upserts:[{id:'first',kind:'text',x:1,y:1,text:'new'},{id:'third',kind:'circle',cx:2,cy:2,radius:1}]});
    expect(changed.elements.map(e=>e.id)).toEqual(['first','third']);
    expect(changed.elements[0].text).toBe('new');
    expect(applySceneUpdate(changed,{replace_all:true,upserts:[{id:'replacement',kind:'svg',x:1,y:1,svg:'<svg/>'}]}).elements.map(e=>e.id)).toEqual(['replacement']);
  });

  it('renders the current flattened Swift BoardStyle wire fields', () => {
    const scene:BoardScene={elements:[{id:'wire',kind:'line',x1:1,y1:2,x2:30,y2:40,stroke:'#ff0000',fill:'#00ff00',stroke_width:7,opacity:.4,dash:[3,2],rotation:12}]};
    const markup=renderToStaticMarkup(createElement(TutorScene,{scene}));
    expect(markup).toContain('stroke="#ff0000"');
    expect(markup).toContain('stroke-width="7"');
    expect(markup).toContain('stroke-dasharray="3 2"');
    expect(markup).toContain('opacity="0.4"');
    expect(markup).toContain('rotate(12');
  });

  it('frames SVG and path scene content away from the board origin', () => {
    const scene:BoardScene={elements:[
      {id:'svg',kind:'svg',x:700,y:900,svg:'<svg viewBox="0 0 120 80"></svg>'},
      {id:'path',kind:'path',d:'M 900 1000 L 940 1040',style:{stroke_width:4}},
    ]};
    expect(sceneBounds(scene)).toEqual({x:700,y:900,width:242,height:142});
  });
});
