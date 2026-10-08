import type { BoardElement, BoardPoint } from './element-types';
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
  const pressure = Math.max(0.15, ...stroke.points.map(point => point.pressure || 0.5));
  const pad = stroke.width * pressure / 2;
  const x = Math.min(...xs) - pad; const y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) - Math.min(...xs) + pad * 2,
    height: Math.max(...ys) - Math.min(...ys) + pad * 2 };
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (((a[1] > point[1]) !== (b[1] > point[1])) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const on = (p: Point, q: Point, r: Point) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0])
    && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const c1 = cross(a, b, c), c2 = cross(a, b, d), c3 = cross(c, d, a), c4 = cross(c, d, b);
  if ((c1 === 0 && on(a, b, c)) || (c2 === 0 && on(a, b, d)) || (c3 === 0 && on(c, d, a)) || (c4 === 0 && on(c, d, b))
    || ((c1 > 0) !== (c2 > 0) && (c3 > 0) !== (c4 > 0))) return 0;
  return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b));
}

/** Whole-stroke lasso hit test; tolerance includes the rendered nib radius. */
export function strokeIntersectsPolygon(stroke: Stroke, polygon: Point[]): boolean {
  if (polygon.length < 3 || stroke.points.length === 0) return false;
  const tolerance = Math.max(0, stroke.width / 2);
  const points = stroke.points.map(p => [p.x, p.y] as Point);
  if (points.some(point => pointInPolygon(point, polygon))) return true;
  const strokeSegments: [Point, Point][] = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((point, i) => [points[i], point]);
  const lassoSegments: [Point, Point][] = polygon.map((point, i) => [point, polygon[(i + 1) % polygon.length]]);
  return strokeSegments.some(([a, b]) => lassoSegments.some(([c, d]) => segmentDistance(a, b, c, d) <= tolerance));
}

/** Shift selected learner strokes without mutating stored/history snapshots. */
export function translateStrokes(strokes: Stroke[], ids: Set<string>, delta: Point): Stroke[] {
  if (!ids.size || (!delta[0] && !delta[1])) return strokes;
  return strokes.map(stroke => ids.has(stroke.id) ? { ...stroke, points: stroke.points.map(point => ({ ...point, x: point.x + delta[0], y: point.y + delta[1] })) } : stroke);
}

export function unionRegions(regions: Array<BoardRegion | null>): BoardRegion | null {
  const valid = regions.filter((r): r is BoardRegion => !!r && Number.isFinite(r.x) && Number.isFinite(r.y)
    && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width >= 0 && r.height >= 0);
  if (!valid.length) return null;
  const x = Math.min(...valid.map(r => r.x)); const y = Math.min(...valid.map(r => r.y));
  const right = Math.max(...valid.map(r => r.x + r.width)); const bottom = Math.max(...valid.map(r => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** A percent rectangle is relative to the same padded content extent as overview(). */
export function percentRegion(extent: BoardRegion, percent: BoardRegion): BoardRegion {
  const clipped = clampPercentRegion(percent);
  return { x: extent.x + extent.width * clipped.x / 100, y: extent.y + extent.height * clipped.y / 100,
    width: extent.width * clipped.width / 100, height: extent.height * clipped.height / 100 };
}

export function clampPercentRegion(region: BoardRegion): BoardRegion {
  const x = Math.min(100, Math.max(0, region.x)), y = Math.min(100, Math.max(0, region.y));
  const right = Math.min(100, Math.max(x, region.x + region.width)), bottom = Math.min(100, Math.max(y, region.y + region.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Minimum model crop accepted by Swift's board_request region contract. */
export function clampRequestedPercentRegion(region: BoardRegion): BoardRegion {
  const x = Math.min(100, Math.max(0, region.x)), y = Math.min(100, Math.max(0, region.y));
  const width = Math.min(100, Math.max(1, region.width)), height = Math.min(100, Math.max(1, region.height));
  return { x: Math.min(x, 100 - width), y: Math.min(y, 100 - height), width, height };
}

/** Tutor selection has a screen-space minimum, independent of board zoom. */
export function selectionMeetsScreenMinimum(region: BoardRegion, zoom: number, minimum = 24): boolean {
  return region.width * zoom >= minimum && region.height * zoom >= minimum;
}

function styleValue(element: BoardElement, key: 'stroke_width' | 'rotation', fallback: number): number {
  const flat = element[key];
  const nested = element.style?.[key];
  return typeof flat === 'number' ? flat : typeof nested === 'number' ? nested : fallback;
}

function boundsForPoints(points: BoardPoint[], pad: number): BoardRegion | null {
  if (!points.length || points.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return null;
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
    width: Math.max(...xs) - Math.min(...xs) + pad * 2, height: Math.max(...ys) - Math.min(...ys) + pad * 2 };
}

/**
 * Conservative bounds for one known scene primitive. The discriminated union
 * intentionally makes adding a Swift scene kind a compile-time obligation.
 */
export function elementBounds(element: BoardElement): BoardRegion | null {
  const inset = Math.max(0, styleValue(element, 'stroke_width', 4) / 2);
  let rect: BoardRegion | null;
  switch (element.kind) {
    case 'text': {
      const size = Math.max(8, element.font_size);
      const lines = element.text.split('\n');
      const naturalWidth = Math.max(1, ...lines.map(line => line.length * size * 0.56));
      const requestedWidth = element.width ?? 0;
      const width = requestedWidth > 0 ? requestedWidth : naturalWidth;
      const lineCount = requestedWidth > 0 ? estimateWrappedLineCount(lines, size, width) : lines.length;
      rect = { x: element.x, y: element.y, width, height: Math.max(1, lineCount * size * 1.2) };
      break;
    }
    case 'line':
      rect = boundsForPoints([[element.x1, element.y1], [element.x2, element.y2]], inset);
      break;
    case 'arrow': {
      const pad = Math.max(inset, element.head_size ?? 12);
      rect = boundsForPoints([[element.x1, element.y1], [element.x2, element.y2]], pad);
      break;
    }
    case 'rectangle':
    case 'ellipse':
      rect = { x: element.x - inset, y: element.y - inset, width: element.width + inset * 2, height: element.height + inset * 2 };
      break;
    case 'circle':
      rect = { x: element.cx - element.radius - inset, y: element.cy - element.radius - inset,
        width: element.radius * 2 + inset * 2, height: element.radius * 2 + inset * 2 };
      break;
    case 'polygon':
    case 'polyline':
    case 'freehand':
      rect = boundsForPoints(element.points, inset);
      break;
    case 'arc': {
      const side = Math.max(0, element.radius) + Math.max(inset, 4);
      rect = { x: element.cx - side, y: element.cy - side, width: side * 2, height: side * 2 };
      break;
    }
    case 'angle_marker': {
      const radius = Math.max(4, element.radius ?? 40);
      if (!element.right_angle) {
        rect = { x: element.vertex_x - radius - inset, y: element.vertex_y - radius - inset,
          width: radius * 2 + inset * 2, height: radius * 2 + inset * 2 };
      } else {
        const first = normalize(element.ray1_x - element.vertex_x, element.ray1_y - element.vertex_y);
        const second = normalize(element.ray2_x - element.vertex_x, element.ray2_y - element.vertex_y);
        rect = boundsForPoints([
          [element.vertex_x + first[0] * radius, element.vertex_y + first[1] * radius],
          [element.vertex_x + (first[0] + second[0]) * radius, element.vertex_y + (first[1] + second[1]) * radius],
          [element.vertex_x + second[0] * radius, element.vertex_y + second[1] * radius],
        ], inset);
      }
      break;
    }
    case 'path': {
      const pathBox = pathBounds(element.d);
      rect = pathBox ? { x: pathBox.x - inset, y: pathBox.y - inset, width: pathBox.width + inset * 2, height: pathBox.height + inset * 2 } : null;
      break;
    }
    case 'math_text': {
      const size = Math.max(8, element.font_size);
      // KaTeX's actual result is used by capture; this is a conservative live
      // bounds estimate until its browser typesetting image is ready.
      const width = Math.max(size * 3, element.latex.length * size * 0.62);
      rect = { x: element.x, y: element.y, width, height: size * 2.2 };
      break;
    }
    case 'ink_text': {
      const size = Math.max(8, element.size ?? 24);
      const lines = element.text.split('\n');
      rect = { x: element.x, y: element.y, width: Math.max(0, ...lines.map(line => line.length * size * 0.57)), height: size * 1.35 * lines.length };
      break;
    }
    case 'image':
      rect = { x: element.x, y: element.y, width: element.width, height: element.height };
      break;
    case 'svg': {
      const dimensions = svgDimensions(element.svg);
      const width = element.width && element.width > 0 ? element.width : dimensions?.width ?? 0;
      const height = element.height && element.height > 0 ? element.height : dimensions?.height ?? 0;
      rect = width > 0 && height > 0 ? { x: element.x, y: element.y, width, height } : null;
      break;
    }
    default:
      return assertNever(element);
  }
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const rotation = styleValue(element, 'rotation', 0);
  if (!rotation) return rect;
  // Swift deliberately returns a conservative square around the element's
  // rotated center, so drawing cache bounds and capture bounds cannot clip.
  const side = Math.hypot(rect.width, rect.height), cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  return { x: cx - side / 2, y: cy - side / 2, width: side, height: side };
}

function assertNever(value: never): never { throw new Error(`Unsupported board element: ${JSON.stringify(value)}`); }

function normalize(x: number, y: number): Point {
  const length = Math.hypot(x, y) || 1;
  return [x / length, y / length];
}

function estimateWrappedLineCount(lines: string[], fontSize: number, width: number): number {
  const measure = (text: string) => typeof document !== 'undefined'
    ? (() => { const ctx = document.createElement('canvas').getContext('2d'); if (!ctx) return text.length * fontSize * 0.56; ctx.font = `${fontSize}px sans-serif`; return ctx.measureText(text).width; })()
    : text.length * fontSize * 0.56;
  return lines.reduce((count, paragraph) => {
    let countForLine = 1, line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > width) { countForLine++; line = word; } else line = next;
    }
    return count + countForLine;
  }, 0);
}

function svgDimensions(markup: string): { width: number; height: number } | null {
  const root = typeof DOMParser !== 'undefined' ? new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement : null;
  if (root && root.localName !== 'svg') return null;
  const viewBoxText = root?.getAttribute('viewBox') ?? /<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/i.exec(markup)?.[1] ?? '';
  const viewBox = viewBoxText.trim().split(/[ ,]+/).map(Number);
  const widthText = root?.getAttribute('width') ?? /<svg\b[^>]*\bwidth\s*=\s*["']([^"']+)["']/i.exec(markup)?.[1] ?? null;
  const heightText = root?.getAttribute('height') ?? /<svg\b[^>]*\bheight\s*=\s*["']([^"']+)["']/i.exec(markup)?.[1] ?? null;
  const width = parseSvgLength(widthText) || (viewBox.length === 4 ? viewBox[2] : 0);
  const height = parseSvgLength(heightText) || (viewBox.length === 4 ? viewBox[3] : 0);
  return width > 0 && height > 0 ? { width, height } : null;
}

function parseSvgLength(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pathBounds(data: string): BoardRegion | null {
  if (typeof document !== 'undefined') {
    try {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', data); svg.append(path); document.body.append(svg);
      const box = path.getBBox(); svg.remove();
      if ([box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0) {
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }
      svg.remove();
    } catch { /* Fall back to control/end point bounds below. */ }
  }
  // A fallback for SSR/tests and environments without SVG getBBox. Include
  // Bézier control points, which safely overbounds their actual curves.
  const nums = data.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  if (nums.length < 2) return null;
  const points: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
  return boundsForPoints(points, 0);
}
