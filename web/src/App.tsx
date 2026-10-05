import { useEffect, useRef, useState } from 'react';
import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/500.css';
import '@fontsource/source-sans-3/600.css';
import '@fontsource/source-sans-3/700.css';
import 'katex/dist/katex.min.css';
import './design/app.css';
import { Icon } from './design/Icon';
import { Composer } from './tutor/Composer';
import { MessageView } from './tutor/MessageView';
import { Orb } from './tutor/Orb';
import { SessionDrawer } from './tutor/SessionDrawer';
import { Settings } from './tutor/Settings';
import { WorkspaceCards } from './tutor/WorkspaceCards';
import type { AppProps, TutorSettings } from './ui-types';
import type { BoardTool, Capture } from './types';

const colors = ['#0A0A0A', '#6051DC', '#0155FB', '#40A365', '#E33E38'];
const toolDefs: Array<{ id: BoardTool; icon: string; label: string }> = [
  { id: 'pen', icon: 'tool/pen', label: 'Pen' },
  { id: 'highlighter', icon: 'tool/highlighter', label: 'Highlighter' },
  { id: 'eraser', icon: 'tool/eraser', label: 'Eraser' },
  { id: 'lasso', icon: 'tool/lasso', label: 'Lasso' },
];

export function App(props: AppProps) {
  const [panelMode, setPanelMode] = useState<'docked' | 'collapsed' | 'fullscreen'>('docked');
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [widthOpen, setWidthOpen] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [panelWidth, setPanelWidth] = useState(337);
  const resizing = useRef(false);
  const following = useRef(true);
  const currentSettings: TutorSettings = { model: props.workspace?.model ?? 'gpt-5.6-luna', reasoningEffort: props.workspace?.reasoningEffort ?? 'high' };
  const activeSession = props.workspace?.id ?? null;
  const messages = props.workspace?.messages ?? [];
  const lastMessage = messages[messages.length - 1];

  useEffect(() => {
    const thread = document.querySelector<HTMLElement>('.thread');
    if (thread && following.current) thread.scrollTop = thread.scrollHeight;
  }, [messages.length, lastMessage?.text, panelMode]);

  useEffect(() => {
    const move = (event: PointerEvent) => { if (resizing.current) setPanelWidth(Math.max(300, Math.min(520, event.clientX - 28))); };
    const up = () => { resizing.current = false; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);

  const send = async (text: string, ids: string[] = [], capture: Capture | null = null) => props.onSend(text, ids, capture);
  const sendSuggestion = (text: string) => { void send(text).catch(() => {}); };
  const isBusy = props.status.busy;
  const displayError = props.status.error || props.auth.error || props.voice.error || null;
  const errorBanner = displayError && <div className="status-error" role="status">{displayError}{props.status.preserve && <button className="retry-action" onClick={props.status.preserve}>Preserve a copy</button>}{props.status.retry && <button className="retry-action" onClick={props.status.retry}>Try again</button>}</div>;
  const onReset = () => {
    if (!window.confirm('Reset this session? This starts a new conversation and board.')) return;
    props.onCreateSession();
    setSettingsOpen(false);
  };
  if (props.auth.required) return <div className="modal-backdrop"><form className="settings-window auth-window" onSubmit={event => { event.preventDefault(); void props.auth.submit(authCode); }}>
    <div className="settings-pane auth-pane"><header className="settings-heading"><h2>AI Tutor</h2><p>Enter your access code to open your workspace.</p></header><label className="auth-label">Access code<input autoFocus type="password" autoComplete="one-time-code" value={authCode} onChange={event => setAuthCode(event.target.value)} /></label>{props.auth.error && <div className="status-error">{props.auth.error}</div>}<button className="primary-button" disabled={!authCode || props.auth.busy}>{props.auth.busy ? 'Connecting…' : 'Continue'}</button></div>
  </form></div>;

  return <main className={`app-shell ${panelMode === 'fullscreen' ? 'mode-fullscreen' : ''}`} style={{ '--tutor-width': `${panelWidth}px` } as React.CSSProperties}>
    {props.board && <div className="board-frame" aria-label="Whiteboard">{props.board}
      <div className="board-tools"><button className="board-action" onClick={props.onUndo}>Undo</button><button className="board-action" onClick={props.onRedo}>Redo</button><button className="board-action" onClick={props.onEvaluate}>Check work</button><button className="board-action" onClick={() => { if (window.confirm('Clear all board content?')) props.onClearBoard(); }}>Clear</button></div>
    </div>}
    {panelMode !== 'fullscreen' && <aside className="tool-rail" aria-label="Board tools">
      <div className="tool-group">{toolDefs.map(tool => <button key={tool.id} className={`tool-slot ${props.boardTool === tool.id ? 'is-selected' : ''}`} aria-label={tool.label} aria-pressed={props.boardTool === tool.id} onClick={() => props.onBoardToolChange(tool.id)}><Icon name={tool.icon} size={28} /></button>)}</div>
      <div className="rail-divider" />
      <div className="swatches" aria-label="Pen color">{colors.map(color => <button key={color} className={`swatch ${props.boardColor.toLowerCase() === color.toLowerCase() ? 'is-selected' : ''}`} style={{ backgroundColor: color }} aria-label={`Choose ${color}`} aria-pressed={props.boardColor.toLowerCase() === color.toLowerCase()} onClick={() => props.onBoardColorChange(color)} />)}</div>
      <button className="width-swatch" aria-label="Choose stroke width" onClick={() => setWidthOpen(open => !open)} style={{ transform: `scaleY(${Math.max(.7, Math.min(2.2, props.boardWidth / 5))})` }} />
      {widthOpen && <div className="tool-input"><label>Stroke width <strong>{props.boardWidth}px</strong><input type="range" min="1" max="12" step="1" value={props.boardWidth} onChange={event => props.onBoardWidthChange(Number(event.target.value))} /></label></div>}
      <button className="tool-slot center-tool" aria-label="Fit board to view" onClick={() => props.onFitBoard()}><Icon name="tool/center" size={26} /></button>
    </aside>}
    {panelMode === 'docked' && <section className="chat-panel">
      <header className="panel-top"><button className="icon-button" aria-label="Open sessions" onClick={() => setSessionsOpen(true)}><Icon name="ui/sidebar-toggle" /></button><span className="panel-title" aria-hidden="true" /> <div className="panel-actions"><button className="icon-button" aria-label="Full screen tutor" onClick={() => setPanelMode('fullscreen')}><Icon name="control/full" /></button><button className="icon-button" aria-label="Collapse tutor" onClick={() => setPanelMode('collapsed')}><Icon name="control/dock" /></button></div></header>
      <div className="thread" aria-live="polite" onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {messages.length === 0 && <div className="greeting"><Orb /><h1>Hi! I'm your AI Tutor</h1><p>I'm here to help you learn, practice and achieve your goals.</p><div className="suggestions">{[
          ['chip/explain', 'Explain this concept'], ['chip/example', 'Give me an example'], ['chip/exercise', 'Create an exercise'], ['chip/confused', "I don't understand this"],
        ].map(([icon, label]) => <button className="suggestion" key={label} onClick={() => sendSuggestion(label)}><Icon name={icon} size={22} />{label}</button>)}</div></div>}
        {messages.map(message => <MessageView key={message.id} message={message} onEdit={message.role === 'user' ? text => props.onEditMessage(message.id, text) : undefined} />)}
        {isBusy && <div className="status-sync" role="status">{props.status.phase ?? 'Working…'}</div>}
        {props.workspace && <WorkspaceCards workspace={props.workspace} activity={props.activity} sources={props.sources} onStartPlan={sendSuggestion} />}
        {props.voice.phase !== 'idle' && <div className="voice-state-orb"><Orb variant={props.voice.phase === 'resting' ? 'resting' : 'live'} /></div>}
        {lastMessage?.role === 'user' && isBusy && <div className="message" aria-live="polite">Thinking…</div>}
      </div>
      {errorBanner}
      <Composer ready={Boolean(props.workspace)} key={activeSession} selectedCapture={props.selectedCapture} voice={props.voice} dictationState={props.dictationState} busy={isBusy} liveAvailable={Boolean(props.workspace && props.config?.liveAvailable)} onStop={props.onStop} onSend={send} onAttach={props.onAttach} onClearCapture={props.onClearCapture} onDictation={props.onDictation} onVoiceAction={props.onVoiceAction} />
      <footer className="panel-footer">{props.status.sync && <span className="status-sync" title={props.status.sync}>{props.status.sync}</span>}</footer>
      <div className="resize-handle" onPointerDown={event => { event.preventDefault(); resizing.current = true; }} role="separator" aria-label="Resize tutor panel" aria-orientation="vertical" />
      {sessionsOpen && <SessionDrawer sessions={props.sessions} activeId={activeSession} onClose={() => setSessionsOpen(false)} onCreate={() => { void props.onCreateSession(); setSessionsOpen(false); }} onSelect={id => { void props.onSelectSession(id); setSessionsOpen(false); }} onRename={(id, title) => void props.onRenameSession(id, title)} onDelete={id => void props.onDeleteSession(id)} onSettings={() => { setSessionsOpen(false); setSettingsOpen(true); }} />}
    </section>}
    {panelMode === 'fullscreen' && <div className="fullscreen-chat"><section className="chat-panel"><header className="panel-top"><button className="icon-button" aria-label="Open sessions" onClick={() => setSessionsOpen(true)}><Icon name="ui/sidebar-toggle" /></button><span className="panel-title" aria-hidden="true" /><button className="icon-button" aria-label="Return tutor to dock" onClick={() => setPanelMode('docked')}><Icon name="control/dock" /></button></header><div className="thread" onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>{messages.length === 0 ? <div className="greeting"><Orb /><h1>Hi! I'm your AI Tutor</h1><p>I'm here to help you learn, practice and achieve your goals.</p><div className="suggestions">{[['chip/explain','Explain this concept'],['chip/example','Give me an example'],['chip/exercise','Create an exercise'],['chip/confused',"I don't understand this"]].map(([icon,label])=><button className="suggestion" key={label} onClick={()=>sendSuggestion(label)}><Icon name={icon} size={22}/>{label}</button>)}</div></div> : messages.map(message => <MessageView key={message.id} message={message} onEdit={message.role === 'user' ? text => props.onEditMessage(message.id, text) : undefined} />)}{isBusy && <div className="status-sync" role="status">{props.status.phase ?? 'Working…'}</div>}{props.workspace && <WorkspaceCards workspace={props.workspace} activity={props.activity} sources={props.sources} onStartPlan={sendSuggestion} />}{props.voice.phase !== 'idle' && <div className="voice-state-orb"><Orb variant={props.voice.phase === 'resting' ? 'resting' : 'live'} /></div>}</div>{errorBanner}<Composer ready={Boolean(props.workspace)} key={activeSession} selectedCapture={props.selectedCapture} voice={props.voice} dictationState={props.dictationState} busy={isBusy} liveAvailable={Boolean(props.workspace && props.config?.liveAvailable)} onStop={props.onStop} onSend={send} onAttach={props.onAttach} onClearCapture={props.onClearCapture} onDictation={props.onDictation} onVoiceAction={props.onVoiceAction} /><footer className="panel-footer">{props.status.sync && <span className="status-sync" title={props.status.sync}>{props.status.sync}</span>}</footer><button className="board-peek-toggle" aria-label="Return board to docked view" onClick={() => setPanelMode('docked')}><Icon name="board/hinge" size={22} /></button></section></div>}
    {panelMode === 'collapsed' && <button className="collapsed-dock" onClick={() => setPanelMode('docked')} aria-label="Reopen tutor"><Orb variant="collapsed" /><span>AI Tutor</span></button>}
    {sessionsOpen && panelMode !== 'docked' && <div className="modal-backdrop"><SessionDrawer sessions={props.sessions} activeId={activeSession} onClose={() => setSessionsOpen(false)} onCreate={() => { void props.onCreateSession(); setSessionsOpen(false); }} onSelect={id => { void props.onSelectSession(id); setSessionsOpen(false); }} onRename={(id, title) => void props.onRenameSession(id, title)} onDelete={id => void props.onDeleteSession(id)} onSettings={() => { setSessionsOpen(false); setSettingsOpen(true); }} /></div>}
    {settingsOpen && <Settings settings={currentSettings} config={props.config} busy={isBusy} error={displayError} onSave={settings => void props.onSaveSettings(settings)} onClose={() => setSettingsOpen(false)} onReset={onReset} />}
  </main>;
}

export default App;
