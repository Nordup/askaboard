import type { BoardRegion, Camera, Point, Stroke } from '../types';

export const DEFAULT_CENTER: Point = [0, 0];
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;

export function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(value) ? value : 1));
}

/** Board coordinate represented by a viewport point. */
export function screenToBoard(point: Point, size: Point, camera: Camera): Point {
  return [camera.center[0] + (point[0] - size[0] / 2) / camera.zoom,
    camera.center[1] + (point[1] - size[1] / 2) / camera.zoom];
}

/** Screen point occupied by a board coordinate. */
export function boardToScreen(point: Point, size: Point, camera: Camera): Point {
  return [(point[0] - camera.center[0]) * camera.zoom + size[0] / 2,
    (point[1] - camera.center[1]) * camera.zoom + size[1] / 2];
}

/** Keep the board point beneath the cursor fixed while zooming. */
export function zoomAt(camera: Camera, screenPoint: Point, size: Point, zoom: number): Camera {
  const anchor = screenToBoard(screenPoint, size, camera);
  const nextZoom = clampZoom(zoom);
  return { zoom: nextZoom, center: [anchor[0] - (screenPoint[0] - size[0] / 2) / nextZoom,
    anchor[1] - (screenPoint[1] - size[1] / 2) / nextZoom] };
}

export function strokeBounds(stroke: Stroke): BoardRegion | null {
  if (!stroke.points.length) return null;
  const xs = stroke.points.map(p => p.x); const ys = stroke.points.map(p => p.y);
  const pad = stroke.width / 2;
  const x = Math.min(...xs) - pad; const y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) - Math.min(...xs) + pad * 2,
    height: Math.max(...ys) - Math.min(...ys) + pad * 2 };
}

function pointInPolygon(point:Point,polygon:Point[]):boolean{
  let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];if(((a[1]>point[1])!==(b[1]>point[1]))&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }return inside;
}
function segmentDistance(a:Point,b:Point,c:Point,d:Point):number{
  const cross=(p:Point,q:Point,r:Point)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  const on=(p:Point,q:Point,r:Point)=>Math.min(p[0],q[0])<=r[0]&&r[0]<=Math.max(p[0],q[0])&&Math.min(p[1],q[1])<=r[1]&&r[1]<=Math.max(p[1],q[1]);
  const c1=cross(a,b,c),c2=cross(a,b,d),c3=cross(c,d,a),c4=cross(c,d,b);
  if((c1===0&&on(a,b,c))||(c2===0&&on(a,b,d))||(c3===0&&on(c,d,a))||(c4===0&&on(c,d,b))||((c1>0)!==(c2>0)&&(c3>0)!==(c4>0)))return 0;
  return Math.min(distanceToSegment(a,c,d),distanceToSegment(b,c,d),distanceToSegment(c,a,b),distanceToSegment(d,a,b));
}
function distanceToSegment(p:Point,a:Point,b:Point):number{
  const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy,t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)):0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
}

/** Whole-stroke lasso hit test; tolerance includes the rendered nib radius. */
export function strokeIntersectsPolygon(stroke:Stroke,polygon:Point[]):boolean{
  if(polygon.length<3||stroke.points.length===0)return false;
  const tolerance=Math.max(0,stroke.width/2);
  const points=stroke.points.map(p=>[p.x,p.y] as Point);
  if(points.some(point=>pointInPolygon(point,polygon)))return true;
  const strokeSegments=points.length===1?[[points[0],points[0]] as [Point,Point]]:points.slice(1).map((point,i)=>[points[i],point] as [Point,Point]);
  const lassoSegments=polygon.map((point,i)=>[point,polygon[(i+1)%polygon.length]] as [Point,Point]);
  return strokeSegments.some(([a,b])=>lassoSegments.some(([c,d])=>segmentDistance(a,b,c,d)<=tolerance));
}

/** Shift selected learner strokes without mutating stored/history snapshots. */
export function translateStrokes(strokes:Stroke[],ids:Set<string>,delta:Point):Stroke[]{
  if(!ids.size||(!delta[0]&&!delta[1]))return strokes;
  return strokes.map(stroke=>ids.has(stroke.id)?{...stroke,points:stroke.points.map(point=>({...point,x:point.x+delta[0],y:point.y+delta[1]}))}:stroke);
}

export function unionRegions(regions: Array<BoardRegion | null>): BoardRegion | null {
  const valid = regions.filter((r): r is BoardRegion => !!r && r.width >= 0 && r.height >= 0);
  if (!valid.length) return null;
  const x = Math.min(...valid.map(r => r.x)); const y = Math.min(...valid.map(r => r.y));
  const right = Math.max(...valid.map(r => r.x + r.width));
  const bottom = Math.max(...valid.map(r => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** A % rectangle is relative to the same padded content extent as overview(). */
export function percentRegion(extent: BoardRegion, percent: BoardRegion): BoardRegion {
  const clipped=clampPercentRegion(percent);
  return { x: extent.x + extent.width * clipped.x / 100,
    y: extent.y + extent.height * clipped.y / 100,
    width: extent.width * clipped.width / 100,
    height: extent.height * clipped.height / 100 };
}

export function clampPercentRegion(region:BoardRegion):BoardRegion{
  const x=Math.min(100,Math.max(0,region.x)),y=Math.min(100,Math.max(0,region.y));
  const right=Math.min(100,Math.max(x,region.x+region.width)),bottom=Math.min(100,Math.max(y,region.y+region.height));
  return {x,y,width:right-x,height:bottom-y};
}

export function elementBounds(element: Record<string, unknown>): BoardRegion | null {
  const n = (key: string, fallback = 0) => typeof element[key] === 'number' ? element[key] as number : fallback;
  const style = { ...((element.style ?? {}) as Record<string, unknown>),
    ...Object.fromEntries(['stroke','fill','stroke_width','opacity','dash','rotation'].filter(key=>key in element).map(key=>[key,element[key]])) };
  const sw = typeof style.stroke_width === 'number' ? style.stroke_width : 4;
  const pad = sw / 2;
  const rotation=typeof style.rotation==='number'?style.rotation:0;
  if(rotation&&!element.__skipRotation){
    const base=elementBounds({...element,style:{...style,rotation:0},__skipRotation:true});
    if(!base)return null;const rad=rotation*Math.PI/180,cx=base.x+base.width/2,cy=base.y+base.height/2;
    const w=Math.abs(base.width*Math.cos(rad))+Math.abs(base.height*Math.sin(rad));
    const h=Math.abs(base.width*Math.sin(rad))+Math.abs(base.height*Math.cos(rad));
    return {x:cx-w/2,y:cy-h/2,width:w,height:h};
  }
  const x = n('x'); const y = n('y'); const width = n('width'); const height = n('height');
  switch (element.kind) {
    case 'line': case 'arrow': {
      const x1 = n('x1'); const y1 = n('y1'); const x2 = n('x2'); const y2 = n('y2');
      const p = element.kind === 'arrow' ? Math.max(pad, n('head_size', 12)) : pad;
      return { x: Math.min(x1, x2) - p, y: Math.min(y1, y2) - p,
        width: Math.abs(x2 - x1) + p * 2, height: Math.abs(y2 - y1) + p * 2 };
    }
    case 'circle': {
      const r = n('radius'); return { x: n('cx') - r - pad, y: n('cy') - r - pad,
        width: r * 2 + pad * 2, height: r * 2 + pad * 2 };
    }
    case 'arc': {
      const r=Math.max(0,n('radius'))+Math.max(pad,4);return{x:n('cx')-r,y:n('cy')-r,width:r*2,height:r*2};
    }
    case 'polygon': case 'polyline': case 'freehand': {
      const points = Array.isArray(element.points) ? element.points as Array<[number, number]> : [];
      if (!points.length) return null;
      const xs = points.map(p => p[0]); const ys = points.map(p => p[1]);
      return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
        width: Math.max(...xs) - Math.min(...xs) + pad * 2, height: Math.max(...ys) - Math.min(...ys) + pad * 2 };
    }
    case 'angle_marker': {
      const vx=n('vertex_x'),vy=n('vertex_y'),r=Math.max(4,n('radius',40));
      if(!element.right_angle)return{x:vx-r-pad,y:vy-r-pad,width:(r+pad)*2,height:(r+pad)*2};
      const ux=n('ray1_x')-vx,uy=n('ray1_y')-vy,ul=Math.hypot(ux,uy)||1,wx=n('ray2_x')-vx,wy=n('ray2_y')-vy,wl=Math.hypot(wx,wy)||1;
      const points:[[number,number],[number,number],[number,number]]=[[vx+r*ux/ul,vy+r*uy/ul],[vx+r*(ux/ul+wx/wl),vy+r*(uy/ul+wy/wl)],[vx+r*wx/wl,vy+r*wy/wl]];
      const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);return{x:Math.min(...xs)-pad,y:Math.min(...ys)-pad,width:Math.max(...xs)-Math.min(...xs)+2*pad,height:Math.max(...ys)-Math.min(...ys)+2*pad};
    }
    case 'text': case 'math_text': case 'ink_text': {
      const size=n('font_size',n('size',24));const lines=strValue(element.text??element.latex).split('\n');
      const naturalWidth=Math.max(size*3,...lines.map(line=>line.length*size*.62));
      const naturalHeight=size*(element.kind==='math_text'?2.2:Math.max(1,lines.length)*(element.kind==='ink_text'?1.35:1.5));
      return {x,y,width:Math.max(width,naturalWidth),height:Math.max(height,naturalHeight)};
    }
    case 'image':
      return { x, y, width, height };
    case 'svg': {
      const markup = typeof element.svg === 'string' ? element.svg : '';
      const viewBox = /\bviewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(markup);
      const naturalW = Number.parseFloat(/\bwidth\s*=\s*["']([\d.]+)/i.exec(markup)?.[1] ?? '') || Number(viewBox?.[1]) || 0;
      const naturalH = Number.parseFloat(/\bheight\s*=\s*["']([\d.]+)/i.exec(markup)?.[1] ?? '') || Number(viewBox?.[2]) || 0;
      return { x,y,width:width>0?width:naturalW,height:height>0?height:naturalH };
    }
    case 'path': {
      const d = strValue(element.d);
      if (typeof document !== 'undefined' && d) {
        try {
          const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
          svg.style.cssText='position:fixed;left:-100000px;top:-100000px;width:1px;height:1px;visibility:hidden';
          const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);svg.append(path);document.body.append(svg);
          const b=path.getBBox();svg.remove();
          if(Number.isFinite(b.x)&&Number.isFinite(b.y))return {x:b.x-pad,y:b.y-pad,width:b.width+pad*2,height:b.height+pad*2};
        } catch { /* invalid paths fall through to the coordinate estimate */ }
      }
      const numbers = d.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
      if(numbers.length<2)return null;
      const xs:number[]=[],ys:number[]=[];for(let i=0;i+1<numbers.length;i+=2){xs.push(numbers[i]);ys.push(numbers[i+1]);}
      return {x:Math.min(...xs)-pad,y:Math.min(...ys)-pad,width:Math.max(...xs)-Math.min(...xs)+pad*2,height:Math.max(...ys)-Math.min(...ys)+pad*2};
    }
    default:
      return null;
  }
}

function strValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
