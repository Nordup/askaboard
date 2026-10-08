const crossfadeStart = 0.2;
const crossfadeEnd = 0.3;
const fullVeil = 0.55;

function crossfade(progress: number) {
  const t = Math.max(0, Math.min(1, (progress - crossfadeStart) / (crossfadeEnd - crossfadeStart)));
  return t * t * (3 - 2 * t);
}

/** The drawer stays put while the chat pane tracks across it. */
export function drawerVeil(progress: number) {
  return fullVeil * (1 - crossfade(progress));
}

/** The chat veil crosses in at 20–30% and deepens to the published 55% wash. */
export function chatVeil(progress: number) {
  const crossed = crossfade(progress);
  const tail = Math.max(0, Math.min(1, (progress - crossfadeEnd) / (1 - crossfadeEnd)));
  return 0.3 * crossed + (fullVeil - 0.3) * tail * tail;
}

export function toggleOpacity(progress: number) {
  return Math.max(0, Math.min(1, 1 - progress / 0.35));
}
