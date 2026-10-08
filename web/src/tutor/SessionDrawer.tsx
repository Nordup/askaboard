import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionSummary } from '../ui-types';
import { Icon } from '../design/Icon';

type Variant = 'docked' | 'sidebar';

export function SessionDrawer({ sessions, activeId, variant, width, onClose, onCreate, onSelect, onRename, onDelete, onSettings, onMenuActivity }: {
  sessions: SessionSummary[];
  activeId: string | null;
  variant: Variant;
  width: number;
  onClose(): void;
  onCreate(): void;
  onSelect(id: string): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
  onSettings(): void;
  onMenuActivity?(active: boolean): void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuAt, setMenuAt] = useState({ x: 0, y: 0 });
  const [renameFor, setRenameFor] = useState<SessionSummary | null>(null);
  const [title, setTitle] = useState('');
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressOpenedMenu = useRef(false);
  const firstMenuItem = useRef<HTMLButtonElement>(null);
  const menuReturnFocus = useRef<HTMLElement | null>(null);
  const sorted = [...sessions].sort((a, b) => (b.updated_at ?? b.updatedAt ?? '').localeCompare(a.updated_at ?? a.updatedAt ?? ''));
  const latest = sorted.slice(0, 8);
  const rows = activeId && !latest.some(session => session.id === activeId)
    ? [...latest, ...sorted.filter(session => session.id === activeId).slice(0, 1)]
    : latest;

  useEffect(() => {
    onMenuActivity?.(menuFor !== null);
    return () => onMenuActivity?.(false);
  }, [menuFor, onMenuActivity]);
  useEffect(() => () => { if (longPress.current) clearTimeout(longPress.current); }, []);
  useEffect(() => { if (menuFor) firstMenuItem.current?.focus(); }, [menuFor]);

  const clearLongPress = () => {
    if (longPress.current) clearTimeout(longPress.current);
    longPress.current = null;
  };
  const openMenu = (session: SessionSummary, x: number, y: number, origin?: HTMLElement | null) => {
    const menuWidth = 164;
    const menuHeight = 96;
    if (origin) menuReturnFocus.current = origin;
    setMenuFor(session.id);
    setMenuAt({
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
  };
  const startRename = (session: SessionSummary) => {
    setMenuFor(null);
    setRenameFor(session);
    setTitle(session.title || '');
  };
  const saveRename = () => {
    if (renameFor && title.trim()) onRename(renameFor.id, title.trim());
    setRenameFor(null);
  };
  const closeMenu = () => {
    setMenuFor(null);
    requestAnimationFrame(() => menuReturnFocus.current?.focus());
  };

  return <>
    <aside
      className={`session-drawer session-drawer--${variant}`}
      aria-label={variant === 'sidebar' ? 'Sessions sidebar' : 'Sessions'}
      style={{ '--drawer-width': `${width}px` } as React.CSSProperties}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
    >
      <div className="drawer-header"><strong>AI Tutor</strong></div>
      <p className="drawer-label">Recent</p>
      <div className="session-list">
        {rows.map(session => <div
          key={session.id}
          className={`session-row ${session.id === activeId ? 'is-current' : ''}`}
          onContextMenu={event => { event.preventDefault(); openMenu(session, event.clientX, event.clientY, event.currentTarget.querySelector<HTMLButtonElement>('.session-row-title')); }}
          onPointerDown={event => {
            clearLongPress();
            longPressOpenedMenu.current = false;
            if (event.pointerType === 'touch') {
              const { clientX, clientY } = event;
              const origin = event.currentTarget.querySelector<HTMLButtonElement>('.session-row-title');
              longPress.current = setTimeout(() => { longPressOpenedMenu.current = true; openMenu(session, clientX, clientY, origin); }, 480);
            }
          }}
          onKeyDown={event => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(session, rect.left + rect.width / 2, rect.top + rect.height / 2, event.currentTarget.querySelector<HTMLButtonElement>('.session-row-title'));
            }
          }}
        >
          <button className="session-row-title" onClick={() => {
            if (longPressOpenedMenu.current) { longPressOpenedMenu.current = false; return; }
            setMenuFor(null); onSelect(session.id);
          }} title={session.title || 'Untitled session'}>
            {session.title || 'Untitled session'}
          </button>
        </div>)}
      </div>
      {renameFor && <form className="rename-session" onSubmit={event => { event.preventDefault(); saveRename(); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenameFor(null); }
      }}>
        <label>Session name<input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={120} /></label>
        <div><button type="button" onClick={() => setRenameFor(null)}>Cancel</button><button type="submit" disabled={!title.trim()}>Save</button></div>
      </form>}
      <div className="drawer-bottom">
        <button className="new-session" onClick={onCreate}><Icon name="ui/plus" size={20} />New chat</button>
        <button className="icon-button" aria-label="Settings" onClick={onSettings}><Icon name="control/settings" /></button>
      </div>
    </aside>
    {menuFor && createPortal(<div className="session-menu-layer">
      <button className="session-menu-shield" aria-label="Dismiss session menu" onClick={closeMenu} />
      <div
        className="session-menu"
        role="menu"
        aria-label="Session actions"
        style={{ left: menuAt.x, top: menuAt.y }}
        onPointerDown={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
          if (event.key === 'Tab') setMenuFor(null);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[index]?.focus();
          }
        }}
      >
        <button ref={firstMenuItem} role="menuitem" onClick={() => { const session = sessions.find(item => item.id === menuFor); if (session) startRename(session); }}>Rename</button>
        <button role="menuitem" className="session-menu-delete" onClick={() => { const id = menuFor; setMenuFor(null); onDelete(id); }}>Delete</button>
      </div>
    </div>, document.body)}
  </>;
}
