import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentHomeDir } from './agent-home'

/**
 * The learner's own Gemini key for the cloud voice: the one owner of GEMINI_API_KEY in ~/.askaboard/.env.
 * voice.ts reads the key at each use (readVoiceKey); Settings saves and removes it here (main/settings.ts calls these).
 * The key never goes back to the renderer, into a log, analytics or state.json: Settings hears only whether one is saved.
 */

const KEY_LINE = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=.*$/m
const envPath = (): string => join(agentHomeDir(), '.env')

/** The key: the environment first, then the file. Read at each use, so a key added later counts at the next scene. */
export function readVoiceKey(): string | null {
  const own = process.env.GEMINI_API_KEY?.trim()
  if (own) return own
  try {
    const line = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/m.exec(readFileSync(envPath(), 'utf8'))
    // A quoted value, else a value up to white space: a comment can follow it.
    return (line && (/^(['"])(.*?)\1/.exec(line[1].trim())?.[2] ?? /^\S*/.exec(line[1].trim())?.[0])) || null
  } catch {
    return null
  }
}

async function readEnv(): Promise<string> {
  try {
    return await readFile(envPath(), 'utf8')
  } catch {
    return ''
  }
}

/** The file without its GEMINI_API_KEY lines, the other lines as they were. */
const withoutKey = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !KEY_LINE.test(line))
    .join('\n')

/**
 * A new file, made with mode 0600, renamed over the old one: the key is never in a file that others
 * can read (an existing file keeps its mode on a write), and a crash leaves the old file or the new one.
 */
async function writeEnv(text: string): Promise<void> {
  await mkdir(agentHomeDir(), { recursive: true })
  const temp = join(agentHomeDir(), `.env-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' })
    await rename(temp, envPath())
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** A key line is in the file (Settings shows "Key saved"; a key from the environment is not the learner's to remove). */
export async function voiceKeySaved(): Promise<boolean> {
  return KEY_LINE.test(await readEnv())
}

export async function saveVoiceKey(key: unknown): Promise<void> {
  const value = typeof key === 'string' ? key.trim() : ''
  if (!value) throw new Error('Paste a key first.')
  // One line of the file: no line break, quote, comment or second "=" in it.
  if (/[\s'"#=]/.test(value)) throw new Error('This does not look like a Gemini key.')
  const rest = withoutKey(await readEnv()).replace(/\n*$/, '')
  await writeEnv(`${rest ? `${rest}\n` : ''}GEMINI_API_KEY=${value}\n`)
}

export async function removeVoiceKey(): Promise<void> {
  const text = await readEnv()
  if (KEY_LINE.test(text)) await writeEnv(withoutKey(text))
}
