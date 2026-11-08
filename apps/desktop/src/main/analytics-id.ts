import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentHomeDir } from './agent-home'

/**
 * The ids of usage data (decision P24), adapted from T3 Code (MIT; THIRD_PARTY_NOTICES.md):
 *
 *   installId    SHA-256 of ~/.askaboard/anonymous-id, a random UUID made once
 *   distinctId   SHA-256 of the Codex account_id, else of the Claude userID, else installId
 *   owners       SHA-256 of the OpenAI user id (Codex id_token) and of the Claude account uuid
 *
 * A missing file only removes that id. Nothing here sends a raw id.
 */

export type OwnerSource = 'openai' | 'claude'

export interface TelemetryOwner {
  source: OwnerSource
  /** hashTelemetryId of the source's raw id. */
  ownerId: string
}

export interface TelemetryIdentity {
  /** Null disables usage data: the install id could not be read or made, and no provider login names the person. */
  distinctId: string | null
  installId: string | null
  owners: TelemetryOwner[]
}

export const hashTelemetryId = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

export function anonymousIdPath(): string {
  return join(agentHomeDir(), 'anonymous-id')
}

const isNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** The file's text, null when it is not there; other read errors throw. */
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** A JSON file as an object, or null when it is missing, unreadable or malformed (a warning for the last two). */
async function readJson(path: string, source: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readText(path)
    if (text === null) return null
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch (error) {
    console.warn(`analytics: could not read the ${source} identity file: ${error instanceof Error ? error.name : 'error'}`)
    return null
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const obj = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined)

/** The anonymous id: read, or made once and written atomically. */
async function upsertAnonymousId(): Promise<string> {
  const path = anonymousIdPath()
  const existing = await readText(path)
  if (existing !== null) return existing
  const id = randomUUID()
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, id, 'utf8')
  await rename(temp, path)
  return id
}

/** The OpenAI account id in a ChatGPT id_token, read without verifying it (analytics needs only a stable id). */
function openAiUserId(idToken: string): string | undefined {
  try {
    const claims = obj(JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')))
    const id = str(obj(claims?.['https://api.openai.com/auth'])?.user_id)
    return id ? id : undefined
  } catch {
    return undefined
  }
}

export async function readTelemetryIdentity(): Promise<TelemetryIdentity> {
  const home = homedir()
  // Codex writes `tokens` only for ChatGPT logins; `account_id` is the workspace, the id_token names the person.
  const codexTokens = obj((await readJson(join(home, '.codex', 'auth.json'), 'codex'))?.tokens)
  const claudeJson = await readJson(join(home, '.claude.json'), 'claude')
  let installId: string | null = null
  try {
    installId = hashTelemetryId(await upsertAnonymousId())
  } catch (error) {
    console.warn(`analytics: could not read or write the anonymous id: ${error instanceof Error ? error.name : 'error'}`)
  }
  const accountId = str(codexTokens?.account_id)
  const providerId = accountId !== undefined ? accountId : str(claudeJson?.userID)
  const raw: Array<[OwnerSource, string | undefined]> = [
    ['openai', ((token) => (token ? openAiUserId(token) : undefined))(str(codexTokens?.id_token))],
    ['claude', str(obj(claudeJson?.oauthAccount)?.accountUuid)]
  ]
  const owners = raw.flatMap(([source, value]): TelemetryOwner[] => (value !== undefined && value.trim() !== '' ? [{ source, ownerId: hashTelemetryId(value) }] : []))
  return { distinctId: providerId !== undefined ? hashTelemetryId(providerId) : installId, installId, owners }
}

let shared: Promise<TelemetryIdentity> | null = null

/** The ids, read once per process: usage data and the voice server (main/voice.ts, its user for the daily cap) share them, also with usage data off. */
export function telemetryIdentity(): Promise<TelemetryIdentity> {
  return (shared ??= readTelemetryIdentity())
}
