import { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import App from './App';
import { Board } from './board/Board';
import { applySceneUpdate } from './board/scene';
import { api, ApiError, consumeSSE, json, type WebStatus } from './api/client';
import type { Activity, BoardElement, BoardHandle, BoardRegion, BoardTool, Capture, Message, Source, Workspace } from './types';
import { WorkspaceStore } from './workspace/store';
import { LiveCall, type LiveState } from './voice/live';
import { Dictation } from './voice/dictation';

const store = new WorkspaceStore();
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';

function Client() {
  const [, render] = useReducer(n => n + 1, 0);
  const [webStatus, setWebStatus] = useState<WebStatus | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [tool, setTool] = useState<BoardTool>('pen');
  const [color, setColor] = useState('#0A0A0A');
  const [width, setWidth] = useState(4);
  const [capture, setCapture] = useState<Capture | null>(null);
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

  async function runTurn(id: string, text: string, attachmentIds: string[] = [], selected: Capture | null = null, spoken = false): Promise<string> {
    if (!store.authenticated) throw new Error('Connect the backend before sending a message.');
    if (running.current) throw new Error('Wait for the current tutor turn or stop it first.');
    const initial = store.entries.get(id)?.workspace;
    if (!initial) throw new Error('The session is unavailable.');
    const handle = getBoard(id); if (!handle) throw new Error('The session board is not ready.');
    const controller = new AbortController(); const turnId = crypto.randomUUID();
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    running.current = { id, controller, done };
    setBusy(true); setPhase('Thinking…'); setError(null);
    const assistantId = crypto.randomUUID(); let answer = '';
    try {
      const overview = await handle.overview();
      const scene = handle.context();
      if (scene.length > 60000) throw new Error('This board is too large for a tutor turn. Start a new session or remove older material.');
      if (!spoken) {
        patch(id, { messages: [...initial.messages, { id: crypto.randomUUID(), role: 'user', text }, { id: assistantId, role: 'assistant', text: '' }] });
      }
      const response = await fetch('/v1/turn', { ...json({
        turn_id: turnId, session_id: id, text, model: initial.model, reasoning_effort: initial.reasoningEffort,
        board_overview_base64: overview, board_scene: scene, attachment_ids: attachmentIds,
        ...(selected ? { image_base64: selected.image_base64, image_region: JSON.stringify(selected.region) } : {}),
      }), credentials: 'same-origin', signal: controller.signal });
      await consumeSSE(response, async event => {
        const current = store.entries.get(id)?.workspace; if (!current) return;
        switch (event.type) {
          case 'status': {
            const labels: Record<string, string> = { thinking: 'Thinking…', looking: 'Inspecting the board…', searching: 'Researching…', writing: 'Writing…', drawing: 'Drawing…', computing: 'Computing…' };
            setPhase(labels[String(event.phase)] ?? 'Working…'); break;
          }
          case 'text_delta':
            answer += typeof event.text === 'string' ? event.text : '';
            if (!spoken) patch(id, { messages: current.messages.map(m => m.id === assistantId ? { ...m, text: answer } : m) });
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
              const image = await sessionBoard.capture(region); await api.boardReply(turnId, callId, image);
            } catch (e) { await api.boardReply(turnId, callId, new Error(errorText(e))); }
            break;
          }
          case 'workspace': patch(id, { plan: event.plan, exercise: event.exercise }); break;
          case 'search_sources': {
            const sources = Array.isArray(event.sources) ? event.sources as Source[] : [];
            const all = new Map((current.sources ?? []).map(source => [source.url, source]));
            sources.forEach(source => { if (/^https?:\/\//.test(source.url)) all.set(source.url, source); });
            patch(id, { sources: [...all.values()] }); break;
          }
          case 'step': {
            const item: Activity = { id: String(event.id), label: String(event.label) };
            const activities = [...current.activity ?? []]; const at = activities.findIndex(a => a.id === item.id);
            if (at === -1) activities.push(item); else activities[at] = item;
            patch(id, { activity: activities }); break;
          }
        }
      });
      await store.flush(id);
      return answer;
    } catch (e) {
      if (controller.signal.aborted) {
        setError('The response stopped. Your work is saved.'); return answer;
      }
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
      return runTurn(id, text, [], null, true);
    },
  });
  if (!dictation.current) dictation.current = new Dictation(setDictationState);

  async function send(text: string, ids: string[] = [], selected: Capture | null = null) {
    const id = store.activeId; if (!id) throw new Error('Create a session first.');
    if (id === voice.current?.state.sessionId && voice.current.state.phase !== 'idle' && voice.current.state.phase !== 'error') {
      const problem = new Error('End this voice conversation before sending a typed message.'); report(problem); throw problem;
    }
    retry.current = () => runTurn(id, text, ids, selected);
    try { await runTurn(id, text, ids, selected); } catch (e) { report(e); throw e; }
  }
  async function selectSession(id: string) {
    if (dictationState !== 'idle') { setError('Finish dictation before changing sessions.'); return; }
    setCapture(null);
    const old = store.activeId;
    try { await store.open(id); if (old && old !== id && old !== running.current?.id && old !== voice.current?.state.sessionId && store.authenticated) await api.close(old); }
    catch (e) { report(e); }
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
  const backgroundIds = new Set([voiceState.sessionId, running.current?.id].filter((id): id is string => !!id && id !== store.activeId));
  const backgroundWorkspaces = [...backgroundIds].map(id => store.entries.get(id)?.workspace).filter((w): w is Workspace => !!w);
  const boardNode = workspace ? <Board key={workspace.id} ref={board} workspace={workspace} tool={tool} color={color} width={width}
    onChange={value => patch(workspace.id, value)} onSelection={setCapture} onError={setError} /> : null;
  return <>
    <App config={webStatus ? { models: webStatus.models, effortsForModel: webStatus.efforts_for_model, liveAvailable: webStatus.live_available } : undefined}
      workspace={workspace} sessions={[...store.entries.values()].map(e => ({ id: e.workspace.id, title: e.workspace.title, updated_at: e.workspace.updatedAt })).sort((a, b) => b.updated_at.localeCompare(a.updated_at))}
      board={boardNode} auth={{ required: webStatus?.authenticated === false, busy: authBusy, error, submit: authenticate }}
      status={{ busy, phase, error: error ?? store.error, preserve: store.conflictId ? () => { const id = store.conflictId; if (id) store.preserveConflict(id); setCapture(null); } : undefined, sync: store.sync === 'saved' ? 'Saved' : store.sync === 'saving' ? 'Saving…' : store.sync === 'conflict' ? 'Save conflict' : 'Saved in this browser', retry: () => { void (async () => { await reconnect(); if (retry.current && !busy && store.authenticated) await retry.current(); })().catch(report); } }}
      sources={workspace?.sources ?? []} activity={workspace?.activity ?? []} selectedCapture={capture} voice={voiceState}
      dictationState={dictationState} boardTool={tool} boardColor={color} boardWidth={width}
      onCreateSession={() => { if (dictationState !== 'idle') { setError('Finish dictation before creating a session.'); return; } const old = store.activeId; store.create(); setCapture(null); if (old && old !== running.current?.id && old !== voiceState.sessionId && store.authenticated) void api.close(old).catch(report); }}
      onSelectSession={selectSession}
      onRenameSession={(id, title) => { if (title.trim()) patch(id, { title: title.trim() }); }}
      onDeleteSession={async id => { try { if (running.current?.id === id) { running.current.controller.abort(); await running.current.done; } if (id === voiceState.sessionId) await voiceAction('end'); await store.remove(id); if (!store.active) store.create(); } catch (e) { report(e); } }}
      onSaveSettings={settings => { if (workspace) { const allowed = webStatus?.efforts_for_model[settings.model]; patch(workspace.id, { model: settings.model, reasoningEffort: allowed && !allowed.includes(settings.reasoningEffort) ? 'high' : settings.reasoningEffort }); } }}
      onSend={send}
      onEditMessage={async (messageId, text) => {
        if (!workspace || busy) return;
        const at = workspace.messages.findIndex(m => m.id === messageId); if (at < 0) return;
        const prefix = { ...workspace, messages: workspace.messages.slice(0, at) };
        try { await api.transcript(prefix); patch(workspace.id, { messages: prefix.messages }); await send(text); }
        catch (e) { report(e); throw e; }
      }}
      onStop={() => running.current?.controller.abort()}
      onAttach={async files => { if (!workspace) return []; try { return await Promise.all(files.map(file => api.upload(workspace.id, file))); } catch (e) { report(e); throw e; } }}
      onClearCapture={() => setCapture(null)}
      onDictation={async () => { if (!store.activeId) return ''; if (voiceState.phase === 'live') throw new Error('End voice before dictating a message.'); try { return await dictation.current!.start(store.activeId); } catch (e) { report(e); throw e; } }}
      onVoiceAction={voiceAction} onBoardToolChange={setTool} onBoardColorChange={setColor} onBoardWidthChange={setWidth}
      onUndo={() => board.current?.undo()} onRedo={() => board.current?.redo()}
      onClearBoard={() => { board.current?.clear(); if (workspace) patch(workspace.id, { scene: { elements: [] } }); }}
      onFitBoard={() => board.current?.fit()}
      onEvaluate={() => { if (!workspace) return; void (async () => { const selected = await board.current?.capture(); if (selected) await send('Please inspect my work on the board and help me find the next step without solving it for me.', [], selected); })().catch(report); }} />
    {backgroundWorkspaces.map(w => <div key={w.id} style={{ position: 'fixed', left: -20000, top: 0, width: 1000, height: 900, pointerEvents: 'none' }} aria-hidden="true">
      <Board ref={handle => { if (handle) backgroundBoards.current.set(w.id, handle); else backgroundBoards.current.delete(w.id); }} workspace={w} tool="pen" color={color} width={width}
        onChange={value => patch(w.id, value)} onSelection={() => {}} onError={setError} />
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
