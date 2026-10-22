import type { Workspace } from '../types';

/**
 * What a session with nothing in it is called (iPad `LearningSession.untitledName`).
 * Not "Untitled": a brand new session is exactly what it is.
 */
export const UNTITLED_SESSION = 'New session';

/** Names older clients stored before titles were derived; never a learner's own choice. */
const PLACEHOLDER_TITLES = new Set([UNTITLED_SESSION, 'Untitled session']);

/**
 * The name the session drawer shows, derived in iPad's order
 * (`LearningSession.title`): the plan's headline, then the learner's first
 * words, then "New session". A learner's rename (web only) comes first.
 *
 * `Workspace.title` is a cache of this, rewritten by the store on every change
 * so the server's session list carries the same name; nothing else writes it.
 */
export function sessionTitle(workspace: Pick<Workspace, 'customTitle' | 'plan' | 'messages'>): string {
  const custom = workspace.customTitle?.trim();
  if (custom) return custom;
  const plan = workspace.plan && typeof workspace.plan === 'object' ? workspace.plan as Record<string, unknown> : null;
  const planTitle = typeof plan?.title === 'string' ? leadingClause(plan.title) : null;
  if (planTitle) return planTitle;
  const opening = workspace.messages.find(message => message.role === 'user' && message.text.trim());
  if (opening) return condensed(opening.text);
  return UNTITLED_SESSION;
}

/**
 * Brings a workspace from any source (browser journal, server, a fresh blank)
 * onto the derived-title model. A workspace saved before `customTitle` existed
 * carries its rename, if any, in `title`; a placeholder there was never a rename.
 */
export function withDerivedTitle(workspace: Workspace): Workspace {
  const customTitle = workspace.customTitle !== undefined
    ? workspace.customTitle
    : PLACEHOLDER_TITLES.has(workspace.title.trim()) || !workspace.title.trim() ? null : workspace.title.trim();
  const next = { ...workspace, customTitle };
  return { ...next, title: sessionTitle(next) };
}

/**
 * A plan title up to its first break in sense: "Radical equations, one careful
 * step at a time" becomes "Radical equations". A head under four characters
 * loses to the whole title, so "No, we square both sides" never becomes "No".
 */
export function leadingClause(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  const stop = [...trimmed].findIndex(character => ',:;—–'.includes(character));
  if (stop < 0) return condensed(trimmed);
  const head = [...trimmed].slice(0, stop).join('').trim();
  return [...head].length >= 4 ? condensed(head) : condensed(trimmed);
}

/** One line, single-spaced, at most `limit` characters, cut at a word where that keeps the subject. */
export function condensed(text: string, limit = 48): string {
  const firstLine = text.split(/\r?\n|\r/).find(line => line.trim()) ?? text;
  const collapsed = firstLine.split(/\s+/).filter(Boolean).join(' ');
  const characters = [...collapsed];
  if (characters.length <= limit) return collapsed;
  const clipped = characters.slice(0, limit).join('');
  const lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace >= limit / 2) return `${clipped.slice(0, lastSpace).trim()}…`;
  return `${clipped.trim()}…`;
}
