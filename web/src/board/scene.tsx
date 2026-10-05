import DOMPurify from 'dompurify';
import katex from 'katex';
import { createElement, type ReactNode } from 'react';
import type { BoardElement, BoardScene, BoardRegion } from '../types';
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
const styleOf = (e: Record<string, unknown>) => ({
  ...((e.style && typeof e.style === 'object' ? e.style : {}) as Record<string, unknown>),
  ...Object.fromEntries(['stroke','fill','stroke_width','opacity','dash','rotation'].filter(key=>key in e).map(key=>[key,e[key]])),
});
const styleAttrs = (e: BoardElement) => {
  const s = styleOf(e);
  const bounds=elementBounds(e);const centerX=bounds?bounds.x+bounds.width/2:num(e,'x');const centerY=bounds?bounds.y+bounds.height/2:num(e,'y');
  return { stroke: str(s, 'stroke', '#0A0A0A'), fill: str(s, 'fill', 'transparent'),
    strokeWidth: num(s, 'stroke_width', 4), opacity: num(s, 'opacity', 1),
    strokeDasharray: Array.isArray(s.dash) ? (s.dash as number[]).join(' ') : undefined,
    transform: num(s, 'rotation') ? `rotate(${num(s, 'rotation')} ${centerX} ${centerY})` : undefined };
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
export async function rasterizeMathElements(scene:BoardScene):Promise<Record<string,{href:string;width:number;height:number;offsetX:number;offsetY:number}>>{
  if(typeof document==='undefined')return{};
  await document.fonts?.ready;
  const out:Record<string,{href:string;width:number;height:number;offsetX:number;offsetY:number}>={};
  for(const element of scene.elements){if(element.kind!=='math_text')continue;
    const size=num(element,'font_size',24),color=str(styleOf(element),'stroke','#0A0A0A');
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

function ElementView({ element, images, mathImages }: { element: BoardElement; images: Record<string, string>; mathImages?:Record<string,{href:string;width:number;height:number;offsetX:number;offsetY:number}> }): ReactNode {
  const s = styleAttrs(element); const x = num(element, 'x'); const y = num(element, 'y');
  const color = str(styleOf(element), 'stroke', '#0A0A0A');
  const xy = pts(element).map(p => p.join(',')).join(' ');
  switch (element.kind) {
    case 'text': {const size=Math.max(8,num(element,'font_size',24)),lines=textLines(str(element,'text'),size,num(element,'width'));return <text key={element.id} x={x} y={y+size*.9} fontSize={size} fontFamily="-apple-system, BlinkMacSystemFont, sans-serif" textAnchor={str(element, 'alignment') === 'center' ? 'middle' : str(element, 'alignment') === 'right' ? 'end' : 'start'} fill={s.stroke} opacity={s.opacity} transform={s.transform}>{lines.map((line,i)=><tspan key={i} x={x} dy={i===0?0:size*1.2}>{line}</tspan>)}</text>;}
    case 'line': return <line key={element.id} x1={num(element,'x1')} y1={num(element,'y1')} x2={num(element,'x2')} y2={num(element,'y2')} {...s} />;
    case 'arrow': { const x1=num(element,'x1'), y1=num(element,'y1'), x2=num(element,'x2'), y2=num(element,'y2'); const a=Math.atan2(y2-y1,x2-x1), h=num(element,'head_size',12); const p1=`${x2-h*Math.cos(a-Math.PI/6)},${y2-h*Math.sin(a-Math.PI/6)}`; const p2=`${x2-h*Math.cos(a+Math.PI/6)},${y2-h*Math.sin(a+Math.PI/6)}`; return <g key={element.id} opacity={s.opacity} transform={s.transform}><path d={`M${x1} ${y1} L${x2} ${y2} M${p1} L${x2} ${y2} L${p2}`} fill="none" stroke={s.stroke} strokeWidth={s.strokeWidth} strokeDasharray={s.strokeDasharray}/></g>; }
    case 'rectangle': return <rect key={element.id} x={x} y={y} width={num(element,'width')} height={num(element,'height')} {...s} />;
    case 'ellipse': return <ellipse key={element.id} cx={x+num(element,'width')/2} cy={y+num(element,'height')/2} rx={num(element,'width')/2} ry={num(element,'height')/2} {...s}/>;
    case 'circle': return <circle key={element.id} cx={num(element,'cx')} cy={num(element,'cy')} r={num(element,'radius')} {...s}/>;
    case 'polygon': return <polygon key={element.id} points={xy} {...s}/>;
    case 'polyline': return <polyline key={element.id} points={xy} {...s} fill="none"/>;
    case 'freehand': {const points=pts(element);let d='';if(points.length){d=`M ${points[0][0]} ${points[0][1]}`;if(points.length<=2)d+=points.slice(1).map(p=>` L ${p[0]} ${p[1]}`).join('');else{for(let i=1;i<points.length-1;i++){const a=points[i],b=points[i+1];d+=` Q ${a[0]} ${a[1]} ${(a[0]+b[0])/2} ${(a[1]+b[1])/2}`;}const last=points[points.length-1];d+=` L ${last[0]} ${last[1]}`;}}return <path key={element.id} d={d} {...s} fill="none"/>;}
    case 'arc': { const cx=num(element,'cx'), cy=num(element,'cy'), r=Math.max(0,num(element,'radius')); return <path key={element.id} d={arcD(cx,cy,r,num(element,'start_angle'),num(element,'end_angle'),false)} {...s} fill="none"/>; }
    case 'angle_marker': { const vx=num(element,'vertex_x'), vy=num(element,'vertex_y'), r=Math.max(4,num(element,'radius',40)); const ax=num(element,'ray1_x')-vx,ay=num(element,'ray1_y')-vy,bx=num(element,'ray2_x')-vx,by=num(element,'ray2_y')-vy,al=Math.hypot(ax,ay)||1,bl=Math.hypot(bx,by)||1,a=Math.atan2(ay,ax),b=Math.atan2(by,bx); const p1=`${vx+r*ax/al} ${vy+r*ay/al}`,p2=`${vx+r*bx/bl} ${vy+r*by/bl}`; const d=element.right_angle?`M ${p1} L ${vx+r*(ax/al+bx/bl)} ${vy+r*(ay/al+by/bl)} L ${p2}`:arcD(vx,vy,r,a*180/Math.PI,b*180/Math.PI,true);return <path key={element.id} d={d} {...s} fill="none"/>; }
    case 'path': return <path key={element.id} d={str(element,'d')} fillRule={str(element,'fill_rule','nonzero') as 'nonzero'|'evenodd'} {...s}/>;
    case 'math_text': return mathImages?.[element.id]
      ? <image key={element.id} x={x+mathImages[element.id].offsetX} y={y+mathImages[element.id].offsetY} width={mathImages[element.id].width} height={mathImages[element.id].height} href={mathImages[element.id].href} opacity={s.opacity} transform={s.transform}/>
      : <foreignObject key={element.id} x={x} y={y} width={Math.max(num(element,'width'),80,num(element,'font_size',24)*12)} height={Math.max(num(element,'height'),num(element,'font_size',24)*2.2)} opacity={s.opacity} transform={s.transform}>{createElement('div',{xmlns:'http://www.w3.org/1999/xhtml',style:{color,fontSize:num(element,'font_size',24)},dangerouslySetInnerHTML:{__html:mathMarkup(str(element,'latex'),color,num(element,'font_size',24))}})}</foreignObject>;
    case 'ink_text': return <text key={element.id} x={x} y={y+num(element,'size',24)} fontFamily="Caveat, cursive" fontSize={num(element,'size',24)} fill={color} opacity={s.opacity} transform={s.transform}>{str(element,'text').split('\n').map((line,i)=><tspan key={i} x={x} dy={i===0?0:num(element,'size',24)*1.35}>{line}</tspan>)}</text>;
    case 'image': { const href=images[str(element,'blob_id')] ?? ''; return <image key={element.id} x={x} y={y} width={num(element,'width')} height={num(element,'height')} href={href} preserveAspectRatio="none" opacity={s.opacity} transform={s.transform}/>; }
    case 'svg': { const inner=rawSvgBody(str(element,'svg')); if (!inner.body) return null; const width=num(element,'width',inner.width), height=num(element,'height',inner.height); return <svg key={element.id} x={x} y={y} width={width || inner.width} height={height || inner.height} viewBox={inner.viewBox || undefined} opacity={s.opacity} transform={s.transform} dangerouslySetInnerHTML={{__html:inner.body}}/>; }
    default: return null;
  }
}

export function TutorScene({ scene, images = {}, viewBox, mathImages }: { scene: BoardScene; images?: Record<string, string>; viewBox?: string; mathImages?:Record<string,{href:string;width:number;height:number;offsetX:number;offsetY:number}> }) {
  return <svg className="board-scene" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox={viewBox} preserveAspectRatio="none">
    {scene.elements.map(element => <ElementView key={element.id} element={element} images={images} mathImages={mathImages}/>) }
  </svg>;
}

export function sceneBounds(scene: BoardScene): BoardRegion | null {
  return unionRegions(scene.elements.map(element => elementBounds(element)));
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
  const elements = scene.elements.filter(e => e.kind === 'image');
  const pairs = await Promise.all(elements.map(async element => {
    const id = str(element, 'blob_id');
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
