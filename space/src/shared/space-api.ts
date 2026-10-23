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

export type MenuCommand = 'new-board' | 'zoom-in' | 'zoom-out' | 'zoom-reset'

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

/** One item in a get_changes answer. */
export interface ChangedItem {
  id: string
  kind: string
  tool?: string
  color?: string
  bounds: BoardRect | null
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
}

export type ScreenshotResult =
  | { kind: 'empty'; board: string; message: string; cursor: number }
  | {
      kind: 'image'
      board: string
      /** Base64 PNG, without the data: prefix. */
      png: string
      rect: BoardRect
      /** Image pixels per board point. */
      scale: number
      width: number
      height: number
      /** For target "changes": what the outlines mark. */
      changes?: { changed: number; removed: number }
      cursor: number
    }

/**
 * The requests the main process sends to the renderer, which owns the live
 * board (with unsaved strokes). `since: null` means "from now": no changes.
 */
export interface AgentMethods {
  canvasInfo: { params: Record<string, never>; result: CanvasInfo }
  changes: { params: { since: number | null }; result: ChangeSet }
  screenshot: {
    params: { target: ScreenshotTarget; region?: BoardRect; maxSize: number; since: number | null }
    result: ScreenshotResult
  }
  openBoard: { params: { path: string }; result: CanvasInfo }
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
  agentReply: 'space:agent-reply'
} as const
