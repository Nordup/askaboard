import { describe, expect, it } from 'vitest';
import { shellSpringDuration, shellSpringEasing, springInitialProgressVelocity, springProgress, springVelocity } from './spring';

describe('Swift shell spring', () => {
  it('settles a zero-velocity reveal near its target in the reference duration', () => {
    expect(springProgress(shellSpringDuration, 0, 1)).toBeGreaterThan(0.998);
    expect(Math.abs(springVelocity(shellSpringDuration, 0, 1))).toBeLessThan(0.04);
  });

  it('keeps the CSS spring curve endpoints exact for completed surface transitions', () => {
    expect(shellSpringEasing()).toMatch(/^linear\(0, .* 100%\)$/);
    expect(shellSpringEasing().endsWith('1 100%)')).toBe(true);
  });

  it('carries the release direction and caps motion into the target at the natural frequency', () => {
    expect(springInitialProgressVelocity(300, 0.4, 1, 263)).toBeGreaterThan(0);
    expect(springInitialProgressVelocity(-300, 0.4, 1, 263)).toBeLessThan(0);
    expect(springInitialProgressVelocity(10000, 0.99, 1, 263)).toBeLessThan(18);
  });

  it('keeps the spring reversible when a release starts away from the chosen target', () => {
    const velocity = springInitialProgressVelocity(-900, 0.2, 1, 263);
    expect(velocity).toBeLessThan(0);
    expect(springProgress(0.005, 0.2, 1, velocity)).toBeLessThan(0.2);
  });
});
