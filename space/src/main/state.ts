import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import type { Camera, RecentFolder } from '@shared/space-api'

/**
 * App state in `userData/state.json`: the last folder, the recent list, the
 * last camera per board and the last open board per folder. Board cameras
 * live here, not in the board file, so panning never churns Git.
 */
interface PersistedState {
  lastFolder: string | null
  recent: string[]
  /** Key: `<folder root>::<relative board path>`. */
  cameras: Record<string, Camera>
  /** Key: folder root. Value: relative board path. */
  lastBoards: Record<string, string>
  /** Folder roots where the learner chose "Don't ask" for the setup offer. */
  setupDontAsk: string[]
  /** Each agent app's news state per board (see news.ts). Key: `<client label>::<folder root>::<board path>`. */
  agentLooks: Record<string, AgentLook>
  /** View > Show performance. */
  showPerformance: boolean
  /** The row "Uncapped frame rate" of the performance pill. It counts only while the pill is on. */
  uncappedFrames: boolean
}

/**
 * An agent app's news state on a board: the board seq up to which the learner's
 * changes were delivered (in a "Board news" line or by a look), when, and the seq
 * of its last look (get_screenshot, get_changes), where a new connection's change
 * cursor starts.
 */
export interface AgentLook {
  seq: number
  at: number
  lookSeq: number
}

const MAX_RECENT = 8
const MAX_CAMERAS = 500
const MAX_LOOKS = 200

const statePath = (): string => join(app.getPath('userData'), 'state.json')

let state: PersistedState = { lastFolder: null, recent: [], cameras: {}, lastBoards: {}, setupDontAsk: [], agentLooks: {}, showPerformance: false, uncappedFrames: true }
let saveTimer: ReturnType<typeof setTimeout> | null = null

export function loadState(): void {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<PersistedState>
    state = {
      lastFolder: typeof raw.lastFolder === 'string' ? raw.lastFolder : null,
      recent: Array.isArray(raw.recent) ? raw.recent.filter((entry) => typeof entry === 'string') : [],
      cameras: raw.cameras && typeof raw.cameras === 'object' ? raw.cameras : {},
      lastBoards: raw.lastBoards && typeof raw.lastBoards === 'object' ? raw.lastBoards : {},
      setupDontAsk: Array.isArray(raw.setupDontAsk) ? raw.setupDontAsk.filter((entry) => typeof entry === 'string') : [],
      agentLooks: raw.agentLooks && typeof raw.agentLooks === 'object' ? raw.agentLooks : {},
      showPerformance: raw.showPerformance === true,
      uncappedFrames: raw.uncappedFrames !== false
    }
  } catch {
    // A missing or broken state file means a fresh start.
  }
}

/** Write now. The write is atomic (temp file + rename). */
export function saveStateNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    const path = statePath()
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
    renameSync(temp, path)
  } catch (error) {
    console.error(`state.json write failed: ${String(error)}`)
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveStateNow, 300)
}

export function lastFolder(): string | null {
  return state.lastFolder
}

export function recentFolders(): RecentFolder[] {
  return state.recent.filter((path) => existsSync(path)).map((path) => ({ path, name: basename(path) }))
}

export function isRecent(path: string): boolean {
  return state.recent.includes(path)
}

export function rememberFolder(root: string): void {
  state.lastFolder = root
  state.recent = [root, ...state.recent.filter((path) => path !== root)].slice(0, MAX_RECENT)
  scheduleSave()
}

const cameraKey = (root: string, rel: string): string => `${root}::${rel}`

export function getCamera(root: string, rel: string): Camera | null {
  return state.cameras[cameraKey(root, rel)] ?? null
}

export function setCamera(root: string, rel: string, camera: Camera): void {
  const key = cameraKey(root, rel)
  delete state.cameras[key] // re-insert, so the newest entries are last
  state.cameras[key] = camera
  const keys = Object.keys(state.cameras)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CAMERAS))) delete state.cameras[old]
  scheduleSave()
}

export function getLastBoard(root: string): string | null {
  return state.lastBoards[root] ?? null
}

export function setLastBoard(root: string, rel: string | null): void {
  if (rel) state.lastBoards[root] = rel
  else delete state.lastBoards[root]
  scheduleSave()
}

/** Move the per-board state after a rename. */
export function renameBoardState(root: string, from: string, to: string): void {
  const camera = state.cameras[cameraKey(root, from)]
  if (camera) {
    delete state.cameras[cameraKey(root, from)]
    state.cameras[cameraKey(root, to)] = camera
  }
  if (state.lastBoards[root] === from) state.lastBoards[root] = to
  const suffix = `::${root}::${from}`
  for (const key of Object.keys(state.agentLooks)) {
    if (!key.endsWith(suffix)) continue
    state.agentLooks[`${key.slice(0, -suffix.length)}::${root}::${to}`] = state.agentLooks[key]
    delete state.agentLooks[key]
  }
  scheduleSave()
}

export function forgetBoardState(root: string, rel: string): void {
  delete state.cameras[cameraKey(root, rel)]
  if (state.lastBoards[root] === rel) delete state.lastBoards[root]
  scheduleSave()
}

export function getSetupDontAsk(root: string): boolean {
  return state.setupDontAsk.includes(root)
}

export function setSetupDontAsk(root: string, value: boolean): void {
  state.setupDontAsk = state.setupDontAsk.filter((entry) => entry !== root)
  if (value) state.setupDontAsk.push(root)
  // A rare, deliberate choice: write it now, so a crash cannot lose it.
  saveStateNow()
}

export function getShowPerformance(): boolean {
  return state.showPerformance
}

export function setShowPerformance(value: boolean): void {
  state.showPerformance = value
  saveStateNow()
}

export function getUncappedFrames(): boolean {
  return state.uncappedFrames
}

export function setUncappedFrames(value: boolean): void {
  state.uncappedFrames = value
  saveStateNow()
}

const lookKey = (client: string, root: string, rel: string): string => `${client}::${root}::${rel}`

export function getAgentLook(client: string, root: string, rel: string): AgentLook | null {
  const look = state.agentLooks[lookKey(client, root, rel)]
  if (!look || typeof look.seq !== 'number' || typeof look.at !== 'number') return null
  return { seq: look.seq, at: look.at, lookSeq: typeof look.lookSeq === 'number' ? look.lookSeq : look.seq }
}

export function setAgentLook(client: string, root: string, rel: string, look: AgentLook): void {
  const key = lookKey(client, root, rel)
  delete state.agentLooks[key] // re-insert, so the newest entries are last
  state.agentLooks[key] = look
  const keys = Object.keys(state.agentLooks)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_LOOKS))) delete state.agentLooks[old]
  scheduleSave()
}
