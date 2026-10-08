import { describe, expect, it } from 'vitest';
import { computeShellLayout, fullscreenSidebarOverlays, resolvePanelResize, resolvePanelWidth, SHELL } from './layout';

describe('computed shell lanes', () => {
  it('matches the Paper reference docked geometry', () => {
    const layout = computeShellLayout(1376, 1032);
    expect(layout).toMatchObject({
      fit: 'threeLane', panelWidth: 337, panelX: 28, railX: 389, boardX: 485,
      boardWidthDocked: 863, drawerWidth: 263, pushedChatWidth: 74,
      columnX: 318, columnWidth: 740, columnXWithSidebar: 466,
      columnWidthWithSidebar: 740,
      collapsedDockX: 148, collapsedDockY: 916,
    });
  });

  it('keeps the requested width when a viewport temporarily clamps it', () => {
    expect(resolvePanelWidth(480, 700)).toBe(324);
    expect(computeShellLayout(700, 900, 480).fit).toBe('threeLane');
    expect(computeShellLayout(700, 900, 480).panelWidth).toBe(324);
    expect(resolvePanelWidth(480, 1100)).toBe(480);
  });

  it('switches to the existing collapsed-board fit when a dock cannot preserve 200px of board', () => {
    expect(computeShellLayout(635, 900).fit).toBe('boardOnly');
    expect(computeShellLayout(636, 900).fit).toBe('threeLane');
    expect(computeShellLayout(351, 900).fit).toBe('unsupported');
    expect(computeShellLayout(900, 130).fit).toBe('unsupported');
  });

  it('centres the full-screen reading column in the remaining sidebar lane', () => {
    const layout = computeShellLayout(1280, 720);
    expect(layout.columnWidth).toBe(SHELL.columnWidth);
    expect(layout.columnX).toBe(270);
    expect(layout.sidebarWidth).toBe(275);
    expect(layout.columnXWithSidebar).toBe(407.5);
    expect(layout.columnWidthWithSidebar).toBe(740);
    expect(layout.resizeStripX).toBe(347);
  });

  it('centres the reading lane in the remaining viewport while preserving the 600px tutor content cap', () => {
    const layout = computeShellLayout(800, 720);
    expect(layout.columnWidth).toBe(654);
    expect(layout.columnX).toBe(73);
    expect(layout.columnWidthWithSidebar).toBe(410);
    expect(layout.columnXWithSidebar).toBe(317);
    expect(Math.min(layout.columnWidth, 600)).toBe(600);
    expect(Math.min(layout.columnWidthWithSidebar, 600)).toBe(410);
  });

  it('overlays the full-screen sidebar only when reserving it would collapse the reading lane', () => {
    expect(fullscreenSidebarOverlays(390, 244)).toBe(true);
    expect(fullscreenSidebarOverlays(633, 244)).toBe(true);
    expect(fullscreenSidebarOverlays(634, 244)).toBe(false);
    expect(fullscreenSidebarOverlays(1280, 275)).toBe(false);
  });

  it('keeps resize anchored to its start, clamps at bounds, and collapses without overwriting the saved width', () => {
    expect(resolvePanelResize(337, 120, 500)).toEqual({ width: 457, handleOffset: 0, collapsed: false });
    expect(resolvePanelResize(337, 400, 400).width).toBe(400);
    expect(resolvePanelResize(337, 400, 400).handleOffset).toBeGreaterThan(0);
    expect(resolvePanelResize(337, -200, 800).collapsed).toBe(true);
  });
});
