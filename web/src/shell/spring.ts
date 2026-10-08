export const SHELL_SPRING = { stiffness: 320, damping: 34 } as const;

const naturalFrequency = Math.sqrt(SHELL_SPRING.stiffness);
const dampingRatio = SHELL_SPRING.damping / (2 * naturalFrequency);
const decay = dampingRatio * naturalFrequency;
const dampedFrequency = naturalFrequency * Math.sqrt(1 - dampingRatio * dampingRatio);
export const shellSpringDuration = 0.42;

/** Swift DrawerReveal.normalizedSettleVelocity, expressed as progress per second. */
export function springInitialProgressVelocity(physicalVelocity: number, from: number, to: number, travel: number): number {
  const remaining = (to - from) * travel;
  if (!remaining || !travel) return 0;
  let normalized = physicalVelocity / remaining;
  if (normalized > 0) normalized = Math.min(normalized, naturalFrequency);
  return normalized * (to - from);
}

export function springProgress(seconds: number, from: number, to: number, initialVelocity = 0): number {
  const elapsed = Math.max(0, seconds);
  const offset = from - to;
  const sineCoefficient = (initialVelocity + decay * offset) / dampedFrequency;
  const envelope = Math.exp(-decay * elapsed);
  return to + envelope * (offset * Math.cos(dampedFrequency * elapsed) + sineCoefficient * Math.sin(dampedFrequency * elapsed));
}

export function springVelocity(seconds: number, from: number, to: number, initialVelocity = 0): number {
  const elapsed = Math.max(0, seconds);
  const offset = from - to;
  const sineCoefficient = (initialVelocity + decay * offset) / dampedFrequency;
  const angle = dampedFrequency * elapsed;
  const envelope = Math.exp(-decay * elapsed);
  const value = offset * Math.cos(angle) + sineCoefficient * Math.sin(angle);
  const derivative = -offset * dampedFrequency * Math.sin(angle) + sineCoefficient * dampedFrequency * Math.cos(angle);
  return envelope * (derivative - decay * value);
}

/** A sampled CSS timing curve for surfaces that use Swift's same zero-velocity spring. */
export function shellSpringEasing(samples = 10): string {
  const stops = Array.from({ length: samples + 1 }, (_, index) => {
    const percent = index / samples;
    const value = index === 0 ? 0 : index === samples ? 1
      : Math.max(0, Math.min(1.02, springProgress(shellSpringDuration * percent, 0, 1)));
    return `${Number(value.toFixed(4))}${index === 0 ? '' : ` ${Number((percent * 100).toFixed(1))}%`}`;
  });
  return `linear(${stops.join(', ')})`;
}
