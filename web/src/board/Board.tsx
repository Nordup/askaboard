import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BoardHandle, BoardProps, BoardRegion, Camera, InkPoint, Point, Stroke } from '../types';
import { BoardHistory } from './history';
import { boardToScreen, clampRequestedPercentRegion, DEFAULT_CENTER, screenToBoard, selectionMeetsScreenMinimum, strokeBounds, strokeIntersectsPolygon, translateStrokes, unionRegions, zoomAt } from './geometry';
import { boardExtent, captureBoard, overviewBoardResult, selectionAsPercent } from './capture';
import { loadSceneImages, rasterizeMathElements, sceneBounds, TutorScene, type MathRaster } from './scene';
import { boardKeyAction, canHandleBoardShortcut, copySelectedStrokes, duplicateStrokes, hasInkClipboard, pasteStrokes, readInkClipboard, removeSelectedStrokes, writeInkClipboard, type BoardKeyAction } from './clipboard';
import './board.css';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cssPoint = (e: { clientX: number; clientY: number }, rect: DOMRect): Point => [e.clientX - rect.left, e.clientY - rect.top];
const distanceToSegment = (p: Point, a: Point, b: Point) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], d = dx * dx + dy * dy;
  const t = d ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

function paintInk(canvas: HTMLCanvasElement | null, strokes: Stroke[], viewport: Point, camera: Camera) {
  if (!canvas) return;
  const [width, height] = viewport, dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d'); if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
  context.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom,
    dpr * (width / 2 - camera.center[0] * camera.zoom), dpr * (height / 2 - camera.center[1] * camera.zoom));
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    context.globalAlpha = stroke.tool === 'highlighter' ? 0.3 : 1;
    context.strokeStyle = stroke.color; context.fillStyle = stroke.color;
    context.lineCap = 'round'; context.lineJoin = 'round';
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      context.beginPath(); context.arc(point.x, point.y, stroke.width * Math.max(0.15, point.pressure) / 2, 0, Math.PI * 2); context.fill();
      continue;
    }
    for (let i = 1; i < stroke.points.length; i++) {
      const a = stroke.points[i - 1], b = stroke.points[i];
      context.beginPath(); context.lineWidth = stroke.width * Math.max(0.15, (a.pressure + b.pressure) / 2);
      context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
    }
  }
  context.globalAlpha = 1;
}

type DragKind = 'pan' | 'tutor-selection' | 'lasso' | 'move' | 'ink' | 'erase';
interface DragState {
  kind: DragKind;
  pointerId: number;
  start: Point;
  last: Point;
  startBoard: Point;
  startCamera: Camera;
  points: Point[];
  startStrokes?: Stroke[];
  startSelection?: BoardRegion | null;
  startSelectedIds?: string[];
  changed?: boolean;
}

function logicalRect(a: Point, b: Point): BoardRegion {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
}

interface InkMenuPosition { x: number; y: number; }
const inkMenuHeight = 5 * 40 + 18;
function menuPosition(client: Point): InkMenuPosition {
  return { x: Math.max(8, Math.min(client[0], window.innerWidth - 172)), y: Math.max(8, Math.min(client[1], window.innerHeight - inkMenuHeight - 8)) };
}

/** Paper's board surface: native tutor scene beneath portable learner ink. */
export const Board = forwardRef<BoardHandle, BoardProps>(function Board({
  workspace, tool, color, width, selectionMode, onChange, onSelection, onHistoryChange, onError,
}, ref) {
  const hostRef = useRef<HTMLDivElement>(null), inkRef = useRef<HTMLCanvasElement>(null), activeInkRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef(workspace.strokes), sceneRef = useRef(workspace.scene), cameraRef = useRef<Camera>(workspace.camera), persistedCameraRef = useRef<Camera>(workspace.camera);
  const activeRef = useRef<Stroke | null>(null), dragRef = useRef<DragState | null>(null);
  const historyRef = useRef(new BoardHistory()); const selectedIdsRef = useRef<string[]>([]);
  const firstInkMenuItem = useRef<HTMLButtonElement>(null);
  const pasteAnchorRef = useRef<Point | null>(null);
  const spaceRef = useRef(false);
  const [strokes, setStrokes] = useState(workspace.strokes), [camera, setCamera] = useState<Camera>(workspace.camera);
  const [viewport, setViewport] = useState<Point>([1, 1]);
  const [lassoPreview, setLassoPreview] = useState<Point[] | null>(null);
  const [tutorRegion, setTutorRegion] = useState<BoardRegion | null>(null);
  const [tutorPreview, setTutorPreview] = useState<BoardRegion | null>(null);
  const [selectionBounds, setSelectionBounds] = useState<BoardRegion | null>(null);
  const [inkMenu, setInkMenu] = useState<InkMenuPosition | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [mathImages, setMathImages] = useState<Record<string, MathRaster>>({});
  const mathImagesRef = useRef<Record<string, MathRaster>>({});
  const boundsRef = useRef<BoardRegion | null>(null);
  const wheelPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange), onSelectionRef = useRef(onSelection), onHistoryChangeRef = useRef(onHistoryChange), onErrorRef = useRef(onError);
  onChangeRef.current = onChange; onSelectionRef.current = onSelection; onHistoryChangeRef.current = onHistoryChange; onErrorRef.current = onError;

  const notifyHistory = useCallback(() => onHistoryChangeRef.current(historyRef.current.availability), []);
  const commitCamera = useCallback((next: Camera) => {
    if (same(next, persistedCameraRef.current)) return;
    cameraRef.current = next; persistedCameraRef.current = next; setCamera(next); onChangeRef.current({ camera: next });
  }, []);
  const setCameraTransient = useCallback((next: Camera) => {
    cameraRef.current = next; setCamera(next);
  }, []);
  const redraw = useCallback(() => paintInk(inkRef.current, strokesRef.current, viewport, cameraRef.current), [viewport, strokes, camera]);
  const redrawActive = useCallback(() => paintInk(activeInkRef.current, activeRef.current ? [activeRef.current] : [], viewport, cameraRef.current), [viewport, camera]);
  useEffect(() => { redraw(); redrawActive(); }, [redraw, redrawActive]);
  useEffect(() => { notifyHistory(); }, [notifyHistory]);

  useEffect(() => {
    if (!same(workspace.strokes, strokesRef.current)) {
      strokesRef.current = workspace.strokes; setStrokes(workspace.strokes); historyRef.current.clear(); notifyHistory();
      selectedIdsRef.current = []; setSelectionBounds(null); boundsRef.current = null;
    }
  }, [workspace.strokes, notifyHistory]);
  useEffect(() => {
    sceneRef.current = workspace.scene; boundsRef.current = null;
    setImages({}); setMathImages({}); mathImagesRef.current = {};
    let current = true;
    void Promise.all([loadSceneImages(workspace.scene), rasterizeMathElements(workspace.scene)]).then(([value, math]) => {
      if (!current) return;
      setImages(value); setMathImages(math); mathImagesRef.current = math; boundsRef.current = null;
    }).catch(error => {
      if (current) onErrorRef.current(error instanceof Error ? error.message : 'Tutor board content could not be rendered.');
    });
    return () => { current = false; };
  }, [workspace.scene]);
  useEffect(() => {
    if (!same(workspace.camera, persistedCameraRef.current)) {
      persistedCameraRef.current = workspace.camera; cameraRef.current = workspace.camera; setCamera(workspace.camera);
    }
  }, [workspace.camera]);
  useEffect(() => {
    const host = hostRef.current; if (!host) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) setViewport([Math.max(1, rect.width), Math.max(1, rect.height)]);
    });
    observer.observe(host); return () => observer.disconnect();
  }, []);
  useEffect(() => () => {
    if (wheelPersistRef.current) { clearTimeout(wheelPersistRef.current); wheelPersistRef.current = null; commitCamera(cameraRef.current); }
  }, [commitCamera]);

  const clearInkSelection = useCallback((notifyTutor = false) => {
    selectedIdsRef.current = []; setSelectionBounds(null); setInkMenu(null);
    if (notifyTutor) { setTutorRegion(null); setTutorPreview(null); onSelectionRef.current(null); }
  }, []);

  const commitStrokes = useCallback((next: Stroke[], snapshot = strokesRef.current) => {
    if (same(snapshot, next)) return;
    historyRef.current.record(snapshot); notifyHistory();
    strokesRef.current = next; setStrokes(next); boundsRef.current = null;
    onChangeRef.current({ strokes: next });
  }, [notifyHistory]);

  const removeAt = useCallback((point: Point, radius: number) => {
    const boardPoint = screenToBoard(point, viewport, cameraRef.current);
    const kept = strokesRef.current.filter(stroke => {
      const points = stroke.points;
      for (let i = 0; i < points.length; i++) {
        const current: Point = [points[i].x, points[i].y];
        if (Math.hypot(current[0] - boardPoint[0], current[1] - boardPoint[1]) <= radius + stroke.width / 2
          || (i > 0 && distanceToSegment(boardPoint, [points[i - 1].x, points[i - 1].y], current) <= radius + stroke.width / 2)) return false;
      }
      return true;
    });
    if (!same(kept, strokesRef.current)) {
      strokesRef.current = kept; setStrokes(kept); boundsRef.current = null; clearInkSelection();
      if (dragRef.current) dragRef.current.changed = true;
    }
  }, [viewport, clearInkSelection]);

  // The source uses PencilKit's vector eraser, whose radius is independent of pen thickness.
  const eraseRadius = () => 14;

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const penEraser = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0);
    if (event.button === 2 && !penEraser) return;
    const host = hostRef.current; if (!host) return;
    host.focus({ preventScroll: true });
    const screen = cssPoint(event, host.getBoundingClientRect()), startBoard = screenToBoard(screen, viewport, cameraRef.current);
    pasteAnchorRef.current = startBoard;
    const shouldPan = !selectionMode && !penEraser && (event.button === 1 || spaceRef.current || event.pointerType === 'touch');
    const selectedBounds = selectionBounds;
    const selectedTopLeft = selectedBounds ? boardToScreen([selectedBounds.x, selectedBounds.y], viewport, cameraRef.current) : null;
    const inInkSelection = Boolean(selectedIdsRef.current.length && selectedTopLeft && selectedBounds
      && screen[0] >= selectedTopLeft[0] - 8 && screen[0] <= selectedTopLeft[0] + selectedBounds.width * cameraRef.current.zoom + 8
      && screen[1] >= selectedTopLeft[1] - 8 && screen[1] <= selectedTopLeft[1] + selectedBounds.height * cameraRef.current.zoom + 8);
    const kind: DragKind = selectionMode ? 'tutor-selection'
      : shouldPan ? 'pan'
        : penEraser || tool === 'eraser' ? 'erase'
          : tool === 'lasso' ? (inInkSelection ? 'move' : 'lasso') : 'ink';
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer capture may be unavailable. */ }
    dragRef.current = {
      kind, pointerId: event.pointerId, start: screen, last: screen, startBoard, startCamera: cameraRef.current,
      points: [screen], startStrokes: kind === 'move' || kind === 'erase' ? strokesRef.current : undefined,
      startSelection: selectedBounds, startSelectedIds: [...selectedIdsRef.current],
    };
    event.preventDefault();
    if (kind === 'ink') {
      const pressure = event.pointerType === 'mouse' ? 1 : (event.pressure > 0 ? event.pressure : 0.5);
      const highlighter = tool === 'highlighter';
      const baseWidth = [2.5, 5, 10].reduce((nearest, candidate) => Math.abs(candidate - width) < Math.abs(nearest - width) ? candidate : nearest, 5);
      activeRef.current = { id: crypto.randomUUID(), tool: highlighter ? 'highlighter' : 'pen', color,
        width: baseWidth * (highlighter ? 4 : 1), points: [{ x: startBoard[0], y: startBoard[1], pressure, time: Date.now() }] };
      redrawActive();
    } else if (kind === 'erase') removeAt(screen, eraseRadius() / cameraRef.current.zoom);
    else if (kind === 'tutor-selection') setTutorPreview(logicalRect(startBoard, startBoard));
    else if (kind === 'lasso') setLassoPreview([screen]);
  };

  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current, host = hostRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !host) return;
    const rect = host.getBoundingClientRect(), screen = cssPoint(event, rect);
    const delta: Point = [screen[0] - drag.last[0], screen[1] - drag.last[1]]; drag.last = screen;
    if (drag.kind === 'pan') {
      const current = cameraRef.current;
      setCameraTransient({ ...current, center: [current.center[0] - delta[0] / current.zoom, current.center[1] - delta[1] / current.zoom] });
    } else if (drag.kind === 'ink' && activeRef.current) {
      const samples = typeof event.nativeEvent.getCoalescedEvents === 'function' ? event.nativeEvent.getCoalescedEvents() : [];
      for (const sample of samples.length ? samples : [event.nativeEvent]) {
        const sampleScreen = cssPoint(sample, rect), point = screenToBoard(sampleScreen, viewport, cameraRef.current);
        activeRef.current.points.push({ x: point[0], y: point[1], pressure: event.pointerType === 'mouse' ? 1 : (sample.pressure > 0 ? sample.pressure : 0.5), time: Date.now() });
      }
      redrawActive();
    } else if (drag.kind === 'erase') removeAt(screen, eraseRadius() / cameraRef.current.zoom);
    else if (drag.kind === 'move' && drag.startStrokes) {
      const boardDelta: Point = [(screen[0] - drag.start[0]) / cameraRef.current.zoom, (screen[1] - drag.start[1]) / cameraRef.current.zoom];
      const moved = translateStrokes(drag.startStrokes, new Set(selectedIdsRef.current), boardDelta);
      drag.changed = drag.changed || boardDelta[0] !== 0 || boardDelta[1] !== 0;
      strokesRef.current = moved; setStrokes(moved); boundsRef.current = null;
      setSelectionBounds(unionRegions(moved.filter(stroke => selectedIdsRef.current.includes(stroke.id)).map(strokeBounds)));
    } else if (drag.kind === 'tutor-selection') {
      const currentBoard = screenToBoard(screen, viewport, cameraRef.current);
      setTutorPreview(logicalRect(drag.startBoard, currentBoard));
    } else if (drag.kind === 'lasso') {
      drag.points.push(screen); setLassoPreview([...drag.points]);
    }
    event.preventDefault();
  };

  async function ensureBounds() {
    const current = await captureBoard(strokesRef.current, sceneRef.current);
    boundsRef.current = current.bounds; return current.bounds;
  }

  const attachTutorRegion = async (region: BoardRegion) => {
    try {
      const bounds = boundsRef.current ?? await ensureBounds();
      const capture = await captureBoard(strokesRef.current, sceneRef.current, selectionAsPercent(region, bounds), bounds, 2_000, region);
      setTutorRegion(region); onSelectionRef.current(capture);
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : 'Could not capture that board region.');
    }
  };

  const pointerUp = async (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const host = hostRef.current, screen = host ? cssPoint(event, host.getBoundingClientRect()) : drag.last;
    dragRef.current = null;
    if (drag.kind === 'ink' && activeRef.current) {
      const stroke = activeRef.current, endpoint = screenToBoard(screen, viewport, cameraRef.current), last = stroke.points[stroke.points.length - 1];
      if (last.x !== endpoint[0] || last.y !== endpoint[1]) stroke.points.push({ x: endpoint[0], y: endpoint[1], pressure: event.pointerType === 'mouse' ? 1 : (event.pressure > 0 ? event.pressure : 0.5), time: Date.now() });
      activeRef.current = null; commitStrokes([...strokesRef.current, stroke]);
    } else if (drag.kind === 'pan') commitCamera(cameraRef.current);
    else if (drag.kind === 'erase' && drag.changed && drag.startStrokes) commitStrokes(strokesRef.current, drag.startStrokes);
    else if (drag.kind === 'move' && drag.changed && drag.startStrokes) commitStrokes(strokesRef.current, drag.startStrokes);
    else if (drag.kind === 'tutor-selection') {
      const currentBoard = screenToBoard(screen, viewport, cameraRef.current), region = logicalRect(drag.startBoard, currentBoard);
      setTutorPreview(null);
      if (selectionMeetsScreenMinimum(region, cameraRef.current.zoom)) await attachTutorRegion(region);
    } else if (drag.kind === 'lasso' && drag.points.length >= 3) {
      const polygon = drag.points.map(point => screenToBoard(point, viewport, cameraRef.current));
      const selected = strokesRef.current.filter(stroke => strokeIntersectsPolygon(stroke, polygon));
      selectedIdsRef.current = selected.map(stroke => stroke.id);
      setSelectionBounds(unionRegions(selected.map(strokeBounds)));
    }
    setLassoPreview(null); redrawActive();
  };

  const pointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null; activeRef.current = null;
    if ((drag.kind === 'move' || drag.kind === 'erase') && drag.startStrokes) {
      strokesRef.current = drag.startStrokes; setStrokes(drag.startStrokes); boundsRef.current = null;
    }
    if (drag.kind === 'move' || drag.kind === 'lasso') {
      selectedIdsRef.current = drag.startSelectedIds ?? []; setSelectionBounds(drag.startSelection ?? null);
    }
    if (drag.kind === 'pan') setCameraTransient(drag.startCamera);
    setTutorPreview(null); setLassoPreview(null); redrawActive();
  };

  const centerOnContent = useCallback(() => {
    const content = unionRegions([unionRegions(strokesRef.current.map(strokeBounds)), sceneBounds(sceneRef.current, mathImagesRef.current)]);
    const center = content ? [content.x + content.width / 2, content.y + content.height / 2] as Point : DEFAULT_CENTER;
    commitCamera({ ...cameraRef.current, center });
  }, [commitCamera]);

  const undo = useCallback(() => {
    const previous = historyRef.current.undo(strokesRef.current); if (!previous) return;
    strokesRef.current = previous; setStrokes(previous); boundsRef.current = null; clearInkSelection();
    onChangeRef.current({ strokes: previous }); notifyHistory();
  }, [clearInkSelection, notifyHistory]);
  const redo = useCallback(() => {
    const next = historyRef.current.redo(strokesRef.current); if (!next) return;
    strokesRef.current = next; setStrokes(next); boundsRef.current = null; clearInkSelection();
    onChangeRef.current({ strokes: next }); notifyHistory();
  }, [clearInkSelection, notifyHistory]);
  const clear = useCallback(() => {
    if (!strokesRef.current.length) return;
    commitStrokes([]); clearInkSelection();
  }, [clearInkSelection, commitStrokes]);

  const focusBoardAfterMenu = () => requestAnimationFrame(() => hostRef.current?.focus({ preventScroll: true }));
  const applyInkAction = useCallback((action: BoardKeyAction, fromMenu = false) => {
    const ids = [...selectedIdsRef.current];
    if (action === 'undo') undo();
    else if (action === 'redo') redo();
    else if (action === 'copy' || action === 'cut') {
      const copied = copySelectedStrokes(strokesRef.current, ids);
      if (copied.length) writeInkClipboard(copied);
      if (action === 'cut' && copied.length) {
        commitStrokes(removeSelectedStrokes(strokesRef.current, ids)); clearInkSelection();
      }
    } else if (action === 'delete') {
      commitStrokes(removeSelectedStrokes(strokesRef.current, ids)); clearInkSelection();
    } else if (action === 'duplicate') {
      const result = duplicateStrokes(strokesRef.current, ids);
      if (result.insertedIds.length) {
        commitStrokes(result.strokes); selectedIdsRef.current = result.insertedIds;
        setSelectionBounds(unionRegions(result.strokes.filter(stroke => result.insertedIds.includes(stroke.id)).map(strokeBounds)));
      }
    } else if (action === 'paste') {
      const anchor = pasteAnchorRef.current ?? cameraRef.current.center;
      const result = pasteStrokes(strokesRef.current, readInkClipboard(), anchor);
      if (result.insertedIds.length) {
        commitStrokes(result.strokes); selectedIdsRef.current = result.insertedIds;
        setSelectionBounds(unionRegions(result.strokes.filter(stroke => result.insertedIds.includes(stroke.id)).map(strokeBounds)));
        pasteAnchorRef.current = null;
      }
    }
    if (fromMenu) { setInkMenu(null); focusBoardAfterMenu(); }
  }, [clearInkSelection, commitStrokes, redo, undo]);

  const showInkMenu = (client: Point, boardPoint: Point) => {
    if (!selectedIdsRef.current.length) return;
    pasteAnchorRef.current = boardPoint;
    setInkMenu(menuPosition(client));
  };
  useEffect(() => { if (inkMenu) firstInkMenuItem.current?.focus(); }, [inkMenu]);

  const boardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const host = event.currentTarget;
    const boardOwnsFocus = document.activeElement === host && event.target === host;
    const boardVisible = host.getClientRects().length > 0 && getComputedStyle(host).pointerEvents !== 'none'
      && !host.closest('[aria-hidden="true"]');
    if (!canHandleBoardShortcut(target, boardOwnsFocus, Boolean(inkMenu), boardVisible)) return;
    if (event.key === 'Escape' && (selectionMode || tutorRegion || selectedIdsRef.current.length || dragRef.current)) {
      event.preventDefault(); event.stopPropagation();
      const drag = dragRef.current;
      if (drag?.startStrokes && (drag.kind === 'move' || drag.kind === 'erase')) { strokesRef.current = drag.startStrokes; setStrokes(drag.startStrokes); }
      if (drag?.kind === 'pan') setCameraTransient(drag.startCamera);
      dragRef.current = null; activeRef.current = null; setTutorPreview(null); setLassoPreview(null);
      selectedIdsRef.current = []; setSelectionBounds(null); setTutorRegion(null); onSelectionRef.current(null); redrawActive();
      return;
    }
    const action = boardKeyAction(event.nativeEvent, { hasSelection: selectedIdsRef.current.length > 0, hasClipboard: hasInkClipboard() });
    if (action) { event.preventDefault(); applyInkAction(action); }
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const bounds = selectionBounds;
      const screen = bounds ? boardToScreen([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], viewport, cameraRef.current) : [viewport[0] / 2, viewport[1] / 2] as Point;
      const rect = hostRef.current?.getBoundingClientRect();
      if (rect) showInkMenu([rect.left + screen[0], rect.top + screen[1]], screen);
    }
  };

  useImperativeHandle(ref, () => ({
    async capture(region?: BoardRegion) {
      const requested = region ? clampRequestedPercentRegion(region) : undefined;
      const captured = await captureBoard(strokesRef.current, sceneRef.current, requested, boundsRef.current, 1_536);
      boundsRef.current = captured.bounds; return { image_base64: captured.image_base64, region: captured.region };
    },
    async overview() {
      const result = await overviewBoardResult(strokesRef.current, sceneRef.current);
      boundsRef.current = result.bounds; return result.image_base64;
    },
    context() {
      const bounds = boundsRef.current, ink = unionRegions(strokesRef.current.map(strokeBounds)), cam = cameraRef.current;
      const visible = { x: cam.center[0] - viewport[0] / cam.zoom / 2, y: cam.center[1] - viewport[1] / cam.zoom / 2,
        width: viewport[0] / cam.zoom, height: viewport[1] / cam.zoom };
      const box = (region: BoardRegion) => [region.x, region.y, region.x + region.width, region.y + region.height];
      const inset = visible.width * 0.06;
      const tutor = { x: visible.x + inset, y: visible.y + visible.height * 0.06, width: visible.width - 2 * inset, height: visible.height * 0.44 };
      const learner = { x: visible.x + inset, y: visible.y + visible.height * 0.58, width: visible.width - 2 * inset, height: visible.height * 0.36 };
      const clusters: Array<{ box: BoardRegion; count: number; newest: number }> = [];
      for (const stroke of strokesRef.current) {
        const region = strokeBounds(stroke); if (!region) continue;
        const index = clusters.findIndex(cluster => cluster.box.x - 600 < region.x + region.width && cluster.box.x + cluster.box.width + 600 > region.x
          && cluster.box.y - 600 < region.y + region.height && cluster.box.y + cluster.box.height + 600 > region.y);
        const newest = Math.max(...stroke.points.map(point => point.time));
        if (index < 0) clusters.push({ box: region, count: 1, newest });
        else { const current = clusters[index]; clusters[index] = { box: unionRegions([current.box, region])!, count: current.count + 1, newest: Math.max(current.newest, newest) }; }
      }
      const content = bounds ?? boardExtent(strokesRef.current, sceneRef.current, mathImagesRef.current);
      return JSON.stringify({ kind: 'board_scene_context', data_not_instructions: true,
        coordinate_system: 'logical board points; (0,0) is drawing (25000,25000); +x right, +y down',
        visible_logical_rect: box(visible), recommended_tutor_rect: box(tutor), reserved_learner_work_rect: box(learner),
        ...(content ? { overview_logical_bounds: box(content) } : {}),
        ...(ink ? { learner_ink_logical_bounds: box(ink), learner_ink_clusters: clusters.map(cluster => ({ logical_box: box(cluster.box), strokes: cluster.count, newest_unix: cluster.newest / 1000 })) } : {}),
        tutor_elements: sceneRef.current.elements });
    },
    fit: centerOnContent, undo, redo, clear,
  }), [viewport, centerOnContent, undo, redo, clear]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const host = hostRef.current;
      if (event.code === 'Space' && host && document.activeElement === host && getComputedStyle(host).pointerEvents !== 'none') {
        spaceRef.current = true; event.preventDefault();
      }
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') spaceRef.current = false; };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  useEffect(() => {
    const host = hostRef.current; if (!host) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); if (selectionMode) return;
      const point = cssPoint(event, host.getBoundingClientRect()), current = cameraRef.current;
      const next = event.ctrlKey || event.metaKey
        ? zoomAt(current, point, viewport, current.zoom * Math.exp(-event.deltaY * 0.002))
        : { ...current, center: [current.center[0] + event.deltaX / current.zoom, current.center[1] + event.deltaY / current.zoom] as Point };
      setCameraTransient(next);
      if (wheelPersistRef.current) clearTimeout(wheelPersistRef.current);
      wheelPersistRef.current = setTimeout(() => { wheelPersistRef.current = null; commitCamera(cameraRef.current); }, 160);
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, [viewport, selectionMode, setCameraTransient, commitCamera]);

  useEffect(() => {
    if (selectionMode) return;
    setTutorPreview(null);
    if (tutorRegion) { setTutorRegion(null); onSelectionRef.current(null); }
  }, [selectionMode, tutorRegion]);

  const viewBox = `${camera.center[0] - viewport[0] / camera.zoom / 2} ${camera.center[1] - viewport[1] / camera.zoom / 2} ${viewport[0] / camera.zoom} ${viewport[1] / camera.zoom}`;
  const visibleTutorRegion = tutorPreview ?? (selectionMode ? tutorRegion : null);
  const tutorScreen = visibleTutorRegion ? boardToScreen([visibleTutorRegion.x, visibleTutorRegion.y], viewport, camera) : null;
  const lassoActive = dragRef.current?.kind === 'lasso';
  const inkSelectionScreen = selectionBounds ? boardToScreen([selectionBounds.x, selectionBounds.y], viewport, camera) : null;

  return <>
  <div ref={hostRef} className="board-surface" tabIndex={0} onKeyDown={boardKeyDown} onPointerDown={pointerDown} onPointerMove={pointerMove}
    onPointerUp={pointerUp} onPointerCancel={pointerCancel} onContextMenu={event => {
      event.preventDefault();
      const host = hostRef.current; if (!host || !selectedIdsRef.current.length) return;
      const screen = cssPoint(event, host.getBoundingClientRect());
      showInkMenu([event.clientX, event.clientY], screenToBoard(screen, viewport, cameraRef.current));
    }} data-board-tool={selectionMode ? 'selection' : tool}
    data-testid="board-surface" aria-label="Learning board">
    <TutorScene scene={workspace.scene} images={images} mathImages={mathImages} viewBox={viewBox} />
    <canvas className="board-ink" ref={inkRef} aria-label="Learning whiteboard" />
    <canvas className="board-active-ink" ref={activeInkRef} aria-hidden="true" />
    {lassoActive && <svg className="board-lasso" viewBox={`0 0 ${viewport[0]} ${viewport[1]}`} aria-hidden="true">
      <polyline points={dragRef.current!.points.map(point => point.join(',')).join(' ')} />
    </svg>}
    {visibleTutorRegion && tutorScreen && <div className="board-marquee board-marquee--tutor" data-testid="tutor-selection-region"
      style={{ left: tutorScreen[0], top: tutorScreen[1], width: visibleTutorRegion.width * camera.zoom, height: visibleTutorRegion.height * camera.zoom }} />}
    {selectionBounds && selectedIdsRef.current.length > 0 && inkSelectionScreen && <div className="board-marquee" data-testid="ink-selection-bounds"
      style={{ left: inkSelectionScreen[0], top: inkSelectionScreen[1], width: selectionBounds.width * camera.zoom, height: selectionBounds.height * camera.zoom }} />}
  </div>
  {inkMenu && createPortal(<div className="session-menu-layer board-edit-menu-layer" onPointerDown={event => event.stopPropagation()}>
    <button className="session-menu-shield" type="button" aria-label="Dismiss ink actions" onClick={() => { setInkMenu(null); focusBoardAfterMenu(); }} />
    <div className="session-menu board-edit-menu" role="menu" aria-label="Learner ink actions" style={{ left: inkMenu.x, top: inkMenu.y }}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setInkMenu(null); focusBoardAfterMenu(); } }}>
      <button ref={firstInkMenuItem} role="menuitem" onClick={() => applyInkAction('cut', true)}>Cut</button>
      <button role="menuitem" onClick={() => applyInkAction('copy', true)}>Copy</button>
      <button role="menuitem" disabled={!hasInkClipboard()} onClick={() => applyInkAction('paste', true)}>Paste</button>
      <button role="menuitem" onClick={() => applyInkAction('duplicate', true)}>Duplicate</button>
      <button role="menuitem" className="session-menu-delete" onClick={() => applyInkAction('delete', true)}>Delete</button>
    </div>
  </div>, document.body)}
  </>;
});
