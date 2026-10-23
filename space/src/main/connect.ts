import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, shell } from 'electron'
import type { AgentClientId, AgentClientStatus, AgentClientsStatus, ConnectResult } from '@shared/space-api'
import { shimPath } from './agent-home'
import { resourcePath } from './resources'

/**
 * The "Connect an agent" buttons: find the Claude Code and Codex CLIs, read
 * whether Learning Space is in their config, and run their `mcp add`. Every
 * command is a fixed argv run with execFile (no shell string) and a timeout.
 * The Claude app gets the bundled .mcpb, which it installs from its own dialog.
 */

const SERVER_NAME = 'learning-space'
const SHELL_TIMEOUT_MS = 8000
const STATUS_TIMEOUT_MS = 20_000
const ADD_TIMEOUT_MS = 30_000

/** Dev hook: "Install" for the Claude app logs the .mcpb path instead of opening it. */
const dryRunOpen = !app.isPackaged && process.env.SPACE_CONNECT_DRY_RUN === '1'

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  error: string | null
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
      const reason = error ? (error.killed ? `timed out after ${Math.round(timeout / 1000)} s` : error.message) : null
      resolve({ code, stdout: String(stdout), stderr: String(stderr), error: reason })
    })
  })
}

function firstLine(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? null
}

function failure(result: RunResult): string {
  return firstLine(result.stderr) ?? firstLine(result.stdout) ?? result.error ?? `exit code ${result.code}`
}

/** The shim path as a learner types it: ~/... when it is under the home folder. */
function displayShim(): string {
  const home = homedir()
  const path = shimPath()
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

// ---------- Finding the CLIs ----------

interface Tools {
  env: NodeJS.ProcessEnv
  claude: string | null
  codex: string | null
}

/**
 * An app started from the Dock gets a short PATH, so ask the login shell
 * (`/bin/zsh -lc 'command -v claude'`) for the learner's PATH and the CLIs.
 * A CLI the login shell misses (PATH set in .zshrc only) is looked up in the
 * usual install folders.
 */
async function findTools(): Promise<Tools> {
  const script = 'printf "\\n__LS_PATH=%s\\n" "$PATH"; printf "__LS_claude=%s\\n" "$(command -v claude)"; printf "__LS_codex=%s\\n" "$(command -v codex)"'
  const result = await run('/bin/zsh', ['-lc', script], process.env, SHELL_TIMEOUT_MS)
  const value = (key: string): string | null => {
    const line = result.stdout.split('\n').find((entry) => entry.startsWith(`__LS_${key}=`))
    return line ? line.slice(`__LS_${key}=`.length).trim() || null : null
  }
  const path = value('PATH') ?? process.env.PATH ?? '/usr/bin:/bin'
  const home = homedir()
  const fallbackDirs = [join(home, '.local/bin'), join(home, '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global/bin')]
  const locate = (name: string): string | null => {
    const found = value(name)
    // `command -v` prints "alias claude=..." for an alias; only an absolute path is runnable.
    if (found?.startsWith('/')) return found
    return fallbackDirs.map((dir) => join(dir, name)).find((candidate) => existsSync(candidate)) ?? null
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [path, ...fallbackDirs].join(':') }
  // The CLIs must not inherit the dev hook that runs Electron as Node.
  delete env.ELECTRON_RUN_AS_NODE
  return { env, claude: locate('claude'), codex: locate('codex') }
}

// ---------- Status ----------

async function claudeCodeStatus(tools: Tools): Promise<AgentClientStatus> {
  const base = { id: 'claude-code' as const, label: 'Claude Code', command: `claude mcp add --scope user ${SERVER_NAME} -- ${displayShim()} mcp` }
  if (!tools.claude) return { ...base, state: 'missing', detail: 'The claude command was not found.' }
  const result = await run(tools.claude, ['mcp', 'get', SERVER_NAME], tools.env, STATUS_TIMEOUT_MS)
  if (result.code === 0) return { ...base, state: 'connected', detail: null }
  if (result.code === null) return { ...base, state: 'unknown', detail: result.error }
  return { ...base, state: 'available', detail: null }
}

function codexConfigPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
}

/** A [mcp_servers.learning-space] table, with a URL or a command: both count. */
function codexHasServer(): boolean {
  try {
    const text = readFileSync(codexConfigPath(), 'utf8')
    return /^\s*\[\s*mcp_servers\s*\.\s*(?:"learning-space"|'learning-space'|learning-space)\s*\]/m.test(text)
  } catch {
    return false
  }
}

function codexStatus(tools: Tools): AgentClientStatus {
  const base = { id: 'codex' as const, label: 'Codex', command: `codex mcp add ${SERVER_NAME} -- ${displayShim()} mcp` }
  if (codexHasServer()) return { ...base, state: 'connected', detail: null }
  if (!tools.codex) return { ...base, state: 'missing', detail: 'The codex command was not found.' }
  return { ...base, state: 'available', detail: null }
}

function claudeAppPath(): string | null {
  return ['/Applications/Claude.app', join(homedir(), 'Applications/Claude.app')].find((path) => existsSync(path)) ?? null
}

/**
 * The Claude app unpacks each extension into its own folder under "Claude
 * Extensions". The folder name is not a published contract, so any folder
 * whose name holds "learning-space" counts.
 */
function claudeAppHasExtension(): boolean {
  try {
    const dir = join(homedir(), 'Library/Application Support/Claude/Claude Extensions')
    return readdirSync(dir).some((name) => name.toLowerCase().includes(SERVER_NAME))
  } catch {
    return false
  }
}

function claudeAppStatus(): AgentClientStatus {
  const base = { id: 'claude-app' as const, label: 'Claude app', command: null }
  if (claudeAppHasExtension()) return { ...base, state: 'connected', detail: null }
  if (!claudeAppPath()) return { ...base, state: 'missing', detail: 'The Claude app was not found in Applications.' }
  return { ...base, state: 'available', detail: null }
}

export async function agentClients(): Promise<AgentClientsStatus> {
  const tools = await findTools()
  const clients = await Promise.all([claudeCodeStatus(tools), Promise.resolve(codexStatus(tools)), Promise.resolve(claudeAppStatus())])
  return { shimPath: shimPath(), clients }
}

// ---------- Actions ----------

function mcpbPath(): string {
  return resourcePath('learning-space.mcpb')
}

async function addWith(cli: 'claude' | 'codex', args: string[]): Promise<ConnectResult> {
  const tools = await findTools()
  const file = tools[cli]
  if (!file) return { ok: false, message: `The ${cli} command was not found.` }
  if (!existsSync(shimPath())) return { ok: false, message: `The shim ${shimPath()} is missing. Restart Learning Space.` }
  const result = await run(file, args, tools.env, ADD_TIMEOUT_MS)
  console.log(`connect: ${cli} ${args.join(' ')} → ${result.code === 0 ? 'ok' : failure(result)}`)
  return result.code === 0 ? { ok: true, message: 'Connected' } : { ok: false, message: failure(result) }
}

export async function connectAgentClient(id: AgentClientId): Promise<ConnectResult> {
  switch (id) {
    case 'claude-code':
      return addWith('claude', ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', shimPath(), 'mcp'])
    case 'codex':
      return addWith('codex', ['mcp', 'add', SERVER_NAME, '--', shimPath(), 'mcp'])
    case 'claude-app': {
      const path = mcpbPath()
      if (!existsSync(path)) return { ok: false, message: 'The extension file is missing (run npm run build:mcpb).' }
      if (dryRunOpen) {
        console.log(`connect: dry run, would open ${path}`)
        return { ok: true, message: 'Opened in Claude' }
      }
      const error = await shell.openPath(path)
      return error ? { ok: false, message: error } : { ok: true, message: 'Opened in Claude' }
    }
    default:
      return { ok: false, message: `Unknown agent app "${String(id)}".` }
  }
}

export function isAgentClientId(value: unknown): value is AgentClientId {
  return value === 'claude-code' || value === 'codex' || value === 'claude-app'
}
