import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, LayoutDashboard, Plus } from 'lucide-react'
import { BOARDS_DIR, boardName, isBoardPath, parseBoard, serializeBoard, type BoardDoc } from '@shared/board-format'
import type { Camera, FileNode, FileTree, Snapshot } from '@shared/space-api'
import { Board, type BoardHandle } from './board/Board'
import { BoardHistory } from './board/history'
import { CanvasNotice } from './components/CanvasNotice'
import { PreviewPanel } from './components/PreviewPanel'
import { Sidebar, type BoardEntry } from './components/Sidebar'
import { Toast } from './components/Toast'
import { ToolPalette } from './components/ToolPalette'
import { TopBar, type SaveStatus } from './components/TopBar'
import { WelcomeCard } from './components/WelcomeCard'
import { errorMessage } from './lib/errors'
import { isEditableTarget } from './lib/keys'
import { colorValue, TOOL_KEYS, widthValue, type ToolState } from './tools'

const space = window.space
const SAVE_DELAY_MS = 400
const CAMERA_SAVE_DELAY_MS = 500

interface OpenBoard {
  path: string
  /** Changes when the Board must remount: a board switch or a reload from disk. */
  key: number
  doc: BoardDoc
  history: BoardHistory
  camera: Camera | null
}

interface CacheEntry {
  doc: BoardDoc
  history: BoardHistory
}

function collectBoards(nodes: FileNode[], out: BoardEntry[] = []): BoardEntry[] {
  for (const node of nodes) {
    if (node.kind === 'dir') collectBoards(node.children ?? [], out)
    else if (isBoardPath(node.name)) {
      const dir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''
      out.push({ path: node.path, name: boardName(node.path), dir: dir === BOARDS_DIR ? null : dir || '/' })
    }
  }
  return out
}

function sortBoards(boards: BoardEntry[]): BoardEntry[] {
  // Boards in boards/ first, then the others by path.
  return [...boards].sort((a, b) => {
    if (!a.dir !== !b.dir) return a.dir ? 1 : -1
    return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })
  })
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [tree, setTree] = useState<FileTree | null>(null)
  const [open, setOpen] = useState<OpenBoard | null>(null)
  const [boardError, setBoardError] = useState<{ path: string; message: string } | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [zoom, setZoom] = useState(1)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewVersion, setPreviewVersion] = useState(0)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [tools, setTools] = useState<ToolState>({ tool: 'pen', colorId: 'white', widthId: 'medium' })

  const clearToast = useCallback(() => setToast(null), [])
  const folder = snapshot?.folder ?? null
  const boards = useMemo(() => sortBoards(collectBoards(tree?.nodes ?? [])), [tree])

  const boardRef = useRef<BoardHandle>(null)
  const cacheRef = useRef(new Map<string, CacheEntry>())
  const openRef = useRef<OpenBoard | null>(null)
  openRef.current = open
  const keyRef = useRef(0)
  const openTokenRef = useRef(0)
  const openingRef = useRef(false)
  const preferredBoardRef = useRef<string | null>(null)

  // ---------- Saving ----------

  const pendingRef = useRef<{ path: string; doc: BoardDoc } | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())

  /** Write the pending board now. Writes run one after another. */
  const flushSave = useCallback((): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    saveChainRef.current = saveChainRef.current.then(async () => {
      const pending = pendingRef.current
      if (!pending) return
      pendingRef.current = null
      setSaveStatus('saving')
      try {
        await space.writeBoard(pending.path, serializeBoard(pending.doc))
        if (!pendingRef.current) setSaveStatus('saved')
      } catch (error) {
        console.error(`save failed for ${pending.path}: ${errorMessage(error)}`)
        pendingRef.current ??= pending // keep it for the next try
        setSaveStatus('error')
        setToast(`Could not save the board: ${errorMessage(error)}`)
      }
    })
    return saveChainRef.current
  }, [])

  const scheduleSave = useCallback(
    (path: string, doc: BoardDoc) => {
      pendingRef.current = { path, doc }
      setSaveStatus('unsaved')
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => void flushSave(), SAVE_DELAY_MS)
    },
    [flushSave]
  )

  /** Drop unsaved edits for a path (the board is gone or replaced). */
  const dropPending = (path: string): void => {
    if (pendingRef.current?.path !== path) return
    pendingRef.current = null
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    setSaveStatus('saved')
  }

  // ---------- Camera persistence ----------

  const cameraRef = useRef<{ path: string; camera: Camera } | null>(null)
  const cameraTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushCamera = useCallback(() => {
    if (cameraTimerRef.current) clearTimeout(cameraTimerRef.current)
    cameraTimerRef.current = null
    if (cameraRef.current) space.setCamera(cameraRef.current.path, cameraRef.current.camera)
  }, [])

  const onCameraChange = useCallback(
    (camera: Camera) => {
      const path = openRef.current?.path
      if (!path) return
      cameraRef.current = { path, camera }
      setZoom(camera.zoom)
      if (cameraTimerRef.current) clearTimeout(cameraTimerRef.current)
      cameraTimerRef.current = setTimeout(flushCamera, CAMERA_SAVE_DELAY_MS)
    },
    [flushCamera]
  )

  // ---------- Opening boards ----------

  const openBoard = useCallback(
    async (path: string) => {
      const token = ++openTokenRef.current
      openingRef.current = true
      try {
        await flushSave()
        flushCamera()
        let entry = cacheRef.current.get(path)
        if (!entry) {
          let doc: BoardDoc
          try {
            doc = parseBoard(await space.readBoard(path))
          } catch (error) {
            if (token !== openTokenRef.current) return
            setOpen(null)
            setBoardError({ path, message: errorMessage(error) })
            space.setLastBoard(path)
            return
          }
          entry = { doc, history: new BoardHistory() }
          cacheRef.current.set(path, entry)
        }
        const camera = await space.getCamera(path).catch(() => null)
        if (token !== openTokenRef.current) return
        cameraRef.current = camera ? { path, camera } : null
        setZoom(camera?.zoom ?? 1)
        setBoardError(null)
        setOpen({ path, key: ++keyRef.current, doc: entry.doc, history: entry.history, camera })
        space.setLastBoard(path)
      } finally {
        if (token === openTokenRef.current) openingRef.current = false
      }
    },
    [flushCamera, flushSave]
  )

  const onDocChange = useCallback(
    (doc: BoardDoc) => {
      const current = openRef.current
      if (!current) return
      const entry = cacheRef.current.get(current.path)
      if (entry) entry.doc = doc
      scheduleSave(current.path, doc)
    },
    [scheduleSave]
  )

  /** Show a new folder (or none). */
  const applySnapshot = useCallback(
    async (next: Snapshot) => {
      await flushSave()
      flushCamera()
      cacheRef.current.clear()
      openTokenRef.current++
      openingRef.current = false
      setOpen(null)
      setBoardError(null)
      setRenaming(null)
      setPreviewPath(next.devOpen ?? null)
      preferredBoardRef.current = next.folder?.lastBoard ?? null
      setTree(next.folder?.tree ?? null)
      setSnapshot(next)
    },
    [flushCamera, flushSave]
  )

  // Open a board automatically: the last one, else the first one.
  useEffect(() => {
    if (!folder || open || boardError || openingRef.current || boards.length === 0) return
    const preferred = preferredBoardRef.current
    preferredBoardRef.current = null
    const target = boards.find((board) => board.path === preferred) ?? boards[0]
    void openBoard(target.path)
  }, [folder, open, boardError, boards, openBoard])

  // ---------- Folder actions ----------

  const openFolderDialog = useCallback(async () => {
    try {
      const next = await space.openFolderDialog()
      if (next) await applySnapshot(next)
    } catch (error) {
      setToast(errorMessage(error))
    }
  }, [applySnapshot])

  const openRecent = useCallback(
    async (path: string) => {
      try {
        await applySnapshot(await space.openRecent(path))
      } catch (error) {
        setToast(errorMessage(error))
      }
    },
    [applySnapshot]
  )

  // ---------- Board actions ----------

  const createBoard = useCallback(async () => {
    if (!snapshot?.folder) return
    try {
      const path = await space.createBoard()
      setTree(await space.listFiles())
      await openBoard(path)
      setRenaming(path)
    } catch (error) {
      setToast(errorMessage(error))
    }
  }, [openBoard, snapshot])

  const renameBoard = useCallback(
    async (path: string, name: string) => {
      setRenaming(null)
      try {
        await flushSave()
        flushCamera()
        const target = await space.renameBoard(path, name)
        const entry = cacheRef.current.get(path)
        cacheRef.current.delete(path)
        if (entry) cacheRef.current.set(target, entry)
        if (openRef.current?.path === path) {
          setOpen({ ...openRef.current, path: target })
          if (cameraRef.current?.path === path) cameraRef.current = { ...cameraRef.current, path: target }
        }
        if (boardError?.path === path) setBoardError({ ...boardError, path: target })
        setTree(await space.listFiles())
      } catch (error) {
        setToast(errorMessage(error))
      }
    },
    [boardError, flushCamera, flushSave]
  )

  const deleteBoard = useCallback(
    async (path: string) => {
      if (!window.confirm(`Move “${boardName(path)}” to the Trash?`)) return
      try {
        dropPending(path)
        await saveChainRef.current // a write in progress must not recreate the file
        await space.deleteBoard(path)
        cacheRef.current.delete(path)
        if (openRef.current?.path === path) {
          openTokenRef.current++
          setOpen(null)
          cameraRef.current = null
        }
        if (boardError?.path === path) setBoardError(null)
        setTree(await space.listFiles())
      } catch (error) {
        setToast(errorMessage(error))
      }
    },
    [boardError]
  )

  const reveal = useCallback((path: string) => {
    space.revealInFinder(path).catch((error: unknown) => setToast(errorMessage(error)))
  }, [])

  const openFile = useCallback(
    (node: FileNode) => {
      if (isBoardPath(node.name)) void openBoard(node.path)
      else setPreviewPath(node.path)
    },
    [openBoard]
  )

  // ---------- Events from the main process ----------

  const onBoardChangeRef = useRef<(path: string, deleted: boolean) => Promise<void>>(async () => undefined)
  onBoardChangeRef.current = async (path, deleted) => {
    const current = openRef.current
    if (current?.path !== path) {
      cacheRef.current.delete(path) // reload from disk next time it opens
      if (boardError?.path === path && !deleted) await openBoard(path)
      return
    }
    if (deleted) {
      console.warn(`${path} was deleted on disk`)
      dropPending(path)
      cacheRef.current.delete(path)
      openTokenRef.current++
      setOpen(null)
      return
    }
    if (pendingRef.current?.path === path) {
      // Last writer wins: keep the local edits and save over the disk version.
      console.warn(`${path} changed on disk while local edits were unsaved; keeping the local version`)
      await flushSave()
      return
    }
    let doc: BoardDoc
    try {
      doc = parseBoard(await space.readBoard(path))
    } catch (error) {
      console.error(`${path} changed on disk but cannot be read: ${errorMessage(error)}`)
      setToast(`“${boardName(path)}” changed on disk but cannot be read. Showing the last good version.`)
      return
    }
    if (openRef.current?.path !== path || pendingRef.current?.path === path) return
    const history = current.history
    history.clear()
    cacheRef.current.set(path, { doc, history })
    console.log(`${path} reloaded from disk`)
    setOpen({ path, key: ++keyRef.current, doc, history, camera: cameraRef.current?.camera ?? current.camera })
  }

  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  flushRef.current = async () => {
    await flushSave()
    flushCamera()
  }

  useEffect(() => {
    let active = true
    void space.getInitialState().then((initial) => {
      if (active) void applySnapshot(initial)
    })
    const offs = [
      space.onFolderOpened((next) => void applySnapshot(next)),
      space.onFilesChanged((next) => {
        setTree(next)
        setPreviewVersion((version) => version + 1)
      }),
      space.onBoardChanged((change) => void onBoardChangeRef.current(change.path, change.deleted)),
      space.onMenuCommand((command) => {
        if (command === 'new-board') void createBoardRef.current()
        else if (command === 'zoom-in') boardRef.current?.zoomStep('in', 'menu')
        else if (command === 'zoom-out') boardRef.current?.zoomStep('out', 'menu')
        else if (command === 'zoom-reset') boardRef.current?.zoomStep('reset', 'menu')
      }),
      space.onFlushRequest(() => {
        void flushRef.current().finally(() => space.flushDone())
      })
    ]
    return () => {
      active = false
      offs.forEach((off) => off())
    }
  }, [applySnapshot])

  const createBoardRef = useRef(createBoard)
  createBoardRef.current = createBoard

  // ---------- Tool shortcuts: V P H E ----------

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return
      const tool = TOOL_KEYS[event.key.toLowerCase()]
      if (!tool) return
      event.preventDefault()
      setTools((current) => ({ ...current, tool }))
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [])

  // ---------- Render ----------

  const recent = snapshot?.recent ?? []
  const loading = snapshot === null

  let canvasContent = null
  if (!loading && !folder) {
    canvasContent = <WelcomeCard recent={recent} onOpenFolder={openFolderDialog} onOpenRecent={openRecent} />
  } else if (folder && boardError) {
    canvasContent = (
      <CanvasNotice
        icon={<AlertCircle size={18} strokeWidth={1.75} />}
        title={`“${boardName(boardError.path)}” cannot be opened`}
        body={
          <>
            {boardError.message}
            <br />
            The file is not changed. Fix it in an editor, or pick another board.
          </>
        }
      />
    )
  } else if (folder && boards.length === 0) {
    canvasContent = (
      <CanvasNotice
        icon={<LayoutDashboard size={18} strokeWidth={1.75} />}
        title="No boards yet"
        body={
          <>
            A board is a <span className="mono">.board.json</span> file in this folder.
          </>
        }
        action={{ label: 'New board', icon: <Plus size={14} strokeWidth={2} />, onClick: () => void createBoard() }}
      />
    )
  }

  return (
    <div className="shell">
      <Sidebar
        folderName={folder?.name ?? null}
        folderRoot={folder?.root ?? null}
        recent={recent}
        boards={boards}
        tree={tree}
        openBoard={open?.path ?? null}
        previewPath={previewPath}
        renaming={renaming}
        onOpenFolder={() => void openFolderDialog()}
        onOpenRecent={(path) => void openRecent(path)}
        onOpenBoard={(path) => void openBoard(path)}
        onCreateBoard={() => void createBoard()}
        onStartRename={setRenaming}
        onRename={(path, name) => void renameBoard(path, name)}
        onCancelRename={() => setRenaming(null)}
        onDeleteBoard={(path) => void deleteBoard(path)}
        onReveal={reveal}
        onOpenFile={openFile}
      />
      <main className="main">
        <TopBar
          folderName={folder?.name ?? null}
          boardName={open ? boardName(open.path) : null}
          saveStatus={open ? saveStatus : null}
          zoom={open ? zoom : null}
          onResetZoom={() => boardRef.current?.zoomTo(1)}
        />
        <div className="workspace">
          <div className="canvas">
            {open && (
              <Board
                key={open.key}
                ref={boardRef}
                doc={open.doc}
                history={open.history}
                initialCamera={open.camera}
                tool={tools.tool}
                color={colorValue(tools)}
                width={widthValue(tools)}
                onDocChange={onDocChange}
                onCameraChange={onCameraChange}
              />
            )}
            {canvasContent}
            {open && <ToolPalette state={tools} onChange={setTools} />}
            {toast && <Toast message={toast} onDone={clearToast} />}
          </div>
          {previewPath && <PreviewPanel path={previewPath} version={previewVersion} onClose={() => setPreviewPath(null)} />}
        </div>
      </main>
    </div>
  )
}
