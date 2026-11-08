#!/usr/bin/env node
/**
 * Makes the README hero image, assets/brand/readme/hero.png, with the app's own board.
 *
 *   cd apps/desktop && node scripts/readme/hero-image.mjs
 *
 * Why: the README shows the real app, not a mock-up. The picture is the website hero rebuilt on a
 * real board (hero-scene.js, the board's own ink and items), in the real app window, with a Claude
 * Code chat window in front of the app's lower-left corner, as on the website. Run it again after
 * the app or the hero changes.
 *
 * What it does, all on its own instance (the founder's app and ~/.askaboard are never touched):
 * 1. Builds the app (npm run build) only when out/ is missing.
 * 2. Makes a scratch HOME, user-data-dir and learning folder under the system temp folder; picks free ports.
 * 3. Starts the built app: window visible but not focused, 1280 x 720 content, sidebar hidden.
 * 4. Connects one MCP session as Claude Code (agent.mjs), makes the board "Hero image", writes and plays the scene.
 * 5. Captures the real window with screencapture -l <window id> (macOS: rounded corners, window buttons).
 * 6. Puts the chat window in front of the capture, squares the window's corners with the app's own colours,
 *    and writes one 2560 x 1440 rectangle (compose.cjs, offscreen Electron).
 * 7. Stops exactly the processes it started and removes the scratch folder.
 * 8. Cuts the share cards from the same picture: apps/website/public/askaboard-social.png (1200 x 630)
 *    and assets/brand/exports/web/github-social.png (1280 x 640).
 * macOS only (screencapture, swift).
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectAgent } from './agent.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPACE = join(HERE, '..', '..')
const OUT = join(SPACE, '..', '..', 'assets', 'brand', 'readme', 'hero.png')
const HERO_WIDTH = 2560
/** The share cards made from OUT: the crop's top edge in OUT's pixels, and the card's size. */
const SOCIAL = [
  { out: join(SPACE, '..', 'website', 'public', 'askaboard-social.png'), width: 1200, height: 630, top: 92 },
  { out: join(SPACE, '..', '..', 'assets', 'brand', 'exports', 'web', 'github-social.png'), width: 1280, height: 640, top: 152 }
]
const ELECTRON = createRequire(join(SPACE, 'package.json'))('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('hero-image:', ...a)

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

const listening = (port) =>
  new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
  })

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Stop one process we started: SIGTERM, then SIGKILL after 8 s; wait until it is gone. */
async function stop(child, name) {
  if (!child || child.exitCode !== null || !alive(child.pid)) return
  child.kill('SIGTERM')
  for (let i = 0; i < 80 && alive(child.pid); i++) await sleep(100)
  if (alive(child.pid)) child.kill('SIGKILL')
  for (let i = 0; i < 30 && alive(child.pid); i++) await sleep(100)
  log(`stopped ${name} (pid ${child.pid})${alive(child.pid) ? ' — STILL RUNNING' : ''}`)
}

/** scripts/drive.mjs against our instance's debug port. */
function drive(debugPort, ...args) {
  const r = spawnSync(process.execPath, [join(SPACE, 'scripts', 'drive.mjs'), ...args], { cwd: SPACE, env: { ...process.env, SPACE_REMOTE_DEBUG: String(debugPort) }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`drive ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

/** The CGWindow id of the process's 1280-wide window (inline swift, CGWindowListCopyWindowInfo). */
function windowId(pid) {
  const code = `import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list {
  guard let owner = w["kCGWindowOwnerPID"] as? Int, owner == ${pid}, let layer = w["kCGWindowLayer"] as? Int, layer == 0,
        let b = w["kCGWindowBounds"] as? [String: Any], let width = b["Width"] as? Double, width == 1280 else { continue }
  print(w["kCGWindowNumber"]!)
  break
}`
  const id = execFileSync('swift', ['-e', code], { encoding: 'utf8' }).trim()
  if (!/^\d+$/.test(id)) throw new Error(`no 1280-wide window of pid ${pid} found (${id || 'nothing'})`)
  return id
}

const scratch = mkdtempSync(join(tmpdir(), 'askaboard-hero-'))
let appProcess = null
let agent = null
try {
  if (!existsSync(join(SPACE, 'out', 'main')) || !existsSync(join(SPACE, 'out', 'renderer'))) {
    log('out/ is missing: npm run build')
    execFileSync('npm', ['run', 'build'], { cwd: SPACE, stdio: 'inherit' })
  }
  const home = join(scratch, 'home')
  const userData = join(scratch, 'user-data')
  const folder = join(scratch, 'Askaboard')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })
  mkdirSync(join(folder, 'boards', 'scenes'), { recursive: true })
  copyFileSync(join(HERE, 'hero-scene.js'), join(folder, 'boards', 'scenes', 'hero.js'))
  const mcpPort = await freePort()
  const debugPort = await freePort()

  // 3. The app: the built app in out/, as `electron .`; no focus, no usage data.
  const env = { ...process.env, HOME: home, SPACE_FOLDER: folder, SPACE_MCP_PORT: String(mcpPort), SPACE_REMOTE_DEBUG: String(debugPort), SPACE_NO_FOCUS: '1', ASKABOARD_TELEMETRY_ENABLED: 'false' }
  delete env.ELECTRON_RUN_AS_NODE
  const appLog = openSync(join(scratch, 'app.log'), 'w')
  appProcess = spawn(ELECTRON, [`--user-data-dir=${userData}`, '.'], { cwd: SPACE, env, stdio: ['ignore', appLog, appLog] })
  log(`app started (pid ${appProcess.pid}, MCP ${mcpPort}, debug ${debugPort})`)
  for (let i = 0; i < 100 && !(await listening(mcpPort)); i++) await sleep(300)
  if (!(await listening(mcpPort))) throw new Error(`the app's MCP server did not start; see ${join(scratch, 'app.log')}`)
  // The MCP server starts before the window's page can answer on the debug port: wait until the
  // page answers, so the first window command never meets a page that is still loading.
  let ready = null
  for (let i = 0; i < 100; i++) {
    try {
      drive(debugPort, 'eval-state')
      ready = true
      break
    } catch (error) {
      ready = error
      await sleep(300)
    }
  }
  if (ready !== true) throw new Error(`the app's window did not answer on the debug port: ${ready?.message ?? ready}`)
  drive(debugPort, 'window-size', '1280', '720')
  drive(debugPort, 'menu', 'hide-sidebar')

  // 4. The board, as Claude Code makes it.
  agent = await connectAgent(mcpPort)
  await agent.call('open_board', { board: 'Hero image', create: true })
  await agent.call('write_scene', { name: 'Hero image', file: 'hero.js' })
  const played = JSON.parse(await agent.call('play_scene', { action: 'start', name: 'Hero image' }))
  await sleep(((played.ends_in_s ?? 0) + 1.5) * 1000)
  // The scene panel opens while a scene plays: hide it; then the hero's framing and the pointer off the board.
  const panel = JSON.parse(drive(debugPort, 'element-rect', '.script-panel__hide'))
  const hide = (Array.isArray(panel) ? panel : panel.rects ?? []).find((r) => r.visible !== false && r.width > 0)
  if (hide) drive(debugPort, 'click', String(Math.round(hide.x + hide.width / 2)), String(Math.round(hide.y + hide.height / 2)))
  await sleep(500)
  drive(debugPort, 'camera', '0', '75')
  drive(debugPort, 'hover', '640', '22')
  await sleep(1200)

  // 5. The real window.
  const id = windowId(appProcess.pid)
  const windowPng = join(scratch, 'window.png')
  execFileSync('screencapture', ['-l', id, '-o', '-x', windowPng])
  log(`window ${id} captured`)
  await agent.close()
  agent = null
  await stop(appProcess, 'app')
  appProcess = null

  // 6. The composite.
  mkdirSync(dirname(OUT), { recursive: true })
  const composeUserData = join(scratch, 'compose-data')
  const compose = spawnSync(ELECTRON, [`--user-data-dir=${composeUserData}`, join(HERE, 'compose.cjs'), windowPng, OUT, scratch], { cwd: SPACE, env: { ...env, HOME: home }, encoding: 'utf8' })
  if (compose.status !== 0) throw new Error(`compose failed: ${compose.stderr || compose.stdout}`)
  log(compose.stdout.trim().split('\n').pop())
  console.log(OUT)

  // 7. The share cards, cut from the same picture: the board without the app's top bar (88 px at 2x),
  //    scaled to each card's size. The website's Open Graph / Twitter image and GitHub's social preview.
  for (const card of SOCIAL) {
    const height = Math.round((HERO_WIDTH * card.height) / card.width)
    execFileSync('sips', ['-c', String(height), String(HERO_WIDTH), '--cropOffset', String(card.top), '0', OUT, '--out', card.out], { stdio: 'ignore' })
    execFileSync('sips', ['-z', String(card.height), String(card.width), card.out], { stdio: 'ignore' })
    console.log(card.out)
  }
} finally {
  if (agent) await agent.close()
  await stop(appProcess, 'app')
  rmSync(scratch, { recursive: true, force: true })
}
