import DOMPurify from 'dompurify';
import katex from 'katex';
import { createElement, type ReactNode } from 'react';
import type { BoardElement, BoardScene, BoardRegion } from '../types';
import type { BoardElementStyle } from './element-types';
import shantellFontUrl from './assets/ShantellSans-Normal-Regular.otf?url';
import { elementBounds, unionRegions } from './geometry';

const num = (e: Record<string, unknown>, key: string, fallback = 0) => typeof e[key] === 'number' ? e[key] as number : fallback;
const str = (e: Record<string, unknown>, key: string, fallback = '') => typeof e[key] === 'string' ? e[key] as string : fallback;
const pts = (e: BoardElement) => Array.isArray(e.points) ? e.points as Array<[number, number]> : [];
function textLines(text:string,fontSize:number,width:number):string[]{
  const ctx=typeof document!=='undefined'?document.createElement('canvas').getContext('2d'):null;
  if(ctx)ctx.font=`${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  const measure=(s:string)=>ctx?.measureText(s).width??s.length*fontSize*.55;
  const lines:string[]=[];
  for(const paragraph of text.split('\n')){let line='';for(const word of paragraph.split(/\s+/)){const next=line?`${line} ${word}`:word;if(width>0&&line&&measure(next)>width){lines.push(line);line=word;}else line=next;}lines.push(line);}
  return lines;
}
function arcD(cx:number,cy:number,radius:number,start:number,end:number,shortest:boolean):string{
  const norm=(a:number)=>((a%360)+360)%360;let delta=norm(end)-norm(start);
  if(shortest){if(delta>180)delta-=360;if(delta< -180)delta+=360;}else if(delta<0)delta+=360;
  const segments=Math.max(4,Math.min(128,Math.floor(Math.abs(delta)/5)+1));let d='';
  for(let i=0;i<=segments;i++){const a=(norm(start)+delta*i/segments)*Math.PI/180,x=cx+radius*Math.cos(a),y=cy+radius*Math.sin(a);d+=`${i?' L':'M'} ${x} ${y}`;}
  return d;
}
// Current Swift wire elements flatten BoardStyle keys beside geometry. Accept
// nested style too for legacy/local fixtures, with the wire fields winning.
const styleOf = (element: BoardElement): BoardElementStyle => ({
  ...(element.style ?? {}),
  ...(element.stroke !== undefined ? { stroke: element.stroke } : {}),
  ...(element.fill !== undefined ? { fill: element.fill } : {}),
  ...(element.stroke_width !== undefined ? { stroke_width: element.stroke_width } : {}),
  ...(element.opacity !== undefined ? { opacity: element.opacity } : {}),
  ...(element.dash !== undefined ? { dash: element.dash } : {}),
  ...(element.rotation !== undefined ? { rotation: element.rotation } : {}),
});
const styleAttrs = (e: BoardElement) => {
  const s = styleOf(e);
  const bounds = elementBounds(e);
  const centerX = bounds ? bounds.x + bounds.width / 2 : 'x' in e ? e.x : 'cx' in e ? e.cx : 0;
  const centerY = bounds ? bounds.y + bounds.height / 2 : 'y' in e ? e.y : 'cy' in e ? e.cy : 0;
  const rotation = s.rotation ?? 0;
  return { stroke: s.stroke ?? '#0A0A0A', fill: s.fill ?? 'transparent',
    strokeWidth: Math.max(0.5, s.stroke_width ?? 4), opacity: Math.max(0, Math.min(1, s.opacity ?? 1)),
    strokeDasharray: s.dash?.join(' '), strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    transform: rotation ? `rotate(${rotation} ${centerX} ${centerY})` : undefined };
};
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' }[c]!));

/** Strip active content and every external resource from tutor-authored SVG. */
export function sanitizeSvg(source: string): string {
  if (typeof window === 'undefined' || !source) return '';
  const clean = DOMPurify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: false },
    FORBID_TAGS: ['script', 'foreignObject', 'image', 'iframe', 'audio', 'video'],
    FORBID_ATTR: ['onload', 'onclick', 'onerror'] });
  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg') return '';
  for (const node of [root,...Array.from(root.querySelectorAll('*'))]) {
    if(node.localName==='style'){
      const css=node.textContent??'';const urls=[...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
      if(/@import/i.test(css)||urls.some(match=>!String(match[2]).startsWith('#'))){node.remove();continue;}
    }
    for (const attr of Array.from(node.attributes)) {
      if (/^(href|xlink:href)$/i.test(attr.name) && !attr.value.startsWith('#')) node.removeAttribute(attr.name);
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      const urls=[...attr.value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
      if(urls.some(match=>!String(match[2]).startsWith('#')))node.removeAttribute(attr.name);
    }
  }
  return root.outerHTML;
}

export function katexCaptureStyles(): string {
  if(typeof document==='undefined')return '';
  const rules:string[]=[];
  for(const sheet of Array.from(document.styleSheets)){
    try{for(const rule of Array.from(sheet.cssRules)){const css=rule.cssText;if(css.includes('.katex')||css.includes('KaTeX_'))rules.push(css);}}
    catch{/* cross-origin stylesheets do not participate in local board capture */}
  }
  return rules.join('\n');
}

export interface MathRaster { href: string; width: number; height: number; offsetX: number; offsetY: number; }
const mathRasterCache = new Map<string, Promise<Record<string, MathRaster>>>();

let shantellFontData: Promise<string> | undefined;
async function shantellFontBase64(): Promise<string> {
  if (!shantellFontData) {
    shantellFontData = (async () => {
      const response = await fetch(shantellFontUrl);
      if (!response.ok) throw new Error('Shantell Sans could not be loaded for board capture.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let start = 0; start < bytes.length; start += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(start, Math.min(start + 0x8000, bytes.length)));
      }
      return btoa(binary);
    })();
    void shantellFontData.catch(() => { shantellFontData = undefined; });
  }
  return shantellFontData;
}

/** CSS needed to keep math and handwritten tutor text faithful in detached PNG captures. */
export async function sceneCaptureStyles(scene: BoardScene): Promise<string> {
  const styles = [katexCaptureStyles()];
  if (scene.elements.some(element => element.kind === 'ink_text')) {
    const font = await shantellFontBase64();
    styles.push(`@font-face{font-family:'Shantell Sans';src:url(data:font/otf;base64,${font}) format('opentype');font-weight:400;font-style:normal}`);
  }
  return styles.join('\n');
}

function rawSvgBody(source: string): { body: string; width: number; height: number; viewBox: string } {
  const safe = sanitizeSvg(source);
  if (!safe) return { body: '', width: 0, height: 0, viewBox: '' };
  const root = new DOMParser().parseFromString(safe, 'image/svg+xml').documentElement;
  const viewBox = root.getAttribute('viewBox') ?? '';
  const parts = viewBox.split(/[ ,]+/).map(Number);
  const width = Number.parseFloat(root.getAttribute('width') ?? '') || parts[2] || 0;
  const height = Number.parseFloat(root.getAttribute('height') ?? '') || parts[3] || 0;
  return { body: root.innerHTML, width, height, viewBox };
}

function mathMarkup(latex: string, color: string, size: number, mathml = false): string {
  try {
    const markup=katex.renderToString(latex.replace(/^\$+|\$+$/g, ''), { throwOnError: false, output: mathml?'mathml':'html' });
    if(mathml){const inner=/<span class="katex">([\s\S]*)<\/span>/.exec(markup)?.[1]??'';return `<g fill="${escape(color)}" font-size="${size}px">${inner}</g>`;}
    return markup.replace('<span class="katex">', `<span class="katex" style="color:${escape(color)};font-size:${size}px">`);
  }
  catch { return escape(latex); }
}

/** Render KaTeX HTML using text and rule primitives into origin-clean PNGs.
 * SVG foreignObject images taint Chromium canvases; this DOM measurement pass
 * preserves KaTeX's browser layout while keeping captures exportable. */
export function rasterizeMathElements(scene: BoardScene): Promise<Record<string, MathRaster>> {
  const key = JSON.stringify(scene.elements.filter(element => element.kind === 'math_text'));
  const cached = mathRasterCache.get(key); if (cached) return cached;
  const pending = rasterizeMathElementsUncached(scene);
  mathRasterCache.set(key, pending);
  while (mathRasterCache.size > 32) mathRasterCache.delete(mathRasterCache.keys().next().value!);
  void pending.catch(() => { if (mathRasterCache.get(key) === pending) mathRasterCache.delete(key); });
  return pending;
}

async function rasterizeMathElementsUncached(scene:BoardScene):Promise<Record<string,MathRaster>>{
  if(typeof document==='undefined')return{};
  await document.fonts?.ready;
  const out:Record<string,MathRaster>={};
  for(const element of scene.elements){if(element.kind!=='math_text')continue;
    const size=num(element,'font_size',24),color=styleOf(element).stroke??'#0A0A0A';
    const host=document.createElement('div');host.style.cssText=`position:fixed;left:-10000px;top:0;display:inline-block;visibility:hidden;white-space:nowrap;color:${color};font-size:${size}px`;
    try{
      const markup=katex.renderToString(str(element,'latex').replace(/^\$+|\$+$/g,''),{throwOnError:false,output:'html'});
      host.innerHTML=markup;document.body.append(host);await document.fonts?.ready;
      const root=host.firstElementChild as HTMLElement|null;if(!root)continue;
      const rootBounds=root.getBoundingClientRect();
      const textRuns:Array<{text:string;rect:DOMRect;style:CSSStyleDeclaration}>=[];
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node:Node|null;
      while((node=walker.nextNode())){const text=node.textContent??'';if(!text.trim())continue;const range=document.createRange();range.selectNodeContents(node);const rect=range.getBoundingClientRect();if(rect.width&&rect.height)textRuns.push({text,rect,style:getComputedStyle(node.parentElement??root)});}
      const svgs=Array.from(root.querySelectorAll<SVGSVGElement>('svg')).filter(svg=>!svg.parentElement?.closest('svg'));
      const svgRuns=svgs.map(svg=>({svg,rect:svg.getBoundingClientRect()})).filter(item=>item.rect.width>0&&item.rect.height>0);
      const rules:Array<{rect:DOMRect;color:string;width:number}>=[];
      for(const part of [root,...Array.from(root.querySelectorAll<HTMLElement>('*'))]){const style=getComputedStyle(part),bw=Number.parseFloat(style.borderBottomWidth);if(bw>0&&style.borderBottomStyle!=='none')rules.push({rect:part.getBoundingClientRect(),color:style.borderBottomColor||color,width:bw});}
      const rootAndContent=[rootBounds,...textRuns.map(run=>run.rect),...svgRuns.map(run=>run.rect),...rules.map(rule=>rule.rect)];
      const left=Math.min(...rootAndContent.map(rect=>rect.left)),top=Math.min(...rootAndContent.map(rect=>rect.top)),right=Math.max(...rootAndContent.map(rect=>rect.right)),bottom=Math.max(...rootAndContent.map(rect=>rect.bottom));
      const bounds={left,top,width:Math.max(1,right-left),height:Math.max(1,bottom-top)},scale=2;
      const canvas=document.createElement('canvas');canvas.width=Math.ceil(bounds.width*scale);canvas.height=Math.ceil(bounds.height*scale);const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Could not rasterize math notation.');ctx.scale(scale,scale);
      // KaTeX uses inline SVG paths for radicals, extensible accents, braces,
      // arrows and delimiters. Rasterize those rendered glyphs themselves,
      // preserving measured placement and computed SVG paint attributes.
      for(const {svg,rect} of svgRuns){
        const clone=svg.cloneNode(true) as SVGSVGElement;clone.setAttribute('xmlns','http://www.w3.org/2000/svg');clone.setAttribute('width',String(rect.width));clone.setAttribute('height',String(rect.height));
        const originalNodes=[svg,...Array.from(svg.querySelectorAll<SVGElement>('*'))],cloneNodes=[clone,...Array.from(clone.querySelectorAll<SVGElement>('*'))];
        const inlineProperties=['fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','opacity','clip-path','clip-rule','mask','filter','transform','transform-origin','vector-effect','color','visibility','display'];
        originalNodes.forEach((original,index)=>{const computed=getComputedStyle(original),target=cloneNodes[index];for(const property of inlineProperties){const value=computed.getPropertyValue(property);if(value)target.style.setProperty(property,value);}target.style.setProperty('visibility','visible');});
        clone.style.setProperty('visibility','visible');clone.style.setProperty('display','block');
        const safe=sanitizeSvg(new XMLSerializer().serializeToString(clone));if(!safe)continue;
        const source='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(safe);const image=new Image();image.src=source;await image.decode();
        let clip={left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom};
        for(let ancestor=svg.parentElement;ancestor&&ancestor!==root;ancestor=ancestor.parentElement){const style=getComputedStyle(ancestor);if([style.overflowX,style.overflowY].some(value=>value==='hidden'||value==='clip'||value==='scroll'||value==='auto')){const r=ancestor.getBoundingClientRect();clip={left:Math.max(clip.left,r.left),top:Math.max(clip.top,r.top),right:Math.min(clip.right,r.right),bottom:Math.min(clip.bottom,r.bottom)};}}
        if(clip.right<=clip.left||clip.bottom<=clip.top)continue;
        ctx.save();ctx.beginPath();ctx.rect(clip.left-bounds.left,clip.top-bounds.top,clip.right-clip.left,clip.bottom-clip.top);ctx.clip();ctx.drawImage(image,rect.left-bounds.left,rect.top-bounds.top,rect.width,rect.height);ctx.restore();
      }
      // SVG glyphs sit behind their neighboring HTML glyphs in KaTeX's live
      // composition (for example, an underbrace sits below its annotation).
      for(const run of textRuns){ctx.font=run.style.font||`${run.style.fontSize} ${run.style.fontFamily}`;ctx.fillStyle=run.style.color||color;ctx.textBaseline='alphabetic';const metrics=ctx.measureText(run.text);const descent=metrics.fontBoundingBoxDescent||metrics.actualBoundingBoxDescent||0;ctx.fillText(run.text,run.rect.left-bounds.left,run.rect.bottom-bounds.top-descent);}
      for(const rule of rules){ctx.strokeStyle=rule.color;ctx.lineWidth=rule.width;ctx.beginPath();ctx.moveTo(rule.rect.left-bounds.left,rule.rect.bottom-bounds.top-rule.width/2);ctx.lineTo(rule.rect.right-bounds.left,rule.rect.bottom-bounds.top-rule.width/2);ctx.stroke();}
      out[element.id]={href:canvas.toDataURL('image/png'),width:bounds.width,height:bounds.height,offsetX:left-rootBounds.left,offsetY:top-rootBounds.top};
    }finally{host.remove();}
  }
  return out;
}

function ElementView({ element, images, mathImages }: { element: BoardElement; images: Record<string, string>; mathImages?:Record<string,MathRaster> }): ReactNode {
  const s = styleAttrs(element); const x = num(element, 'x'); const y = num(element, 'y');
  const color = styleOf(element).stroke ?? '#0A0A0A';
  const xy = pts(element).map(p => p.join(',')).join(' ');
  switch (element.kind) {
    case 'text': {const size=Math.max(8,element.font_size),width=element.width??0,lines=textLines(element.text,size,width);return <text key={element.id} x={x} y={y+size*.9} fontSize={size} fontFamily="-apple-system, BlinkMacSystemFont, sans-serif" textAnchor={element.alignment==='center'?'middle':element.alignment==='right'?'end':'start'} fill={s.stroke} opacity={s.opacity} transform={s.transform}>{lines.map((line,i)=><tspan key={i} x={x} dy={i===0?0:size*1.2}>{line}</tspan>)}</text>;}
    case 'line': return <line key={element.id} x1={element.x1} y1={element.y1} x2={element.x2} y2={element.y2} {...s} />;
    case 'arrow': {
      const dx=element.x2-element.x1,dy=element.y2-element.y1,length=Math.hypot(dx,dy)||1,ux=dx/length,uy=dy/length;
      const head=Math.max(4,element.head_size??12),baseX=element.x2-ux*head,baseY=element.y2-uy*head,half=head*.5,px=-uy,py=ux;
      return <g key={element.id} opacity={s.opacity} transform={s.transform}>
        <line x1={element.x1} y1={element.y1} x2={element.x2} y2={element.y2} stroke={s.stroke} strokeWidth={s.strokeWidth} strokeDasharray={s.strokeDasharray} strokeLinecap="round" />
        <path d={`M ${element.x2} ${element.y2} L ${baseX+px*half} ${baseY+py*half} L ${baseX-px*half} ${baseY-py*half} Z`} fill={s.stroke} />
      </g>;
    }
    case 'rectangle': return <rect key={element.id} x={x} y={y} width={element.width} height={element.height} {...s} />;
    case 'ellipse': return <ellipse key={element.id} cx={x+element.width/2} cy={y+element.height/2} rx={element.width/2} ry={element.height/2} {...s}/>;
    case 'circle': return <circle key={element.id} cx={element.cx} cy={element.cy} r={element.radius} {...s}/>;
    case 'polygon': return <polygon key={element.id} points={xy} {...s}/>;
    case 'polyline': return <polyline key={element.id} points={xy} {...s} fill="none"/>;
    case 'freehand': {const points=element.points;let d='';if(points.length){d=`M ${points[0][0]} ${points[0][1]}`;if(points.length<=2)d+=points.slice(1).map(p=>` L ${p[0]} ${p[1]}`).join('');else{for(let i=1;i<points.length-1;i++){const a=points[i],b=points[i+1];d+=` Q ${a[0]} ${a[1]} ${(a[0]+b[0])/2} ${(a[1]+b[1])/2}`;}const last=points[points.length-1];d+=` L ${last[0]} ${last[1]}`;}}return <path key={element.id} d={d} {...s} fill="none"/>;}
    case 'arc': { const radius=Math.max(0,element.radius); return <path key={element.id} d={arcD(element.cx,element.cy,radius,element.start_angle,element.end_angle,false)} {...s} fill="none"/>; }
    case 'angle_marker': { const vx=element.vertex_x,vy=element.vertex_y,r=Math.max(4,element.radius??40),ax=element.ray1_x-vx,ay=element.ray1_y-vy,bx=element.ray2_x-vx,by=element.ray2_y-vy,al=Math.hypot(ax,ay)||1,bl=Math.hypot(bx,by)||1,a=Math.atan2(ay,ax),b=Math.atan2(by,bx); const p1=`${vx+r*ax/al} ${vy+r*ay/al}`,p2=`${vx+r*bx/bl} ${vy+r*by/bl}`; const d=element.right_angle?`M ${p1} L ${vx+r*(ax/al+bx/bl)} ${vy+r*(ay/al+by/bl)} L ${p2}`:arcD(vx,vy,r,a*180/Math.PI,b*180/Math.PI,true);return <path key={element.id} d={d} {...s} fill="none"/>; }
    case 'path': return <path key={element.id} d={element.d} fillRule={element.fill_rule??'nonzero'} {...s}/>;
    case 'math_text': return mathImages?.[element.id]
      ? <image key={element.id} x={x+mathImages[element.id].offsetX} y={y+mathImages[element.id].offsetY} width={mathImages[element.id].width} height={mathImages[element.id].height} href={mathImages[element.id].href} opacity={s.opacity} transform={s.transform}/>
      : <foreignObject key={element.id} x={x} y={y} width={Math.max(80,element.font_size*12)} height={element.font_size*2.2} opacity={s.opacity} transform={s.transform}>{createElement('div',{xmlns:'http://www.w3.org/1999/xhtml',style:{color,fontSize:element.font_size},dangerouslySetInnerHTML:{__html:mathMarkup(element.latex,color,element.font_size)}})}</foreignObject>;
    case 'ink_text': {const size=element.size??24;return <text key={element.id} x={element.x} y={element.y+size} fontFamily="Shantell Sans, cursive" fontSize={size} fill={color} opacity={s.opacity} transform={s.transform}>{element.text.slice(0,400).split('\n').map((line,i)=><tspan key={i} x={element.x} dy={i===0?0:size*1.35}>{line}</tspan>)}</text>;}
    case 'image': {
      const href=images[element.blob_id]; const radius=Math.min(12,Math.min(element.width,element.height)/4);
      return <g key={element.id} opacity={s.opacity} transform={s.transform}>
        {!href && <rect x={element.x} y={element.y} width={element.width} height={element.height} rx={radius} fill="#E6E6E8" />}
        {href && <image x={element.x} y={element.y} width={element.width} height={element.height} href={href} preserveAspectRatio="none" />}
      </g>;
    }
    case 'svg': {
      const inner=rawSvgBody(element.svg); if (!inner.body) return null;
      const framed=Boolean(element.width&&element.width>0&&element.height&&element.height>0);
      const width=framed?element.width!:inner.width,height=framed?element.height!:inner.height;
      return <svg key={element.id} x={x} y={y} width={width} height={height} viewBox={inner.viewBox||undefined} preserveAspectRatio="xMidYMid meet" opacity={s.opacity} transform={s.transform} dangerouslySetInnerHTML={{__html:inner.body}}/>;
    }
    default: return assertNever(element);
  }
}

function assertNever(element: never): never { throw new Error(`Unsupported board element: ${JSON.stringify(element)}`); }

export function TutorScene({ scene, images = {}, viewBox, mathImages }: { scene: BoardScene; images?: Record<string, string>; viewBox?: string; mathImages?:Record<string,MathRaster> }) {
  return <svg className="board-scene" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox={viewBox} preserveAspectRatio="none">
    {scene.elements.map(element => <ElementView key={element.id} element={element} images={images} mathImages={mathImages}/>) }
  </svg>;
}

export function sceneBounds(scene: BoardScene, mathImages: Record<string, MathRaster> = {}): BoardRegion | null {
  return unionRegions(scene.elements.map(element => {
    if (element.kind !== 'math_text' || !mathImages[element.id]) return elementBounds(element);
    const image = mathImages[element.id];
    const base = { x: element.x + image.offsetX, y: element.y + image.offsetY, width: image.width, height: image.height };
    const style = styleOf(element), rotation = style.rotation ?? 0;
    if (!rotation) return base;
    const side = Math.hypot(base.width, base.height), cx = base.x + base.width / 2, cy = base.y + base.height / 2;
    return { x: cx - side / 2, y: cy - side / 2, width: side, height: side };
  }));
}

/** Match the server's ordered/idempotent board_update semantics. */
export function applySceneUpdate(scene: BoardScene, update: {
  upserts?: BoardElement[]; deletes?: string[]; replace_all?: boolean;
}): BoardScene {
  const next=update.replace_all?[]:[...scene.elements];
  if(update.deletes?.length){const deleted=new Set(update.deletes);for(let i=next.length-1;i>=0;i--)if(deleted.has(next[i].id))next.splice(i,1);}
  for(const element of update.upserts??[]){const index=next.findIndex(item=>item.id===element.id);if(index<0)next.push(element);else next[index]=element;}
  return {elements:next};
}

export async function loadSceneImages(scene: BoardScene): Promise<Record<string, string>> {
  const elements = scene.elements.filter((e): e is Extract<BoardElement, {kind:'image'}> => e.kind === 'image');
  const pairs = await Promise.all(elements.map(async element => {
    const id = element.blob_id;
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) return [id, ''] as const;
    try { return [id, await imageDataUrl(id)] as const;
    } catch { return [id, ''] as const; }
  }));
  return Object.fromEntries(pairs);
}

const imageLoads=new Map<string,Promise<string>>();
function imageDataUrl(id:string):Promise<string>{
  const cached=imageLoads.get(id);if(cached)return cached;
  const load=(async()=>{const response=await fetch(`/v1/blobs/${encodeURIComponent(id)}`,{credentials:'same-origin'});if(!response.ok)throw new Error('Board image is unavailable');const blob=await response.blob();return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(blob);});})();
  imageLoads.set(id,load);void load.catch(()=>imageLoads.delete(id));return load;
}
