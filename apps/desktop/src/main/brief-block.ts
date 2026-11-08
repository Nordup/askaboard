import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { briefPath, labText } from './lab-switch'

/**
 * The brief (`resources/brief.md`) as a managed block in a learning folder's
 * `AGENTS.md`, so agents in the folder always have it in context:
 *
 *   <!-- askaboard brief: start (managed by …; edits here stop its updates) sha=<hash> -->
 *   …the text of brief.md…
 *   <!-- askaboard brief: end -->
 *
 * `sha` is a short hash of the exact body the app wrote. When the folder
 * opens, a block whose body still has that hash (the learner did not edit it)
 * and differs from the current brief is rewritten; every byte outside the
 * block stays. An edited block is left alone. A file without the start marker
 * never gets a block. A block with the markers of the old name (Learning Space)
 * is found too, and its rewrite gets the new markers.
 */

const START_PREFIX = '<!-- askaboard brief: start (managed by the Askaboard app; edits here stop its updates) sha='
const START_SUFFIX = ' -->'
const END_LINE = '<!-- askaboard brief: end -->'
/** The markers before the rename to Askaboard (2026-11-08), each start with its end. */
const MARKERS: Array<[start: string, end: string]> = [
  [START_PREFIX, END_LINE],
  ['<!-- learning-space brief: start (managed by the Learning Space app; edits here stop its updates) sha=', '<!-- learning-space brief: end -->']
]

/** The line in the learning-folder template that setup replaces with the block. */
export const BRIEF_PLACEHOLDER = '<!-- askaboard brief: placeholder (the app puts the brief here at setup) -->'

function hash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
}

/** The block body: brief.md (or the lab's LS_LAB_BRIEF file) as it is, with the lab switches' spans applied (lab-switch.ts), ending in exactly one newline. */
export function briefBody(): string {
  const text = labText(readFileSync(briefPath(), 'utf8'), 'brief.md').replace(/\r\n?/g, '\n')
  return `${text.replace(/\n+$/, '')}\n`
}

/** The whole block for a body, without a trailing newline after the end line. */
function blockFor(body: string): string {
  return `${START_PREFIX}${hash(body)}${START_SUFFIX}\n${body}${END_LINE}`
}

/** The learning-folder template with the placeholder line replaced by the current block. */
export function fillTemplate(template: string): string {
  const at = template.indexOf(BRIEF_PLACEHOLDER)
  if (at < 0) throw new Error('The AGENTS.md template has no brief placeholder.')
  return template.slice(0, at) + blockFor(briefBody()) + template.slice(at + BRIEF_PLACEHOLDER.length)
}

interface FoundBlock {
  /** Offset of the start line and of the end of the end line. */
  start: number
  end: number
  sha: string
  body: string
}

/** The managed block in a file, null when there is no start line, or a reason when it is broken. */
function findBlock(text: string): FoundBlock | null | string {
  for (const [prefix, endLine] of MARKERS) {
    const found = findBlockWith(text, prefix, endLine)
    if (found !== null) return found
  }
  return null
}

function findBlockWith(text: string, prefix: string, endLine: string): FoundBlock | null | string {
  let start = -1
  for (let from = 0; ; ) {
    const at = text.indexOf(prefix, from)
    if (at < 0) break
    if (at === 0 || text.charAt(at - 1) === '\n') {
      start = at
      break
    }
    from = at + prefix.length
  }
  if (start < 0) return null
  const lineEnd = text.indexOf('\n', start)
  if (lineEnd < 0) return 'the start line has no block after it'
  const line = text.slice(start, lineEnd)
  if (!line.endsWith(START_SUFFIX)) return 'the start line is not in the expected form'
  const sha = line.slice(prefix.length, line.length - START_SUFFIX.length)
  const bodyStart = lineEnd + 1
  let endAt = -1
  for (let from = bodyStart; ; ) {
    const at = text.indexOf(endLine, from)
    if (at < 0) break
    if (text.charAt(at - 1) === '\n' || at === bodyStart) {
      endAt = at
      break
    }
    from = at + endLine.length
  }
  if (endAt < 0) return 'the end line is missing'
  return { start, end: endAt + endLine.length, sha, body: text.slice(bodyStart, endAt) }
}

/** Messages already logged, so each problem shows once per launch. */
const logged = new Set<string>()
function logOnce(key: string, message: string): void {
  if (logged.has(key)) return
  logged.add(key)
  console.log(message)
}

/**
 * Bring the brief block in `<folder>/AGENTS.md` up to date. `file` is the
 * file's path, already checked by the folder's path guard. Never throws.
 */
export async function refreshBriefBlock(file: string): Promise<void> {
  try {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const found = findBlock(text)
    if (found === null) return
    if (typeof found === 'string') {
      logOnce(`${file}:broken`, `brief block: ${file}: ${found}; left unchanged`)
      return
    }
    if (hash(found.body) !== found.sha) {
      logOnce(`${file}:edited:${found.sha}`, `brief block: ${file} was edited by hand (sha ${found.sha} does not match its text); the app no longer updates it`)
      return
    }
    const body = briefBody()
    if (found.body === body) return
    const next = text.slice(0, found.start) + blockFor(body) + text.slice(found.end)
    const real = await realpath(file)
    const mode = (await stat(real)).mode & 0o777
    const temp = join(dirname(real), `.${basename(real)}.${process.pid}.${Date.now()}.tmp`)
    try {
      await writeFile(temp, next, { mode, flag: 'wx' })
      await rename(temp, real)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
    console.log(`brief block: updated ${file} (sha ${found.sha} → ${hash(body)})`)
  } catch (error) {
    console.error(`brief block: could not refresh ${file}: ${String(error)}`)
  }
}
