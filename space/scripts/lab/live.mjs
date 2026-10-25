#!/usr/bin/env node
/**
 * Live pixel items without the scene API: put a shader or canvas program on
 * the board of a running dev app (SPACE_REMOTE_DEBUG) through the dev hook
 * window.__spaceDev.live. For checks and for trying programs.
 *
 *   node scripts/lab/live.mjs [--port N] add <file> [--at x,y] [--size WxH] [--param name=value ...]
 *   node scripts/lab/live.mjs examples          the four programs in programs/live/, in a 2 × 2 grid
 *   node scripts/lab/live.mjs list              live items: id, mode, visible, state, frames, error
 *   node scripts/lab/live.mjs validate <file>   the compile log or syntax error, or "ok"
 *   node scripts/lab/live.mjs set <id> name=value ...   change params
 *   node scripts/lab/live.mjs code <id> <file>  replace the code
 *
 * A program file is GLSL (.glsl: shader mode) or the body of a JavaScript
 * function (ctx, t, w, h, params, dt) (.js: canvas mode). Its first line may
 * give defaults: `// live: shader  size: 600x340  params: k=16 omega=3`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdpConnect } from './common.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
function take(name) {
  const i = args.indexOf(name)
  if (i === -1) return null
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}
function takeAll(name) {
  const out = []
  for (let v = take(name); v !== null; v = take(name)) out.push(v)
  return out
}
const port = Number(take('--port') ?? process.env.SPACE_REMOTE_DEBUG ?? 9339)

function parseParams(list) {
  const out = {}
  for (const entry of list) {
    const [name, value] = entry.split('=')
    if (name && value !== undefined && Number.isFinite(Number(value))) out[name] = Number(value)
  }
  return out
}

/** Read a program file and its header defaults. */
function program(file) {
  const code = readFileSync(file, 'utf8')
  const head = code.split('\n')[0]
  const mode = /live:\s*(shader|canvas)/.exec(head)?.[1] ?? (extname(file) === '.glsl' ? 'shader' : 'canvas')
  const size = /size:\s*(\d+)x(\d+)/.exec(head)
  const params = parseParams((/params:\s*(.*)$/.exec(head)?.[1] ?? '').trim().split(/\s+/).filter(Boolean))
  return { code, mode, w: size ? Number(size[1]) : 400, h: size ? Number(size[2]) : 300, params, name: basename(file, extname(file)) }
}

const cdp = await cdpConnect(port)
const call = (expr) => cdp.evaluate(`(async () => { const live = window.__spaceDev?.live; if (!live) throw new Error('No dev hook: start the app with SPACE_REMOTE_DEBUG.'); return ${expr} })()`)

async function add(file, at, size, params) {
  const p = program(file)
  const [w, h] = size ? size.split('x').map(Number) : [p.w, p.h]
  const fields = { mode: p.mode, code: p.code, w, h, params: { ...p.params, ...params }, name: p.name, x: at[0], y: at[1] }
  return call(`live.add(${JSON.stringify(fields)})`)
}

try {
  const [command, ...rest] = args
  if (command === 'add') {
    const at = (take('--at') ?? '0,0').split(',').map(Number)
    const size = take('--size')
    const params = parseParams(takeAll('--param'))
    const file = args[1]
    if (!file) throw new Error('add needs a program file')
    console.log(await add(file, at, size, params))
  } else if (command === 'examples') {
    const dir = join(HERE, 'programs/live')
    const files = readdirSync(dir).filter((f) => /\.(glsl|js)$/.test(f)).sort()
    const out = {}
    for (const [i, f] of files.entries()) {
      const x = (i % 2) * 660 - 640
      const y = Math.floor(i / 2) * 460 - 420
      out[f] = await add(join(dir, f), [x, y], null, {})
    }
    console.log(JSON.stringify(out, null, 2))
  } else if (command === 'list') {
    console.log(JSON.stringify(await call('live.items()'), null, 2))
  } else if (command === 'validate') {
    const p = program(rest[0])
    const error = await call(`live.validate(${JSON.stringify(p.mode)}, ${JSON.stringify(p.code)}, ${JSON.stringify(p.params)})`)
    console.log(error ?? 'ok')
  } else if (command === 'set') {
    const [id, ...pairs] = rest
    console.log(await call(`live.setParams(${JSON.stringify(id)}, ${JSON.stringify(parseParams(pairs))})`))
  } else if (command === 'code') {
    const [id, file] = rest
    console.log(await call(`live.update(${JSON.stringify(id)}, { code: ${JSON.stringify(readFileSync(file, 'utf8'))} })`))
  } else {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 17).join('\n'))
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  cdp.close()
}
