import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { BoardHandle, BoardProps, BoardRegion, Camera, InkPoint, Point, Stroke } from '../types';
import { boardToScreen, clampZoom, DEFAULT_CENTER, elementBounds, screenToBoard, strokeBounds, strokeIntersectsPolygon, translateStrokes, unionRegions, zoomAt } from './geometry';
import { boardExtent, captureBoard, overviewBoard, selectionAsPercent } from './capture';
import { loadSceneImages, sceneBounds, TutorScene } from './scene';
import './board.css';

const cssPoint = (e: {clientX:number;clientY:number}, rect: DOMRect): Point => [e.clientX-rect.left,e.clientY-rect.top];
const same = (a: unknown,b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const distanceToSegment = (p: Point,a: Point,b: Point) => { const dx=b[0]-a[0],dy=b[1]-a[1]; const d=dx*dx+dy*dy; const t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d)):0; return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy); };
function paintInk(canvas:HTMLCanvasElement|null,strokes:Stroke[],viewport:Point,camera:Camera){
  if(!canvas)return;const [w,h]=viewport;const dpr=window.devicePixelRatio||1;canvas.width=Math.max(1,Math.round(w*dpr));canvas.height=Math.max(1,Math.round(h*dpr));canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;
  const ctx=canvas.getContext('2d');if(!ctx)return;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.setTransform(dpr*camera.zoom,0,0,dpr*camera.zoom,dpr*(w/2-camera.center[0]*camera.zoom),dpr*(h/2-camera.center[1]*camera.zoom));
  for(const stroke of strokes){const points=stroke.points;if(!points.length)continue;ctx.globalAlpha=stroke.tool==='highlighter'?.34:1;ctx.strokeStyle=stroke.color;ctx.fillStyle=stroke.color;ctx.lineCap='round';ctx.lineJoin='round';
    if(points.length===1){const p=points[0];ctx.beginPath();ctx.arc(p.x,p.y,stroke.width*Math.max(.15,p.pressure)/2,0,Math.PI*2);ctx.fill();continue;}
    for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];ctx.beginPath();ctx.lineWidth=stroke.width*Math.max(.15,(a.pressure+b.pressure)/2);ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
  }ctx.globalAlpha=1;
}

/** Paper's board surface: native tutor scene beneath portable learner ink. */
export const Board = forwardRef<BoardHandle, BoardProps>(function Board({workspace,tool,color,width,onChange,onSelection,onError},ref) {
  const hostRef=useRef<HTMLDivElement>(null); const inkRef=useRef<HTMLCanvasElement>(null);const activeInkRef=useRef<HTMLCanvasElement>(null);
  const strokesRef=useRef(workspace.strokes); const sceneRef=useRef(workspace.scene); const cameraRef=useRef<Camera>(workspace.camera);
  const activeRef=useRef<Stroke|null>(null); const dragRef=useRef<{kind:'pan'|'select'|'lasso'|'move'|'ink'|'erase';start:Point;last:Point;pointerId:number;points:Point[];erased?:boolean;startStrokes?:Stroke[];selectionBounds?:BoardRegion;changed?:boolean}|null>(null);
  const selectedIdsRef=useRef<string[]>([]);
  const undoRef=useRef<Stroke[][]>([]); const redoRef=useRef<Stroke[][]>([]); const spaceRef=useRef(false);
  const [strokes,setStrokes]=useState(workspace.strokes); const [camera,setCamera]=useState<Camera>(workspace.camera);
  const [viewport,setViewport]=useState<Point>([1,1]); const [marquee,setMarquee]=useState<BoardRegion|null>(null); const [selectionBounds,setSelectionBounds]=useState<BoardRegion|null>(null);
  const [images,setImages]=useState<Record<string,string>>({});
  const boundsRef=useRef<BoardRegion|null>(null);
  const wheelPersistRef=useRef<ReturnType<typeof setTimeout>|null>(null);const onChangeRef=useRef(onChange);onChangeRef.current=onChange;
  useEffect(()=>()=>{if(wheelPersistRef.current){clearTimeout(wheelPersistRef.current);wheelPersistRef.current=null;onChangeRef.current({camera:cameraRef.current});}},[]);

  useEffect(()=>{if(!same(workspace.strokes,strokesRef.current)){strokesRef.current=workspace.strokes;setStrokes(workspace.strokes);}},[workspace.strokes]);
  useEffect(()=>{sceneRef.current=workspace.scene;boundsRef.current=null;let current=true;void loadSceneImages(workspace.scene).then(value=>{if(current)setImages(value);});return()=>{current=false;};},[workspace.scene]);
  useEffect(()=>{if(!same(workspace.camera,cameraRef.current)){cameraRef.current=workspace.camera;setCamera(workspace.camera);}},[workspace.camera]);
  useEffect(()=>{const host=hostRef.current;if(!host)return;const observer=new ResizeObserver(entries=>{const r=entries[0]?.contentRect;if(r){setViewport([r.width,r.height]);}});observer.observe(host);return()=>observer.disconnect();},[]);

  const redraw=useCallback(()=>paintInk(inkRef.current,strokesRef.current,viewport,cameraRef.current),[viewport,strokes,camera]);
  const redrawActive=useCallback(()=>paintInk(activeInkRef.current,activeRef.current?[activeRef.current]:[],viewport,cameraRef.current),[viewport,camera]);
  useEffect(()=>{redraw();redrawActive();},[redraw,redrawActive]);

  const commitCamera=useCallback((next:Camera)=>{cameraRef.current=next;setCamera(next);onChange({camera:next});},[onChange]);
  const clearInkSelection=useCallback((notify=true)=>{selectedIdsRef.current=[];setSelectionBounds(null);if(notify)onSelection(null);},[onSelection]);
  const commitStrokes=useCallback((next:Stroke[],history=true)=>{if(history){undoRef.current=[...undoRef.current,strokesRef.current].slice(-100);redoRef.current=[];}boundsRef.current=null;strokesRef.current=next;setStrokes(next);onChange({strokes:next});},[onChange]);
  const removeAt=useCallback((point:Point,radius:number)=>{
    const boardPoint=screenToBoard(point,viewport,cameraRef.current);let changed=false;
    const kept=strokesRef.current.filter(stroke=>{const pts=stroke.points;for(let i=0;i<pts.length;i++){const p:Point=[pts[i].x,pts[i].y];if(Math.hypot(p[0]-boardPoint[0],p[1]-boardPoint[1])<=radius+stroke.width/2||(i>0&&distanceToSegment(boardPoint,[pts[i-1].x,pts[i-1].y],p)<=radius+stroke.width/2)){changed=true;return false;}}return true;});
    if(changed){const drag=dragRef.current;if(drag?.kind==='erase'&&!drag.erased){undoRef.current=[...undoRef.current,strokesRef.current].slice(-100);redoRef.current=[];drag.erased=true;}strokesRef.current=kept;setStrokes(kept);boundsRef.current=null;clearInkSelection();}
  },[viewport,clearInkSelection]);

  const pointerDown=(event:React.PointerEvent<HTMLDivElement>)=>{
    const penEraser=event.pointerType==='pen'&&(event.button===5||(event.buttons&32)!==0);if(event.button===2&&!penEraser)return;const host=hostRef.current;if(!host)return;
    host.focus({preventScroll:true});const screen=cssPoint(event,host.getBoundingClientRect());const cam=cameraRef.current;
    const p=screenToBoard(screen,viewport,cam);const isPan=!penEraser&&(event.button===1||spaceRef.current||tool==='hand'||(event.pointerType==='touch'));
    const currentSelection=selectionBounds;const selected=selectedIdsRef.current.length>0;
    const topLeft=currentSelection?boardToScreen([currentSelection.x,currentSelection.y],viewport,cam):null;
    const inSelection=!!(selected&&topLeft&&currentSelection&&screen[0]>=topLeft[0]-8&&screen[0]<=topLeft[0]+currentSelection.width*cam.zoom+8&&screen[1]>=topLeft[1]-8&&screen[1]<=topLeft[1]+currentSelection.height*cam.zoom+8);
    const kind=isPan?'pan':penEraser||tool==='eraser'?'erase':tool==='lasso'?(inSelection?'move':'lasso'):tool==='selection'?'select':'ink';
    try{event.currentTarget.setPointerCapture(event.pointerId);}catch{/* capture may fail when the browser cancels */}
    dragRef.current={kind,start:screen,last:screen,pointerId:event.pointerId,points:[screen],erased:false,...(kind==='move'?{startStrokes:strokesRef.current,selectionBounds:currentSelection??undefined}:{})};event.preventDefault();
    if(kind==='ink'){
      const pressure=event.pointerType==='mouse'?1:(event.pressure>0?event.pressure:0.5);
      activeRef.current={id:crypto.randomUUID(),tool:tool==='highlighter'?'highlighter':'pen',color,width,points:[{x:p[0],y:p[1],pressure,time:Date.now()}]};
      redrawActive();
    } else if(kind==='erase') removeAt(screen,Math.max(width,14)/cam.zoom);
    else if(kind==='select'||kind==='lasso'){setMarquee({x:screen[0],y:screen[1],width:0,height:0});}
  };

  const pointerMove=(event:React.PointerEvent<HTMLDivElement>)=>{
    const drag=dragRef.current,host=hostRef.current;if(!drag||drag.pointerId!==event.pointerId||!host)return;
    const screen=cssPoint(event,host.getBoundingClientRect());const delta:Point=[screen[0]-drag.last[0],screen[1]-drag.last[1]];drag.last=screen;
    if(drag.kind==='pan'){const cam=cameraRef.current;const next={...cam,center:[cam.center[0]-delta[0]/cam.zoom,cam.center[1]-delta[1]/cam.zoom] as Point};cameraRef.current=next;setCamera(next);}
    else if(drag.kind==='ink'&&activeRef.current){const cam=cameraRef.current;const coalesced=typeof event.nativeEvent.getCoalescedEvents==='function'?event.nativeEvent.getCoalescedEvents():[];const samples=coalesced.length?coalesced:[event.nativeEvent];for(const sample of samples){const sp=cssPoint(sample,host.getBoundingClientRect()),p=screenToBoard(sp,viewport,cam);activeRef.current.points.push({x:p[0],y:p[1],pressure:event.pointerType==='mouse'?1:(sample.pressure>0?sample.pressure:0.5),time:Date.now()});}redrawActive();}
    else if(drag.kind==='erase')removeAt(screen,Math.max(width,14)/cameraRef.current.zoom);
    else if(drag.kind==='move'&&drag.startStrokes){const boardDelta:Point=[(screen[0]-drag.start[0])/cameraRef.current.zoom,(screen[1]-drag.start[1])/cameraRef.current.zoom];const next=translateStrokes(drag.startStrokes,new Set(selectedIdsRef.current),boardDelta);drag.changed=drag.changed||boardDelta[0]!==0||boardDelta[1]!==0;strokesRef.current=next;setStrokes(next);boundsRef.current=null;const moved=next.filter(s=>selectedIdsRef.current.includes(s.id)).map(strokeBounds);setSelectionBounds(unionRegions(moved));}
    else {drag.points.push(screen);setMarquee({x:Math.min(drag.start[0],screen[0]),y:Math.min(drag.start[1],screen[1]),width:Math.abs(screen[0]-drag.start[0]),height:Math.abs(screen[1]-drag.start[1])});}
    event.preventDefault();
  };

  const pointerUp=async(event:React.PointerEvent<HTMLDivElement>)=>{
    const drag=dragRef.current;if(!drag||drag.pointerId!==event.pointerId)return;
    dragRef.current=null;
    if(drag.kind==='ink'&&activeRef.current){const stroke=activeRef.current;activeRef.current=null;commitStrokes([...strokesRef.current,stroke]);}
    else if(drag.kind==='pan')onChange({camera:cameraRef.current});
    else if(drag.kind==='erase')onChange({strokes:strokesRef.current});
    else if(drag.kind==='move'&&drag.startStrokes){
      const finalStrokes=strokesRef.current;
      if(drag.changed){undoRef.current=[...undoRef.current,drag.startStrokes].slice(-100);redoRef.current=[];onChange({strokes:finalStrokes});try{const bounds=boundsRef.current??await ensureBounds();const selectedBounds=unionRegions(finalStrokes.filter(s=>selectedIdsRef.current.includes(s.id)).map(strokeBounds));if(selectedBounds)onSelection(await captureBoard(finalStrokes,sceneRef.current,selectionAsPercent(selectedBounds,bounds),bounds));}catch(error){onError(error instanceof Error?error.message:'Could not capture that board region.');}}
    }
    else if(drag.kind==='lasso'){
      if(drag.points.length>2){const polygon=drag.points.map(point=>screenToBoard(point,viewport,cameraRef.current));const selected=strokesRef.current.filter(stroke=>strokeIntersectsPolygon(stroke,polygon));selectedIdsRef.current=selected.map(stroke=>stroke.id);const region=unionRegions(selected.map(strokeBounds));setSelectionBounds(region);if(!selected.length)onSelection(null);}
    }
    else if(drag.kind==='select'&&marquee&&marquee.width>3&&marquee.height>3){
      const a=screenToBoard([marquee.x,marquee.y],viewport,cameraRef.current),b=screenToBoard([marquee.x+marquee.width,marquee.y+marquee.height],viewport,cameraRef.current);
      const region={x:a[0],y:a[1],width:b[0]-a[0],height:b[1]-a[1]};
      try{const bounds=boundsRef.current??await ensureBounds();onSelection(await captureBoard(strokesRef.current,sceneRef.current,selectionAsPercent(region,bounds),bounds));}catch(error){onError(error instanceof Error?error.message:'Could not capture that board region.');}
    }
    if(drag.kind==='lasso'&&drag.points.length>2){const a=screenToBoard([Math.min(...drag.points.map(p=>p[0])),Math.min(...drag.points.map(p=>p[1]))],viewport,cameraRef.current),b=screenToBoard([Math.max(...drag.points.map(p=>p[0])),Math.max(...drag.points.map(p=>p[1]))],viewport,cameraRef.current);if(b[0]>a[0]&&b[1]>a[1])try{const bounds=boundsRef.current??await ensureBounds();onSelection(await captureBoard(strokesRef.current,sceneRef.current,selectionAsPercent({x:a[0],y:a[1],width:b[0]-a[0],height:b[1]-a[1]},bounds),bounds));}catch(error){onError(error instanceof Error?error.message:'Could not capture that board region.');}}
    setMarquee(null);redrawActive();
  };

  const pointerCancel=(event:React.PointerEvent<HTMLDivElement>)=>{const drag=dragRef.current;if(drag?.pointerId!==event.pointerId)return;dragRef.current=null;activeRef.current=null;if(drag.kind==='pan')onChange({camera:cameraRef.current});if(drag.kind==='erase')onChange({strokes:strokesRef.current});if(drag.kind==='move'&&drag.startStrokes){strokesRef.current=drag.startStrokes;setStrokes(drag.startStrokes);setSelectionBounds(drag.selectionBounds??null);boundsRef.current=null;}setMarquee(null);redrawActive();};

  async function ensureBounds(){const captured=await captureBoard(strokesRef.current,sceneRef.current);boundsRef.current=captured.bounds;return captured.bounds;}
  const fit=()=>{const content=unionRegions([unionRegions(strokesRef.current.map(strokeBounds)),sceneBounds(sceneRef.current)]);if(!content)return;const margin=48;const zoom=clampZoom(Math.min((viewport[0]-margin*2)/Math.max(1,content.width),(viewport[1]-margin*2)/Math.max(1,content.height)));commitCamera({center:[content.x+content.width/2,content.y+content.height/2],zoom});};
  const undo=()=>{const previous=undoRef.current.pop();if(!previous)return;redoRef.current.push(strokesRef.current);strokesRef.current=previous;setStrokes(previous);boundsRef.current=null;clearInkSelection();onChange({strokes:previous});};
  const redo=()=>{const next=redoRef.current.pop();if(!next)return;undoRef.current.push(strokesRef.current);strokesRef.current=next;setStrokes(next);boundsRef.current=null;clearInkSelection();onChange({strokes:next});};
  const clear=()=>{if(!strokesRef.current.length)return;commitStrokes([]);clearInkSelection();};
  const boardKeyDown=(event:React.KeyboardEvent<HTMLDivElement>)=>{
    const target=event.target as HTMLElement;
    if(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))return;
    if(event.key==='Escape'&&(selectedIdsRef.current.length||marquee)){event.preventDefault();setMarquee(null);clearInkSelection();return;}
    if((event.key==='Delete'||event.key==='Backspace')&&selectedIdsRef.current.length){event.preventDefault();const ids=new Set(selectedIdsRef.current);commitStrokes(strokesRef.current.filter(stroke=>!ids.has(stroke.id)));clearInkSelection();}
  };

  useImperativeHandle(ref,()=>({
    async capture(region?:BoardRegion){const result=await captureBoard(strokesRef.current,sceneRef.current,region,boundsRef.current);boundsRef.current=result.bounds;return {image_base64:result.image_base64,region:result.region};},
    async overview(){const data=await overviewBoard(strokesRef.current,sceneRef.current);boundsRef.current=boardExtent(strokesRef.current,sceneRef.current);return data;},
    context(){
      const bounds=boundsRef.current;const ink=unionRegions(strokesRef.current.map(strokeBounds));const cam=cameraRef.current;const visible={x:cam.center[0]-viewport[0]/cam.zoom/2,y:cam.center[1]-viewport[1]/cam.zoom/2,width:viewport[0]/cam.zoom,height:viewport[1]/cam.zoom};
      const box=(r:BoardRegion)=>[r.x,r.y,r.x+r.width,r.y+r.height];
      const inset=visible.width*.06;const tutor={x:visible.x+inset,y:visible.y+visible.height*.06,width:visible.width-2*inset,height:visible.height*.44};
      const learner={x:visible.x+inset,y:visible.y+visible.height*.58,width:visible.width-2*inset,height:visible.height*.36};
      const clusters: Array<{box:BoardRegion;count:number;newest:number}> = [];
      for(const stroke of strokesRef.current){const r=strokeBounds(stroke);if(!r)continue;const i=clusters.findIndex(c=>c.box.x-600<r.x+r.width&&c.box.x+c.box.width+600>r.x&&c.box.y-600<r.y+r.height&&c.box.y+c.box.height+600>r.y);const newest=Math.max(...stroke.points.map(p=>p.time));if(i<0)clusters.push({box:r,count:1,newest});else{const current=clusters[i],merged=unionRegions([current.box,r])!;clusters[i]={box:merged,count:current.count+1,newest:Math.max(current.newest,newest)};}}
      const content=bounds??boardExtent(strokesRef.current,sceneRef.current);
      return JSON.stringify({kind:'board_scene_context',data_not_instructions:true,coordinate_system:'logical board points; (0,0) is drawing (25000,25000); +x right, +y down',visible_logical_rect:box(visible),recommended_tutor_rect:box(tutor),reserved_learner_work_rect:box(learner),...(content?{overview_logical_bounds:box(content)}:{}),...(ink?{learner_ink_logical_bounds:box(ink),learner_ink_clusters:clusters.map(c=>({logical_box:box(c.box),strokes:c.count,newest_unix:c.newest/1000}))}:{}),tutor_elements:sceneRef.current.elements});
    },
    fit,undo,redo,clear
  }),[viewport,onChange]);

  useEffect(()=>{const down=(e:KeyboardEvent)=>{if(e.code==='Space'&&!/INPUT|TEXTAREA/.test((e.target as HTMLElement)?.tagName??'')){spaceRef.current=true;e.preventDefault();}};const up=(e:KeyboardEvent)=>{if(e.code==='Space')spaceRef.current=false;};window.addEventListener('keydown',down);window.addEventListener('keyup',up);return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);};},[]);
  useEffect(()=>{const host=hostRef.current;if(!host)return;const wheel=(event:WheelEvent)=>{event.preventDefault();const p=cssPoint(event,host.getBoundingClientRect());const cam=cameraRef.current;const next=event.ctrlKey||event.metaKey?zoomAt(cam,p,viewport,cam.zoom*Math.exp(-event.deltaY*.002)):{...cam,center:[cam.center[0]+event.deltaX/cam.zoom,cam.center[1]+event.deltaY/cam.zoom] as Point};cameraRef.current=next;setCamera(next);if(wheelPersistRef.current)clearTimeout(wheelPersistRef.current);wheelPersistRef.current=setTimeout(()=>{wheelPersistRef.current=null;onChangeRef.current({camera:cameraRef.current});},120);};host.addEventListener('wheel',wheel,{passive:false});return()=>host.removeEventListener('wheel',wheel);},[viewport]);
  const viewBox=`${camera.center[0]-viewport[0]/camera.zoom/2} ${camera.center[1]-viewport[1]/camera.zoom/2} ${viewport[0]/camera.zoom} ${viewport[1]/camera.zoom}`;

  const selectionScreen=selectionBounds?boardToScreen([selectionBounds.x,selectionBounds.y],viewport,camera):null;
  const lassoActive=dragRef.current?.kind==='lasso';
  return <div ref={hostRef} className="board-surface" tabIndex={0} onKeyDown={boardKeyDown} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onContextMenu={e=>e.preventDefault()} data-board-tool={tool}>
    <TutorScene scene={workspace.scene} images={images} viewBox={viewBox}/>
    <canvas className="board-ink" ref={inkRef} aria-label="Learning whiteboard"/>
    <canvas className="board-active-ink" ref={activeInkRef} aria-hidden="true"/>
    {lassoActive&&<svg className="board-lasso" viewBox={`0 0 ${viewport[0]} ${viewport[1]}`}><polyline points={dragRef.current!.points.map(p=>p.join(',')).join(' ')} /></svg>}
    {marquee&&dragRef.current?.kind==='select'&&<div className="board-marquee" style={{left:marquee.x,top:marquee.y,width:marquee.width,height:marquee.height}}/>}
    {selectionBounds&&selectedIdsRef.current.length>0&&selectionScreen&&<div className="board-marquee" data-testid="ink-selection-bounds" style={{left:selectionScreen[0],top:selectionScreen[1],width:selectionBounds.width*camera.zoom,height:selectionBounds.height*camera.zoom}}/>}
  </div>;
});
