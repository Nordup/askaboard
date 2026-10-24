import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { FolderOverride, GuideOverrides } from '@shared/space-api'
import { resourcePath } from './resources'

/**
 * What agents read from this file: the server instructions (sent at connect),
 * the brief (get_brief) and the board reference (get_guide). The text lives in
 * markdown files, read fresh on every use, so prompt experiments need no
 * rebuild:
 *
 * - built in: `resources/instructions.md`, `resources/brief.md` (the brief is
 *   also the managed block in a learning folder's AGENTS.md, see
 *   brief-block.ts, so agents in a learning folder never need get_brief) and
 *   `resources/guide.md` (the reference, in topics; decision T11);
 * - per learning folder: `.learning-space/guide.md` (the reference's topic
 *   "folder", or the whole reference with `mode: replace`) and
 *   `.learning-space/instructions.md` (appended to the server instructions,
 *   or replacing them with `mode: replace`).
 *
 * In guide.md, every `## ` heading starts a topic. `<!-- topic: name -->`
 * names it (else the slugged title) and `<!-- summary: … -->` gives the one
 * line that get_guide's description lists for it (else the title).
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
/** The get_guide topic that holds the folder's .learning-space/guide.md (append mode). */
const FOLDER_TOPIC = 'folder'
const FOLDER_SUMMARY = "Guidance from this learning folder (its .learning-space/guide.md)."

type FolderFileName = 'guide.md' | 'instructions.md'

type FolderText =
  | { kind: 'text'; mode: 'append' | 'replace'; body: string }
  | { kind: 'too-large'; size: number }

interface Section {
  topic: string
  summary: string
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

/** The value of the first `<!-- key: value -->` comment in a section, or null. */
function marker(text: string, key: string): string | null {
  let from = 0
  for (;;) {
    const open = text.indexOf('<!--', from)
    if (open < 0) return null
    const close = text.indexOf('-->', open + 4)
    if (close < 0) return null
    const inner = text.slice(open + 4, close).trim()
    if (inner.startsWith(`${key}:`)) {
      const value = inner.slice(key.length + 1).trim()
      if (value) return value
    }
    from = close + 3
  }
}

/** A topic marker's name, when it is a plain word (letters, digits, _ and -). */
function topicName(text: string): string | null {
  const name = marker(text, 'topic')
  return name && [...name].every((ch) => /[\w-]/.test(ch)) ? name : null
}

/** Split markdown at `## ` headings into topics. Text before the first heading is left out. */
function splitSections(markdown: string): Section[] {
  const sections: { title: string; lines: string[] }[] = []
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const title = line.startsWith('##') && /\s/.test(line.charAt(2)) ? line.slice(3).trim() : ''
    if (title) sections.push({ title, lines: [line] })
    else sections.at(-1)?.lines.push(line)
  }
  return sections.map(({ title, lines }) => {
    const text = lines.join('\n')
    const topic = topicName(text) ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return { topic, summary: marker(text, 'summary') ?? title, text }
  })
}

/** The reference's topics: the built-in guide plus the folder's topic, or the folder's guide in replace mode. */
function referenceSections(root: string | null): Section[] {
  const local = readFolderText(root, 'guide.md')
  if (local?.kind === 'text' && local.mode === 'replace') return splitSections(local.body)
  const sections = splitSections(readBuiltIn('guide.md'))
  if (local?.kind === 'text') {
    sections.push({ topic: FOLDER_TOPIC, summary: FOLDER_SUMMARY, text: `## ${FOLDER_HEADING}\n\n${FOLDER_PREFIX}\n\n${local.body}` })
  }
  if (local?.kind === 'too-large') {
    sections.push({ topic: FOLDER_TOPIC, summary: FOLDER_SUMMARY, text: `## ${FOLDER_HEADING}\n\n${tooLargeNote('guide.md', local.size)}` })
  }
  return sections
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

/** The get_brief text: the built-in brief, nothing else (the folder's guidance is get_guide topic "folder"). */
export function briefText(): string {
  return `${clean(readBuiltIn('brief.md'))}\n`
}

/** get_guide's topics, one line each ("- html: summary"), for its description. */
export function guideTopics(root: string | null): string {
  try {
    return referenceSections(root)
      .map((section) => `- ${section.topic}: ${clean(section.summary)}`)
      .join('\n')
  } catch (error) {
    console.error(String(error))
    return ''
  } finally {
    notify(root)
  }
}

/** The get_guide text. With a topic: only that topic. Without: every topic in order. */
export function guideText(root: string | null, topic?: string): string {
  try {
    const sections = referenceSections(root)
    if (!topic) return `${clean(sections.map((section) => section.text).join('\n\n'))}\n`
    const found = sections.filter((section) => section.topic === topic)
    if (!found.length) {
      const brief = topic === 'brief' ? ' The brief is not a guide topic: read it with get_brief.' : ''
      throw new Error(`No guide topic "${topic}".${brief} Topics: ${sections.map((section) => section.topic).join(', ')}.`)
    }
    return `${clean(found.map((section) => section.text).join('\n\n'))}\n`
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
