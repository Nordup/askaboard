import { BOARDS_DIR } from './board-format'

/**
 * What a scene program is, for the main process and the stage (spec: docs/drafts/
 * story-foundation-2026-10-27/spec.md, section 0).
 *
 * The source of a program is a snapshot: the entry module (inline code from write_scene, or a
 * file in <learning folder>/boards/scenes/) and every file it imports, read once at
 * write_scene (main/scene-files.ts). Every later run of the program (preview, play, restage, a
 * rebuild of the stage) runs the same snapshot; the app never reads the files again for it.
 *
 * The stage runs a StageProgram, which main makes from the snapshot (main/scene-files.ts,
 * stageProgram): a script (inline code with no import or export: the body of an async function,
 * as before modules) or modules (stage/worker.ts loads them).
 */

/** A module of a scene program: its path in boards/scenes/ (null: the inline code of write_scene), its text, and the SHA-256 of the text (hex). */
export interface SceneModule {
  path: string | null
  text: string
  sha256: string
}

/**
 * The snapshot a scene program runs. entry: the file path, or null for inline code. modules[0] is the entry module; the rest are
 * the files it imports, in the order they were first found. A module's path is its real path in boards/scenes/ (links resolved).
 * links: each import path that names a link, and the real path it led to (only when there are any).
 */
export interface SceneSource {
  entry: string | null
  modules: SceneModule[]
  links?: Array<[string, string]>
}

/**
 * A module as the stage runs it (made by main/scene-files.ts): an async function expression whose one parameter is the stage's
 * module helper (stage/worker.ts runModules), with the same line numbers as the module's text.
 */
export interface StageModule {
  path: string | null
  code: string
}

/**
 * The program the stage runs: a script (the body of an async function), or modules (the first one is the entry; links: import
 * paths that lead to another module path, for import() with a computed path).
 */
export type StageProgram = { kind: 'script'; code: string } | { kind: 'modules'; modules: StageModule[]; links: Array<[string, string]> }

/** The folder of scene files, relative to the learning folder. */
export const SCENES_DIR = `${BOARDS_DIR}/scenes`

/**
 * The script URL of a module in stack traces (//# sourceURL): "scene.js" for inline code (as
 * before modules), "scenes/<path>" for a file. A sourceURL with white space is ignored by V8, and
 * a parenthesis would end the location in a stack line: both are escaped.
 */
export function moduleUrl(path: string | null): string {
  if (path === null) return 'scene.js'
  return `scenes/${path
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')}`
}

/** Where in the agent's code something happened: the module (null: the inline code) and the line. */
export interface ProgramSite {
  file: string | null
  line: number
}

/** The innermost frame of an error's stack that is in the agent's code (a module or the inline code), or null. */
export function programSite(stack: string): ProgramSite | null {
  for (const text of stack.split('\n')) {
    const match = /(?:\(|at )(scene\.js|scenes\/[^\s()]+):(\d+):\d+\)?\s*$/.exec(text)
    if (!match) continue
    if (match[1] === 'scene.js') return { file: null, line: Number(match[2]) }
    try {
      return { file: decodeURIComponent(match[1].slice('scenes/'.length)), line: Number(match[2]) }
    } catch {
      continue
    }
  }
  return null
}

/** "Line 12" for the inline code, "lib/arrows.js line 12" for a file: the start of an error or warning. */
export function siteLabel(site: ProgramSite): string {
  return site.file === null ? `Line ${site.line}` : `${site.file} line ${site.line}`
}

/**
 * The path in boards/scenes/ that an import specifier names, from the module that imports it
 * (from: its path, or null for inline code, which imports from the scenes/ root). Relative
 * specifiers ("./x.js", "../lib/y.js") start at the importer's folder; others ("lib/y.js")
 * at the scenes/ root. Returns the path, or why the specifier names no file there.
 */
export function resolveSpecifier(from: string | null, specifier: string): { path: string } | { error: string } {
  if (!specifier) return { error: 'an empty import path' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return { error: 'URLs (and node: or npm: names) cannot be imported; imports name files in boards/scenes/' }
  if (specifier.startsWith('/') || specifier.includes('\\') || specifier.includes('\0')) return { error: 'an import path is relative ("./arrows.js", "../lib/neuron.js") or starts at boards/scenes/ ("lib/neuron.js")' }
  const relative = specifier.startsWith('./') || specifier.startsWith('../')
  const parts = relative && from !== null ? from.split('/').slice(0, -1) : []
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (!parts.length) return { error: 'the path leaves boards/scenes/' }
      parts.pop()
    } else parts.push(part)
  }
  if (!parts.length) return { error: 'the path names no file' }
  return { path: parts.join('/') }
}
