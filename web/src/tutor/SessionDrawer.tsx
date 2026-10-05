import { useState } from 'react';
import type { SessionSummary } from '../ui-types';
import { Icon } from '../design/Icon';

export function SessionDrawer({ sessions, activeId, onClose, onCreate, onSelect, onRename, onDelete, onSettings }: {
  sessions: SessionSummary[]; activeId: string | null; onClose(): void; onCreate(): void; onSelect(id: string): void;
  onRename(id: string, title: string): void; onDelete(id: string): void; onSettings(): void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameFor, setRenameFor] = useState<SessionSummary | null>(null);
  const [title, setTitle] = useState('');
  const sorted = [...sessions].sort((a, b) => (b.updated_at ?? b.updatedAt ?? '').localeCompare(a.updated_at ?? a.updatedAt ?? ''));
  const rename = () => {
    if (renameFor && title.trim()) onRename(renameFor.id, title.trim());
    setRenameFor(null);
  };
  return <aside className="session-drawer" aria-label="Sessions">
    <div className="drawer-header"><strong>AI Tutor</strong><button className="icon-button" aria-label="Close sessions" onClick={onClose}><Icon name="composer/dismiss" /></button></div>
    <p className="drawer-label">Recent</p>
    <div className="session-list">{sorted.map(session => <div key={session.id} className={`session-row ${session.id === activeId ? 'is-current' : ''}`}>
      <button className="session-row-title" onClick={() => onSelect(session.id)} title={session.title}>{session.title || 'Untitled session'}</button>
      <button className="icon-button session-more" aria-label={`Options for ${session.title || 'session'}`} onClick={() => setMenuFor(menuFor === session.id ? null : session.id)}>···</button>
      {menuFor === session.id && <div className="session-menu"><button onClick={() => { setRenameFor(session); setTitle(session.title); setMenuFor(null); }}>Rename</button><button onClick={() => { if (window.confirm(`Delete “${session.title || 'Untitled session'}”?`)) onDelete(session.id); setMenuFor(null); }}>Delete</button></div>}
    </div>)}</div>
    {renameFor && <form className="rename-session" onSubmit={event => { event.preventDefault(); rename(); }}><label>Session name<input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={120} /></label><div><button type="button" onClick={() => setRenameFor(null)}>Cancel</button><button type="submit" disabled={!title.trim()}>Save</button></div></form>}
    <div className="drawer-bottom"><button className="new-session" onClick={onCreate}><Icon name="ui/plus" size={20} />New chat</button><button className="icon-button" aria-label="Settings" onClick={onSettings}><Icon name="control/settings" /></button></div>
  </aside>;
}
