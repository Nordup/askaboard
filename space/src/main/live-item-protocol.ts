import { readFile } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { app, protocol } from 'electron'
import { LIVE_SCHEME, rewriteBareImports } from '@shared/live-libs'
import { resourcePath } from './resources'

/**
 * live-item://host/ — the origin of program() items (live-pixels/program.ts).
 * Each item is a sandboxed iframe of /frame.html (an opaque origin of its own,
 * apart from the app's page, storage and files) whose worker runs the
 * agent's program. The frame has no Content-Security-Policy: a program may
 * fetch and import from any URL. /lib/ serves the bundled libraries
 * (shared/live-libs.ts), with their bare imports rewritten to URLs, because
 * workers have no import maps.
 */

export const LIVE_SCHEME_PRIVILEGES = { scheme: LIVE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }

/** The item frame: hosts the canvas and the worker, forwards input. Messages: see program.ts. */
const FRAME_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;touch-action:none;user-select:none;-webkit-user-select:none}canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none}</style>
</head><body><script>
'use strict';
let worker = null;
let canvas = null;
const toParent = (m) => parent.postMessage(m, '*');
const fields = ['type','offsetX','offsetY','clientX','clientY','movementX','movementY','button','buttons','pointerId','pointerType','isPrimary','pressure','tiltX','tiltY','width','height','shiftKey','ctrlKey','altKey','metaKey','deltaX','deltaY','deltaZ','deltaMode','key','code','repeat','detail'];
const forward = (event) => {
  if (!worker) return;
  const e = {};
  for (const f of fields) if (event[f] !== undefined) e[f] = event[f];
  if (event.type === 'wheel' || event.type === 'contextmenu') event.preventDefault();
  if (event.type === 'pointerdown' && canvas) { try { canvas.setPointerCapture(event.pointerId); } catch (x) {} canvas.focus(); }
  if (event.type === 'keydown' && event.key === 'Escape') { toParent({ type: 'escape' }); }
  worker.postMessage({ type: 'input', event: e });
};
for (const type of ['pointerdown','pointermove','pointerup','pointercancel','pointerenter','pointerleave','click','dblclick','contextmenu','keydown','keyup']) addEventListener(type, forward, true);
addEventListener('wheel', forward, { capture: true, passive: false });
addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'start' && !worker) {
    canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.appendChild(canvas);
    const offscreen = canvas.transferControlToOffscreen();
    try { worker = new Worker(m.url, { name: 'live-program' }); }
    catch (error) { toParent({ type: 'load-error', message: String(error && error.message || error), line: 0 }); return; }
    worker.addEventListener('error', (e) => { e.preventDefault(); toParent({ type: 'load-error', message: e.message || '', line: e.lineno || 0 }); });
    worker.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.type === 'cursor') document.body.style.cursor = canvas.style.cursor = typeof d.value === 'string' ? d.value : '';
    });
    worker.postMessage(Object.assign({}, m.init, { type: 'init', canvas: offscreen, port: m.port }), [offscreen, m.port]);
  } else if (m.type === 'focus') {
    if (canvas) canvas.focus();
  } else if (m.type === 'stop') {
    if (worker) worker.terminate();
    worker = null;
  }
});
toParent({ type: 'ready' });
</script></body></html>`

const cache = new Map<string, { body: Buffer | string; type: string }>()

function typeOf(path: string): string {
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.wasm')) return 'application/wasm'
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  return 'application/octet-stream'
}

/** A file under `root`, or null when the path leaves it. */
function inside(root: string, rel: string): string | null {
  const full = normalize(join(root, rel))
  return full.startsWith(root + sep) ? full : null
}

async function libraryFile(path: string): Promise<{ body: Buffer | string; type: string } | null> {
  const hit = cache.get(path)
  if (hit) return hit
  let file: string | null = null
  if (path.startsWith('/lib/three/')) file = inside(join(app.getAppPath(), 'node_modules', 'three'), path.slice('/lib/three/'.length))
  else if (path.startsWith('/lib/ls/')) file = inside(resourcePath('live'), path.slice('/lib/ls/'.length))
  if (!file) return null
  const type = typeOf(file)
  const raw = await readFile(file)
  const body = type.startsWith('text/javascript') ? rewriteBareImports(raw.toString('utf8'), false) : raw
  const entry = { body, type }
  // The interaction module may change while the app runs in dev; the libraries do not.
  if (!path.startsWith('/lib/ls/')) cache.set(path, entry)
  return entry
}

export function registerLiveItemProtocol(): void {
  protocol.handle(LIVE_SCHEME, async (request) => {
    const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-cache', 'cross-origin-resource-policy': 'cross-origin' }
    try {
      const url = new URL(request.url)
      if (url.host !== 'host') return new Response('Not found', { status: 404, headers })
      const path = decodeURIComponent(url.pathname)
      if (path === '/frame.html') return new Response(FRAME_HTML, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
      const file = await libraryFile(path)
      if (!file) return new Response(`Not found: ${path}`, { status: 404, headers })
      return new Response(typeof file.body === 'string' ? file.body : new Uint8Array(file.body), { headers: { ...headers, 'content-type': file.type } })
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'Not found', { status: 404, headers })
    }
  })
}
