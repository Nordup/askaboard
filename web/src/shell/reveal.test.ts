import { describe, expect, it } from 'vitest';
import { chatVeil, drawerVeil, toggleOpacity } from './reveal';

describe('docked drawer reveal', () => {
  it('crosses the white wash between the drawer and chat at the source-design band', () => {
    expect(drawerVeil(0)).toBeCloseTo(0.55);
    expect(drawerVeil(0.25)).toBeCloseTo(0.275);
    expect(drawerVeil(0.3)).toBeCloseTo(0);
    expect(chatVeil(0)).toBeCloseTo(0);
    expect(chatVeil(0.3)).toBeCloseTo(0.3);
    expect(chatVeil(1)).toBeCloseTo(0.55);
  });

  it('fades the pane toggle out before the drawer reaches its open position', () => {
    expect(toggleOpacity(0)).toBe(1);
    expect(toggleOpacity(0.175)).toBeCloseTo(0.5);
    expect(toggleOpacity(0.35)).toBe(0);
  });
});
