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
  type Author,
  type BoardDoc,
  type LiveNode,
  type Removal,
  type Revision
} from '@shared/board-format'
import { learnerEditSince } from '@shared/learner-edit'
import { liveItems, liveResources, validateWorld } from './live-pixels/registry'
import type { AgentActivity, AgentServerStatus, BoardChangeOp, BoardChangeResult, Camera, FailedSave, FileNode, FileTree, GuideOverrides, Snapshot } from '@shared/space-api'
import { scenePlayer } from './live/player'
import { handleAgentRequest, type AgentContext } from './agent/handler'
import { dropTracker, moveTracker } from './agent/groups'
import { Board, type BoardHandle } from './board/Board'
import { ChangeLog } from './board/changes'
import { BoardHistory } from './board/history'
import { CanvasNotice } from './components/CanvasNotice'
import { PreviewPanel } from './components/PreviewPanel'
import { Sidebar, type BoardEntry } from './components/Sidebar'
import { ScriptPanel } from './components/ScriptPanel'
import { Toast } from './components/Toast'
import { ToolPalette } from './components/ToolPalette'
import { TopBar, type SaveStatus } from './components/TopBar'
import { WelcomeCard } from './components/WelcomeCard'
import { errorMessage } from './lib/errors'
import { isEditableTarget } from './lib/keys'
import { setStories } from './live/stories'
import { setBoardNodes, setReadingBoard, setSelection } from './live/reading'
import { perfMeter } from './perf-meter'
import type { BoardStories } from '@shared/scene-story'
import { colorValue, TOOL_KEYS, widthValue, type ToolId, type ToolState } from './tools'

const space = window.space
/** Save this long after the last change… */
const SAVE_DELAY_MS = 400
/** …but at least this often while changes continue. */
const SAVE_MAX_WAIT_MS = 2000
/** A failed save tries again after this long. */
const SAVE_RETRY_MS = 5000
const CAMERA_SAVE_DELAY_MS = 500

/** A board's key across folders. */
const saveKey = (root: string, path: string): string => `${root}\0${path}`

interface OpenBoard {
  /** The folder the board came from: its saves go there, whichever folder is open by then. */
  root: string
  path: string
  /** Changes when the Board must remount: a board switch or a reload from disk. */
  key: number
  doc: BoardDoc
  history: BoardHistory
  camera: Camera | null
}

interface PendingSave {
  root: string
  path: string
  doc: BoardDoc
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
  /** The folder the renderer shows: reads and new boards belong to it. */
  const rootRef = useRef<string | null>(null)

  // ---------- Saving ----------

  /** The unsaved version of each board, by saveKey. A board stays here until its write succeeds, so a failure never drops edits and no other board displaces them. */
  const pendingRef = useRef(new Map<string, PendingSave>())
  /** The last writes failed: the learner has seen the error. */
  const saveFailingRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** When the oldest unsaved change was made, or null when all is saved. */
  const unsavedSinceRef = useRef<number | null>(null)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  /** nextSeq per board (saveKey) at the last read or save: learner nodes at or past it go to the learner-edit log. */
  const learnerSeqRef = useRef(new Map<string, number>())

  /** Read and parse a board from disk, and set its learner-edit baseline. */
  const readBoardDoc = async (root: string, path: string): Promise<BoardDoc> => {
    const doc = parseBoard(await space.readBoard(root, path))
    learnerSeqRef.current.set(saveKey(root, path), doc.nextSeq)
    return doc
  }

  /**
   * Write the pending boards. Runs only inside saveChainRef. A failed write keeps its board
   * pending, and the result lists it. `mustSave` names the boards a board or folder change
   * needs saved: when one of them fails, this throws (the change must not go on).
   */
  const writePending = useCallback(async (mustSave: (save: PendingSave) => boolean = () => false): Promise<FailedSave[]> => {
    const pending = pendingRef.current
    if (!pending.size) return []
    setSaveStatus('saving')
    const failed: FailedSave[] = []
    let refused: string | null = null
    for (const key of [...pending.keys()]) {
      const save = pending.get(key)
      if (!save) continue
      pending.delete(key)
      let text: string | null = null
      try {
        const start = performance.now()
        text = serializeBoard(save.doc)
        const serializeMs = performance.now() - start
        const since = learnerSeqRef.current.get(key)
        const learnerEdit = since === undefined ? null : learnerEditSince(save.doc, since)
        await space.writeBoard(save.root, save.path, text, { learnerEdit, serializeMs })
        learnerSeqRef.current.set(key, save.doc.nextSeq)
      } catch (error) {
        const message = errorMessage(error)
        console.error(`save failed for ${save.path}: ${message}`)
        if (!pending.has(key)) pending.set(key, save) // newer edits of the board, if any, hold these too
        if (text !== null) failed.push({ root: save.root, path: save.path, text })
        if (!saveFailingRef.current) showError(`Could not save the board: ${message}`)
        saveFailingRef.current = true
        if (mustSave(save)) refused ??= `“${boardName(save.path)}” could not be saved first, so nothing was changed: ${message}`
      }
    }
    if (failed.length) setSaveStatus('error')
    else {
      saveFailingRef.current = false
      setSaveStatus(pending.size ? 'unsaved' : 'saved')
    }
    if (refused) throw new Error(refused)
    return failed
  }, [])

  /** Write the pending boards now, and resolve with the ones that failed. Writes run one after another. */
  const flushSave = useCallback((): Promise<FailedSave[]> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    unsavedSinceRef.current = null
    const run = saveChainRef.current.then(() => writePending())
    saveChainRef.current = run.then(
      () => undefined,
      () => undefined
    )
    return run.finally(() => {
      // Saves that failed try again, also with no new edit.
      if (pendingRef.current.size && !saveTimerRef.current) saveTimerRef.current = setTimeout(() => void flushSaveRef.current(), SAVE_RETRY_MS)
    })
  }, [writePending])
  const flushSaveRef = useRef(flushSave)
  flushSaveRef.current = flushSave

  /** Save what is pending soon (after a board or folder change that held the saves). */
  const saveSoon = useCallback(() => {
    if (!pendingRef.current.size) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => void flushSaveRef.current(), SAVE_DELAY_MS)
  }, [])

  const scheduleSave = useCallback(
    (root: string, path: string, doc: BoardDoc) => {
      pendingRef.current.set(saveKey(root, path), { root, path, doc })
      setSaveStatus('unsaved')
      const now = Date.now()
      unsavedSinceRef.current ??= now
      const delay = Math.max(0, Math.min(SAVE_DELAY_MS, unsavedSinceRef.current + SAVE_MAX_WAIT_MS - now))
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => void flushSave(), delay)
    },
    [flushSave]
  )

  /** There are unsaved edits for this board of the folder on show. */
  const isPending = (path: string): boolean => rootRef.current !== null && pendingRef.current.has(saveKey(rootRef.current, path))

  /** Drop unsaved edits for a path (the board is gone or replaced). */
  const dropPending = (path: string): void => {
    if (!isPending(path)) return
    pendingRef.current.delete(saveKey(rootRef.current as string, path))
    if (pendingRef.current.size) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    unsavedSinceRef.current = null
    setSaveStatus('saved')
  }

  // ---------- Camera persistence ----------

  const cameraRef = useRef<{ root: string; path: string; camera: Camera } | null>(null)
  const cameraTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushCamera = useCallback(() => {
    if (cameraTimerRef.current) clearTimeout(cameraTimerRef.current)
    cameraTimerRef.current = null
    if (cameraRef.current) space.setCamera(cameraRef.current.root, cameraRef.current.path, cameraRef.current.camera)
  }, [])

  const onCameraChange = useCallback(
    (camera: Camera) => {
      const current = openRef.current
      if (!current) return
      cameraRef.current = { root: current.root, path: current.path, camera }
      setZoom(camera.zoom)
      if (cameraTimerRef.current) clearTimeout(cameraTimerRef.current)
      cameraTimerRef.current = setTimeout(flushCamera, CAMERA_SAVE_DELAY_MS)
    },
    [flushCamera]
  )

  // ---------- Opening boards ----------

  /** The scene records of a board that mounts (an open, a reload of the open board from disk): its stories, and the id it must have (main/scene-store.ts; a copied board file gets a new one). */
  const boardRecords = (path: string, doc: BoardDoc): Promise<BoardStories | null> =>
    space.openSceneRecords(path, doc.id ?? null).catch((error: unknown) => {
      console.error(`scene records of ${path} could not be read: ${errorMessage(error)}`)
      return null
    })

  /** The board that mounts now takes its records: the stories, and its new id (saved at once). Returns the doc to mount. */
  const mountRecords = (root: string, path: string, doc: BoardDoc, records: BoardStories | null): BoardDoc => {
    setStories(records)
    if (!records?.id || records.id === doc.id) return doc
    const next = { ...doc, id: records.id }
    scheduleSave(root, path, next)
    return next
  }

  /** The board kept in a recovery file (main/recovery.ts), or null. */
  const recoveryOf = async (root: string, path: string): Promise<BoardDoc | null> => {
    try {
      const text = await space.readRecovery(root, path)
      return text === null ? null : parseBoard(text)
    } catch (error) {
      console.error(`the recovery of ${path} cannot be read: ${errorMessage(error)}`)
      return null
    }
  }

  const openBoard = useCallback(
    async (path: string) => {
      const root = rootRef.current
      if (!root) return
      const token = ++openTokenRef.current
      openingRef.current = true
      try {
        boardRef.current?.settle()
        await flushSave()
        flushCamera()
        let recovered = false
        let entry = cacheRef.current.get(path)
        if (!entry || entry.stale) {
          let doc: BoardDoc
          try {
            doc = await readBoardDoc(root, path)
          } catch (error) {
            if (token !== openTokenRef.current) return
            setOpen(null)
            setBoardError({ path, message: errorMessage(error) })
            space.setLastBoard(root, path)
            return
          }
          if (entry) {
            // Changed on disk while closed: diff, so agents see the change.
            const reconciled = reconcileBoard(entry.doc, doc)
            entry.log.record(reconciled.removed)
            entry.log.revise(reconciled.revisions)
            entry.history.clear()
            entry.doc = reconciled.doc
            entry.stale = false
          } else {
            // Edits still pending for a board that was closed (a folder left and opened again) are the board.
            entry = { doc: pendingRef.current.get(saveKey(root, path))?.doc ?? doc, history: new BoardHistory(), log: new ChangeLog() }
            const kept = await recoveryOf(root, path)
            if (token !== openTokenRef.current) return
            if (kept) {
              // Work that a failed save kept at close comes back, as a change from the file.
              const reconciled = reconcileBoard(doc, kept)
              entry.log.record(reconciled.removed)
              entry.log.revise(reconciled.revisions)
              entry.doc = reconciled.doc
              recovered = true
            }
            cacheRef.current.set(path, entry)
          }
        }
        if (token !== openTokenRef.current) return
        const [camera, records] = await Promise.all([space.getCamera(path).catch(() => null), boardRecords(path, entry.doc)])
        if (token !== openTokenRef.current) return
        entry.doc = mountRecords(root, path, entry.doc, records)
        cameraRef.current = camera ? { root, path, camera } : null
        setZoom(camera?.zoom ?? 1)
        setBoardError(null)
        setOpen({ root, path, key: ++keyRef.current, doc: entry.doc, history: entry.history, camera })
        space.setLastBoard(root, path)
        if (recovered) {
          scheduleSave(root, path, entry.doc)
          setToast({ text: `Your unsaved work on “${boardName(path)}” is back`, kind: 'info' })
        }
      } finally {
        if (token === openTokenRef.current) openingRef.current = false
      }
    },
    [flushCamera, flushSave, scheduleSave]
  )

  const onChanges = useCallback(({ removed, revisions, by }: { removed: Removal[]; revisions: Revision[]; by: Author }) => {
    const current = openRef.current
    const log = current ? cacheRef.current.get(current.path)?.log : undefined
    if (!log) return
    log.record(removed)
    log.revise(revisions, by)
  }, [])

  const onDocChange = useCallback(
    (doc: BoardDoc) => {
      const current = openRef.current
      if (!current) return
      const entry = cacheRef.current.get(current.path)
      if (entry) entry.doc = doc
      scheduleSave(current.root, current.path, doc)
    },
    [scheduleSave]
  )

  /** Show a new folder (or none). Edits made after the last save stay pending under the folder they belong to. */
  const applySnapshot = useCallback((next: Snapshot) => {
    rootRef.current = next.folder?.root ?? null
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
  }, [])

  // Open a board automatically: the last one, else the first one.
  useEffect(() => {
    if (!folder || open || boardError || openingRef.current || boards.length === 0) return
    const preferred = preferredBoardRef.current
    preferredBoardRef.current = null
    const target = boards.find((board) => board.path === preferred) ?? boards[0]
    void openBoard(target.path)
  }, [folder, open, boardError, boards, openBoard])

  // ---------- Folder actions ----------

  /**
   * The one folder switch, for every route (the menu, the dialog, the recent list). It runs in
   * the save chain, so no save or board change interleaves with it:
   *   1. the open editor commits, and the pending save is written to the folder it belongs to;
   *      a failed save fails the switch (nothing is changed);
   *   2. the main process makes the new folder the open one;
   *   3. here the new folder replaces the old one.
   * An edit that comes in during step 2 stays pending under the old folder, and the save below
   * writes it there.
   */
  const switchFolder = useCallback(
    async (path: string): Promise<void> => {
      const leaving = rootRef.current
      boardRef.current?.settle()
      flushCamera()
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      unsavedSinceRef.current = null
      const run = saveChainRef.current.then(async () => {
        await writePending((save) => save.root === leaving)
        boardRef.current?.settle()
        applySnapshot(await space.openFolder(path))
      })
      saveChainRef.current = run.catch(() => undefined)
      try {
        await run
      } finally {
        saveSoon()
      }
    },
    [applySnapshot, flushCamera, saveSoon, writePending]
  )

  const openRecent = useCallback(
    async (path: string) => {
      try {
        await switchFolder(path)
      } catch (error) {
        showError(errorMessage(error))
      }
    },
    [switchFolder]
  )

  const openFolderDialog = useCallback(async () => {
    try {
      const path = await space.pickFolder()
      if (path) await switchFolder(path)
    } catch (error) {
      showError(errorMessage(error))
    }
  }, [switchFolder])

  // ---------- Board actions ----------

  /**
   * The one board-change operation: create, rename or trash a board, for the sidebar and
   * for agents (open_board, move_board). It runs in the save chain, so no save interleaves with it:
   *   1. the pending save is written; a failed save fails the change (nothing is changed);
   *   2. the main process changes the file and moves or ends the drafts, change cursors,
   *      stage and board cache (main/index.ts → AgentServer.boardMoved);
   *   3. here the board's cache (document, undo history, change log), learner-edit
   *      baseline, ink group ids, camera and open path move to the new path, or end on trash.
   * A renamed open board stays mounted (same undo history, same live scene). A trashed open
   * board closes, and the app opens the first board of the list (the effect above).
   * The new file list is set in the same render as the move, so the old path never reopens.
   */
  const changeBoard = useCallback(
    async (op: BoardChangeOp): Promise<BoardChangeResult> => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      unsavedSinceRef.current = null
      flushCamera()
      const run = saveChainRef.current.then(async (): Promise<BoardChangeResult> => {
        await writePending((save) => op.op !== 'create' && save.root === rootRef.current && save.path === op.path)
        if (op.op === 'create') {
          const path = await space.createBoard(op.name, op.folder)
          setTree(await space.listFiles())
          return { path, wasOpen: false }
        }
        const from = op.path
        const wasOpen = openRef.current?.path === from
        const target = op.op === 'rename' ? await space.renameBoard(from, op.name) : (await space.deleteBoard(from), null)
        const tree = await space.listFiles()
        if (target === from) return { path: from, wasOpen }
        const entry = cacheRef.current.get(from)
        cacheRef.current.delete(from)
        const root = rootRef.current as string
        const seq = learnerSeqRef.current.get(saveKey(root, from))
        learnerSeqRef.current.delete(saveKey(root, from))
        if (target) {
          if (entry) cacheRef.current.set(target, entry)
          if (seq !== undefined) learnerSeqRef.current.set(saveKey(root, target), seq)
          moveTracker(from, target)
          // Edits made while the file moved are saved under the new path.
          const pending = pendingRef.current.get(saveKey(root, from))
          if (pending) {
            pendingRef.current.delete(saveKey(root, from))
            pendingRef.current.set(saveKey(root, target), { ...pending, path: target })
          }
          if (cameraRef.current?.path === from) cameraRef.current = { ...cameraRef.current, path: target }
          if (openRef.current?.path === from) {
            openRef.current = { ...openRef.current, path: target }
            setOpen(openRef.current)
          }
          setBoardError((error) => (error?.path === from ? { ...error, path: target } : error))
        } else {
          dropTracker(from)
          dropPending(from)
          if (cameraRef.current?.path === from) cameraRef.current = null
          if (openRef.current?.path === from) {
            openTokenRef.current++
            openRef.current = null
            setOpen(null)
          }
          setBoardError((error) => (error?.path === from ? null : error))
        }
        setTree(tree)
        return { path: target ?? from, wasOpen }
      })
      saveChainRef.current = run.then(
        () => undefined,
        () => undefined
      )
      try {
        return await run
      } finally {
        // Edits still pending (made while the operation ran, or a save that failed) are saved again now, under the current path.
        saveSoon()
      }
    },
    [flushCamera, saveSoon, writePending]
  )

  const createBoard = useCallback(async () => {
    if (!snapshot?.folder) return
    try {
      const { path } = await changeBoard({ op: 'create' })
      await openBoard(path)
      setRenaming(path)
    } catch (error) {
      showError(errorMessage(error))
    }
  }, [changeBoard, openBoard, snapshot])

  const renameBoard = useCallback(
    async (path: string, name: string) => {
      setRenaming(null)
      try {
        await changeBoard({ op: 'rename', path, name })
      } catch (error) {
        showError(errorMessage(error))
      }
    },
    [changeBoard]
  )

  const deleteBoard = useCallback(
    async (path: string) => {
      if (!window.confirm(`Move “${boardName(path)}” to the Trash?`)) return
      try {
        await changeBoard({ op: 'trash', path })
      } catch (error) {
        showError(errorMessage(error))
      }
    },
    [changeBoard]
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
      if (deleted) dropPending(path)
      else if (isPending(path)) {
        // As for the open board: the local edits win, and they are saved over the disk version.
        await flushSave()
        return
      }
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
    if (isPending(path)) {
      // Last writer wins: keep the local edits and save over the disk version.
      console.warn(`${path} changed on disk while local edits were unsaved; keeping the local version`)
      await flushSave()
      return
    }
    let doc: BoardDoc
    try {
      doc = await readBoardDoc(current.root, path)
    } catch (error) {
      console.error(`${path} changed on disk but cannot be read: ${errorMessage(error)}`)
      showError(`“${boardName(path)}” changed on disk but cannot be read. Showing the last good version.`)
      return
    }
    if (openRef.current?.path !== path || isPending(path)) return
    // A file that replaced the open board's mounts as any board does: its records, and the duplicate-id check.
    const token = openTokenRef.current
    const records = await boardRecords(path, doc)
    if (token !== openTokenRef.current || openRef.current?.path !== path || isPending(path)) return
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
    log.revise(reconciled.revisions)
    doc = mountRecords(current.root, path, reconciled.doc, records)
    cacheRef.current.set(path, { doc, history, log })
    console.log(`${path} reloaded from disk`)
    setOpen({ root: current.root, path, key: ++keyRef.current, doc, history, camera: cameraRef.current?.camera ?? current.camera })
  }

  // The reading panel and the scene pill belong to the open board (live/reading.ts).
  const openPath = open?.path ?? null
  useEffect(() => setReadingBoard(openPath), [openPath])
  useEffect(() => setBoardNodes(() => boardRef.current?.liveState().nodes ?? []), [])

  // View > Show performance: main holds the choice; the top bar's pill follows it.
  const [showPerformance, setShowPerformance] = useState(false)
  useEffect(() => {
    void space.getShowPerformance().then(setShowPerformance)
  }, [])

  /** Save everything now: the open editor first. Resolves with the boards that could not be saved. */
  const flushRef = useRef<() => Promise<FailedSave[]>>(async () => [])
  flushRef.current = async () => {
    try {
      boardRef.current?.settle()
    } catch (error) {
      console.error(`could not commit the open edit: ${errorMessage(error)}`)
    }
    flushCamera()
    return flushSave()
  }

  useEffect(() => {
    let active = true
    void space.getInitialState().then((initial) => {
      if (active) applySnapshot(initial)
    })
    const offs = [
      space.onFilesChanged((next) => {
        setTree(next)
        setPreviewVersion((version) => version + 1)
      }),
      space.onBoardChanged((change) => void onBoardChangeRef.current(change.path, change.deleted)),
      // Main sends the stories of the board the window shows; reads take them only for that board's path (live/stories.ts).
      // Main sends a board's stories after each new record line; they are for the open board only when its id is theirs.
      space.onSceneStories((stories) => {
        if (stories.id && boardRef.current?.boardId() === stories.id) setStories(stories)
      }),
      space.onMenuCommand((command) => {
        if (command === 'open-folder') void openFolderDialogRef.current()
        else if (command === 'new-board') void createBoardRef.current()
        else if (command === 'setup-folder') setMenuSetup(folderRef.current !== null)
        else if (command === 'zoom-in') boardRef.current?.zoomStep('in', 'menu')
        else if (command === 'zoom-out') boardRef.current?.zoomStep('out', 'menu')
        else if (command === 'zoom-reset') boardRef.current?.zoomStep('reset', 'menu')
        else if (command === 'show-performance') setShowPerformance(true)
        else if (command === 'hide-performance') setShowPerformance(false)
        else if (command === 'select-all') {
          // A focused text field selects its own text; otherwise the board selects all nodes.
          const active = document.activeElement
          if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.select()
          else if (isEditableTarget(active)) document.execCommand('selectAll')
          else boardRef.current?.selectAll()
        }
      }),
      space.onFlushRequest(() => {
        space.flushStarted()
        void flushRef.current().then(space.flushDone, (error: unknown) => {
          console.error(`save at close failed: ${errorMessage(error)}`)
          space.flushDone([])
        })
      })
    ]
    return () => {
      active = false
      offs.forEach((off) => off())
    }
  }, [applySnapshot])

  const createBoardRef = useRef(createBoard)
  createBoardRef.current = createBoard
  const openFolderDialogRef = useRef(openFolderDialog)
  openFolderDialogRef.current = openFolderDialog

  // ---------- Agents (MCP) ----------

  // The key of the Board that is mounted now: set after React attaches boardRef.
  const mountedKeyRef = useRef<number | null>(null)
  useEffect(() => {
    mountedKeyRef.current = open?.key ?? null
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
      unsaved: !!current && isPending(current.path),
      changeBoard: (op) => changeBoardRef.current(op),
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
      saveNow: async () => (await flushRef.current()).length === 0
    }
  }, [])

  const openBoardRef = useRef(openBoard)
  openBoardRef.current = openBoard
  const changeBoardRef = useRef(changeBoard)
  changeBoardRef.current = changeBoard
  const sidebarRef = useRef({ renameBoard, deleteBoard, openRecent })
  sidebarRef.current = { renameBoard, deleteBoard, openRecent }

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
      /** Live-scene playback (play_scene): what plays now; seek(t) holds the current scene at t s, seek(null) lets it run; finish() ends all. */
      get scene() {
        return { ...scenePlayer.state(), seek: (t: number | null) => scenePlayer.seek(t), finish: () => scenePlayer.finish(), frame: () => scenePlayer.debugFrame(), snap: () => { const s = scenePlayer.snapshot(); return s && { overrides: [...s.frame.overrides], inks: s.frame.inks } } }
      },
      /** Worlds (dev checks): add one, list them with status and frame counts, check code. */
      live: {
        add: (fields: Partial<LiveNode> & Pick<LiveNode, 'code'>) => {
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
          board.agentCommit(state.nodes, [...state.nodes, node])
          return node.id
        },
        update: (id: string, fields: Partial<LiveNode>) => {
          const board = boardRef.current
          if (!board) return false
          const state = board.liveState()
          board.agentCommit(state.nodes, state.nodes.map((n) => (n.id === id ? ({ ...n, ...fields } as typeof n) : n)))
          return true
        },
        setParams: (id: string, params: Record<string, number>) => {
          const board = boardRef.current
          if (!board) return false
          const state = board.liveState()
          board.agentCommit(state.nodes, state.nodes.map((n) => (n.id === id && n.kind === 'live' ? ({ ...n, params: { ...(n as LiveNode).params, ...params } } as LiveNode) : n)))
          return true
        },
        items: () => liveItems(),
        resources: () => liveResources(),
        validate: (code: string, params?: Record<string, number>) => validateWorld(code, params)
      },
      /** The render meter (scripts/perf/render.mjs): start(), stop(), read(). */
      perf: perfMeter,
      /** The sidebar's own actions (dev checks, scripts/drive.mjs): the same callbacks as its Rename, Move to Trash and recent-folder items; trash answers the confirm with OK. */
      sidebar: {
        rename: (path: string, name: string) => sidebarRef.current.renameBoard(path, name),
        openRecent: (path: string) => sidebarRef.current.openRecent(path),
        trash: (path: string) => {
          const confirm = window.confirm
          window.confirm = () => true
          try {
            return sidebarRef.current.deleteBoard(path)
          } finally {
            window.confirm = confirm
          }
        }
      },
      /** Close the window as the red button does (scripts/drive.mjs close). */
      close: () => space.devClose(),
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
          showPerformance={showPerformance}
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
                onChanges={onChanges}
                onSelectionChange={setSelection}
              />
            )}
            {canvasContent}
            {open && <ScriptPanel key={open.path} />}
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
