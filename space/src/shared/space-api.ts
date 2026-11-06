/**
 * The bridge between the preload script and the renderer.
 * The preload exposes one object of type SpaceApi as `window.space`.
 * Every file path in this API is relative to the open learning folder and
 * uses `/` separators. The main process refuses paths that leave the folder.
 */

import type { BoardDigest, TextMatch } from './board-digest'
import type { LearnerEditDelta } from './learner-edit'
import type { BoardStories } from './scene-story'
import type { WorldTune } from './world-tune'

/** What the renderer knows about one board save. */
export interface BoardSaveInfo {
  /** The learner's new or changed nodes since the last read or save, or null. */
  learnerEdit: LearnerEditDelta | null
  /** Time to serialise the board on the renderer thread. */
  serializeMs: number
}

export interface Camera {
  /** The board point at the centre of the view. */
  center: [number, number]
  zoom: number
}

export interface FileNode {
  name: string
  /** Relative path from the folder root, with `/` separators. */
  path: string
  kind: 'dir' | 'file'
  children?: FileNode[]
}

export interface FileTree {
  nodes: FileNode[]
  /** True when the listing hit the depth or count cap. */
  truncated: boolean
}

/** A board of the sidebar list (main/folder.ts boardList). */
export interface BoardListEntry {
  path: string
  name: string
  /** The board's folder when it is not boards/: '/' for the folder root, else the folder path. */
  dir: string | null
  /** The file's last change (mtime, ms). Opening a board does not change it. */
  editedAt: number
}

/** The boards of a folder, newest edit first. The main process owns it; `seq` grows with each list of the folder, so a late list is known. */
export interface BoardList {
  root: string
  seq: number
  boards: BoardListEntry[]
}

export interface FolderInfo {
  /** Absolute path of the folder (after symlinks are resolved). */
  root: string
  name: string
  tree: FileTree
  boards: BoardList
  /** The board that was open the last time, if it still exists. */
  lastBoard: string | null
  /** AGENTS.md exists at the root when the folder opened. */
  setUp: boolean
  /** The learner chose "Don't ask for this folder" for the setup offer. */
  setupDontAsk: boolean
}

/** One item "Set up this folder for learning" would create. */
export interface SetupItem {
  /** Relative path, for example "AGENTS.md" or "sessions". */
  path: string
  kind: 'file' | 'dir'
  /** It exists already: setup keeps it as it is. */
  exists: boolean
  /** A few words on what it is for. */
  note: string
}

export interface SetupPlan {
  items: SetupItem[]
  /** AGENTS.md exists. */
  setUp: boolean
}

export interface SetupResult {
  /** What was created, dirs with a trailing "/". */
  created: string[]
}

/** A folder file that changes what agents read (.learning-space/guide.md or instructions.md). */
export interface FolderOverride {
  /** Relative path, for example ".learning-space/guide.md". */
  path: string
  /** append: added after the built-in text. replace: used instead of it. too-large: ignored. */
  mode: 'append' | 'replace' | 'too-large'
}

/** The folder's agent-text overrides. null: the file is missing or holds only comments. */
export interface GuideOverrides {
  guide: FolderOverride | null
  instructions: FolderOverride | null
}

export interface RecentFolder {
  path: string
  name: string
}

/** The app state the renderer needs after a folder opens or closes. */
export interface Snapshot {
  folder: FolderInfo | null
  recent: RecentFolder[]
  /** Dev hook SPACE_OPEN: a file to show in the preview at launch. */
  devOpen?: string | null
}

export type FilePreview =
  | { kind: 'text'; text: string; truncated: boolean; size: number }
  | { kind: 'image'; dataUrl: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number }

export interface BoardChange {
  path: string
  /** True when the file no longer exists. */
  deleted: boolean
}

/** A board whose save failed, with the text that could not be written. */
export interface FailedSave {
  root: string
  path: string
  text: string
}

/** The window chrome the renderer lays out by (main/index.ts owns all three). */
export interface ShellState {
  /** View > Hide Sidebar, saved in state.json. */
  sidebarHidden: boolean
  /** The window is in full screen (macOS: no window buttons at the top left). */
  fullScreen: boolean
  /** macOS: the window buttons' right edge in CSS px at the window's Interface Size (--window-buttons-end); null elsewhere. */
  windowButtonsEnd: number | null
  /** The learner's home folder, so a path can show as `~/…`. */
  homeDir: string
}

export type MenuCommand = 'open-folder' | 'new-board' | 'back' | 'forward' | 'search-boards' | 'setup-folder' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'select-all' | 'open-settings'

// ---------- Settings (main/settings.ts owns every user setting) ----------

/** The local voice on this Mac (main/kokoro.ts LocalVoiceState). */
export type LocalVoiceStatus = { state: 'absent' } | { state: 'installing'; progress: number } | { state: 'installed' } | { state: 'failed'; error: string }

/** Interface Size: 'auto' (the automatic size for the window's display) or a page zoom factor. */
export type InterfaceSizeSetting = 'auto' | number

/** An Interface Size as View > Interface Size and the Settings dialog name it: "Automatic (120%)", "80%". */
export function interfaceSizeLabel(size: InterfaceSizeSetting, automaticSize: number): string {
  const percent = (factor: number): string => `${Math.round(factor * 100)}%`
  return size === 'auto' ? `Automatic (${percent(automaticSize)})` : percent(size)
}

/**
 * Every user setting as it stands, from main/settings.ts: the Settings dialog shows it, and the View menu is built from
 * it. Main sends it again after every change, from any place (the dialog, the menu, the local voice's install). The
 * Gemini key never comes back: only whether one is saved.
 */
export interface SettingsSnapshot {
  general: {
    /** View > Interface Size. */
    interfaceSize: InterfaceSizeSetting
    /** The sizes it offers (page zoom factors). */
    interfaceSizes: number[]
    /** The factor of 'auto' for the main window's display ("Automatic (120%)"). */
    automaticSize: number
    /** View > Show performance: the performance item in the top bar. */
    showPerformance: boolean
  }
  voice: {
    /** View > Read Lines Aloud: with it off, the board plays no voice. */
    readLines: boolean
    /** Which voice reads the lines: our cloud voice, or the local one on this Mac. */
    model: 'cloud' | 'local'
    /** The voice of the chosen model, and that model's voices. */
    voice: string
    voices: string[]
    /** View > Pace, and its choices. */
    pace: string
    paces: { id: string; label: string }[]
    local: LocalVoiceStatus
    localDownloadMb: number
    /** A Gemini key is saved in ~/.learning-space/.env. */
    keySaved: boolean
  }
  about: {
    /** package.json productName, through Electron's app.name. */
    name: string
    version: string
    /** package.json license, or null when it has none. */
    license: string | null
  }
}

/** A change of settings: the fields it sets. voice is the voice of the chosen model. Main checks every value. */
export interface SettingsChange {
  interfaceSize?: InterfaceSizeSetting
  showPerformance?: boolean
  readLines?: boolean
  model?: 'cloud' | 'local'
  voice?: string
  pace?: string
}

/** Call the returned function to stop listening. */
export type Unsubscribe = () => void

// ---------- Agent (MCP) bridge ----------

/** A rectangle in board coordinates (logical points, origin at the centre, +y down). */
export interface BoardRect {
  x: number
  y: number
  width: number
  height: number
}

/** One item in a get_changes answer. */
export interface ChangedItem {
  id: string
  kind: string
  tool?: string
  color?: string
  name?: string
  /** Who made this change: "learner" or "agent" (agent edits since the app started). */
  by?: string
  /**
   * What the change was, compared with the item at `since`: added, restored
   * (removed earlier and back now, by undo, redo or paste), moved, resized,
   * edited (its content), changed (anything else, or not known), unchanged
   * (changed and changed back).
   */
  change: ItemChange
  /** For a move: the offset in board points. */
  offset?: { dx: number; dy: number }
  bounds: BoardRect | null
  seq: number
}

export type ItemChange = 'added' | 'restored' | 'moved' | 'resized' | 'turned' | 'edited' | 'changed' | 'unchanged'

/** An ink group: strokes clustered by distance and time, addressed as "g3". */
export interface InkGroupSummary {
  id: string
  author: string
  /** The frame the strokes belong to, or "root". */
  parent: string
  strokes: number
  bounds: BoardRect
  /** The highest seq among its strokes. */
  seq: number
}

export interface RemovedItem {
  id: string
  kind: string
  name?: string
  /** Who removed it: "learner" or "agent", when known. */
  by?: string
  bounds: BoardRect | null
  seq: number
}

/** A part of the learner's view that app UI covers, in board points. */
export interface CoveredRect extends BoardRect {
  by: string
}

/** One learner stroke (added or erased) in the board news. */
export interface NewsStroke {
  id: string
  seq: number
  bounds: BoardRect | null
  /** The ink group that holds it now (added strokes only). */
  group?: string
  /** When the learner drew or erased it (epoch ms), when the app saw it happen. */
  at?: number
}

/** An ink group that holds new learner strokes. */
export interface NewsGroup {
  id: string
  bounds: BoardRect
  /** Where it is, relative to the nearest material: 'right of your SVG "Thermal spectra"'. */
  where: string | null
}

/**
 * One learner change to the board that is not a new or erased stroke: an item
 * added, restored, moved, resized, edited or deleted, or ink restored, moved or
 * resized (per ink group).
 */
export interface NewsItem {
  /** 'drawn' and 'erased' are a learner's shapes, which the news tells as it tells strokes. */
  change: ItemChange | 'deleted' | 'drawn' | 'erased'
  /** The item in words: 'your image "Fig 2A"', 'ink group g3', '2 strokes of ink group g3'. */
  label: string
  /** Its bounds now (for a deletion: when it was removed). */
  bounds: BoardRect | null
  /** For a move: the offset in board points. */
  offset?: { dx: number; dy: number }
  at?: number
  /** Whose and what kind, for summaries of many items: 'your SVG', "the learner's text", 'ink'. */
  unit?: string
}

/**
 * The learner's changes on the open board after a seq (the board news;
 * see main/news.ts). Only the learner's changes; the agents' edits are left out.
 */
export interface LearnerNews {
  board: string
  boardName: string
  /** The highest seq on the board now. */
  cursor: number
  added: NewsStroke[]
  erased: NewsStroke[]
  /** The groups of the added strokes. */
  groups: NewsGroup[]
  /** Where the erased strokes were, relative to the nearest material. */
  erasedWhere: string | null
  /** Every other learner change: moves, resizes, edits, items added or deleted. */
  items: NewsItem[]
  /** Parts of worlds that the learner marked: `marked part "receptor" of world wave`. */
  marks?: string[]
  /** Live scenes that paused because the learner started drawing. */
  scenePauses?: Array<{ scene: string; name: string | null; step: string | null; t: number; duration: number }>
}

/** A live scene's look at one moment, for the snapshot window: overrides per node id and pen tips / the pointer (playback.ts types). */
export interface SnapshotPlayback {
  overrides: Array<[string, unknown]>
  tips: unknown[]
}

/** The board tools the renderer runs (see agent/edits.ts). Results are plain JSON. */
export type AgentToolName =
  | 'sceneContext'
  | 'runScene'
  | 'sceneDraft'
  | 'sceneFrames'
  | 'sceneControl'
  | 'sceneRestore'
  | 'sceneMemory'

/** A box drawn over a snapshot (the "changes" view), in board coordinates. */
export interface SnapshotOutline {
  rect: BoardRect
  color: string
}

/**
 * A mark over one frame of preview_scene, in the snapshot window's own style (snapshot.css), with a
 * tag that stays the same size in the image at every scale: the learner's view at the frame's
 * moment, or a part of it that app UI covers ("script panel").
 */
export interface SnapshotMark {
  kind: 'view' | 'covered'
  rect: BoardRect
  tag: string
}

/** An id tag drawn over a snapshot at the item's top-left, with a thin outline. */
export interface SnapshotLabel {
  rect: BoardRect
  text: string
  /** Tag background and outline colour. */
  color: string
  /** Tag text colour. */
  textColor: string
}

/** The overlays only the agent's image gets (never the learner's canvas). */
export interface SnapshotOverlays {
  labels: SnapshotLabel[]
  /** Board-coordinate grid pitch in points, or 0 for no grid. */
  grid: number
}

/** What a screenshot shows: the main renderer plans it, the snapshot window draws it. */
export type ScreenshotPlan =
  | { kind: 'empty'; board: string; message: string; cursor: number }
  | {
      kind: 'plan'
      board: string
      /** The board's nodes (BoardNode[]), unsaved edits included. */
      nodes: unknown[]
      rect: BoardRect
      scale: number
      width: number
      height: number
      outlines: SnapshotOutline[]
      overlays: SnapshotOverlays
      changes?: { changed: number; removed: number; handle: string }
      /** What the image shows, in words ("the view", "scene \"lengths\""). */
      what: string
      cursor: number
      background: string
      /** A live scene plays: the image shows this moment of it. */
      playback?: SnapshotPlayback
      playing?: { scene: string; name: string | null; t: number | null; duration: number | null; step: string | null; paused: boolean }
    }

/** Where the pictures of worlds sit in a frame, by node id. */
export type SnapshotCellBoxes = Record<string, { x: number; y: number; w: number; h: number }>

/** Main → snapshot window: draw this, then answer snapshotReady. */
export interface SnapshotRequest {
  requestId: number
  nodes: unknown[]
  rect: BoardRect
  scale: number
  width: number
  height: number
  outlines: SnapshotOutline[]
  overlays?: SnapshotOverlays
  background: string
  playback?: SnapshotPlayback
  /**
   * A grid of frames in one image (preview_scene). Each cell shows `rect` at
   * `scale` with `nodes` and its own nodes, stills and playback; width and
   * height are then the size of the whole image. Without cells the request
   * is one image of `nodes` with `playback`.
   */
  cells?: {
    width: number
    height: number
    gapColor: string
    list: SnapshotCell[]
    /** The pixels at the top of each cell that its label takes: mark tags stay below them. */
    markTop?: number
  }
}

/**
 * A scene's playback event on the board (renderer/live/player.ts), for the
 * session trace: its first frame drawn (first_frame), its end (end, with how it
 * ended), a new play in its place (replaced, outcome "cut" or "replaced"), or
 * a hold of its clock (hold, sent when the hold ends; t is its start).
 * t: wall time (Date ms).
 */
export interface SceneEvent {
  kind: 'first_frame' | 'end' | 'replaced' | 'hold'
  scene: string
  name: string | null
  t: number
  /** end: played (to its end), stopped (play_scene stop), cancelled (taken out of the queue before it played), removed (the board changed or closed). replaced: cut or replaced. */
  outcome?: 'played' | 'stopped' | 'cancelled' | 'removed' | 'cut' | 'replaced'
  /** hold: how long the clock stood. */
  ms?: number
}

/** One frame of a grid snapshot: where it goes in the image (pixels), and what only it shows. */
export interface SnapshotCell {
  left: number
  top: number
  /** Nodes that only this frame shows (changing ink, its label). */
  nodes: unknown[]
  /** Pictures of live items in this frame, by node id (image URLs). */
  stills?: Record<string, string>
  /** Worlds: where each picture sits, from the nominal rect's top-left, by node id. */
  stillBoxes?: SnapshotCellBoxes
  playback?: SnapshotPlayback
  /** The marks of this frame (its own view and covered parts). */
  marks?: SnapshotMark[]
}

export type SnapshotReply = { requestId: number; ok: true; missingImages: number } | { requestId: number; ok: false; error: string }

/** A live item in preview frames (renderer/live/run.ts sceneFrames): its node, its scene's params and steps over time, its moments. */
export interface LiveStillsItem {
  /** The LiveNode as the frames show it. */
  node: unknown
  timeline: { params: Array<[number, Record<string, number>]> | null; steps: Array<[number, string]> } | null
  /** t: scene time (s); null: the item as it is on the board now (no scene of the frames plays it). */
  moments: Array<{ frame: number; t: number | null }>
}

/** A board change (create, rename, trash) for the one operation that does them. */
export type BoardChangeOp = { op: 'create'; name?: string; folder?: string } | { op: 'rename'; path: string; name: string } | { op: 'trash'; path: string }
/** path: the new board, the renamed board's new path, or the trashed board's old path. wasOpen: it was the open board. */
export interface BoardChangeResult {
  path: string
  wasOpen: boolean
}

/**
 * The requests the main process sends to the renderer, which owns the live
 * board (with unsaved strokes). `since: null` means "from now": no changes.
 */
export interface AgentMethods {
  /** Save the open board now (a board that just got its id saves it before main writes its first scene record). */
  saveBoard: { params: Record<string, never>; result: { saved: boolean } }
  /** The open board and the highest seq on it (the change cursor for "now"). */
  cursorInfo: { params: Record<string, never>; result: { board: { path: string } | null; cursor: number | null } }
  /** list_items: the outline text of a part, or search results. look: the session's change cursor on this board. scenes: the stage log's scene names. */
  boardRead: {
    params: { part?: unknown; query?: string; depth?: number; look: number | null; scenes: Array<{ id: string; name: string | null }> }
    result: { board: string; cursor: number; text: string }
  }
  /** get_item: one or more ids as one form. */
  itemRead: { params: { id: string | string[]; as?: string; include_ids?: boolean; scenes: Array<{ id: string; name: string | null }> }; result: string }
  /** get_changes: the net changes from (exclusive) to (inclusive; null = now), as text, or each item (detail "items"). */
  changeReport: {
    params: { from: number; to: number | null; detail?: 'items'; all: boolean; again: boolean; scenes: Array<{ id: string; name: string | null }> }
    result: { board: string; cursor: number; text: string }
  }
  screenshotPlan: {
    params: {
      /** A part form (agent/reads.ts PartArg). */
      part?: unknown
      scale: number
      /** The longest image side in px; null picks the default for the shot's size. */
      maxSize: number | null
      labels?: boolean
      grid?: boolean
      scenes: Array<{ id: string; name: string | null }>
    }
    result: ScreenshotPlan
  }
  /** Open a board; the result is the list_items overview of it. */
  openBoard: { params: { path: string; look: number | null; scenes: Array<{ id: string; name: string | null }> }; result: { board: string; cursor: number; text: string } }
  /** list_boards: the open board's counts and title (and its text matches for a query), from memory with unsaved changes; null when no board is open. */
  boardDigest: {
    params: { query: string | null }
    result: {
      path: string
      unsaved: boolean
      digest: BoardDigest
      groups: number
      matches?: Array<TextMatch & { place: string }>
    } | null
  }
  /**
   * The one board-change operation (App.tsx changeBoard), also used by the sidebar: pending
   * saves are written first (a save error fails the change), then the file changes and the
   * drafts, change cursors, ink groups and stage move or end with it. create opens the new board.
   */
  boardChange: { params: BoardChangeOp; result: BoardChangeResult }
  /** The learner's changes after `since`; null when no board is open. */
  learnerNews: { params: { since: number }; result: LearnerNews | null }
  /** The board element's size in CSS px and the learner's view in board points (the view-size news, T38); null when no board is open. */
  boardView: { params: Record<string, never>; result: { viewport: [number, number]; view: BoardRect } | null }
  agentTool: { params: { tool: AgentToolName; args: Record<string, unknown> }; result: unknown }
  /** Check a world's code; error null when it is fine. */
  validateLive: { params: { code: string; params?: Record<string, number>; size?: [number, number]; data?: unknown }; result: { error: string | null } }
  /**
   * Stills of live items for preview frames, at `scale` px per board point: for each request, a picture per
   * moment (t: scene time; null: the item as it is on the board now). url null when there is no picture.
   */
  liveStills: {
    params: { items: LiveStillsItem[]; scale: number }
    result: { stills: Array<{ frame: number; id: string; url: string | null; tick: number | null; points?: Record<string, [number, number, boolean]>; box?: { x: number; y: number; w: number; h: number } }> }
  }
  /** The rendered size (board points) of scene text nodes (tex: math; text: markup), as the board lays them out. */
  measureText: { params: { items: Array<{ math: boolean; text: string; size: number }> }; result: { sizes: Array<[number, number]> } }
  /** A scene program's question to the board while it runs (html, image, space, copy: renderer/live/host.ts). */
  /** place: where the program runs (a new version of a scene: renderer live/run.ts ScenePlace). */
  sceneHost: { params: { request: Record<string, unknown>; place?: unknown }; result: unknown }
}

export type AgentMethod = keyof AgentMethods

export interface AgentRequest<M extends AgentMethod = AgentMethod> {
  requestId: number
  method: M
  params: AgentMethods[M]['params']
}

export type AgentReply = { requestId: number; ok: true; result: unknown } | { requestId: number; ok: false; error: string }

export interface AgentSessionInfo {
  id: string
  /** From the MCP initialize clientInfo, for example "codex-mcp-client". */
  clientName: string
  /** Epoch milliseconds. */
  connectedAt: number
  /** Epoch milliseconds of the session's last request. */
  lastActiveAt: number
}

export interface AgentServerStatus {
  url: string
  port: number
  state: 'starting' | 'listening' | 'error'
  /** Set when state is "error", for example "Port 47821 is in use". */
  error: string | null
  sessions: AgentSessionInfo[]
}

export interface AgentActivity {
  sessionId: string
  tool: string
}

/** An agent app the "Connect an agent" popover can set up. */
export type AgentClientId = 'claude-code' | 'codex' | 'claude-app'

/**
 * One agent app in the popover.
 * plugin: the Learning Space plugin is installed and enabled.
 * manual: a hand-made `learning-space` MCP entry, no plugin.
 * both: the plugin and a manual entry (the tools appear twice).
 * connected: Claude Desktop (chat) has the extension (a folder-name heuristic).
 * available: the app is installed and not connected. missing: the app was
 * not found. unknown: the check failed.
 */
export type AgentClientState = 'plugin' | 'manual' | 'both' | 'connected' | 'available' | 'missing' | 'unknown'

/**
 * A popover button.
 * install-plugin: add the marketplace (when it is missing), then install the plugin.
 * switch-to-plugin: install-plugin, then remove the manual entry.
 * remove-manual: remove the manual entry only.
 * install-extension:  open the bundled .mcpb in Claude Desktop.
 */
export type AgentClientAction = 'install-plugin' | 'switch-to-plugin' | 'remove-manual' | 'install-extension'

export interface AgentClientStatus {
  id: AgentClientId
  label: string
  state: AgentClientState
  /** A short note for the row (why the check failed). */
  detail: string | null
  /** The primary button for this state, or null when there is nothing to do. */
  action: AgentClientAction | null
}

export interface AgentClientsStatus {
  /** ~/.learning-space/bin/learning-space */
  shimPath: string
  clients: AgentClientStatus[]
}

export interface ConnectResult {
  ok: boolean
  /** A short success text, or the first line of the failed command's error output. */
  message: string
}

export interface SpaceApi {
  /** The Node `process.platform` value, for example `darwin`. */
  readonly platform: string
  /** The app version from package.json. */
  readonly version: string
  /** Dev only (SPACE_REMOTE_DEBUG): the page exposes window.__spaceDev. */
  readonly devHooks: boolean
  /** Measuring switches of the world surface (env SPACE_WORLD_TUNE), or null. */
  readonly worldTune: WorldTune | null
  /** The display's rate when this process started with no frame limit, else null (renderer/src/frame-pace.ts). */
  readonly frameLimitOff: number | null

  getInitialState(): Promise<Snapshot>
  /** Ask the learner for a folder. Nothing opens yet: openFolder does that, after the renderer saved. */
  pickFolder(): Promise<string | null>
  /** Make this folder (a picked or a recent one) the open one. The renderer calls it inside its folder switch, after its saves. */
  openFolder(path: string): Promise<Snapshot>
  listFiles(): Promise<FileTree>
  /** The boards list now, read from the folder (after a create, rename or trash). Main also sends it: onBoardsChanged. */
  getBoards(): Promise<BoardList>

  /** Reads and writes name their folder (`root`): they go to that folder, whichever folder is open by then. */
  readBoard(root: string, path: string): Promise<string>
  /** The board text kept when a save failed at close, or null (main/recovery.ts). */
  readRecovery(root: string, path: string): Promise<string | null>
  /**
   * Atomic write (temp file + rename). Only `*.board.json` paths. `info` carries the
   * learner's changes in this save (for the learner-edit log) and the serialise time (for the save log).
   */
  writeBoard(root: string, path: string, text: string, info?: BoardSaveInfo): Promise<void>
  /** Create `boards/Untitled N.board.json`, or `<folder>/<name>.board.json` when given. Resolves the new path. */
  createBoard(name?: string, folder?: string): Promise<string>
  /** Rename the file. Resolves the new path. */
  renameBoard(path: string, newName: string): Promise<string>
  /** Move the board file to the system Trash. */
  deleteBoard(path: string): Promise<void>

  readFile(path: string): Promise<FilePreview>
  revealInFinder(path: string): Promise<void>

  /** What "Set up this folder for learning" would create, and what exists. */
  setupPlan(): Promise<SetupPlan>
  /** Create the missing setup items. Never overwrites. */
  applySetup(): Promise<SetupResult>
  /** Remember (or forget) "Don't ask for this folder". */
  setSetupDontAsk(value: boolean): Promise<void>
  /** Main window only: the sidebar setting, full screen and the home folder, at once (a sync call, so the first paint is right). */
  getShellState(): ShellState
  /** The sidebar button and ⌘B: main saves the setting and answers with onSidebarHidden (main owns it). */
  setSidebarHidden(hidden: boolean): void
  /** The sidebar setting after any change: the button, ⌘B or View > Hide Sidebar / Show Sidebar. */
  onSidebarHidden(listener: (hidden: boolean) => void): Unsubscribe
  /** The window entered (true) or left (false) full screen. */
  onFullScreen(listener: (on: boolean) => void): Unsubscribe
  /** macOS: the window buttons moved for a new Interface Size; their right edge in CSS px. */
  onWindowButtons(listener: (end: number | null) => void): Unsubscribe
  /** The pill's row "Uncapped frame rate": on, as saved, and launched, the state of Chromium's frame limit since this launch. */
  getUncappedFrames(): Promise<{ on: boolean; launched: boolean }>
  setUncappedFrames(on: boolean): Promise<void>
  /** Every user setting (main/settings.ts): the snapshot, every snapshot after a change from any place, and a change. */
  getSettings(): Promise<SettingsSnapshot>
  onSettings(listener: (settings: SettingsSnapshot) => void): Unsubscribe
  setSettings(change: SettingsChange): Promise<void>
  installLocalVoice(): Promise<void>
  removeLocalVoice(): Promise<void>
  /** A short WAV in the current model, voice and pace. */
  playVoiceSample(): Promise<Uint8Array>
  /** Write GEMINI_API_KEY into ~/.learning-space/.env, or remove it. */
  saveGeminiKey(key: string): Promise<void>
  removeGeminiKey(): Promise<void>
  /** The cloud voice is at its daily limit (at most once a day per app run). */
  onVoiceNotice(listener: (code: 'daily_cap') => void): Unsubscribe
  /** The folder's board guide (.learning-space/guide.md), or null when it does not exist. */
  boardGuidePath(): Promise<string | null>
  /** What the folder's guide and instructions files change for agents now. */
  getGuideOverrides(): Promise<GuideOverrides>
  /** The overrides after an agent read the guide or connected. */
  onGuideOverrides(listener: (overrides: GuideOverrides) => void): Unsubscribe

  getCamera(path: string): Promise<Camera | null>
  setCamera(root: string, path: string, camera: Camera): void
  setLastBoard(root: string, path: string | null): void
  /** View > Back and Forward are enabled as the title row's buttons are (the renderer owns the board history, U11). */
  setHistoryMenu(back: boolean, forward: boolean): void
  /** The board at path opened (its id from the file, or null): its scene stories, and the id it must have (main/scene-store.ts). */
  openSceneRecords(path: string, id: string | null): Promise<BoardStories>
  /** The open board's scene stories after a new record line. */
  onSceneStories(listener: (stories: BoardStories) => void): Unsubscribe
  /** Board window only: run these scenes, restored from the board's records after a restart, again on the stage, so the player can replay them (main/mcp.ts ensureMemories). Resolves when it is done. */
  rebuildScenes(sceneIds: string[]): Promise<void>

  onFilesChanged(listener: (tree: FileTree) => void): Unsubscribe
  /** The boards list after a save, create, rename, trash or a change on disk (at most every 250 ms). */
  onBoardsChanged(listener: (list: BoardList) => void): Unsubscribe
  onBoardChanged(listener: (change: BoardChange) => void): Unsubscribe
  onMenuCommand(listener: (command: MenuCommand) => void): Unsubscribe
  /** The window is about to close: call flushStarted() at once, save, then call flushDone() with the boards that could not be saved. */
  onFlushRequest(listener: () => void): Unsubscribe
  /** Dev hook (SPACE_REMOTE_DEBUG only): close the window as the red button does. A page's window.close() does not ask main. */
  devClose(): void
  /** Dev hook: answer the close dialog (0: Try again, 1: Close anyway). */
  devCloseAnswer(button: number): void
  /** Dev hook: enter or leave full screen, as the green button does. */
  devFullScreen(on: boolean): void
  /** Dev hook: the label of the View menu's sidebar item that shows now; with click, choose it first. */
  devSidebarMenu(click: boolean): string | null
  /** Dev hook: choose the menu item with this id (for example 'search-boards', File > Search Boards…), as a click or its accelerator does; false when it is missing, hidden or disabled. */
  devClickMenu(id: string): boolean
  /** Dev hook: the menu item with this id as it shows (label, checked, enabled, visible), or null when it is missing. */
  devMenuItem(id: string): { label: string; checked: boolean; enabled: boolean; visible: boolean } | null
  flushStarted(): void
  flushDone(failed: FailedSave[]): void

  getAgentStatus(): Promise<AgentServerStatus>
  onAgentStatus(listener: (status: AgentServerStatus) => void): Unsubscribe
  onAgentActivity(listener: (activity: AgentActivity) => void): Unsubscribe
  /** Requests from the MCP server. Answer each one with replyAgent. */
  onAgentRequest(listener: (request: AgentRequest) => void): Unsubscribe
  replyAgent(reply: AgentReply): void
  /** Which agent apps are installed and connected (runs their CLIs; can take seconds). */
  getAgentClients(): Promise<AgentClientsStatus>
  /** Run one popover action for one agent app (plugin install, manual-entry removal, or open the .mcpb). */
  connectAgentClient(id: AgentClientId, action: AgentClientAction): Promise<ConnectResult>

  /**
   * Bring an image into the learning folder for an image node: an https URL
   * is downloaded into assets/, a data: URL is saved there, a folder-relative
   * path is checked. Resolves the folder-relative path.
   */
  importAsset(src: string): Promise<string>
  /** Board window only: put plain text on the system clipboard (empty text clears it): a board copy. */
  writeClipboardText(text: string): void
  /** Board window only: the system clipboard holds text or an image (a board menu shows Paste). */
  clipboardHasContent(): Promise<boolean>
  /** Board window only: paste as Edit > Paste does, so the page gets a paste event with the system clipboard (a board menu's Paste). */
  pasteClipboard(): void
  /** Snapshot window only: draw requests from the main process. */
  onSnapshotRequest(listener: (request: SnapshotRequest) => void): Unsubscribe
  snapshotReady(reply: SnapshotReply): void
  /** Snapshot window only: its request listener is registered, so main/snapshot.ts may send requests. */
  snapshotListening(): void
  /** Board window only: a scene's playback event, for the session trace (main/trace.ts scene_event). */
  sceneEvent(event: SceneEvent): void
  /** A line of a world's console: it reaches the agent in the next tool result. */
  worldLog(level: string, text: string): void
  /** Board window only: a worker's token reads the open folder from now on (main/live-item-protocol.ts). */
  worldFilesGrant(token: string): void
  worldFilesRevoke(token: string): void
  /** Board window only: the bytes of the files that main served to this token in the last `ms` milliseconds. */
  worldBytesRead(token: string, ms: number): Promise<number>
  /**
   * Board window only: ask for a port to the stage page, for the frames of
   * scenes (renderer/live/frames.ts). The port comes as a window message
   * "ls-frames-port"; each call gives a new one.
   */
  framesPort(): void
}

/** IPC channel names. The main process and the preload share them. */
export const IPC = {
  appVersion: 'space:app-version',
  devHooks: 'space:dev-hooks',
  worldTune: 'space:world-tune',
  frameLimitOff: 'space:frame-limit-off',
  getInitialState: 'space:get-initial-state',
  pickFolder: 'space:pick-folder',
  openFolder: 'space:open-folder',
  listFiles: 'space:list-files',
  getBoards: 'space:get-boards',
  readBoard: 'space:read-board',
  readRecovery: 'space:read-recovery',
  writeBoard: 'space:write-board',
  createBoard: 'space:create-board',
  renameBoard: 'space:rename-board',
  deleteBoard: 'space:delete-board',
  readFile: 'space:read-file',
  revealInFinder: 'space:reveal-in-finder',
  setupPlan: 'space:setup-plan',
  applySetup: 'space:apply-setup',
  setSetupDontAsk: 'space:set-setup-dont-ask',
  getUncappedFrames: 'space:get-uncapped-frames',
  setUncappedFrames: 'space:set-uncapped-frames',
  boardGuidePath: 'space:board-guide-path',
  getGuideOverrides: 'space:get-guide-overrides',
  guideOverrides: 'space:guide-overrides',
  getCamera: 'space:get-camera',
  setCamera: 'space:set-camera',
  setLastBoard: 'space:set-last-board',
  setHistoryMenu: 'space:set-history-menu',
  filesChanged: 'space:files-changed',
  boardsChanged: 'space:boards-changed',
  boardChanged: 'space:board-changed',
  menuCommand: 'space:menu-command',
  flushRequest: 'space:flush-request',
  devClose: 'space:dev-close',
  devCloseAnswer: 'space:dev-close-answer',
  devFullScreen: 'space:dev-full-screen',
  devSidebarMenu: 'space:dev-sidebar-menu',
  devClickMenu: 'space:dev-click-menu',
  devMenuItem: 'space:dev-menu-item',
  getShellState: 'space:get-shell-state',
  setSidebarHidden: 'space:set-sidebar-hidden',
  sidebarHidden: 'space:sidebar-hidden',
  fullScreen: 'space:full-screen',
  windowButtons: 'space:window-buttons',
  flushStarted: 'space:flush-started',
  flushDone: 'space:flush-done',
  getAgentStatus: 'space:get-agent-status',
  agentStatus: 'space:agent-status',
  agentActivity: 'space:agent-activity',
  agentRequest: 'space:agent-request',
  agentReply: 'space:agent-reply',
  getAgentClients: 'space:get-agent-clients',
  connectAgentClient: 'space:connect-agent-client',
  importAsset: 'space:import-asset',
  writeClipboardText: 'space:write-clipboard-text',
  clipboardHasContent: 'space:clipboard-has-content',
  pasteClipboard: 'space:paste-clipboard',
  snapshotRequest: 'space:snapshot-request',
  snapshotReady: 'space:snapshot-ready',
  snapshotListening: 'space:snapshot-listening',
  sceneEvent: 'space:scene-event',
  worldLog: 'space:world-log',
  worldFilesGrant: 'space:world-files-grant',
  worldFilesRevoke: 'space:world-files-revoke',
  worldBytesRead: 'space:world-bytes-read',
  framesPort: 'space:frames-port',
  openSceneRecords: 'space:open-scene-records',
  sceneStories: 'space:scene-stories',
  rebuildScenes: 'space:rebuild-scenes',
  getSettings: 'space:get-settings',
  settings: 'space:settings',
  setSettings: 'space:set-settings',
  installLocalVoice: 'space:install-local-voice',
  removeLocalVoice: 'space:remove-local-voice',
  playVoiceSample: 'space:play-voice-sample',
  saveGeminiKey: 'space:save-gemini-key',
  removeGeminiKey: 'space:remove-gemini-key',
  voiceNotice: 'space:voice-notice'
} as const
