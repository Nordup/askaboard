import { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import App from './App';
import { Board } from './board/Board';
import { applySceneUpdate } from './board/scene';
import { api, ApiError, consumeSSE, json, type WebStatus } from './api/client';
import type { Attachment, BoardElement, BoardHandle, BoardRegion, BoardTool, Capture, LearningSignal, Message, Source, Workspace } from './types';
import { WorkspaceStore } from './workspace/store';
import { LiveCall, type LiveState } from './voice/live';
import { Dictation } from './voice/dictation';
import { deleteMedia, saveMedia } from './workspace/media';
import { appendAnswer, appendReasoning, finishTutorMessage, mergeSources, setStepImage, upsertSearch, upsertStep } from './tutor/message-state';

const store = new WorkspaceStore();
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';

interface TurnOptions {
  attachments?: Attachment[];
  capture?: Capture | null;
  signal?: LearningSignal;
  voiceTurn?: boolean;
  baseMessages?: Message[];
  retryMessage?: Message;
  boardOverview?: string;
  boardScene?: string;
  model?: string;
  reasoningEffort?: string;
  onAccepted?(): void;
}

function Client() {
  const [, render] = useReducer(n => n + 1, 0);
  const [webStatus, setWebStatus] = useState<WebStatus | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [tool, setTool] = useState<BoardTool>('pen');
  const [color, setColor] = useState('#0A0A0A');
  const [width, setWidth] = useState(5);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [editDraft, setEditDraft] = useState<{ messageId: string; text: string } | null>(null);
  const [boardHistory, setBoardHistory] = useState({ canUndo: false, canRedo: false });
  const [voiceState, setVoiceState] = useState<LiveState>({ phase: 'idle', muted: false, sessionId: null, inputTranscript: '', outputTranscript: '', error: null });
  const [dictationState, setDictationState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const board = useRef<BoardHandle>(null);
  const backgroundBoards = useRef(new Map<string, BoardHandle>());
  const running = useRef<{ id: string; controller: AbortController; done: Promise<void> } | null>(null);
  const transcriptTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retry = useRef<(() => Promise<unknown>) | null>(null);
  const voice = useRef<LiveCall | null>(null);
  const dictation = useRef<Dictation | null>(null);
  const voiceBase = useRef<Message[]>([]);

  function getBoard(id: string): BoardHandle | null {
    return id === store.activeId ? board.current : backgroundBoards.current.get(id) ?? null;
  }
  function patch(id: string, value: Partial<Workspace>) { store.patch(id, value); }
  function report(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      store.authenticated = false;
      setWebStatus(previous => previous ? { ...previous, authenticated: false } : null);
    }
    setError(errorText(error));
  }
  async function reconnect() {
    const status = await api.status(); setWebStatus(status); store.authenticated = status.authenticated;
    if (status.authenticated) await store.refresh(); setError(null);
  }
  async function authenticate(code: string) {
    setAuthBusy(true); setError(null);
    try {
      await api.login(code); const status = await api.status(); setWebStatus(status); store.authenticated = status.authenticated;
      await store.refresh(); if (!store.active) store.create();
    } catch (e) { report(e); } finally { setAuthBusy(false); }
  }
  useEffect(() => {
    const unsubscribe = store.subscribe(render);
    void (async () => {
      await store.initialize();
      try {
        const status = await api.status(); setWebStatus(status); store.authenticated = status.authenticated;
        if (status.authenticated) await store.refresh();
      } catch { setError('The backend is unavailable. Start it to connect the tutor; existing work stays in this browser.'); }
      if (!store.active) store.create();
    })();
    const retrySaves = () => { for (const id of store.entries.keys()) void store.flush(id); };
    const pageHide = () => { store.pageHide(); voice.current?.pageHide(); dictation.current?.cancel(); };
    window.addEventListener('online', retrySaves);
    window.addEventListener('pagehide', pageHide);
    return () => { unsubscribe(); window.removeEventListener('online', retrySaves); window.removeEventListener('pagehide', pageHide); };
  }, []);

  async function runTurn(id: string, text: string, options: TurnOptions = {}): Promise<string> {
    if (!store.authenticated) throw new Error('Connect the backend before sending a message.');
    if (running.current) throw new Error('Wait for the current tutor turn or stop it first.');
    if (options.voiceTurn) retry.current = null;
    const initial = store.entries.get(id)?.workspace;
    if (!initial) throw new Error('The session is unavailable.');
    const handle = getBoard(id); if (!handle) throw new Error('The session board is not ready.');
    const controller = new AbortController(); const turnId = crypto.randomUUID();
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    running.current = { id, controller, done };
    setBusy(true); setPhase('Thinking…'); setError(null);
    const assistantId = crypto.randomUUID(); let answer = '';
    const startedAt = performance.now();
    const attachments = options.attachments ?? [];
    const selected = options.capture ?? null;
    const attachmentIds = attachments.map(item => item.id);
    let captureId: string | undefined;
    let createdCapture = false;
    let userMessage: Message | null = null;
    let accepted = false;
    let requestAttempted = false;
    const baseMessages = options.baseMessages ?? initial.messages;
    try {
      const overview = options.boardOverview ?? await handle.overview();
      const scene = options.boardScene ?? handle.context();
      if (scene.length > 60000) throw new Error('This board is too large for a tutor turn. Start a new session or remove older material.');
      if (!options.voiceTurn) {
        if (options.retryMessage) {
          userMessage = options.retryMessage;
          captureId = userMessage.capture?.imageId;
        } else {
          let messageCapture: Message['capture'];
          if (selected) {
            captureId = crypto.randomUUID();
            await saveMedia(id, captureId, selected.image_base64);
            createdCapture = true;
            messageCapture = { imageId: captureId, region: selected.region };
          }
          userMessage = {
            id: crypto.randomUUID(), role: 'user', text,
            ...(attachments.length ? { attachments } : {}),
            ...(messageCapture ? { capture: messageCapture } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          };
        }
        retry.current = async () => {
          if (requestAttempted) {
            const current = store.entries.get(id)?.workspace;
            if (current) {
              try { await api.transcript({ ...current, messages: baseMessages }); }
              catch { throw new Error("I couldn't reach the tutor service just now."); }
            }
          }
          return runTurn(id, text, {
            ...options, baseMessages, retryMessage: userMessage ?? undefined,
            boardOverview: overview, boardScene: scene,
            model: options.model ?? initial.model,
            reasoningEffort: options.reasoningEffort ?? initial.reasoningEffort,
          });
        };
      }
      requestAttempted = true;
      const response = await fetch('/v1/turn', { ...json({
        turn_id: turnId, session_id: id, text, model: options.model ?? initial.model, reasoning_effort: options.reasoningEffort ?? initial.reasoningEffort,
        board_overview_base64: overview, board_scene: scene, attachment_ids: attachmentIds,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(selected ? { image_base64: selected.image_base64, image_region: JSON.stringify(selected.region) } : {}),
      }), credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new ApiError(response.status, "I couldn't reach the tutor service just now.");
      accepted = true;
      options.onAccepted?.();
      if (userMessage) patch(id, { messages: [...baseMessages, userMessage] });
      await consumeSSE(response, async event => {
        const current = store.entries.get(id)?.workspace; if (!current) return;
        switch (event.type) {
          case 'status': {
            const labels: Record<string, string> = { thinking: 'Thinking…', looking: 'Inspecting the board…', searching: 'Researching…', writing: 'Writing…', drawing: 'Drawing…', computing: 'Computing…' };
            setPhase(labels[String(event.phase)] ?? 'Working…'); break;
          }
          case 'reasoning_delta': {
            const chunk = typeof event.text === 'string' ? event.text : '';
            patch(id, { messages: appendReasoning(current.messages, assistantId, chunk, crypto.randomUUID(), Boolean(options.voiceTurn)) });
            break;
          }
          case 'text_delta':
            answer += typeof event.text === 'string' ? event.text : '';
            if (!options.voiceTurn) patch(id, { messages: appendAnswer(current.messages, assistantId, typeof event.text === 'string' ? event.text : '') });
            break;
          case 'board_update': {
            const payload = event.payload as { upserts?: BoardElement[]; deletes?: string[]; replace_all?: boolean };
            flushSync(() => patch(id, { scene: applySceneUpdate(current.scene, payload) }));
            await nextFrame(); break;
          }
          case 'board_request': {
            const callId = String(event.call_id);
            try {
              const sessionBoard = getBoard(id); if (!sessionBoard) throw new Error('Session board is unavailable.');
              const region: BoardRegion = { x: Number(event.x), y: Number(event.y), width: Number(event.width), height: Number(event.height) };
              const image = await sessionBoard.capture(region);
              const imageId = crypto.randomUUID();
              await saveMedia(id, imageId, image.image_base64);
              const messageNow = store.entries.get(id)?.workspace?.messages ?? current.messages;
              patch(id, { messages: setStepImage(messageNow, assistantId, callId, imageId, typeof event.detail === 'string' ? event.detail : 'Looked at the board', Boolean(options.voiceTurn)) });
              await api.boardReply(turnId, callId, image);
            } catch (e) { await api.boardReply(turnId, callId, new Error(errorText(e))); }
            break;
          }
          case 'workspace': patch(id, { plan: event.plan, exercise: event.exercise, isWorkspace: false }); break;
          case 'search_sources': {
            const sources = Array.isArray(event.sources) ? event.sources as Source[] : [];
            const searchId = typeof event.search_id === 'string' ? event.search_id : crypto.randomUUID();
            const query = typeof event.query === 'string' ? event.query : '';
            patch(id, { messages: upsertSearch(current.messages, assistantId, searchId, query, sources, Boolean(options.voiceTurn)) }); break;
          }
          case 'step': {
            const item = { kind: 'step' as const, id: String(event.id), tool: String(event.tool ?? ''), label: String(event.label) };
            patch(id, { messages: upsertStep(current.messages, assistantId, item, Boolean(options.voiceTurn)) }); break;
          }
          case 'done': {
            const latest = store.entries.get(id)?.workspace?.messages ?? current.messages;
            patch(id, { messages: finishTutorMessage(latest, assistantId, (performance.now() - startedAt) / 1000) });
            break;
          }
        }
      });
      await store.flush(id);
      return answer;
    } catch (e) {
      if (createdCapture && captureId && !accepted) await deleteMedia(id, captureId).catch(() => undefined);
      if (controller.signal.aborted) {
        setError('The response stopped. Your work is saved.'); return answer;
      }
      if (accepted && e instanceof Error) Object.assign(e, { turnAccepted: true });
      report(e); throw e;
    } finally {
      running.current = null; setBusy(false); setPhase(null); finished(); void store.flush(id);
      if (id !== store.activeId && id !== voice.current?.state.sessionId && store.authenticated) void api.close(id).catch(report);
    }
  }

  if (!voice.current) voice.current = new LiveCall({
    state: setVoiceState,
    error: message => setError(message),
    transcripts: (id, messages) => {
      patch(id, { messages: [...voiceBase.current, ...messages] });
      clearTimeout(transcriptTimer.current);
      transcriptTimer.current = setTimeout(() => {
        if (!running.current) { const w = store.entries.get(id)?.workspace; if (w) void api.transcript(w).catch(report); }
      }, 1200);
    },
    delegate: async (id, text) => {
      // Speech history has no end-of-turn event. Persist the actual timeline,
      // then omit the current request before POST /turn records it once.
      clearTimeout(transcriptTimer.current);
      const activeTurn = running.current;
      if (activeTurn) { activeTurn.controller.abort(); await activeTurn.done; }
      const w = store.entries.get(id)?.workspace;
      if (w) {
        const lastUser = w.messages.map(m => m.role).lastIndexOf('user');
        await api.transcript({ ...w, messages: lastUser >= 0 ? w.messages.slice(0, lastUser) : w.messages });
      }
      return runTurn(id, text, { voiceTurn: true, signal: 'voice' });
    },
  });
  if (!dictation.current) dictation.current = new Dictation(setDictationState);

  async function send(text: string, attachments: Attachment[] = [], selected: Capture | null = null, signal?: LearningSignal) {
    const id = store.activeId; if (!id) throw new Error('Create a session first.');
    const trimmed = signal === 'dontKnow' ? 'I don’t know yet.' : text;
    const learningSignal = signal ?? (selected ? 'evaluate' : undefined);
    const voiceIsHere = voice.current?.state.sessionId === id && voice.current.state.phase !== 'idle' && voice.current.state.phase !== 'error' && voice.current.state.phase !== 'resting';
    if (voiceIsHere && trimmed.trim()) voice.current?.context(`The learner typed: ${trimmed.trim()}`);
    const options: TurnOptions = { attachments, capture: selected, signal: learningSignal };
    retry.current = null;
    retry.current = () => runTurn(id, trimmed, options);
    try {
      const answer = await runTurn(id, trimmed, options);
      if (voiceIsHere && answer.trim()) voice.current?.commentary(answer.trim());
      if (selected) { setCapture(null); setSelectionMode(false); }
    } catch (e) { report(e); throw e; }
  }
  async function selectSession(id: string) {
    if (dictationState !== 'idle') { setError('Finish dictation before changing sessions.'); return; }
    const old = store.activeId;
    setCapture(null); setSelectionMode(false); setEditDraft(null);
    try { await store.open(id); if (old && old !== id && old !== running.current?.id && old !== voice.current?.state.sessionId && store.authenticated) await api.close(old); }
    catch (e) { report(e); }
  }

  function onSelection(next: Capture | null) {
    setCapture(next);
    if (!next) setSelectionMode(false);
  }
  function toggleSelection() {
    if (selectionMode) { setSelectionMode(false); onSelection(null); return; }
    if (!workspace?.strokes.length && !workspace?.scene.elements.length) return;
    setCapture(null); setSelectionMode(true);
  }
  function clearCapture() {
    setCapture(null); setSelectionMode(false);
  }
  function armEdit(messageId: string) {
    const message = store.active?.messages.find(item => item.id === messageId);
    if (!message || message.role !== 'user' || message.attachments?.length || message.capture || message.signal || message.isVoice || busy) return;
    setEditDraft({ messageId, text: message.text });
  }
  async function submitEdit(messageId: string, text: string) {
    const id = store.activeId; const original = store.active;
    if (!id || !original || busy) throw new Error('The tutor is still answering.');
    const index = original.messages.findIndex(message => message.id === messageId);
    const old = original.messages[index];
    if (index < 0 || old?.role !== 'user' || old.attachments?.length || old.capture || old.signal || old.isVoice) throw new Error('This message can no longer be edited.');
    const baseMessages = original.messages.slice(0, index);
    await api.transcript({ ...original, messages: baseMessages });
    let accepted = false;
    try {
      await runTurn(id, text, { baseMessages, onAccepted: () => { accepted = true; setEditDraft(null); } });
      setEditDraft(null);
    } catch (error) {
      if (!accepted) await api.transcript(original).catch(report);
      throw error;
    }
  }

  async function voiceAction(action: 'start' | 'end' | 'mute' | 'rest' | 'wake' | 'return') {
    const call = voice.current!;
    try {
      if (action === 'start') {
        if (!store.activeId || !store.authenticated) throw new Error('Connect the backend before starting voice.');
        if (dictationState !== 'idle') throw new Error('Finish dictation before starting voice.');
        await store.flush(); voiceBase.current = [...store.active?.messages ?? []];
        if (store.active) await api.transcript(store.active);
        await call.start(store.activeId);
      } else if (action === 'end' || action === 'rest') {
        const id = call.state.sessionId;
        if (action === 'rest') await call.rest(); else await call.end();
        if (id) { const w = store.entries.get(id)?.workspace; if (w) await api.transcript(w); await store.flush(id); if (action === 'end') await api.close(id); }
      } else if (action === 'wake') { voiceBase.current = [...store.entries.get(call.state.sessionId ?? '')?.workspace.messages ?? []]; await call.wake(); }
      else if (action === 'mute') call.toggleMute();
      else if (action === 'return' && call.state.sessionId) await selectSession(call.state.sessionId);
    } catch (e) { report(e); }
  }

  const workspace = store.active;
  const busyForActive = busy && running.current?.id === store.activeId;
  const phaseForActive = busyForActive ? phase : null;
  const backgroundIds = new Set([voiceState.sessionId, running.current?.id].filter((id): id is string => !!id && id !== store.activeId));
  const backgroundWorkspaces = [...backgroundIds].map(id => store.entries.get(id)?.workspace).filter((w): w is Workspace => !!w);
  const boardNode = workspace ? <Board key={workspace.id} ref={board} workspace={workspace} tool={tool} color={color} width={width} selectionMode={selectionMode}
    onChange={value => patch(workspace.id, value)} onSelection={onSelection} onHistoryChange={setBoardHistory} onError={setError} /> : null;
  async function createSession() {
    if (dictationState !== 'idle') { setError('Finish dictation before creating a session.'); return; }
    store.create(); setCapture(null); setSelectionMode(false); setEditDraft(null); setBoardHistory({ canUndo: false, canRedo: false });
  }
  async function resetSession() {
    const id = store.activeId;
    if (!id) return;
    if (running.current?.id === id) { running.current.controller.abort(); await running.current.done; }
    if (id === voice.current?.state.sessionId) await voiceAction('end');
    await store.reset(id);
    setCapture(null); setSelectionMode(false); setEditDraft(null); setBoardHistory({ canUndo: false, canRedo: false });
  }
  function startPlan() {
    if (!workspace?.plan || !workspace.exercise) { setError('The tutor has not prepared a session exercise yet. Ask for a problem or a focused next step first.'); return; }
    patch(workspace.id, { isWorkspace: true });
  }
  function returnToChat() { if (workspace) patch(workspace.id, { isWorkspace: false }); }
  return <>
    <App config={webStatus ? { models: webStatus.models, effortsForModel: webStatus.efforts_for_model, liveAvailable: webStatus.live_available } : undefined}
      workspace={workspace} sessions={[...store.entries.values()].map(e => ({ id: e.workspace.id, title: e.workspace.title, updated_at: e.workspace.updatedAt })).sort((a, b) => b.updated_at.localeCompare(a.updated_at))}
      board={boardNode} auth={{ required: webStatus?.authenticated === false, busy: authBusy, error, submit: authenticate }}
      status={{ busy: busyForActive, phase: phaseForActive, error: error ?? store.error, preserve: store.conflictId ? () => { const id = store.conflictId; if (id) store.preserveConflict(id); setCapture(null); setSelectionMode(false); } : undefined, sync: store.sync === 'saved' ? 'Saved' : store.sync === 'saving' ? 'Saving…' : store.sync === 'conflict' ? 'Save conflict' : 'Saved in this browser', retry: () => { void (async () => { await reconnect(); if (retry.current && !busy && store.authenticated) await retry.current(); })().catch(report); } }}
      sources={workspace?.sources ?? []} activity={workspace?.activity ?? []} selectedCapture={capture} voice={voiceState}
      dictationState={dictationState} boardTool={tool} boardColor={color} boardWidth={width}
      selectionMode={selectionMode} canUndo={boardHistory.canUndo} canRedo={boardHistory.canRedo} canSelectBoard={Boolean(workspace && (workspace.strokes.length || workspace.scene.elements.length))} editDraft={editDraft}
      onCreateSession={createSession} onResetSession={resetSession}
      onSelectSession={selectSession}
      onRenameSession={(id, title) => { if (title.trim()) patch(id, { title: title.trim() }); }}
      onDeleteSession={async id => { try { if (running.current?.id === id) { running.current.controller.abort(); await running.current.done; } if (id === voiceState.sessionId) await voiceAction('end'); await store.remove(id); if (!store.active) store.create(); setCapture(null); setSelectionMode(false); setEditDraft(null); } catch (e) { report(e); } }}
      onSaveSettings={settings => { if (workspace) { const allowed = webStatus?.efforts_for_model[settings.model]; patch(workspace.id, { model: settings.model, reasoningEffort: allowed && !allowed.includes(settings.reasoningEffort) ? 'high' : settings.reasoningEffort }); } }}
      onSend={send}
      onEditMessage={armEdit} onCancelEdit={() => setEditDraft(null)} onSubmitEdit={submitEdit}
      onStop={() => { if (running.current?.id === store.activeId) running.current.controller.abort(); }}
      onAttach={async files => { const id = store.activeId; if (!id) return []; try { return await Promise.all(files.map(file => api.upload(id, file))); } catch (e) { report(e); throw e; } }}
      onClearCapture={clearCapture} onToggleSelection={toggleSelection}
      onDictation={async () => { if (!store.activeId) return ''; if (voiceState.sessionId === store.activeId && !['idle', 'error', 'resting'].includes(voiceState.phase)) throw new Error('End voice before dictating a message.'); try { return await dictation.current!.start(store.activeId); } catch (e) { report(e); throw e; } }}
      onVoiceAction={voiceAction} onBoardToolChange={setTool} onBoardColorChange={setColor} onBoardWidthChange={setWidth}
      onUndo={() => board.current?.undo()} onRedo={() => board.current?.redo()}
      onClearBoard={() => board.current?.clear()}
      onFitBoard={() => board.current?.fit()}
      onEvaluate={() => { if (workspace?.strokes.length) setSelectionMode(true); }}
      onStartPlan={startPlan} onReturnToChat={returnToChat} />
    {backgroundWorkspaces.map(w => <div key={w.id} style={{ position: 'fixed', left: -20000, top: 0, width: 1000, height: 900, pointerEvents: 'none' }} aria-hidden="true">
      <Board ref={handle => { if (handle) backgroundBoards.current.set(w.id, handle); else backgroundBoards.current.delete(w.id); }} workspace={w} tool="pen" color={color} width={width} selectionMode={false}
        onChange={value => patch(w.id, value)} onSelection={() => {}} onHistoryChange={() => {}} onError={setError} />
    </div>)}
  </>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<Client />);
// The entry owns long-lived transports and store timers; reload it as a unit.
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
  import.meta.hot.dispose(() => root.unmount());
}
