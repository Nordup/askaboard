import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { BoardRegion, BoardScene, Stroke } from '../types';
import { strokeBounds, unionRegions, percentRegion, clampPercentRegion } from './geometry';
import { loadSceneImages, rasterizeMathElements, sceneBounds, sceneCaptureStyles, TutorScene, type MathRaster } from './scene';

const PAD = 24;
export const OVERVIEW_MAX_SIDE = 900;

function inkPath(stroke: Stroke): string {
  if (!stroke.points.length) return '';
  const pts = stroke.points;
  const opacity = stroke.tool === 'highlighter' ? 0.3 : 1;
  if (pts.length === 1) {
    const p = pts[0]; return `<circle cx="${p.x}" cy="${p.y}" r="${stroke.width*Math.max(.15,p.pressure)/2}" fill="${escapeAttr(stroke.color)}" opacity="${opacity}"/>`;
  }
  // Preserve the tablet's pressure contour with per-segment round-capped vectors.
  return `<g fill="none" stroke="${escapeAttr(stroke.color)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}">${pts.slice(1).map((p,i)=>{
    const a=pts[i]; const pressure=Math.max(.15,Math.min(1,(a.pressure+p.pressure)/2));
    return `<path d="M ${a.x} ${a.y} L ${p.x} ${p.y}" stroke-width="${stroke.width*pressure}"/>`;
  }).join('')}</g>`;
}
const escapeAttr = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));

export function boardExtent(strokes: Stroke[], scene: BoardScene, mathImages: Record<string, MathRaster> = {}): BoardRegion | null {
  const union = unionRegions([...strokes.map(strokeBounds), sceneBounds(scene, mathImages)]);
  if (!union) return null;
  return { x: union.x-PAD, y: union.y-PAD, width: Math.max(1,union.width+PAD*2), height: Math.max(1,union.height+PAD*2) };
}

/** Choose the exact logical tutor marquee or a percent-addressed model crop. */
export function captureCrop(bounds: BoardRegion, percent?: BoardRegion, logicalCrop?: BoardRegion): BoardRegion {
  if (logicalCrop) return { ...logicalCrop };
  return percent ? percentRegion(bounds, clampPercentRegion(percent)) : bounds;
}

function dimensions(region: BoardRegion, maxSide = 2_000) {
  const scale = Math.min(2, maxSide / Math.max(region.width, region.height));
  return { width: Math.max(1,Math.ceil(region.width*scale)), height: Math.max(1,Math.ceil(region.height*scale)) };
}

async function composedSvg(strokes: Stroke[], scene: BoardScene, region: BoardRegion, maxSide = 2_000, mathImages?: Record<string, MathRaster>): Promise<string> {
  await document.fonts?.ready;
  const [images,resolvedMathImages] = await Promise.all([loadSceneImages(scene),mathImages ? Promise.resolve(mathImages) : rasterizeMathElements(scene)]);
  const dims = dimensions(region,maxSide);
  // Rasterized KaTeX keeps its real browser layout without foreignObject,
  // which taints Chromium's canvas and makes PNG export fail.
  const renderedScene = renderToStaticMarkup(createElement(TutorScene,{scene,images,mathImages:resolvedMathImages}));
  const sceneMarkup = renderedScene.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'');
  const ink = strokes.map(inkPath).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${dims.width}" height="${dims.height}" viewBox="${region.x} ${region.y} ${region.width} ${region.height}"><style>${await sceneCaptureStyles(scene)}</style><rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="#fff"/><g>${sceneMarkup}</g><g>${ink}</g></svg>`;
}

async function raster(svg: string): Promise<string> {
  const img = new Image(); const url = URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
  try { img.src=url; await img.decode(); const scale = Math.min(1,2000/Math.max(img.naturalWidth,img.naturalHeight));
    const canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.ceil(img.naturalWidth*scale)); canvas.height=Math.max(1,Math.ceil(img.naturalHeight*scale));
    const ctx=canvas.getContext('2d'); if(!ctx) throw new Error('Could not create board capture'); ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/png').split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}

/** Export exact vectors from the shared live scene/ink data, in logical coordinates. */
export async function captureBoard(strokes: Stroke[], scene: BoardScene, region?: BoardRegion, frozenBounds?:BoardRegion|null, maxSide = 2_000, logicalCrop?:BoardRegion): Promise<{image_base64:string;region:BoardRegion;bounds:BoardRegion}> {
  const mathImages = await rasterizeMathElements(scene);
  const bounds=(region&&frozenBounds)?frozenBounds:boardExtent(strokes,scene,mathImages); if(!bounds) throw new Error('There is no board content to capture yet.');
  const normalized=region ? clampPercentRegion(region) : {x:0,y:0,width:100,height:100};
  const selected=captureCrop(bounds,region ? normalized : undefined,logicalCrop);
  if(selected.width<=0||selected.height<=0)throw new Error('Select a region with non-zero width and height.');
  return {image_base64:await raster(await composedSvg(strokes,scene,selected,maxSide,mathImages)),region:normalized,bounds};
}

/** Small aimable image used on every turn; percentages are normalized to its frozen logical extent. */
export async function overviewBoard(strokes: Stroke[], scene: BoardScene): Promise<string> {
  return (await overviewBoardResult(strokes,scene)).image_base64;
}

export async function overviewBoardResult(strokes: Stroke[], scene: BoardScene): Promise<{image_base64:string;bounds:BoardRegion|null}> {
  const mathImages=await rasterizeMathElements(scene),bounds=boardExtent(strokes,scene,mathImages);
  if(!bounds)return{image_base64:'',bounds:null};
  return{image_base64:await raster(await composedSvg(strokes,scene,bounds,OVERVIEW_MAX_SIDE,mathImages)),bounds};
}

export function selectionAsPercent(selection: BoardRegion,bounds:BoardRegion):BoardRegion {
  return clampPercentRegion({x:(selection.x-bounds.x)*100/bounds.width,y:(selection.y-bounds.y)*100/bounds.height,
    width:selection.width*100/bounds.width,height:selection.height*100/bounds.height});
}
