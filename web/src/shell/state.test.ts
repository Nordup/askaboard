import { describe, expect, it } from 'vitest';
import { initialShellState, transitionShellState } from './state';

describe('shell transitions', () => {
  it('closes only the docked drawer when the presentation changes', () => {
    const state = { ...initialShellState, drawerOpen: true, sidebarOpen: true, selectionMode: true };
    expect(transitionShellState(state, { type: 'presentation', value: 'fullscreen' })).toMatchObject({
      presentation: 'fullscreen', drawerOpen: false, sidebarOpen: true, selectionMode: true,
    });
  });

  it('keeps the full-screen sidebar open after choosing a session', () => {
    const state = { ...initialShellState, sidebarOpen: true };
    expect(transitionShellState(state, { type: 'session-selected' }).sidebarOpen).toBe(true);
  });

  it('leaves drawers open behind settings and dismisses transient layers in order', () => {
    const open = { ...initialShellState, drawerOpen: true, settingsOpen: true };
    const afterFirstEscape = transitionShellState(open, { type: 'escape' });
    expect(afterFirstEscape).toMatchObject({ drawerOpen: true, settingsOpen: false });
    expect(transitionShellState(afterFirstEscape, { type: 'escape' }).drawerOpen).toBe(false);
  });
});
