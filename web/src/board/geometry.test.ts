import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardHistory } from './history';
import { boardToScreen, clampZoom, clampPercentRegion, clampRequestedPercentRegion, elementBounds, percentRegion, screenToBoard, selectionMeetsScreenMinimum, strokeBounds, strokeIntersectsPolygon, translateStrokes, unionRegions, zoomAt } from './geometry';
import { captureCrop, selectionAsPercent } from './capture';
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
    expect(captureCrop(extent,percent,{x:300,y:250,width:250,height:100})).toEqual(selection);
    expect(captureCrop(extent,{x:-10,y:95,width:30,height:20})).toEqual({x:100,y:675,width:200,height:25});
    expect(percentRegion(extent,{x:-10,y:95,width:30,height:20})).toEqual({x:100,y:675,width:200,height:25});
    expect(clampPercentRegion({x:-10,y:95,width:30,height:20})).toEqual({x:0,y:95,width:20,height:5});
    expect(selectionAsPercent({x:0,y:650,width:500,height:100},extent)).toEqual({x:0,y:90,width:40,height:10});
  });

  it('keeps model crops at least one percent and tutor rectangles at least 24 screen points', () => {
    expect(clampRequestedPercentRegion({x:99.8,y:101,width:0.05,height:0})).toEqual({x:99,y:99,width:1,height:1});
    expect(clampRequestedPercentRegion({x:-5,y:-1,width:140,height:3})).toEqual({x:0,y:0,width:100,height:3});
    expect(selectionMeetsScreenMinimum({x:0,y:0,width:24,height:23.99},1)).toBe(false);
    expect(selectionMeetsScreenMinimum({x:0,y:0,width:12,height:12},2)).toBe(true);
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

  it('undoes and redoes a whole lasso move as one snapshot',()=>{
    const history=new BoardHistory();
    const before:Stroke[]=[{id:'selected',tool:'pen',color:'#111',width:4,points:[{x:1,y:2,pressure:.4,time:1}]},{id:'other',tool:'pen',color:'#111',width:4,points:[{x:10,y:20,pressure:1,time:2}]}];
    const after=translateStrokes(before,new Set(['selected']),[14,-8]);
    history.record(before);
    expect(history.undo(after)).toEqual(before);
    expect(history.redo(before)).toEqual(after);
  });

  it('applies board updates in server order and preserves replaced ids in z order', () => {
    const original:BoardScene={elements:[{id:'first',kind:'text',x:0,y:0,text:'old',font_size:24},{id:'second',kind:'line',x1:0,y1:0,x2:1,y2:1}]};
    const changed=applySceneUpdate(original,{deletes:['second'],upserts:[{id:'first',kind:'text',x:1,y:1,text:'new',font_size:24},{id:'third',kind:'circle',cx:2,cy:2,radius:1}]});
    expect(changed.elements.map(e=>e.id)).toEqual(['first','third']);
    expect(changed.elements[0].text).toBe('new');
    expect(applySceneUpdate(changed,{replace_all:true,upserts:[{id:'replacement',kind:'svg',x:1,y:1,svg:'<svg viewBox="0 0 10 10"></svg>'}]}).elements.map(e=>e.id)).toEqual(['replacement']);
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

  it('renders and bounds every Swift board scene kind',()=>{
    const scene:BoardScene={elements:[
      {id:'text',kind:'text',x:10,y:10,text:'label',font_size:16},
      {id:'line',kind:'line',x1:0,y1:0,x2:20,y2:20},
      {id:'arrow',kind:'arrow',x1:0,y1:30,x2:20,y2:40},
      {id:'rectangle',kind:'rectangle',x:30,y:0,width:20,height:12},
      {id:'ellipse',kind:'ellipse',x:60,y:0,width:20,height:12},
      {id:'circle',kind:'circle',cx:100,cy:10,radius:8},
      {id:'polygon',kind:'polygon',points:[[110,0],[120,0],[115,10]]},
      {id:'polyline',kind:'polyline',points:[[125,0],[130,10],[135,0]]},
      {id:'freehand',kind:'freehand',points:[[140,0],[145,10],[150,0]]},
      {id:'arc',kind:'arc',cx:170,cy:10,radius:8,start_angle:0,end_angle:90},
      {id:'angle',kind:'angle_marker',vertex_x:190,vertex_y:10,ray1_x:200,ray1_y:10,ray2_x:190,ray2_y:20},
      {id:'path',kind:'path',d:'M 210 0 L 220 10'},
      {id:'math',kind:'math_text',x:230,y:0,latex:'x^2',font_size:16},
      {id:'ink',kind:'ink_text',x:260,y:0,text:'handwritten',size:16},
      {id:'image',kind:'image',x:300,y:0,width:20,height:20,blob_id:'missing'},
      {id:'svg',kind:'svg',x:330,y:0,width:20,height:20,svg:'<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="4"/></svg>'},
    ]};
    const markup=renderToStaticMarkup(createElement(TutorScene,{scene}));
    expect(scene.elements.map(element=>element.kind)).toHaveLength(16);
    expect(sceneBounds(scene)).not.toBeNull();
    for(const tag of ['<text','<line','<g','<rect','<ellipse','<circle','<polygon','<polyline','<path','foreignObject','Shantell Sans, cursive']) expect(markup).toContain(tag);
    expect(elementBounds(scene.elements[15])).toEqual({x:330,y:0,width:20,height:20});
  });

  it('uses the measured KaTeX raster extent for content and capture bounds',()=>{
    const scene:BoardScene={elements:[{id:'math',kind:'math_text',x:100,y:200,latex:'\\frac{a}{b}',font_size:24}]};
    expect(sceneBounds(scene,{math:{href:'data:image/png;base64,AA==',width:66,height:52,offsetX:-2,offsetY:3}})).toEqual({x:98,y:203,width:66,height:52});
  });
});
