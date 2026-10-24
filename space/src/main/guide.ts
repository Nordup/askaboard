import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { FolderOverride, GuideOverrides } from '@shared/space-api'
import { resourcePath } from './resources'

/**
 * What agents read from this file: the server instructions (sent at connect)
 * and the brief (get_brief). The text lives in markdown files, read fresh on
 * every use, so prompt experiments need no rebuild:
 *
 * - built in: `resources/instructions.md` and `resources/brief.md` (the brief
 *   is also the managed block in a learning folder's AGENTS.md, see
 *   brief-block.ts, so agents in a learning folder never need get_brief);
 * - per learning folder: `.learning-space/guide.md` (added to the brief that
 *   get_brief returns) and `.learning-space/instructions.md`. Their text is
 *   appended to the built-in text, or replaces it when the file starts with
 *   front matter `mode: replace`.
 *
 * The board reference (HTML subset, styles, math, SVG, images, tokens, ink,
 * placement) is not here: it lives in the tool and parameter descriptions in
 * mcp.ts (decision T10).
 *
 * HTML comments are notes for people and never reach the agent.
 *
 * Folder files are untrusted input: every text pass here is linear in the
 * file size (indexOf scans and per-line work, no backtracking regexes).
 */

/** The folder, inside a learning folder, that holds the agent-text overrides. */
export const FOLDER_SETTINGS_DIR = '.learning-space'
const MAX_OVERRIDE_BYTES = 64 * 1024
const FOLDER_HEADING = 'Guidance for this learning folder'
const FOLDER_PREFIX = "The following guidance comes from the learner's folder."
const REPLACED_LINE = "Learning Space: the learner's folder replaced these instructions."

type FolderFileName = 'guide.md' | 'instructions.md'

type FolderText =
  | { kind: 'text'; mode: 'append' | 'replace'; body: string }
  | { kind: 'too-large'; size: number }

/** Remove `<!-- … -->`. An unterminated `<!--` drops the rest of the text. */
function stripComments(text: string): string {
  let out = ''
  let from = 0
  for (;;) {
    const open = text.indexOf('<!--', from)
    if (open < 0) return out + text.slice(from)
    out += text.slice(from, open)
    const close = text.indexOf('-->', open + 4)
    if (close < 0) return out
    from = close + 3
  }
}

/** Without comments, without trailing spaces, with at most one blank line in a row. */
function clean(text: string): string {
  const lines = stripComments(text.replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((line) => line.trimEnd())
  const kept: string[] = []
  for (const line of lines) {
    if (line === '' && kept.length > 0 && kept[kept.length - 1] === '') continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** `mode: replace` in a `---` front matter block at the top of the file. */
function parseFrontMatter(raw: string): { mode: 'append' | 'replace'; body: string } {
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n')) return { mode: 'append', body: text }
  let replace = false
  let start = 4
  while (start <= text.length) {
    const end = text.indexOf('\n', start)
    const stop = end < 0 ? text.length : end
    const line = text.slice(start, stop)
    if (line.trimEnd() === '---') return { mode: replace ? 'replace' : 'append', body: text.slice(Math.min(stop + 1, text.length)) }
    const colon = line.indexOf(':')
    if (colon >= 0 && line.slice(0, colon) === 'mode') {
      const value = line.slice(colon + 1).trim()
      replace = value === 'replace' || value === '"replace"' || value === "'replace'"
    }
    if (end < 0) break
    start = end + 1
  }
  // No closing `---`: not front matter.
  return { mode: 'append', body: text }
}

/** Parsed folder files, by real path. A changed mtime or size reparses. */
const cache = new Map<string, { mtimeMs: number; size: number; value: FolderText | null }>()

/**
 * `.learning-space/<name>` from the learning folder, or null when it is
 * missing, empty (comments only) or leaves the folder through a link.
 * `root` is the folder's real path.
 */
function readFolderText(root: string | null, name: FolderFileName): FolderText | null {
  if (!root) return null
  const rel = `${FOLDER_SETTINGS_DIR}/${name}`
  let real: string
  try {
    real = realpathSync(join(root, FOLDER_SETTINGS_DIR, name))
  } catch {
    return null
  }
  if (!isInside(root, real)) {
    console.error(`${rel} leaves the learning folder through a link; ignored`)
    return null
  }
  try {
    const info = statSync(real)
    if (!info.isFile()) return null
    const hit = cache.get(real)
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.value
    let value: FolderText | null
    if (info.size > MAX_OVERRIDE_BYTES) {
      console.error(`${rel} is ${info.size} bytes, larger than ${MAX_OVERRIDE_BYTES / 1024} KB; ignored`)
      value = { kind: 'too-large', size: info.size }
    } else {
      const parsed = parseFrontMatter(readFileSync(real, 'utf8'))
      const body = clean(parsed.body)
      value = body ? { kind: 'text', mode: parsed.mode, body } : null
    }
    cache.set(real, { mtimeMs: info.mtimeMs, size: info.size, value })
    return value
  } catch (error) {
    console.error(`could not read ${rel}: ${String(error)}`)
    return null
  }
}

/** The line the agent reads when a folder file was too large. */
function tooLargeNote(name: FolderFileName, size: number): string {
  return `Note: ${FOLDER_SETTINGS_DIR}/${name} is ${Math.ceil(size / 1024)} KB, larger than the ${MAX_OVERRIDE_BYTES / 1024} KB limit, so Learning Space ignored it.`
}

function readBuiltIn(name: string): string {
  try {
    return readFileSync(resourcePath(name), 'utf8')
  } catch (error) {
    throw new Error(`The built-in ${name} is missing from the app's resources: ${String(error)}`)
  }
}

/** Called after agent text is built, so the UI can show the folder's overrides. */
let overridesRead: ((root: string | null) => void) | null = null
export function onOverridesRead(listener: (root: string | null) => void): void {
  overridesRead = listener
}
function notify(root: string | null): void {
  try {
    overridesRead?.(root)
  } catch (error) {
    console.error(`guide override listener: ${String(error)}`)
  }
}

/**
 * The get_brief text: the built-in brief, then the learning folder's own
 * guidance (.learning-space/guide.md). In replace mode the folder's text is
 * the whole brief.
 */
export function briefText(root: string | null): string {
  try {
    const local = readFolderText(root, 'guide.md')
    if (local?.kind === 'text' && local.mode === 'replace') return `${local.body}\n`
    const parts = [clean(readBuiltIn('brief.md'))]
    if (local?.kind === 'text') parts.push(`## ${FOLDER_HEADING}\n\n${FOLDER_PREFIX}\n\n${local.body}`)
    if (local?.kind === 'too-large') parts.push(tooLargeNote('guide.md', local.size))
    return `${parts.join('\n\n')}\n`
  } finally {
    notify(root)
  }
}

/** The MCP server instructions for a new session. */
export function serverInstructions(root: string | null): string {
  try {
    const local = readFolderText(root, 'instructions.md')
    if (local?.kind === 'text' && local.mode === 'replace') return `${local.body}\n\n${REPLACED_LINE}`
    let builtIn: string
    try {
      builtIn = clean(readBuiltIn('instructions.md'))
    } catch (error) {
      console.error(String(error))
      builtIn = 'Learning Space is a shared board where a person learns with you. If the Learning Space brief is not in your context, read it with get_brief.'
    }
    if (local?.kind === 'too-large') return `${builtIn}\n\n${tooLargeNote('instructions.md', local.size)}`
    return local ? `${builtIn}\n\n## ${FOLDER_HEADING}\n\n${FOLDER_PREFIX}\n\n${local.body}` : builtIn
  } finally {
    notify(root)
  }
}

/** What the folder's guide and instructions files do now, for the UI. */
export function folderOverrides(root: string | null): GuideOverrides {
  const one = (name: FolderFileName): FolderOverride | null => {
    const local = readFolderText(root, name)
    if (!local) return null
    return { path: `${FOLDER_SETTINGS_DIR}/${name}`, mode: local.kind === 'too-large' ? 'too-large' : local.mode }
  }
  return { guide: one('guide.md'), instructions: one('instructions.md') }
}
