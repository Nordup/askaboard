import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { resourcePath } from './resources'

/**
 * What agents read: the server instructions (sent at connect) and the guide
 * (get_guide). The text lives in markdown files, read fresh on every use, so
 * prompt experiments need no rebuild:
 *
 * - built in: `resources/guide.md` and `resources/instructions.md`;
 * - per learning folder: `.learning-space/guide.md` and
 *   `.learning-space/instructions.md`. Their text is appended to the built-in
 *   text, or replaces it when the file starts with front matter `mode: replace`.
 *
 * HTML comments are notes for people and never reach the agent. In guide.md,
 * `<!-- topic: name -->` under a `## ` heading names the section for
 * get_guide's `topic` parameter.
 */

/** The folder, inside a learning folder, that holds the agent-text overrides. */
export const FOLDER_SETTINGS_DIR = '.learning-space'
const MAX_OVERRIDE_BYTES = 256 * 1024
const FOLDER_HEADING = 'Guidance for this learning folder'

interface FolderText {
  mode: 'append' | 'replace'
  body: string
}

interface Section {
  topic: string
  text: string
}

const stripComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '')

/** Without comments, with at most one blank line in a row. */
const clean = (text: string): string =>
  stripComments(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function parseFrontMatter(raw: string): FolderText {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!match) return { mode: 'append', body: text }
  const replace = /^mode:\s*["']?replace["']?\s*$/m.test(match[1])
  return { mode: replace ? 'replace' : 'append', body: text.slice(match[0].length) }
}

/**
 * `.learning-space/<name>` from the learning folder, or null when it is
 * missing, empty (comments only) or leaves the folder through a link.
 * `root` is the folder's real path.
 */
function readFolderText(root: string | null, name: string): FolderText | null {
  if (!root) return null
  const full = join(root, FOLDER_SETTINGS_DIR, name)
  let real: string
  try {
    real = realpathSync(full)
  } catch {
    return null
  }
  if (!isInside(root, real)) {
    console.error(`${FOLDER_SETTINGS_DIR}/${name} leaves the learning folder through a link; ignored`)
    return null
  }
  try {
    const info = statSync(real)
    if (!info.isFile()) return null
    if (info.size > MAX_OVERRIDE_BYTES) {
      console.error(`${FOLDER_SETTINGS_DIR}/${name} is larger than ${MAX_OVERRIDE_BYTES / 1024} KB; ignored`)
      return null
    }
    const parsed = parseFrontMatter(readFileSync(real, 'utf8'))
    const body = clean(parsed.body)
    return body ? { mode: parsed.mode, body } : null
  } catch (error) {
    console.error(`could not read ${FOLDER_SETTINGS_DIR}/${name}: ${String(error)}`)
    return null
  }
}

function readBuiltIn(name: string): string {
  try {
    return readFileSync(resourcePath(name), 'utf8')
  } catch (error) {
    throw new Error(`The built-in ${name} is missing from the app's resources: ${String(error)}`)
  }
}

/** Split markdown at `## ` headings. The topic is the section's topic marker, else its slugged title. */
function splitSections(markdown: string): Section[] {
  const sections: { title: string; lines: string[] }[] = []
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) sections.push({ title: heading[1], lines: [line] })
    else sections.at(-1)?.lines.push(line)
  }
  return sections.map(({ title, lines }) => {
    const text = lines.join('\n')
    const marker = /<!--\s*topic:\s*([\w-]+)\s*-->/.exec(text)
    const topic = marker ? marker[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return { topic, text }
  })
}

/** The guide's base text: the built-in guide, or the folder's guide in replace mode. */
function guideBase(root: string | null): { base: string; local: FolderText | null } {
  const local = readFolderText(root, 'guide.md')
  return { base: local?.mode === 'replace' ? local.body : readBuiltIn('guide.md'), local }
}

/** The topic names get_guide accepts now. */
export function guideTopics(root: string | null): string[] {
  try {
    return splitSections(guideBase(root).base).map((section) => section.topic)
  } catch {
    return []
  }
}

/** The get_guide text. With a topic: only that section. Without: everything, folder guidance last. */
export function guideText(root: string | null, topic?: string): string {
  const { base, local } = guideBase(root)
  if (topic) {
    const sections = splitSections(base)
    const found = sections.filter((section) => section.topic === topic)
    if (!found.length) throw new Error(`No guide topic "${topic}". Topics: ${sections.map((section) => section.topic).join(', ')}.`)
    return `${clean(found.map((section) => section.text).join('\n\n'))}\n`
  }
  const parts = [clean(base)]
  if (local?.mode === 'append') parts.push(`## ${FOLDER_HEADING}\n\n${local.body}`)
  return `${parts.join('\n\n')}\n`
}

/** The MCP server instructions for a new session. */
export function serverInstructions(root: string | null): string {
  const local = readFolderText(root, 'instructions.md')
  if (local?.mode === 'replace') return local.body
  let builtIn: string
  try {
    builtIn = clean(readBuiltIn('instructions.md'))
  } catch (error) {
    console.error(String(error))
    builtIn = 'Learning Space is a shared canvas. Call get_guide before your first write.'
  }
  return local ? `${builtIn}\n\n${FOLDER_HEADING}:\n${local.body}` : builtIn
}
