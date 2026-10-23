#!/usr/bin/env node
/**
 * Drive a running Learning Space dev app over the Chrome DevTools Protocol,
 * so check agents never need computer use for input. The input reaches the
 * page even when the window is in the background.
 *
 * Start the app with SPACE_REMOTE_DEBUG=<port> (dev builds only), then:
 *
 *   node scripts/drive.mjs [--port 9339] draw <strokes.json | -> [--tool pen|highlighter] [--no-pan]
 *   node scripts/drive.mjs draw --strokes '[[[x,y,p],...],...]'
 *   node scripts/drive.mjs key <combo>          e.g. v, Delete, Escape, Meta+z, Shift+Meta+z
 *   node scripts/drive.mjs click <x> <y> [--shift]  window CSS pixels
 *   node scripts/drive.mjs dblclick <x> <y>
 *   node scripts/drive.mjs drag <x1> <y1> <x2> <y2> [--shift] [--steps N]   mouse drag
 *   node scripts/drive.mjs type "<text>"        insert text into the focused field
 *   node scripts/drive.mjs node-rect <id>       a node's window rect (JSON), from the layout cache
 *   node scripts/drive.mjs screenshot <out.png> the whole window
 *   node scripts/drive.mjs eval-state           board, zoom, tool, selection, nodes with bounds (JSON)
 *
 * Strokes are in board coordinates (points, origin at the centre, +y down);
 * p is pen pressure 0..1. Each stroke is sent as pen input
 * (Input.dispatchMouseEvent with pointerType "pen" and force = pressure).
 * Needs Node 22+ (global fetch and WebSocket). Exit code 0 on success, 1 on error.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const USAGE = `usage: node scripts/drive.mjs [--port N] <command>
  draw <file.json|-> [--tool pen|highlighter] [--no-pan]
                                                 strokes in board coordinates: [[[x,y,p],...],...];
                                                 pans the board first so every point is on screen
  draw --strokes '<json>'
  key <combo>                                    v, Delete, Escape, Meta+z, Shift+Meta+z
  click <x> <y> [--shift]                        window CSS pixels
  dblclick <x> <y>
  drag <x1> <y1> <x2> <y2> [--shift] [--steps N] mouse drag in window CSS pixels
  type "<text>"                                  insert text into the focused field
  node-rect <id>                                 {x, y, width, height, cx, cy} in window CSS pixels
  screenshot <out.png>
  eval-state                                     board, tool, selection, nodes (id, kind, parent, bounds)
The port defaults to $SPACE_REMOTE_DEBUG, then 9339.`

class Failure extends Error {}

// ---------- Arguments ----------

const args = process.argv.slice(2)
function takeOption(name) {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (value === undefined) throw new Failure(`${name} needs a value`)
  args.splice(index, 2)
  return value
}

// ---------- CDP ----------

async function connect(port) {
  let targets
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    targets = await response.json()
  } catch {
    throw new Failure(
      `No app with remote debugging on 127.0.0.1:${port}. Start it with SPACE_REMOTE_DEBUG=${port} npm run dev (dev builds only).`
    )
  }
  const page = targets.find((target) => target.type === 'page' && !target.url.startsWith('devtools://'))
  if (!page) throw new Failure(`Port ${port} answers, but it has no app page. Is the window open?`)

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Failure(`Could not attach to the page on port ${port}.`))
  })
  let nextId = 0
  const pending = new Map()
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data)
    const entry = data.id !== undefined && pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.error) entry.reject(new Failure(`${entry.method}: ${data.error.message}`))
    else entry.resolve(data.result)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject, method })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return { send, close: () => socket.close() }
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Failure(`page error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
  return result.result.value
}

async function requireDevHook(cdp) {
  const ok = await evaluate(cdp, 'typeof window.__spaceDev === "object"')
  if (!ok) throw new Failure('The page has no window.__spaceDev. Start the app with SPACE_REMOTE_DEBUG set (dev builds only).')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- Commands ----------

function readStrokes(source) {
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')
  return parseStrokes(text)
}

function parseStrokes(text) {
  let strokes
  try {
    strokes = JSON.parse(text)
  } catch (error) {
    throw new Failure(`The strokes are not valid JSON: ${error.message}`)
  }
  const valid =
    Array.isArray(strokes) &&
    strokes.every(
      (stroke) =>
        Array.isArray(stroke) &&
        stroke.length > 0 &&
        stroke.every((point) => Array.isArray(point) && point.length >= 2 && point.every((n) => typeof n === 'number' && Number.isFinite(n)))
    )
  if (!valid) throw new Failure('Strokes must be [[[x, y, pressure], ...], ...] in board coordinates.')
  return strokes
}

async function draw(cdp, strokes, tool, pan) {
  await requireDevHook(cdp)
  const state = await evaluate(cdp, 'window.__spaceDev.state()')
  if (!state.board) throw new Failure('No board is open in the app.')
  await evaluate(cdp, `window.__spaceDev.setTool(${JSON.stringify(tool)})`)
  // Input only reaches the board where the canvas is on screen: pan to the strokes first.
  const xs = strokes.flat().map((point) => point[0])
  const ys = strokes.flat().map((point) => point[1])
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
  if (pan) await evaluate(cdp, `window.__spaceDev.reveal(${bounds.join(', ')})`)
  await sleep(80) // let React apply the tool and the camera

  // Map every board point to window coordinates in one call.
  const mapped = await evaluate(
    cdp,
    `(${JSON.stringify(strokes)}).map((s) => s.map(([x, y, p]) => { const c = window.__spaceDev.boardToClient(x, y); return c && [c[0], c[1], p ?? 0.5] }))`
  )
  if (mapped.some((stroke) => stroke.some((point) => !point))) throw new Failure('The board is not mounted yet.')
  const canvas = await evaluate(cdp, 'window.__spaceDev.canvasRect()')
  const outside = mapped.flat().filter(([x, y]) => x < canvas.x || y < canvas.y || x > canvas.x + canvas.width || y > canvas.y + canvas.height)
  if (outside.length) {
    throw new Failure(`${outside.length} point(s) fall outside the visible canvas, so the board would not get them. Drop --no-pan, or pan the board.`)
  }

  const pen = (type, [x, y, p], buttons) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' && buttons === 0 ? 'none' : 'left',
      buttons,
      clickCount: type === 'mouseMoved' ? 0 : 1,
      pointerType: 'pen',
      force: Math.min(1, Math.max(0, p))
    })
  for (const stroke of mapped) {
    // A pen hovers before it touches. Without the hover, the first press on a
    // page that has not seen the pointer yet can be lost.
    await pen('mouseMoved', stroke[0], 0)
    await sleep(16)
    await pen('mousePressed', stroke[0], 1)
    for (const point of stroke.slice(1)) {
      await pen('mouseMoved', point, 1)
      await sleep(4)
    }
    await pen('mouseReleased', stroke[stroke.length - 1], 0)
    await sleep(20)
  }
  const after = await evaluate(cdp, 'window.__spaceDev.state()')
  console.log(JSON.stringify({ drawn: strokes.length, board: after.board, itemCount: after.itemCount }))
}

const NAMED_KEYS = {
  Delete: ['Delete', 46],
  Backspace: ['Backspace', 8],
  Escape: ['Escape', 27],
  Enter: ['Enter', 13],
  Tab: ['Tab', 9],
  Space: ['Space', 32, ' '],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39],
  ArrowDown: ['ArrowDown', 40],
  '=': ['Equal', 187, '='],
  '+': ['Equal', 187, '+'],
  '-': ['Minus', 189, '-']
}
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 }

function parseCombo(combo) {
  const parts = combo.split('+').filter(Boolean)
  if (combo.endsWith('++')) parts.push('+')
  let modifiers = 0
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIERS[part]
    if (!bit) throw new Failure(`Unknown modifier "${part}". Use Alt, Control, Meta, Shift.`)
    modifiers |= bit
  }
  const name = parts[parts.length - 1]
  if (!name) throw new Failure('key needs a combo, for example v, Delete or Meta+z.')
  let key
  let code
  let keyCode
  let text
  if (NAMED_KEYS[name]) {
    ;[code, keyCode, text] = NAMED_KEYS[name]
    key = text ?? name
  } else if (/^[a-z]$/i.test(name)) {
    key = modifiers & 8 ? name.toUpperCase() : name.toLowerCase()
    code = `Key${name.toUpperCase()}`
    keyCode = name.toUpperCase().charCodeAt(0)
    text = key
  } else if (/^[0-9]$/.test(name)) {
    key = name
    code = `Digit${name}`
    keyCode = name.charCodeAt(0)
    text = name
  } else {
    throw new Failure(`Unknown key "${name}".`)
  }
  // A shortcut with Control or Meta types no text.
  if (modifiers & 6) text = undefined
  return { key, code, keyCode, text, modifiers }
}

async function pressKey(cdp, combo) {
  const { key, code, keyCode, text, modifiers } = parseCombo(combo)
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  console.log(JSON.stringify({ key: combo }))
}

async function click(cdp, x, y, modifiers = 0) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, modifiers })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers })
  }
  console.log(JSON.stringify({ click: [x, y] }))
}

async function dblclick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  for (const clickCount of [1, 2]) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount })
    }
  }
  await sleep(50)
  console.log(JSON.stringify({ dblclick: [x, y] }))
}

async function drag(cdp, from, to, modifiers, steps) {
  const at = (t) => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1], button: 'none', buttons: 0, modifiers })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', buttons: 1, clickCount: 1, modifiers })
  for (let i = 1; i <= steps; i++) {
    const [x, y] = at(i / steps)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers })
    await sleep(8)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', buttons: 0, clickCount: 1, modifiers })
  await sleep(50)
  console.log(JSON.stringify({ drag: [from, to] }))
}

async function typeText(cdp, text) {
  await cdp.send('Input.insertText', { text })
  console.log(JSON.stringify({ typed: text }))
}

async function nodeRect(cdp, id) {
  await requireDevHook(cdp)
  const rect = await evaluate(cdp, `window.__spaceDev.nodeRect(${JSON.stringify(id)})`)
  if (!rect) throw new Failure(`No node "${id}" with a known layout on the open board.`)
  const r1 = (value) => Math.round(value * 10) / 10
  console.log(
    JSON.stringify({ x: r1(rect.x), y: r1(rect.y), width: r1(rect.width), height: r1(rect.height), cx: r1(rect.x + rect.width / 2), cy: r1(rect.y + rect.height / 2) })
  )
}

async function screenshot(cdp, out) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log(JSON.stringify({ screenshot: out }))
}

// ---------- Main ----------

async function main() {
  const port = Number(takeOption('--port') ?? process.env.SPACE_REMOTE_DEBUG ?? 9339)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Failure('The port is not valid.')
  const tool = takeOption('--tool') ?? 'pen'
  if (tool !== 'pen' && tool !== 'highlighter') throw new Failure('--tool must be pen or highlighter.')
  const inline = takeOption('--strokes')
  const steps = Number(takeOption('--steps') ?? 12)
  if (!Number.isInteger(steps) || steps < 1) throw new Failure('--steps must be a positive integer.')
  const noPanIndex = args.indexOf('--no-pan')
  const noPan = noPanIndex !== -1
  if (noPan) args.splice(noPanIndex, 1)
  const shiftIndex = args.indexOf('--shift')
  const modifiers = shiftIndex !== -1 ? 8 : 0
  if (shiftIndex !== -1) args.splice(shiftIndex, 1)
  const [command, ...rest] = args
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE)
    return
  }

  // Validate input before connecting.
  let run
  if (command === 'draw') {
    const strokes = inline ? parseStrokes(inline) : rest[0] ? readStrokes(rest[0]) : null
    if (!strokes) throw new Failure('draw needs a strokes file, "-" for stdin, or --strokes.')
    run = (cdp) => draw(cdp, strokes, tool, !noPan)
  } else if (command === 'key') {
    if (!rest[0]) throw new Failure('key needs a combo, for example v, Delete or Meta+z.')
    parseCombo(rest[0])
    run = (cdp) => pressKey(cdp, rest[0])
  } else if (command === 'click') {
    const [x, y] = rest.map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Failure('click needs <x> <y> in window CSS pixels.')
    run = (cdp) => click(cdp, x, y, modifiers)
  } else if (command === 'dblclick') {
    const [x, y] = rest.map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Failure('dblclick needs <x> <y> in window CSS pixels.')
    run = (cdp) => dblclick(cdp, x, y)
  } else if (command === 'drag') {
    const [x1, y1, x2, y2] = rest.map(Number)
    if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Failure('drag needs <x1> <y1> <x2> <y2> in window CSS pixels.')
    run = (cdp) => drag(cdp, [x1, y1], [x2, y2], modifiers, steps)
  } else if (command === 'type') {
    if (rest[0] === undefined) throw new Failure('type needs the text to insert.')
    run = (cdp) => typeText(cdp, rest[0])
  } else if (command === 'node-rect') {
    if (!rest[0]) throw new Failure('node-rect needs a node id.')
    run = (cdp) => nodeRect(cdp, rest[0])
  } else if (command === 'screenshot') {
    if (!rest[0]) throw new Failure('screenshot needs an output path.')
    run = (cdp) => screenshot(cdp, rest[0])
  } else if (command === 'eval-state') {
    run = async (cdp) => {
      await requireDevHook(cdp)
      console.log(JSON.stringify(await evaluate(cdp, 'window.__spaceDev.state()')))
    }
  } else {
    throw new Failure(`Unknown command "${command}".\n${USAGE}`)
  }

  const cdp = await connect(port)
  try {
    await run(cdp)
  } finally {
    cdp.close()
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`drive: ${error instanceof Failure ? error.message : error?.stack ?? String(error)}`)
    process.exit(1)
  }
)
