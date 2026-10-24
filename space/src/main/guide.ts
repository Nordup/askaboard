import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { FolderOverride, GuideOverrides } from '@shared/space-api'
import { resourcePath } from './resources'

/**
 * What agents read: the server instructions (sent at connect) and the guide
 * (get_guide). The text lives in markdown files, read fresh on every use, so
 * prompt experiments need no rebuild:
 *
 * - built in: `resources/guide.md` and `resources/instructions.md`;
 * - the brief, `resources/brief.md`: get_guide topic "brief" (also the managed
 *   block in a learning folder's AGENTS.md, see brief-block.ts). It is not a
 *   reference topic, so get_guide without a topic leaves it out;
 * - per learning folder: `.learning-space/guide.md` and
 *   `.learning-space/instructions.md`. Their text is appended to the built-in
 *   text, or replaces it when the file starts with front matter `mode: replace`.
 *
 * HTML comments are notes for people and never reach the agent. In guide.md,
 * `<!-- topic: name -->` under a `## ` heading names the section for
 * get_guide's `topic` parameter.
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
/** The get_guide topic that serves resources/brief.md. */
const BRIEF_TOPIC = 'brief'

type FolderFileName = 'guide.md' | 'instructions.md'

type FolderText =
  | { kind: 'text'; mode: 'append' | 'replace'; body: string }
  | { kind: 'too-large'; size: number }

interface Section {
  topic: string
  text: string
}

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

/** The topic marker `<!-- topic: name -->` in a section, or null. */
function topicMarker(text: string): string | null {
  let from = 0
  for (;;) {
    const open = text.indexOf('<!--', from)
    if (open < 0) return null
    const close = text.indexOf('-->', open + 4)
    if (close < 0) return null
    const inner = text.slice(open + 4, close).trim()
    if (inner.startsWith('topic:')) {
      const name = inner.slice(6).trim()
      if (name && [...name].every((ch) => /[\w-]/.test(ch))) return name
    }
    from = close + 3
  }
}

/** Split markdown at `## ` headings. The topic is the section's topic marker, else its slugged title. */
function splitSections(markdown: string): Section[] {
  const sections: { title: string; lines: string[] }[] = []
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const title = line.startsWith('##') && /\s/.test(line.charAt(2)) ? line.slice(3).trim() : ''
    if (title) sections.push({ title, lines: [line] })
    else sections.at(-1)?.lines.push(line)
  }
  return sections.map(({ title, lines }) => {
    const text = lines.join('\n')
    const topic = topicMarker(text) ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return { topic, text }
  })
}

/** The guide's base text: the built-in guide, or the folder's guide in replace mode. */
function guideBase(root: string | null): { base: string; local: FolderText | null } {
  const local = readFolderText(root, 'guide.md')
  return { base: local?.kind === 'text' && local.mode === 'replace' ? local.body : readBuiltIn('guide.md'), local }
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

/** The topic names get_guide accepts now. */
export function guideTopics(root: string | null): string[] {
  try {
    return [BRIEF_TOPIC, ...splitSections(guideBase(root).base).map((section) => section.topic).filter((topic) => topic !== BRIEF_TOPIC)]
  } catch {
    return []
  } finally {
    notify(root)
  }
}

/** The get_guide text. With a topic: only that section (or the brief). Without: every reference topic, folder guidance last. */
export function guideText(root: string | null, topic?: string): string {
  try {
    if (topic === BRIEF_TOPIC) return `${clean(readBuiltIn('brief.md'))}\n`
    const { base, local } = guideBase(root)
    if (topic) {
      const sections = splitSections(base)
      const found = sections.filter((section) => section.topic === topic)
      if (!found.length) {
        const topics = [BRIEF_TOPIC, ...sections.map((section) => section.topic)]
        throw new Error(`No guide topic "${topic}". Topics: ${topics.join(', ')}.`)
      }
      return `${clean(found.map((section) => section.text).join('\n\n'))}\n`
    }
    const parts = [clean(base)]
    if (local?.kind === 'text' && local.mode === 'append') parts.push(`## ${FOLDER_HEADING}\n\n${FOLDER_PREFIX}\n\n${local.body}`)
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
      builtIn = 'Learning Space is a shared canvas. Call get_guide before your first write.'
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
