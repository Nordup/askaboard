/**
 * Browser version of ScreenLayout's lane arithmetic. Values intentionally stay in
 * one pure function so viewport changes, pointer resizing, and tests all use the
 * same clamp.
 */
export const SHELL = {
  edge: 28,
  gap: 24,
  panelInset: 18,
  panelDefault: 337,
  panelMinimum: 260,
  railWidth: 72,
  boardMinimum: 200,
  collapsedMinimumWidth: 352,
  minimumContentHeight: 88,
  resizeAccessibilityStep: 24,
  columnWidth: 740,
  peekWidth: 45,
  collapsedDockWidth: 132,
  collapsedDockHeight: 64,
  sidebarWidth: 296,
  sidebarMinimumWidth: 244,
  minimumReadingColumnWidth: 244,
  referenceWidth: 1376,
  drawerRevealFraction: 0.78,
} as const;

export type ShellFit = 'threeLane' | 'boardOnly' | 'unsupported';

export interface ShellLayout {
  width: number;
  height: number;
  contentTop: number;
  contentHeight: number;
  contentBottom: number;
  panelWidth: number;
  maximumPanelWidth: number;
  dockedMinimumWidth: number;
  fit: ShellFit;
  canDockTutor: boolean;
  panelX: number;
  railX: number;
  railXCollapsed: number;
  boardX: number;
  boardXCollapsed: number;
  boardWidthDocked: number;
  boardWidthCollapsed: number;
  resizeStripX: number;
  drawerWidth: number;
  pushedChatWidth: number;
  sidebarWidth: number;
  columnX: number;
  columnWidth: number;
  columnXWithSidebar: number;
  columnWidthWithSidebar: number;
  collapsedDockX: number;
  collapsedDockY: number;
}

export function resolvePanelWidth(requested: number, viewportWidth: number): number {
  const maximum = Math.max(0, viewportWidth - 2 * SHELL.edge - SHELL.railWidth - 2 * SHELL.gap - SHELL.boardMinimum);
  // Match BoardScreen.resized(_:): below the minimum fitting lane it leaves the
  // requested width alone, allowing fit to choose the collapsed presentation.
  if (maximum < SHELL.panelMinimum) return requested;
  return Math.min(Math.max(requested, SHELL.panelMinimum), maximum);
}

export interface ResizeResolution {
  width: number;
  handleOffset: number;
  collapsed: boolean;
}

/** Anchored panel drag with the same minimum, collapse threshold and rubber band as ResizeModel. */
export function resolvePanelResize(start: number, translation: number, maximum: number): ResizeResolution {
  const proposed = start + translation;
  if (proposed < SHELL.panelMinimum * 0.6) {
    return { width: SHELL.panelMinimum, handleOffset: 0, collapsed: true };
  }
  const upper = Math.max(SHELL.panelMinimum, maximum);
  const width = Math.min(Math.max(proposed, SHELL.panelMinimum), upper);
  const overshoot = proposed - width;
  const magnitude = Math.abs(overshoot);
  const resisted = magnitude === 0
    ? 0
    : (1 - 1 / (magnitude * 0.55 / SHELL.panelMinimum + 1)) * SHELL.panelMinimum;
  return { width, handleOffset: Math.sign(overshoot) * resisted, collapsed: false };
}

export function computeShellLayout(width: number, height: number, requestedPanelWidth: number = SHELL.panelDefault): ShellLayout {
  const screenWidth = Math.max(0, Number.isFinite(width) ? width : 0);
  const screenHeight = Math.max(0, Number.isFinite(height) ? height : 0);
  const contentTop = SHELL.edge;
  const contentBottom = Math.max(0, screenHeight - SHELL.edge);
  const contentHeight = Math.max(0, contentBottom - contentTop);
  const panelWidth = resolvePanelWidth(requestedPanelWidth, screenWidth);
  const maximumPanelWidth = Math.max(0, screenWidth - 2 * SHELL.edge - SHELL.railWidth - 2 * SHELL.gap - SHELL.boardMinimum);
  const dockedMinimumWidth = 2 * SHELL.edge + SHELL.railWidth + 2 * SHELL.gap + panelWidth + SHELL.boardMinimum;
  const fit: ShellFit = contentHeight < SHELL.minimumContentHeight
    ? 'unsupported'
    : screenWidth >= dockedMinimumWidth && panelWidth <= maximumPanelWidth
      ? 'threeLane'
      : screenWidth >= SHELL.collapsedMinimumWidth
        ? 'boardOnly'
        : 'unsupported';

  const panelX = SHELL.edge;
  const railX = panelX + panelWidth + SHELL.gap;
  const railXCollapsed = SHELL.edge;
  const boardX = railX + SHELL.railWidth + SHELL.gap;
  const boardXCollapsed = railXCollapsed + SHELL.railWidth + SHELL.gap;
  const contentRight = Math.max(0, screenWidth - SHELL.edge);
  const boardWidthDocked = Math.max(0, contentRight - boardX);
  const boardWidthCollapsed = Math.max(0, contentRight - boardXCollapsed);
  const drawerWidth = Math.max(0, Math.round(panelWidth * SHELL.drawerRevealFraction));
  const sidebarWidth = Math.max(
    SHELL.sidebarMinimumWidth,
    Math.min(SHELL.sidebarWidth, Math.round(screenWidth * SHELL.sidebarWidth / SHELL.referenceWidth)),
  );

  const columnFor = (leading: number) => {
    const regionX = Math.max(0, leading);
    const regionWidth = Math.max(0, screenWidth - regionX);
    const columnWidth = Math.max(0, Math.min(SHELL.columnWidth, regionWidth - 2 * (SHELL.peekWidth + SHELL.edge)));
    return { x: regionX + (regionWidth - columnWidth) / 2, width: columnWidth };
  };
  const column = columnFor(0);
  const sidebarColumn = columnFor(sidebarWidth);

  return {
    width: screenWidth,
    height: screenHeight,
    contentTop,
    contentHeight,
    contentBottom,
    panelWidth,
    maximumPanelWidth,
    dockedMinimumWidth,
    fit,
    canDockTutor: fit === 'threeLane',
    panelX,
    railX,
    railXCollapsed,
    boardX,
    boardXCollapsed,
    boardWidthDocked,
    boardWidthCollapsed,
    resizeStripX: panelX + panelWidth - SHELL.panelInset,
    drawerWidth,
    pushedChatWidth: Math.max(0, panelWidth - drawerWidth),
    sidebarWidth,
    columnX: column.x,
    columnWidth: column.width,
    columnXWithSidebar: sidebarColumn.x,
    columnWidthWithSidebar: sidebarColumn.width,
    collapsedDockX: boardXCollapsed + SHELL.gap,
    collapsedDockY: contentBottom - SHELL.gap - SHELL.collapsedDockHeight,
  };
}

/**
 * Keep the current Swift sidebar as a reserved lane while it leaves a readable tutor
 * column. Below that threshold it overlays the tutor, so opening the drawer never
 * collapses its transcript/composer to zero width. The sidebar's open preference remains
 * in ShellState and becomes a lane again when the viewport grows.
 */
export function fullscreenSidebarOverlays(width: number, sidebarWidth: number): boolean {
  const readingWidth = width - sidebarWidth - 2 * (SHELL.peekWidth + SHELL.edge);
  return readingWidth < SHELL.minimumReadingColumnWidth;
}
