import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, LayoutDashboard, Plus } from 'lucide-react'
import {
  BOARDS_DIR,
  boardName,
  isBoardPath,
  newItemId,
  parseBoard,
  reconcileBoard,
  serializeBoard,
  type BoardDoc,
  type LiveNode,
  type Removal
} from '@shared/board-format'
import { liveItems, validateLiveCode } from './live-pixels/registry'
import type { AgentActivity, AgentServerStatus, Camera, FileNode, FileTree, GuideOverrides, Snapshot } from '@shared/space-api'
import { AgentPresence } from './agent/edits'
import { scenePlayer } from './live/player'
import { handleAgentRequest, type AgentContext } from './agent/handler'
import { Board, type BoardHandle } from './board/Board'
import { ChangeLog } from './board/changes'
import { BoardHistory } from './board/history'
import { CanvasNotice } from './components/CanvasNotice'
import { PreviewPanel } from './components/PreviewPanel'
import { Sidebar, type BoardEntry } from './components/Sidebar'
import { SceneCaption } from './components/SceneCaption'
import { Toast } from './components/Toast'
import { ToolPalette } from './components/ToolPalette'
import { TopBar, type SaveStatus } from './components/TopBar'
import { WelcomeCard } from './components/WelcomeCard'
import { errorMessage } from './lib/errors'
import { isEditableTarget } from './lib/keys'
import { colorValue, TOOL_KEYS, widthValue, type ToolId, type ToolState } from './tools'

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
  /** Removals, for the agents' get_changes. */
  log: ChangeLog
  /** The file changed on disk while the board was closed: diff it on the next open. */
  stale?: boolean
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
  const [toast, setToast] = useState<{ text: string; kind: 'error' | 'info' } | null>(null)
  /** The "Set up this folder" menu is open (the sidebar row, the folder menu or File > Set Up Folder for Learning…). */
  const [menuSetup, setMenuSetup] = useState(false)
  /** "Don't ask" or a finished setup: no setup row until the folder opens again. */
  const [offerDismissed, setOfferDismissed] = useState(false)
  const [tools, setTools] = useState<ToolState>({ tool: 'pen', colorId: 'white', widthId: 'medium' })
  const [agentStatus, setAgentStatus] = useState<AgentServerStatus | null>(null)
  const [guideOverrides, setGuideOverrides] = useState<GuideOverrides | null>(null)
  const [agentActivity, setAgentActivity] = useState<AgentActivity & { at: number } | null>(null)

  const clearToast = useCallback(() => setToast(null), [])
  const showError = (text: string): void => setToast({ text, kind: 'error' })
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
        showError(`Could not save the board: ${errorMessage(error)}`)
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
        if (!entry || entry.stale) {
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
          if (entry) {
            // Changed on disk while closed: diff, so agents see the change.
            const reconciled = reconcileBoard(entry.doc, doc)
            entry.log.record(reconciled.removed)
            entry.history.clear()
            entry.doc = reconciled.doc
            entry.stale = false
          } else {
            entry = { doc, history: new BoardHistory(), log: new ChangeLog() }
            cacheRef.current.set(path, entry)
          }
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

  const onRemoved = useCallback((removed: Removal[]) => {
    const current = openRef.current
    if (current) cacheRef.current.get(current.path)?.log.record(removed)
  }, [])

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
      setMenuSetup(false)
      setOfferDismissed(false)
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
      showError(errorMessage(error))
    }
  }, [applySnapshot])

  const openRecent = useCallback(
    async (path: string) => {
      try {
        await applySnapshot(await space.openRecent(path))
      } catch (error) {
        showError(errorMessage(error))
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
      showError(errorMessage(error))
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
        showError(errorMessage(error))
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
        showError(errorMessage(error))
      }
    },
    [boardError]
  )

  const reveal = useCallback((path: string) => {
    space.revealInFinder(path).catch((error: unknown) => showError(errorMessage(error)))
  }, [])

  // ---------- Learning-folder setup ----------

  /** Ask the main process what the folder's guide files change. The watcher skips .learning-space. */
  const refreshGuideOverrides = useCallback(() => {
    space.getGuideOverrides().then(setGuideOverrides, (error: unknown) => console.error(errorMessage(error)))
  }, [])

  const applySetup = useCallback(async () => {
    try {
      const { created } = await space.applySetup()
      refreshGuideOverrides()
      setTree(await space.listFiles())
      setMenuSetup(false)
      setOfferDismissed(true)
      const text = created.includes('AGENTS.md')
        ? 'Folder set up — AGENTS.md created'
        : created.length
          ? `Folder set up — ${created.length} ${created.length === 1 ? 'item' : 'items'} created`
          : 'Nothing to add — the folder is already set up'
      setToast({ text, kind: 'info' })
    } catch (error) {
      showError(`Could not set up the folder: ${errorMessage(error)}`)
    }
  }, [refreshGuideOverrides])

  /** Outside click or Escape: "not now". The quiet sidebar row stays. */
  const closeSetup = useCallback(() => setMenuSetup(false), [])

  const dontAskSetup = useCallback(() => {
    setMenuSetup(false)
    setOfferDismissed(true)
    space.setSetupDontAsk(true).catch((error: unknown) => showError(errorMessage(error)))
  }, [])

  /** Open the board guide, or another override file (path), in the preview and in Finder. */
  const editGuide = useCallback(async (overridePath?: string) => {
    try {
      const path = overridePath ?? (await space.boardGuidePath())
      refreshGuideOverrides()
      if (!path) {
        setMenuSetup(true)
        setToast({ text: 'No board guide yet. Set up the folder to create .learning-space/guide.md.', kind: 'info' })
        return
      }
      setPreviewPath(path)
      setPreviewVersion((version) => version + 1)
      await space.revealInFinder(path)
    } catch (error) {
      showError(errorMessage(error))
    }
  }, [refreshGuideOverrides])

  // Poll on folder open; the main process pushes after get_guide and agent connects.
  const folderRoot = folder?.root ?? null
  useEffect(() => {
    if (!folderRoot) {
      setGuideOverrides(null)
      return
    }
    refreshGuideOverrides()
    return space.onGuideOverrides(setGuideOverrides)
  }, [folderRoot, refreshGuideOverrides])

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
      const entry = cacheRef.current.get(path)
      if (entry) {
        if (deleted) cacheRef.current.delete(path)
        else entry.stale = true // reload (and diff) from disk next time it opens
      }
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
      showError(`“${boardName(path)}” changed on disk but cannot be read. Showing the last good version.`)
      return
    }
    if (openRef.current?.path !== path || pendingRef.current?.path === path) return
    const history = current.history
    history.clear()
    const entry = cacheRef.current.get(path)
    const log = entry?.log ?? new ChangeLog()
    // Diff against the live board, so agents see the external edit as changes.
    const previous = boardRef.current?.liveState()
    const reconciled = reconcileBoard(
      previous ? { nextSeq: previous.nextSeq, nodes: [...previous.nodes], extra: doc.extra } : (entry?.doc ?? current.doc),
      doc
    )
    log.record(reconciled.removed)
    doc = reconciled.doc
    cacheRef.current.set(path, { doc, history, log })
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
        else if (command === 'setup-folder') setMenuSetup(folderRef.current !== null)
        else if (command === 'zoom-in') boardRef.current?.zoomStep('in', 'menu')
        else if (command === 'zoom-out') boardRef.current?.zoomStep('out', 'menu')
        else if (command === 'zoom-reset') boardRef.current?.zoomStep('reset', 'menu')
        else if (command === 'select-all') {
          // A focused text field selects its own text; otherwise the board selects all nodes.
          const active = document.activeElement
          if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.select()
          else if (isEditableTarget(active)) document.execCommand('selectAll')
          else boardRef.current?.selectAll()
        }
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

  // ---------- Agents (MCP) ----------

  // The key of the Board that is mounted now: set after React attaches boardRef.
  const mountedKeyRef = useRef<number | null>(null)
  const presenceRef = useRef<AgentPresence>(null as unknown as AgentPresence)
  if (!presenceRef.current) presenceRef.current = new AgentPresence()
  useEffect(() => {
    mountedKeyRef.current = open?.key ?? null
    // A remounted board shows the agents' presence again.
    presenceRef.current.attach(boardRef.current)
  }, [open])

  const toolRef = useRef(tools.tool)
  toolRef.current = tools.tool
  const boardsRef = useRef(boards)
  boardsRef.current = boards
  const folderRef = useRef(folder)
  folderRef.current = folder

  const agentContext = useCallback((): AgentContext => {
    const current = openRef.current
    const mounted = current && mountedKeyRef.current === current.key ? boardRef.current : null
    const currentFolder = folderRef.current
    return {
      folder: currentFolder ? { name: currentFolder.name, root: currentFolder.root } : null,
      boards: boardsRef.current.map((board) => board.path),
      openPath: mounted && current ? current.path : null,
      board: mounted,
      changeLog: current ? (cacheRef.current.get(current.path)?.log ?? null) : null,
      tool: toolRef.current,
      openBoard: async (path) => {
        if (openRef.current?.path !== path) await openBoardRef.current(path)
        // Wait for the Board to mount (one or two frames).
        const deadline = performance.now() + 3000
        while (performance.now() < deadline) {
          const now = openRef.current
          if (now?.path === path && mountedKeyRef.current === now.key && boardRef.current) return
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        throw new Error(`"${path}" did not open in time.`)
      },
      importAsset: (src) => space.importAsset(src),
      presence: presenceRef.current
    }
  }, [])

  const openBoardRef = useRef(openBoard)
  openBoardRef.current = openBoard

  // A live scene plays on one mounted board: a board switch or a reload ends it (its items are already final).
  const openKey = open?.key
  useEffect(() => () => scenePlayer.detach(null), [openKey])

  // Dev hook (SPACE_REMOTE_DEBUG only): scripts/drive.mjs maps board points to
  // window points and reads a little state through window.__spaceDev.
  useEffect(() => {
    if (!space.devHooks) return
    const target = window as unknown as { __spaceDev?: unknown }
    target.__spaceDev = {
      boardToClient: (x: number, y: number) => boardRef.current?.boardToClient([x, y]) ?? null,
      canvasRect: () => boardRef.current?.clientRect() ?? null,
      reveal: (x: number, y: number, width: number, height: number) => boardRef.current?.reveal({ x, y, width, height }),
      setTool: (tool: ToolId) => setTools((current) => ({ ...current, tool })),
      state: () => {
        const current = openRef.current
        const live = boardRef.current?.liveState()
        const r1 = (value: number): number => Math.round(value * 10) / 10
        return {
          board: current?.path ?? null,
          itemCount: live?.nodes.length ?? null,
          zoom: live ? Math.round(live.camera.zoom * 1000) / 1000 : null,
          center: live?.camera.center ?? null,
          tool: toolRef.current,
          selected: live?.selectedIds.length ?? 0,
          selectedIds: live ? [...live.selectedIds] : [],
          editing: document.activeElement instanceof HTMLTextAreaElement && document.activeElement.classList.contains('node-text__editor'),
          nodes: (live?.nodes ?? []).map((node) => {
            const bounds = live?.bounds(node.id)
            return {
              id: node.id,
              kind: node.kind,
              author: typeof node.author === 'string' ? node.author : null,
              parent: typeof node.parent === 'string' ? node.parent : null,
              ...(node.kind === 'text' ? { text: node.text } : {}),
              ...(node.kind === 'ink' || node.kind === 'text' ? { color: node.kind === 'ink' ? node.color : (node as { style?: Record<string, string> }).style?.color } : {}),
              bounds: bounds ? { x: r1(bounds.x), y: r1(bounds.y), width: r1(bounds.width), height: r1(bounds.height) } : null
            }
          })
        }
      },
      /** Live-scene playback (run_scene): what plays now; seek(t) holds the current scene at t s, seek(null) lets it run; finish() ends all. */
      get scene() {
        return { ...scenePlayer.state(), seek: (t: number | null) => scenePlayer.seek(t), finish: () => scenePlayer.finish(), frame: () => scenePlayer.debugFrame() }
      },
      /** Live pixel items (dev checks, scripts/lab/live.mjs): add one, list them with status and frame counts, check code. */
      live: {
        add: (fields: Partial<LiveNode> & Pick<LiveNode, 'mode' | 'code'>) => {
          const board = boardRef.current
          if (!board) return null
          const state = board.liveState()
          const node: LiveNode = {
            id: newItemId('n'),
            x: 0,
            y: 0,
            w: 400,
            h: 300,
            params: {},
            style: {},
            z: Math.max(0, ...state.nodes.filter((n) => typeof n.parent !== 'string').map((n) => (typeof n.z === 'number' ? n.z : 0))) + 1,
            author: 'agent',
            seq: 0,
            ...fields,
            kind: 'live'
          }
          board.agentCommit([...state.nodes, node])
          return node.id
        },
        update: (id: string, fields: Partial<LiveNode>) => {
          const board = boardRef.current
          if (!board) return false
          const state = board.liveState()
          board.agentCommit(state.nodes.map((n) => (n.id === id ? ({ ...n, ...fields } as typeof n) : n)))
          return true
        },
        setParams: (id: string, params: Record<string, number>) => {
          const board = boardRef.current
          if (!board) return false
          const state = board.liveState()
          board.agentCommit(state.nodes.map((n) => (n.id === id && n.kind === 'live' ? ({ ...n, params: { ...(n as LiveNode).params, ...params } } as LiveNode) : n)))
          return true
        },
        items: () => liveItems(),
        validate: (mode: 'shader' | 'canvas' | 'program', code: string, params?: Record<string, number>) => validateLiveCode(mode, code, params)
      },
      /** A node's rect in window CSS pixels, from the layout cache. */
      nodeRect: (id: string) => {
        const board = boardRef.current
        const bounds = board?.liveState().bounds(id)
        if (!board || !bounds) return null
        const topLeft = board.boardToClient([bounds.x, bounds.y])
        const bottomRight = board.boardToClient([bounds.x + bounds.width, bounds.y + bounds.height])
        if (!topLeft || !bottomRight) return null
        return { x: topLeft[0], y: topLeft[1], width: bottomRight[0] - topLeft[0], height: bottomRight[1] - topLeft[1] }
      }
    }
    return () => {
      delete target.__spaceDev
    }
  }, [])

  useEffect(() => {
    let active = true
    void space.getAgentStatus().then((status) => {
      if (active) setAgentStatus(status)
    })
    const offs = [
      space.onAgentStatus(setAgentStatus),
      space.onAgentActivity((activity) => setAgentActivity({ ...activity, at: Date.now() })),
      space.onAgentRequest((request) => {
        handleAgentRequest(request, agentContext).then(
          (result) => space.replyAgent({ requestId: request.requestId, ok: true, result }),
          (error: unknown) => space.replyAgent({ requestId: request.requestId, ok: false, error: errorMessage(error) })
        )
      })
    ]
    return () => {
      active = false
      offs.forEach((off) => off())
    }
  }, [agentContext])

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
  const hasAgentsFile = tree?.nodes.some((node) => node.kind === 'file' && node.name === 'AGENTS.md') ?? false
  const setupOffer = !!folder && !folder.setUp && !hasAgentsFile && !folder.setupDontAsk && !offerDismissed

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
        setupOffer={setupOffer}
        setupOpen={!!folder && menuSetup}
        setupVersion={previewVersion}
        onSetUpFolder={() => setMenuSetup(true)}
        onCloseSetup={closeSetup}
        onApplySetup={applySetup}
        onDontAskSetup={dontAskSetup}
        onEditGuide={() => void editGuide()}
        guideOverrides={guideOverrides}
        onOpenOverride={(path) => void editGuide(path)}
      />
      <main className="main">
        <TopBar
          folderName={folder?.name ?? null}
          boardName={open ? boardName(open.path) : null}
          saveStatus={open ? saveStatus : null}
          zoom={open ? zoom : null}
          onResetZoom={() => boardRef.current?.zoomTo(1)}
          agentStatus={agentStatus}
          agentActivityAt={agentActivity?.at ?? null}
          guideOverrides={folder ? guideOverrides : null}
          onOpenOverride={(path) => void editGuide(path)}
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
                onRemoved={onRemoved}
              />
            )}
            {canvasContent}
            {open && <SceneCaption />}
            {open && (
              <ToolPalette
                state={tools}
                onChange={setTools}
                onColor={(value) => boardRef.current?.applyColor(value)}
                onWidth={(px) => boardRef.current?.applyWidth(px)}
              />
            )}
            {toast && <Toast message={toast.text} kind={toast.kind} onDone={clearToast} />}
          </div>
          {previewPath && <PreviewPanel path={previewPath} version={previewVersion} onClose={() => setPreviewPath(null)} />}
        </div>
      </main>
    </div>
  )
}
