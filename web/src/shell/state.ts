export type Presentation = 'docked' | 'collapsed' | 'fullscreen';

export interface ShellState {
  presentation: Presentation;
  drawerOpen: boolean;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  selectionMode: boolean;
}

export type ShellEvent =
  | { type: 'presentation'; value: Presentation }
  | { type: 'toggle-drawer' }
  | { type: 'toggle-sidebar' }
  | { type: 'drawer-open'; value: boolean }
  | { type: 'sidebar-open'; value: boolean }
  | { type: 'settings-open'; value: boolean }
  | { type: 'selection-toggle' }
  | { type: 'session-selected' }
  | { type: 'escape' };

export const initialShellState: ShellState = {
  presentation: 'docked',
  drawerOpen: false,
  sidebarOpen: false,
  settingsOpen: false,
  selectionMode: false,
};

/** Presentation state is transient and orthogonal to the active conversation. */
export function transitionShellState(state: ShellState, event: ShellEvent): ShellState {
  switch (event.type) {
    case 'presentation':
      return event.value === state.presentation
        ? state
        : { ...state, presentation: event.value, drawerOpen: false };
    case 'toggle-drawer':
      return { ...state, drawerOpen: !state.drawerOpen };
    case 'toggle-sidebar':
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case 'drawer-open':
      return { ...state, drawerOpen: event.value };
    case 'sidebar-open':
      return { ...state, sidebarOpen: event.value };
    case 'settings-open':
      return { ...state, settingsOpen: event.value };
    case 'selection-toggle':
      return { ...state, selectionMode: !state.selectionMode };
    case 'session-selected':
      // The docked drawer is a picker; the full-screen sidebar is a live lane.
      return { ...state, drawerOpen: false };
    case 'escape':
      if (state.settingsOpen) return { ...state, settingsOpen: false };
      if (state.drawerOpen) return { ...state, drawerOpen: false };
      if (state.sidebarOpen) return { ...state, sidebarOpen: false };
      if (state.selectionMode) return { ...state, selectionMode: false };
      return state;
  }
}
