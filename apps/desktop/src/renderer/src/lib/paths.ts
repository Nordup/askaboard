/** A folder path as the learner reads it: the folder menu's path line and Settings > Folder. */

/** A path longer than this drops its middle folders (CSS ends a still longer one with an ellipsis). */
const PATH_LINE_MAX = 32

/** The path with `~` for the home folder. */
export function homePath(path: string, home: string): string {
  if (!home || !path.startsWith(home)) return path
  const rest = path.slice(home.length)
  if (rest === '') return '~'
  return rest.startsWith('/') || rest.startsWith('\\') ? `~${rest}` : path
}

/** One line for the path: `~/…/<parent>/<folder>` when it is longer than PATH_LINE_MAX. */
export function shortPath(path: string): string {
  if (path.length <= PATH_LINE_MAX) return path
  const separator = path.includes('/') ? '/' : '\\'
  const parts = path.split(separator)
  if (parts.length <= 4) return path
  return [parts[0], '…', ...parts.slice(-2)].join(separator)
}
