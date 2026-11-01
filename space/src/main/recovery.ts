import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Boards that could not be saved when the window closed: one file per board under the app's
 * user data, by folder and path. The renderer reads a board's file when the board first opens,
 * and the next good save of the board removes it (main/index.ts).
 */
const directory = (): string => join(app.getPath('userData'), 'recovery')

const fileOf = (root: string, path: string): string => join(directory(), `${createHash('sha1').update(`${root}\0${path}`).digest('hex')}.json`)

export async function keepRecovery(root: string, path: string, text: string): Promise<void> {
  await mkdir(directory(), { recursive: true })
  const file = fileOf(root, path)
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify({ root, path, savedAt: new Date().toISOString(), text }), 'utf8')
  await rename(temp, file)
}

/** The board text kept for this board, or null. */
export async function readRecovery(root: string, path: string): Promise<string | null> {
  try {
    const { text } = JSON.parse(await readFile(fileOf(root, path), 'utf8')) as { text?: unknown }
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

export async function dropRecovery(root: string, path: string): Promise<void> {
  await rm(fileOf(root, path), { force: true })
}

/** The board moved to a new path: its recovery goes with it. */
export async function moveRecovery(root: string, from: string, to: string): Promise<void> {
  const text = await readRecovery(root, from)
  if (text === null) return
  await keepRecovery(root, to, text)
  await dropRecovery(root, from)
}
