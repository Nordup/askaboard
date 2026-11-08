/**
 * Folder trust on this page (decision U19). Main owns it (main/state.ts): the
 * folder snapshot carries it (FolderInfo.trusted) and main answers each change
 * with onFolderTrust. App.tsx hands both here, and nothing else writes it.
 *
 * Every world code starts in a WorldHost (world/host.ts), and its constructor
 * refuses to start while the open folder is not trusted. The paths that make
 * hosts (registry.ts for the board, stills.ts for stills and checks) read
 * worldsTrusted() first, so they pause or skip instead of failing.
 *
 * Until the first snapshot no folder is open, and the value is false.
 */

interface TrustState {
  trusted: boolean
  listeners: Set<(trusted: boolean) => void>
  ask: (() => void) | null
}

// The state outlives a hot reload of this file in dev, as the world items do.
const trust: TrustState = (import.meta.hot?.data.trust as TrustState | undefined) ?? { trusted: false, listeners: new Set(), ask: null }
if (import.meta.hot) import.meta.hot.data.trust = trust

/** The open folder's worlds may run. */
export function worldsTrusted(): boolean {
  return trust.trusted
}

/** App.tsx only: the trust from main's folder snapshot or its answer to a change. */
export function setWorldsTrusted(value: boolean): void {
  if (value === trust.trusted) return
  trust.trusted = value
  for (const listener of trust.listeners) listener(value)
}

export function onWorldsTrust(listener: (trusted: boolean) => void): () => void {
  trust.listeners.add(listener)
  return () => trust.listeners.delete(listener)
}

/** A paused world's "Trust folder…": App shows the trust question (the same one as at open). */
export function askTrust(): void {
  trust.ask?.()
}

/** App.tsx: what askTrust opens; null removes it. */
export function setTrustAsker(ask: (() => void) | null): void {
  trust.ask = ask
}
