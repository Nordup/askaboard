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
}

const MAX_RECENT = 8
const MAX_CAMERAS = 500

const statePath = (): string => join(app.getPath('userData'), 'state.json')

let state: PersistedState = { lastFolder: null, recent: [], cameras: {}, lastBoards: {} }
let saveTimer: ReturnType<typeof setTimeout> | null = null

export function loadState(): void {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<PersistedState>
    state = {
      lastFolder: typeof raw.lastFolder === 'string' ? raw.lastFolder : null,
      recent: Array.isArray(raw.recent) ? raw.recent.filter((entry) => typeof entry === 'string') : [],
      cameras: raw.cameras && typeof raw.cameras === 'object' ? raw.cameras : {},
      lastBoards: raw.lastBoards && typeof raw.lastBoards === 'object' ? raw.lastBoards : {}
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
  scheduleSave()
}

export function forgetBoardState(root: string, rel: string): void {
  delete state.cameras[cameraKey(root, rel)]
  if (state.lastBoards[root] === rel) delete state.lastBoards[root]
  scheduleSave()
}
