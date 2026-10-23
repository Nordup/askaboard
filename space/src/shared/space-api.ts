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

export interface SpaceApi {
  /** The Node `process.platform` value, for example `darwin`. */
  readonly platform: string
  /** The app version from package.json. */
  readonly version: string

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
}

/** IPC channel names. The main process and the preload share them. */
export const IPC = {
  appVersion: 'space:app-version',
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
  flushDone: 'space:flush-done'
} as const
