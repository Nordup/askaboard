/**
 * The bridge between the preload script and the renderer.
 * The preload exposes one object of type SpaceApi as `window.space`.
 * Every file path in this API is relative to the open learning folder and
 * uses `/` separators. The main process refuses paths that leave the folder.
 */

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

export interface FolderInfo {
  /** Absolute path of the folder (after symlinks are resolved). */
  root: string
  name: string
  tree: FileTree
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

export type MenuCommand = 'new-board' | 'setup-folder' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'select-all'

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

export type ScreenshotTarget = 'viewport' | 'content' | 'selection' | 'changes' | 'region'

/** A top-level node in get_canvas_info. */
export interface TopLevelSummary {
  id: string
  kind: string
  name?: string
  author?: string
  bounds: BoardRect | null
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
  bounds: BoardRect | null
  seq: number
}

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
  bounds: BoardRect | null
  seq: number
}

export interface ChangeSet {
  board: string
  /** Items with seq > since that are on the board now. */
  changed: ChangedItem[]
  /** Items removed with seq > since. */
  removed: RemovedItem[]
  /** The highest seq seen now (nextSeq - 1). Pass it back as `since`: nothing repeats. */
  cursor: number
  /** Ink groups that hold changed strokes. */
  groups_changed?: InkGroupSummary[]
}

export interface CanvasInfo {
  folder: { name: string; path: string } | null
  board: { path: string; name: string } | null
  boards: string[]
  viewport: BoardRect | null
  contentBounds: BoardRect | null
  itemCount: number
  selection: { ids: string[]; bounds: BoardRect | null }
  tool: string
  zoom: number | null
  /** The highest seq on the board (nextSeq - 1): the change cursor value for "now". */
  cursor: number | null
  /** Node counts by kind. */
  counts?: Record<string, number>
  /** Top-level content nodes, in draw order. */
  topLevel?: TopLevelSummary[]
  /** Every ink group (top level and inside frames). */
  inkGroups?: InkGroupSummary[]
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
 * The learner's ink changes on the open board after a seq (the board news;
 * see main/news.ts). Only the learner's strokes; the agents' edits are left out.
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
  /** Live scenes that paused because the learner started drawing. */
  scenePauses?: Array<{ scene: string; name: string | null; step: string | null; t: number; duration: number }>
}

/** A live scene's look at one moment, for the snapshot window: overrides per node id and pen tips / the pointer (playback.ts types). */
export interface SnapshotPlayback {
  overrides: Array<[string, unknown]>
  tips: unknown[]
  /** The scene clock per node at this moment (program items draw it). */
  clocks?: Array<[string, unknown]>
}

/** The board tools the renderer runs (see agent/edits.ts). Results are plain JSON. */
export type AgentToolName =
  | 'getTree'
  | 'getNodeInfo'
  | 'getHtml'
  | 'sceneContext'
  | 'runScene'
  | 'previewScene'
  | 'sceneControl'

/** A box drawn over a snapshot (the "changes" view), in board coordinates. */
export interface SnapshotOutline {
  rect: BoardRect
  color: string
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
      changes?: { changed: number; removed: number }
      cursor: number
      background: string
      /** A live scene plays: the image shows this moment of it. */
      playback?: SnapshotPlayback
      playing?: { scene: string; name: string | null; t: number | null; duration: number | null; step: string | null; paused: boolean }
    }

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
}

export type SnapshotReply = { requestId: number; ok: true; missingImages: number } | { requestId: number; ok: false; error: string }

/**
 * The requests the main process sends to the renderer, which owns the live
 * board (with unsaved strokes). `since: null` means "from now": no changes.
 */
export interface AgentMethods {
  canvasInfo: { params: Record<string, never>; result: CanvasInfo }
  changes: { params: { since: number | null }; result: ChangeSet }
  screenshotPlan: {
    params: {
      target: ScreenshotTarget | 'node'
      region?: BoardRect
      nodeId?: string
      scale: number
      /** The longest image side in px; null picks the default for the shot's size. */
      maxSize: number | null
      since: number | null
      labels?: boolean
      grid?: boolean
    }
    result: ScreenshotPlan
  }
  openBoard: { params: { path: string }; result: CanvasInfo }
  /** The learner's ink changes after `since`; null when no board is open. */
  learnerNews: { params: { since: number }; result: LearnerNews | null }
  agentTool: { params: { tool: AgentToolName; args: Record<string, unknown> }; result: unknown }
  /** Check live pixel code (shader compile log, canvas syntax error); error null when it is fine. */
  validateLive: { params: { mode: 'shader' | 'canvas' | 'program'; code: string; params?: Record<string, number>; size?: [number, number] }; result: { error: string | null } }
  /** The rendered size (board points) of scene text nodes (tex: math; text: markup), as the board lays them out. */
  measureText: { params: { items: Array<{ math: boolean; text: string; size: number }> }; result: { sizes: Array<[number, number]> } }
  /** A scene program's question to the board while it runs (html, image, space, copy: renderer/live/host.ts). */
  sceneHost: { params: { request: Record<string, unknown> }; result: unknown }
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

  getInitialState(): Promise<Snapshot>
  /** Show the system folder picker. Resolves null when the user cancels. */
  openFolderDialog(): Promise<Snapshot | null>
  /** Open a folder from the recent list. Other paths are refused. */
  openRecent(path: string): Promise<Snapshot>
  listFiles(): Promise<FileTree>

  readBoard(path: string): Promise<string>
  /** Atomic write (temp file + rename). Only `*.board.json` paths. */
  writeBoard(path: string, text: string): Promise<void>
  /** Create `boards/Untitled N.board.json`. Resolves the new path. */
  createBoard(): Promise<string>
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
  /** The folder's board guide (.learning-space/guide.md), or null when it does not exist. */
  boardGuidePath(): Promise<string | null>
  /** What the folder's guide and instructions files change for agents now. */
  getGuideOverrides(): Promise<GuideOverrides>
  /** The overrides after an agent read the guide or connected. */
  onGuideOverrides(listener: (overrides: GuideOverrides) => void): Unsubscribe

  getCamera(path: string): Promise<Camera | null>
  setCamera(path: string, camera: Camera): void
  setLastBoard(path: string | null): void

  onFolderOpened(listener: (snapshot: Snapshot) => void): Unsubscribe
  onFilesChanged(listener: (tree: FileTree) => void): Unsubscribe
  onBoardChanged(listener: (change: BoardChange) => void): Unsubscribe
  onMenuCommand(listener: (command: MenuCommand) => void): Unsubscribe
  /** The window is about to close: save, then call flushDone(). */
  onFlushRequest(listener: () => void): Unsubscribe
  flushDone(): void

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
  /** Snapshot window only: draw requests from the main process. */
  onSnapshotRequest(listener: (request: SnapshotRequest) => void): Unsubscribe
  snapshotReady(reply: SnapshotReply): void
}

/** IPC channel names. The main process and the preload share them. */
export const IPC = {
  appVersion: 'space:app-version',
  devHooks: 'space:dev-hooks',
  getInitialState: 'space:get-initial-state',
  openFolderDialog: 'space:open-folder-dialog',
  openRecent: 'space:open-recent',
  listFiles: 'space:list-files',
  readBoard: 'space:read-board',
  writeBoard: 'space:write-board',
  createBoard: 'space:create-board',
  renameBoard: 'space:rename-board',
  deleteBoard: 'space:delete-board',
  readFile: 'space:read-file',
  revealInFinder: 'space:reveal-in-finder',
  setupPlan: 'space:setup-plan',
  applySetup: 'space:apply-setup',
  setSetupDontAsk: 'space:set-setup-dont-ask',
  boardGuidePath: 'space:board-guide-path',
  getGuideOverrides: 'space:get-guide-overrides',
  guideOverrides: 'space:guide-overrides',
  getCamera: 'space:get-camera',
  setCamera: 'space:set-camera',
  setLastBoard: 'space:set-last-board',
  folderOpened: 'space:folder-opened',
  filesChanged: 'space:files-changed',
  boardChanged: 'space:board-changed',
  menuCommand: 'space:menu-command',
  flushRequest: 'space:flush-request',
  flushDone: 'space:flush-done',
  getAgentStatus: 'space:get-agent-status',
  agentStatus: 'space:agent-status',
  agentActivity: 'space:agent-activity',
  agentRequest: 'space:agent-request',
  agentReply: 'space:agent-reply',
  getAgentClients: 'space:get-agent-clients',
  connectAgentClient: 'space:connect-agent-client',
  importAsset: 'space:import-asset',
  snapshotRequest: 'space:snapshot-request',
  snapshotReady: 'space:snapshot-ready'
} as const
