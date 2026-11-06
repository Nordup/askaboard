import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { AlertCircle, LayoutDashboard, Plus } from 'lucide-react'
import {
  boardName,
  newItemId,
  parseBoard,
  reconcileBoard,
  serializeBoard,
  type Author,
  type BoardDoc,
  type BoardNode,
  type LiveNode,
  type Removal,
  type Revision
} from '@shared/board-format'
import { learnerEditSince } from '@shared/learner-edit'
import { liveItems, liveResources, validateWorld } from './live-pixels/registry'
import type { AgentActivity, AgentServerStatus, BoardChangeOp, BoardChangeResult, BoardList, BoardListEntry, Camera, FailedSave, FileTree, GuideOverrides, ShellState, Snapshot } from '@shared/space-api'
import { scenePlayer } from './live/player'
import { handleAgentRequest, type AgentContext } from './agent/handler'
import { dropTracker, moveTracker } from './agent/groups'
import { Board, type BoardHandle } from './board/Board'
import { ChangeLog } from './board/changes'
import { BoardHistory, boardBytes } from './board/history'
import { HOME_ZOOM } from './board/geometry'
import { strokeShapeBytes } from './board/paint'
import { CanvasNotice } from './components/CanvasNotice'
import { PreviewPanel } from './components/PreviewPanel'
import { SearchPanel } from './components/SearchPanel'
import { Sidebar } from './components/Sidebar'
import { ScriptPanel } from './components/ScriptPanel'
import { Toast } from './components/Toast'
import { BoardControls } from './components/BoardControls'
import { BoardMenu, hasBoardMenu } from './components/BoardMenu'
import type { CommandContext } from './board/commands'
import { TopBar, type SaveStatus } from './components/TopBar'
import { WelcomeCard } from './components/WelcomeCard'
import { errorMessage } from './lib/errors'
import { isEditableTarget } from './lib/keys'
import { isMac } from './platform'
import { setStories } from './live/stories'
import { setBoardNodes, setReadingBoard, setSelection } from './live/reading'
import { perfMeter } from './perf-meter'
import type { BoardStories } from '@shared/scene-story'
import { chooseTool, INITIAL_TOOLS, LOCK_KEY, toolForKey, type ToolId, type ToolState } from './tools'
import type { SelectionStyle, StylePatch } from './board/style'

const space = window.space
/** Save this long after the last change… */
const SAVE_DELAY_MS = 400
/** …but at least this often while changes continue. */
const SAVE_MAX_WAIT_MS = 2000
/** A failed save tries again after this long. */
const SAVE_RETRY_MS = 5000
const CAMERA_SAVE_DELAY_MS = 500
/** About the bytes of the nodes of all boards in memory, the open one too. */
const MAX_BOARD_BYTES = 64 * 1024 * 1024

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

/** About the bytes that a board holds in memory. Its undo and its change log share node objects, and point arrays, with the document. */
function entryBytes({ doc, history, log }: CacheEntry): number {
  const nodes = new Set<BoardNode>(doc.nodes)
  const add = (node: BoardNode): void => void nodes.add(node)
  history.eachNode(add)
  log.eachNode(add)
  return boardBytes(nodes)
}

const NO_BOARDS: BoardListEntry[] = []

/** The one rule for the boards list: of the same folder, the list with the higher seq stays; a list of another folder replaces it. */
const newerList = (current: BoardList | null, list: BoardList): BoardList => (current && current.root === list.root && current.seq >= list.seq ? current : list)

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  /** The folder's files: only for the setup offer (AGENTS.md). The boards come from boardList. */
  const [tree, setTree] = useState<FileTree | null>(null)
  /** The boards list as the main process sends it (newest edit first): the one copy, for the sidebar, the auto-open and agents. */
  const [boardList, setBoardList] = useState<BoardList | null>(null)
  const [open, setOpen] = useState<OpenBoard | null>(null)
  const [boardError, setBoardError] = useState<{ path: string; message: string } | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  /** The zoom the zoom pill shows: the camera zoom as a share of the home zoom (1 is 100%). */
  const [zoom, setZoom] = useState(1)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewVersion, setPreviewVersion] = useState(0)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [toast, setToast] = useState<{ text: string; kind: 'error' | 'info' } | null>(null)
  /** The "Set up this folder" menu is open (the sidebar row, the folder menu or File > Set Up Folder for Learning…). */
  const [menuSetup, setMenuSetup] = useState(false)
  /** "Don't ask" or a finished setup: no setup row until the folder opens again. */
  const [offerDismissed, setOfferDismissed] = useState(false)
  const [tools, setTools] = useState<ToolState>(INITIAL_TOOLS)
  /** The selection's style, for the style pill (Board onSelectionStyle). */
  const [selectionStyle, setSelectionStyle] = useState<SelectionStyle | null>(null)
  /** The right-click menu: where it opened, on which mounted board, and what its commands could do then. */
  const [boardMenu, setBoardMenu] = useState<{ x: number; y: number; board: number; context: CommandContext } | null>(null)
  const closeBoardMenu = useCallback(() => setBoardMenu(null), [])
  const [agentStatus, setAgentStatus] = useState<AgentServerStatus | null>(null)
  const [guideOverrides, setGuideOverrides] = useState<GuideOverrides | null>(null)
  const [agentActivity, setAgentActivity] = useState<AgentActivity & { at: number } | null>(null)

  const clearToast = useCallback(() => setToast(null), [])
  const showError = (text: string): void => setToast({ text, kind: 'error' })
  const folder = snapshot?.folder ?? null
  const boards = boardList?.boards ?? NO_BOARDS

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

  /** Take a boards list from main: only of the folder shown, and only newer than the one shown (a late list is dropped). */
  const takeBoards = useCallback((list: BoardList) => {
    if (list.root !== rootRef.current) return
    setBoardList((current) => newerList(current, list))
  }, [])

  // ---------- Saving ----------

  /** The newest unsaved version of each board, by saveKey. A version stays here until its own write succeeds, also during that write, so what the file lacks is always here: a failure drops nothing, and no other board displaces it. */
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
   * pending, and the result says that one failed. `mustSave` names the boards a board or folder
   * change needs saved: when one of them fails, this throws (the change must not go on).
   */
  const writePending = useCallback(async (mustSave: (save: PendingSave) => boolean = () => false): Promise<boolean> => {
    const pending = pendingRef.current
    if (!pending.size) return false
    setSaveStatus('saving')
    let failed = false
    let refused: string | null = null
    for (const key of [...pending.keys()]) {
      const save = pending.get(key)
      if (!save) continue
      try {
        const start = performance.now()
        const text = serializeBoard(save.doc)
        const serializeMs = performance.now() - start
        const since = learnerSeqRef.current.get(key)
        const learnerEdit = since === undefined ? null : learnerEditSince(save.doc, since)
        await space.writeBoard(save.root, save.path, text, { learnerEdit, serializeMs })
        learnerSeqRef.current.set(key, save.doc.nextSeq)
        if (pending.get(key) === save) pending.delete(key) // a newer version stays
      } catch (error) {
        const message = errorMessage(error)
        console.error(`save failed for ${save.path}: ${message}`)
        failed = true
        if (!saveFailingRef.current) showError(`Could not save the board: ${message}`)
        saveFailingRef.current = true
        if (mustSave(save)) refused ??= `“${boardName(save.path)}” could not be saved first, so nothing was changed: ${message}`
      }
    }
    if (failed) setSaveStatus('error')
    else {
      saveFailingRef.current = false
      setSaveStatus(pending.size ? 'unsaved' : 'saved')
    }
    if (refused) throw new Error(refused)
    return failed
  }, [])

  /** Write the pending boards now, and resolve with true when a write failed. Writes run one after another. */
  const flushSave = useCallback((): Promise<boolean> => {
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
      // The zoom pill shows whole percents: a pan or a small zoom step renders nothing.
      setZoom(Math.round((camera.zoom / HOME_ZOOM) * 100) / 100)
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

  /**
   * The mounted Board is about to go: commit what the learner has open. Call it in the same
   * task as the setOpen that unmounts the Board. A stroke can start in any await before that.
   */
  const leaveBoard = useCallback((): void => {
    try {
      boardRef.current?.settle()
    } catch (error) {
      console.error(`could not commit the open edit: ${errorMessage(error)}`)
    }
  }, [])

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

  /**
   * Closed boards stay in memory for a fast way back, within MAX_BOARD_BYTES. A board costs all
   * the nodes it holds: its document, its undo and its change log, each node object once.
   * A board that leaves opens from its file, and its undo and its change log go with it, as after a restart.
   * A board with an unsaved version stays: pendingRef holds what its file lacks.
   */
  const trimBoards = (openPath: string): void => {
    const root = rootRef.current
    const sizes = new Map([...cacheRef.current].map(([path, entry]) => [path, entryBytes(entry)]))
    let bytes = 0
    for (const size of sizes.values()) bytes += size
    for (const [path, size] of sizes) {
      if (bytes <= MAX_BOARD_BYTES) break
      if (path === openPath || (root && pendingRef.current.has(saveKey(root, path)))) continue
      cacheRef.current.delete(path)
      bytes -= size
    }
  }

  const openBoard = useCallback(
    async (path: string) => {
      const root = rootRef.current
      if (!root) return
      const token = ++openTokenRef.current
      openingRef.current = true
      try {
        leaveBoard()
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
            leaveBoard()
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
        // The boards of the cache in the order of their use: the board left longest ago goes first.
        cacheRef.current.delete(path)
        cacheRef.current.set(path, entry)
        const [camera, records] = await Promise.all([space.getCamera(path).catch(() => null), boardRecords(path, entry.doc)])
        if (token !== openTokenRef.current) return
        leaveBoard()
        entry.doc = mountRecords(root, path, entry.doc, records)
        cameraRef.current = camera ? { root, path, camera } : null
        setZoom(camera ? Math.round((camera.zoom / HOME_ZOOM) * 100) / 100 : 1)
        setBoardError(null)
        setOpen({ root, path, key: ++keyRef.current, doc: entry.doc, history: entry.history, camera })
        trimBoards(path)
        space.setLastBoard(root, path)
        if (recovered) {
          scheduleSave(root, path, entry.doc)
          setToast({ text: `Your unsaved work on “${boardName(path)}” is back`, kind: 'info' })
        }
      } finally {
        if (token === openTokenRef.current) openingRef.current = false
      }
    },
    [flushCamera, flushSave, leaveBoard, scheduleSave]
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
    leaveBoard()
    const leaving = rootRef.current
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
    const list = next.folder?.boards ?? null
    setBoardList((current) => (list ? newerList(current, list) : null))
    setSnapshot(next)
    // Main read the snapshot's list early: a newer list it sent before the folder changed here was dropped. Ask once, by the same rule.
    if (list && list.root !== leaving) void space.getBoards().then(takeBoards, (error: unknown) => console.error(`boards list: ${errorMessage(error)}`))
  }, [leaveBoard, takeBoards])

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
   *   3. here the open editor and a held stroke commit, and the new folder replaces the old one.
   * An edit that comes in during step 2, or that step 3 commits, stays pending under the old
   * folder, and the save below writes it there.
   */
  const switchFolder = useCallback(
    async (path: string): Promise<void> => {
      const leaving = rootRef.current
      leaveBoard()
      flushCamera()
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      unsavedSinceRef.current = null
      const run = saveChainRef.current.then(async () => {
        await writePending((save) => save.root === leaving)
        applySnapshot(await space.openFolder(path))
      })
      saveChainRef.current = run.catch(() => undefined)
      try {
        await run
      } finally {
        saveSoon()
      }
    },
    [applySnapshot, flushCamera, leaveBoard, saveSoon, writePending]
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
          takeBoards(await space.getBoards())
          return { path, wasOpen: false }
        }
        const from = op.path
        const wasOpen = openRef.current?.path === from
        const target = op.op === 'rename' ? await space.renameBoard(from, op.name) : (await space.deleteBoard(from), null)
        const list = await space.getBoards()
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
        takeBoards(list)
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
    [flushCamera, saveSoon, takeBoards, writePending]
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

  /** The search panel's `New board "…"`: a board with that name (main makes the file name safe), opened, no rename step. */
  const createNamedBoard = useCallback(
    async (name: string) => {
      if (!snapshot?.folder) return
      // A typed name that main's safe form turns into an existing board's name opens that board.
      const existing = boards.find((board) => board.dir === null && board.name.toLowerCase() === name.toLowerCase())
      try {
        const path = existing ? existing.path : (await changeBoard({ op: 'create', name })).path
        await openBoard(path)
      } catch (error) {
        showError(errorMessage(error))
      }
    },
    [boards, changeBoard, openBoard, snapshot]
  )

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
    if (token !== openTokenRef.current || openRef.current?.path !== path) return
    leaveBoard()
    if (isPending(path)) {
      // A gesture held through the read is now a commit: last writer wins, as above.
      console.warn(`${path} changed on disk during a held gesture; keeping the local version`)
      await flushSave()
      return
    }
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

  // ---------- Window chrome: the sidebar setting and full screen ----------

  // Main owns both (state.json, the window); the start values come in one sync call, so the first paint has the right layout.
  const [shellStart] = useState<ShellState>(() => space.getShellState())
  const [sidebarHidden, setSidebarHidden] = useState(shellStart.sidebarHidden)
  const [fullScreen, setFullScreen] = useState(shellStart.fullScreen)
  /** The setting as last asked for, so two quick toggles are two changes before main answers. */
  const sidebarHiddenRef = useRef(shellStart.sidebarHidden)
  /**
   * The one place the setting changes here (the sidebar button, ⌘B, the View menu). Before the sidebar hides, a rename
   * in it commits through its own blur (the field unmounts with no blur of its own). The setup flyout hangs at the
   * sidebar's edge, so it closes on each change, as the sidebar's own menus do.
   */
  const changeSidebarHidden = useCallback((hidden: boolean): boolean => {
    if (hidden === sidebarHiddenRef.current) return false
    const active = document.activeElement
    if (hidden && active instanceof HTMLElement && active.closest('.sidebar')) active.blur()
    sidebarHiddenRef.current = hidden
    setSidebarHidden(hidden)
    setMenuSetup(false)
    return true
  }, [])
  useEffect(() => {
    const offs = [space.onSidebarHidden(changeSidebarHidden), space.onFullScreen(setFullScreen)]
    return () => offs.forEach((off) => off())
  }, [changeSidebarHidden])
  const toggleSidebar = useCallback(() => {
    if (changeSidebarHidden(!sidebarHiddenRef.current)) space.setSidebarHidden(sidebarHiddenRef.current)
  }, [changeSidebarHidden])

  // The search panel (⌘K, the "Search boards" row): open only with a folder; a second ⌘K closes it.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(false)
  searchOpenRef.current = searchOpen
  const closeSearch = useCallback(() => setSearchOpen(false), [])
  useEffect(() => setSearchOpen(false), [folder?.root])

  // ⌘B (Ctrl+B): a window key, not a menu accelerator, so ⌘B in a text box stays bold (board/content.tsx).
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.shiftKey || isEditableTarget(event.target)) return
      if (!(isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return
      if (event.key.toLowerCase() !== 'b') return
      event.preventDefault()
      toggleSidebar()
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [toggleSidebar])

  // View > Show performance: main holds the choice; the top bar's pill follows it.
  const [showPerformance, setShowPerformance] = useState(false)
  useEffect(() => {
    void space.getShowPerformance().then(setShowPerformance)
  }, [])

  /** The text of each board with unsaved edits, as it is now: the newest version, whatever write failed. */
  const unsavedBoards = (): FailedSave[] => {
    const out: FailedSave[] = []
    for (const save of pendingRef.current.values()) {
      try {
        out.push({ root: save.root, path: save.path, text: serializeBoard(save.doc) })
      } catch (error) {
        console.error(`${save.path} cannot be kept: ${errorMessage(error)}`)
      }
    }
    return out
  }

  /**
   * Save everything for the close. Resolves with the boards that stay unsaved, and with none
   * only when none does: an edit that comes in during a write is written in another pass.
   */
  const flushRef = useRef<() => Promise<FailedSave[]>>(async () => [])
  flushRef.current = async () => {
    for (;;) {
      leaveBoard()
      flushCamera()
      const failed = await flushSave()
      leaveBoard()
      if (failed) return unsavedBoards()
      if (!pendingRef.current.size) return []
    }
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
      space.onBoardsChanged(takeBoards),
      space.onBoardChanged((change) => void onBoardChangeRef.current(change.path, change.deleted)),
      // Main sends the stories of the board the window shows; reads take them only for that board's path (live/stories.ts).
      // Main sends a board's stories after each new record line; they are for the open board only when its id is theirs.
      space.onSceneStories((stories) => {
        if (stories.id && boardRef.current?.boardId() === stories.id) setStories(stories)
      }),
      space.onMenuCommand((command) => {
        // ⌘N, ⌘O and the setup item close the search panel first; the zoom keys do not reach the board under it.
        if (searchOpenRef.current && (command === 'open-folder' || command === 'new-board' || command === 'setup-folder')) flushSync(() => setSearchOpen(false))
        if (command === 'search-boards') setSearchOpen((open) => !open && folderRef.current !== null)
        else if (command === 'open-folder') void openFolderDialogRef.current()
        else if (command === 'new-board') void createBoardRef.current()
        else if (command === 'setup-folder') setMenuSetup(folderRef.current !== null)
        else if (searchOpenRef.current && command.startsWith('zoom-')) return
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
  // The search panel's rows keep their identity while it is open: an App render (a boards list, an agent's edit) moves no scroll.
  const newBoardFromSearch = useCallback(() => void createBoardRef.current(), [])
  const openFolderFromSearch = useCallback(() => void openFolderDialogRef.current(), [])

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
      // 'marker' is the Pen tool with the marker (drive.mjs --tool).
      setTool: (tool: ToolId | 'marker') =>
        setTools((current) => (tool === 'marker' || tool === 'pen' ? { ...current, tool: 'pen', style: { ...current.style, pen: tool === 'marker' ? 'marker' : 'pen' } } : { ...current, tool })),
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
          /** The focused element: tag, class and its text (checks of the focus return). */
          focus: document.activeElement && document.activeElement !== document.body ? `${document.activeElement.tagName.toLowerCase()}.${document.activeElement.className} ${(document.activeElement.textContent ?? '').trim().slice(0, 40)}`.trim() : null,
          searchOpen: document.querySelector('.search-panel') !== null,
          sidebarHidden: sidebarHiddenRef.current,
          nodes: (live?.nodes ?? []).map((node) => {
            const bounds = live?.bounds(node.id)
            return {
              id: node.id,
              kind: node.kind,
              author: typeof node.author === 'string' ? node.author : null,
              parent: typeof node.parent === 'string' ? node.parent : null,
              z: typeof node.z === 'number' ? node.z : null,
              ...(node.kind === 'text' ? { text: node.text } : {}),
              ...(node.kind === 'text' ? (({ fontSize, fontFamily, textAlign }: Record<string, string | undefined>) => ({ fontSize, fontFamily, textAlign }))((node as { style?: Record<string, string> }).style ?? {}) : {}),
              ...(node.kind === 'ink' || node.kind === 'text' ? { color: node.kind === 'ink' ? node.color : (node as { style?: Record<string, string> }).style?.color } : {}),
              bounds: bounds ? { x: r1(bounds.x), y: r1(bounds.y), width: r1(bounds.width), height: r1(bounds.height) } : null
            }
          })
        }
      },
      /** Live-scene playback (play_scene): what plays now; seek(t) holds the current scene at t s, seek(null) lets it run; finish() ends all. */
      get scene() {
        return { ...scenePlayer.state(), seek: (t: number | null) => scenePlayer.seek(t), finish: () => scenePlayer.finish(), release: () => scenePlayer.release(Number.POSITIVE_INFINITY), frame: () => scenePlayer.debugFrame(), snap: () => { const s = scenePlayer.snapshot(); return s && { overrides: [...s.frame.overrides], inks: s.frame.inks } } }
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
      /** What the memory bounds hold now: the frames of the replay history, the ink tiles, the open board's change log and bytes, and the kept stroke geometry. */
      memory: () => {
        const entry = openRef.current ? cacheRef.current.get(openRef.current.path) : undefined
        return { sceneBytes: scenePlayer.heldBytes(), tiles: boardRef.current?.tileStats() ?? null, revisions: entry?.log.revisionCount() ?? null, boardBytes: entry ? entryBytes(entry) : null, strokeShapeBytes: strokeShapeBytes() }
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
      closeAnswer: (button: number) => space.devCloseAnswer(button),
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

  // ---------- Tool keys (tools.ts TOOLS), Q for the lock ----------

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isEditableTarget(event.target)) return
      const lock = event.key.toUpperCase() === LOCK_KEY
      const tool = toolForKey(event.key)
      if (!lock && !tool) return
      event.preventDefault()
      if (event.repeat) return
      if (lock) setTools((current) => ({ ...current, lock: !current.lock }))
      else if (tool) setTools((current) => chooseTool(current, tool))
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
    <div
      className="shell"
      data-sidebar-hidden={sidebarHidden || undefined}
      data-fullscreen={fullScreen || undefined}
      data-window-buttons={(isMac && !fullScreen) || undefined}
    >
      <Sidebar
        hidden={sidebarHidden}
        onToggleSidebar={toggleSidebar}
        folderName={folder?.name ?? null}
        folderRoot={folder?.root ?? null}
        homeDir={shellStart.homeDir}
        recent={recent}
        boards={boards}
        openBoard={open?.path ?? null}
        renaming={sidebarHidden ? null : renaming}
        onOpenFolder={() => void openFolderDialog()}
        onOpenRecent={(path) => void openRecent(path)}
        onOpenBoard={(path) => void openBoard(path)}
        onCreateBoard={() => void createBoard()}
        onSearch={() => setSearchOpen(true)}
        onStartRename={setRenaming}
        onRename={(path, name) => void renameBoard(path, name)}
        onCancelRename={() => setRenaming(null)}
        onDeleteBoard={(path) => void deleteBoard(path)}
        onReveal={reveal}
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
          sidebarHidden={sidebarHidden}
          onToggleSidebar={toggleSidebar}
          onCreateBoard={folder ? () => void createBoard() : null}
          folderName={folder?.name ?? null}
          boardName={open ? boardName(open.path) : null}
          renaming={sidebarHidden && !!open && renaming === open.path}
          onRename={(name) => open && void renameBoard(open.path, name)}
          onCancelRename={() => setRenaming(null)}
          saveStatus={open ? saveStatus : null}
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
                style={tools.style}
                selectMode={tools.selectMode}
                lock={tools.lock}
                onDocChange={onDocChange}
                onCameraChange={onCameraChange}
                onToolChange={(tool) => setTools((current) => ({ ...current, tool }))}
                onChanges={onChanges}
                onSelectionChange={setSelection}
                onSelectionStyle={setSelectionStyle}
                onContextMenu={([x, y]) => {
                  const context = boardRef.current?.commandContext()
                  setBoardMenu(context && hasBoardMenu(context) ? { x, y, board: open.key, context } : null)
                }}
              />
            )}
            {canvasContent}
            {open && <ScriptPanel key={open.path} />}
            {open && (
              <BoardControls
                tools={tools}
                zoom={zoom}
                selection={selectionStyle}
                onChooseTool={(tool) => setTools((current) => chooseTool(current, tool))}
                onToggleLock={() => setTools((current) => ({ ...current, lock: !current.lock }))}
                onStyle={(patch: StylePatch) => {
                  setTools((current) => ({ ...current, style: { ...current.style, ...patch } }))
                  boardRef.current?.applyStyle(patch)
                }}
                onZoomIn={() => boardRef.current?.zoomStep('in', 'menu')}
                onZoomOut={() => boardRef.current?.zoomStep('out', 'menu')}
                onResetZoom={() => boardRef.current?.zoomTo(HOME_ZOOM)}
                onCommand={(command) => boardRef.current?.runCommand(command)}
                commandContext={() => boardRef.current?.commandContext() ?? null}
                onUndo={() => boardRef.current?.undo()}
                onRedo={() => boardRef.current?.redo()}
              />
            )}
            {open && boardMenu?.board === open.key && (
              <BoardMenu
                key={`${boardMenu.x} ${boardMenu.y}`}
                x={boardMenu.x}
                y={boardMenu.y}
                context={boardMenu.context}
                onCommand={(command) => boardRef.current?.runCommand(command)}
                onClose={closeBoardMenu}
              />
            )}
            {toast && <Toast message={toast.text} kind={toast.kind} onDone={clearToast} />}
          </div>
          {previewPath && <PreviewPanel path={previewPath} version={previewVersion} onClose={() => setPreviewPath(null)} />}
        </div>
      </main>
      {searchOpen && folder && (
        <SearchPanel
          boards={boards}
          onClose={closeSearch}
          onOpenBoard={(path) => void openBoard(path)}
          onNewBoard={newBoardFromSearch}
          onCreateNamed={(name) => void createNamedBoard(name)}
          onOpenFolder={openFolderFromSearch}
        />
      )}
    </div>
  )
}
