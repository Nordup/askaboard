import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { app, protocol } from 'electron'
import { LIVE_SCHEME, rewriteBareImports } from '@shared/live-libs'
import type { FolderSession } from './folder'
import { resourcePath } from './resources'

/**
 * live-item://host/ — the origin of worlds (renderer/src/live-pixels/world).
 * Each board's world surface has a sandboxed iframe of /frame.html (an opaque
 * origin of its own, apart from the app's page, storage and files) whose worker
 * runs the worlds. The frame has no Content-Security-Policy: a world may fetch
 * and import from any URL. /lib/ serves the bundled libraries
 * (shared/live-libs.ts), with their bare imports rewritten to URLs, because
 * workers have no import maps. /file/<token>?path= and
 * /module/<token>/<generation>/<path> read the learning folder for a world's code
 * (world/worker/files.ts): read-only, as streams, by FolderSession.worldFile.
 * /module/ gives modules: their bare imports are rewritten too, and their relative
 * imports stay under the same generation.
 *
 * Any sandboxed frame of the app has the origin "null" and can name this scheme, so
 * the origin says nothing. A read needs the token of a live worker (WorldGrant).
 */

export const LIVE_SCHEME_PRIVILEGES = { scheme: LIVE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }

/** The frame: it starts the worker and hands it a port to the page (world/surface.ts). */
const FRAME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head><body><script>
'use strict';
let worker = null;
const toParent = (m) => parent.postMessage(m, '*');
addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'start' && !worker) {
    try { worker = new Worker(m.url, { name: 'world' }); }
    catch (error) { toParent({ type: 'load-error', message: String(error && error.message || error), line: 0 }); return; }
    worker.addEventListener('error', (e) => { e.preventDefault(); toParent({ type: 'load-error', message: e.message || '', line: e.lineno || 0 }); });
    worker.postMessage({ type: 'init', port: m.port }, [m.port]);
  } else if (m.type === 'stop') {
    if (worker) worker.terminate();
    worker = null;
  }
});
toParent({ type: 'ready' });
</script></body></html>`

/**
 * One worker's right to read the folder. The page mints the token for each worker,
 * and only that worker gets it, by its port (world/surface.ts). The right holds for
 * the folder that was open then. reads: what main itself served to this worker, by
 * file, because the worker's realm belongs to the world's code and its numbers count
 * for nothing.
 */
interface WorldGrant {
  folder: FolderSession | null
  reads: Map<string, { size: number; at: number }>
}

const grants = new Map<string, WorldGrant>()

export function grantWorldFiles(token: unknown, folder: FolderSession | null): void {
  if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) && !grants.has(token)) grants.set(token, { folder, reads: new Map() })
}

export function revokeWorldFiles(token: unknown): void {
  if (typeof token === 'string') grants.delete(token)
}

/** Every worker's right to read this folder ends (the learner stopped trusting it, U19). */
export function revokeWorldFilesOf(root: string): void {
  for (const [token, grant] of grants) if (grant.folder?.root === root) grants.delete(token)
}

/** The bytes of the files that this worker asked for in the last `ms` milliseconds. A file counts once, however many reads ask for it. */
export function worldBytesRead(token: unknown, ms: unknown): number {
  const grant = typeof token === 'string' ? grants.get(token) : undefined
  if (!grant || typeof ms !== 'number' || !Number.isFinite(ms)) return 0
  const since = Date.now() - ms
  let bytes = 0
  for (const read of grant.reads.values()) if (read.at >= since) bytes += read.size
  return bytes
}

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

/** Bytes per read of a stream. */
const STREAM_CHUNK = 1 << 20

const STATUS_TEXT: Record<number, string> = { 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed' }

/** A file of the learning folder. `known`: the tag that the worker holds, which gives 304 while the file stays the same. */
async function folderFile(request: Request, grant: WorldGrant, rel: string, module: boolean, known: string | null, headers: Record<string, string>): Promise<Response> {
  const refuse = (status: number, text: string): Response => new Response(text, { status, statusText: STATUS_TEXT[status], headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } })
  if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(405, 'The learning folder is read-only.')
  const folder = grant.folder
  if (!folder) return refuse(404, 'No learning folder is open.')
  let file: Awaited<ReturnType<FolderSession['worldFile']>>
  try {
    file = await folder.worldFile(rel)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? refuse(404, `No such file: ${rel}`) : refuse(403, error instanceof Error ? error.message : `Refused: ${rel}`)
  }
  grant.reads.set(file.path, { size: file.size, at: Date.now() })
  const fileHeaders = { ...headers, 'content-type': file.type, etag: file.tag, 'access-control-expose-headers': 'etag' }
  if (known === file.tag) return new Response(null, { status: 304, headers: fileHeaders })
  if (module && file.type.startsWith('text/javascript')) return new Response(rewriteBareImports(await readFile(file.path, 'utf8')), { headers: fileHeaders })
  const sized = { ...fileHeaders, 'content-length': String(file.size) }
  if (request.method === 'HEAD') return new Response(null, { headers: sized })
  return new Response(Readable.toWeb(createReadStream(file.path, { highWaterMark: STREAM_CHUNK })) as ReadableStream<Uint8Array>, { headers: sized })
}

export function registerLiveItemProtocol(folder: () => FolderSession | null): void {
  protocol.handle(LIVE_SCHEME, async (request) => {
    // The worker runs in the sandboxed frame from a data: URL: its origin serializes as "null".
    const headers = { 'access-control-allow-origin': 'null', 'cache-control': 'no-cache', 'cross-origin-resource-policy': 'cross-origin' }
    try {
      const url = new URL(request.url)
      if (url.host !== 'host') return new Response('Not found', { status: 404, headers })
      const path = decodeURIComponent(url.pathname)
      if (path === '/frame.html') return new Response(FRAME_HTML, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
      const parts = path.split('/')
      if (parts[1] === 'file' || parts[1] === 'module') {
        const grant = grants.get(parts[2] ?? '')
        if (!grant || grant.folder !== folder()) return new Response('This read has no valid world token.', { status: 403, statusText: STATUS_TEXT[403], headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } })
        if (parts[1] === 'file') return await folderFile(request, grant, url.searchParams.get('path') ?? '', false, url.searchParams.get('known'), headers)
        return await folderFile(request, grant, parts.slice(4).join('/'), true, null, headers)
      }
      const file = await libraryFile(path)
      if (!file) return new Response(`Not found: ${path}`, { status: 404, headers })
      return new Response(typeof file.body === 'string' ? file.body : new Uint8Array(file.body), { headers: { ...headers, 'content-type': file.type } })
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'Not found', { status: 404, headers })
    }
  })
}
