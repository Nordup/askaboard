import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, shell } from 'electron'
import type { AgentClientAction, AgentClientId, AgentClientStatus, AgentClientsStatus, ConnectResult } from '@shared/space-api'
import { shimPath } from './agent-home'
import { resourcePath } from './resources'

/**
 * The "Connect an agent" buttons. Plugin first: Claude Code and Codex get the
 * Learning Space plugin from the public marketplace (`claude plugin install`,
 * `codex plugin add`). A hand-made `learning-space` MCP entry is detected, so
 * the popover can switch it to the plugin or remove the duplicate. Every
 * command is a fixed argv run with execFile (no shell string) and a timeout.
 * The Claude app gets the bundled .mcpb, which it installs from its own dialog.
 */

/** The MCP server name, for the plugin and for a manual entry. */
const SERVER_NAME = 'learning-space'
const MARKETPLACE_REPO = 'Nordup/learning-space-plugins'
const MARKETPLACE_NAME = 'learning-space'
const PLUGIN_ID = 'learning-space@learning-space'
const SHELL_TIMEOUT_MS = 8000
const STATUS_TIMEOUT_MS = 20_000
/** The marketplace add clones a GitHub repository. */
const INSTALL_TIMEOUT_MS = 90_000
const REMOVE_TIMEOUT_MS = 30_000

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
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  return plain.split('\n').map((line) => line.trim()).find(Boolean) ?? null
}

function failure(result: RunResult): string {
  return firstLine(result.stderr) ?? firstLine(result.stdout) ?? result.error ?? `exit code ${result.code}`
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

type Cli = 'claude' | 'codex'

const LABELS: Record<Cli, string> = { claude: 'Claude Code', codex: 'Codex' }
const CLIENT_OF: Record<Cli, 'claude-code' | 'codex'> = { claude: 'claude-code', codex: 'codex' }

/** What the config of one CLI holds. null: that part of the check failed. */
interface Found {
  /** Installed and enabled. */
  plugin: boolean
  /** Installed but disabled. */
  pluginDisabled: boolean
  manual: boolean
  /** The check error, when a part of the check failed. */
  error: string | null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `claude plugin list --json` / `codex plugin list --json` → the plugin entry, or null. */
function findPlugin(value: unknown): { enabled: boolean } | null {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? (value as { installed?: unknown }).installed : null
  if (!Array.isArray(list)) return null
  const entry = list.find((item) => {
    const record = item as { id?: unknown; pluginId?: unknown }
    return record?.id === PLUGIN_ID || record?.pluginId === PLUGIN_ID
  }) as { enabled?: unknown; installed?: unknown } | undefined
  if (!entry || entry.installed === false) return null
  return { enabled: entry.enabled !== false }
}

/** `plugin marketplace list --json` of either CLI holds the Learning Space marketplace. */
function hasMarketplace(value: unknown): boolean {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? (value as { marketplaces?: unknown }).marketplaces : null
  return Array.isArray(list) && list.some((item) => (item as { name?: unknown })?.name === MARKETPLACE_NAME)
}

async function pluginState(file: string, env: NodeJS.ProcessEnv): Promise<{ plugin: boolean; pluginDisabled: boolean; error: string | null }> {
  const result = await run(file, ['plugin', 'list', '--json'], env, STATUS_TIMEOUT_MS)
  const parsed = result.code === 0 ? parseJson(result.stdout) : undefined
  if (parsed === undefined) return { plugin: false, pluginDisabled: false, error: failure(result) }
  const entry = findPlugin(parsed)
  return { plugin: Boolean(entry?.enabled), pluginDisabled: Boolean(entry && !entry.enabled), error: null }
}

/**
 * `claude mcp get learning-space` exits 0 for a manual entry and prints the
 * remove command with its scope. The plugin's server has another name
 * (`plugin:learning-space:learning-space`), so it never matches.
 */
async function claudeManual(tools: Tools): Promise<{ manual: boolean; scope: string; error: string | null }> {
  const result = await run(tools.claude as string, ['mcp', 'get', SERVER_NAME], tools.env, STATUS_TIMEOUT_MS)
  if (result.code === null) return { manual: false, scope: 'user', error: result.error }
  if (result.code !== 0) return { manual: false, scope: 'user', error: null }
  const flag = /mcp remove \S+ -s (user|local|project)\b/.exec(result.stdout)?.[1]
  const label = /Scope:\s*(User|Local|Project)\b/i.exec(result.stdout)?.[1]?.toLowerCase()
  return { manual: true, scope: flag ?? label ?? 'user', error: null }
}

function codexConfigText(): string {
  try {
    return readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8')
  } catch {
    return ''
  }
}

/** A [mcp_servers.learning-space] table, with a URL or a command: both count. */
function codexHasManual(text: string): boolean {
  return /^\s*\[\s*mcp_servers\s*\.\s*(?:"learning-space"|'learning-space'|learning-space)\s*\]/m.test(text)
}

/** The plugin table, read from config.toml when the codex CLI is missing. */
function codexHasPluginTable(text: string): boolean {
  return /^\s*\[\s*plugins\s*\.\s*"learning-space@learning-space"\s*\]/m.test(text)
}

async function found(cli: Cli, tools: Tools): Promise<Found> {
  const file = tools[cli] as string
  if (cli === 'claude') {
    const [plugin, manual] = await Promise.all([pluginState(file, tools.env), claudeManual(tools)])
    return { ...plugin, manual: manual.manual, error: plugin.error ?? manual.error }
  }
  const plugin = await pluginState(file, tools.env)
  return { ...plugin, manual: codexHasManual(codexConfigText()) }
}

function toStatus(cli: Cli, value: Found): AgentClientStatus {
  const base = { id: CLIENT_OF[cli], label: LABELS[cli] }
  if (value.plugin && value.manual) return { ...base, state: 'both', detail: null, action: 'remove-manual' }
  if (value.plugin) return { ...base, state: 'plugin', detail: null, action: null }
  if (value.error) return { ...base, state: 'unknown', detail: value.error, action: 'install-plugin' }
  if (value.manual) return { ...base, state: 'manual', detail: null, action: 'switch-to-plugin' }
  const detail = value.pluginDisabled ? 'The plugin is installed but disabled.' : null
  return { ...base, state: 'available', detail, action: 'install-plugin' }
}

async function cliStatus(cli: Cli, tools: Tools): Promise<AgentClientStatus> {
  if (!tools[cli]) {
    const base = { id: CLIENT_OF[cli], label: LABELS[cli], action: null }
    // Without the CLI, only Codex's config file can still be read.
    if (cli === 'codex') {
      const text = codexConfigText()
      const plugin = codexHasPluginTable(text)
      const manual = codexHasManual(text)
      if (plugin || manual) return { ...base, state: plugin && manual ? 'both' : plugin ? 'plugin' : 'manual', detail: 'The codex command was not found.' }
    }
    return { ...base, state: 'missing', detail: `The ${cli} command was not found.` }
  }
  return toStatus(cli, await found(cli, tools))
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
  const base = { id: 'claude-app' as const, label: 'Claude app' }
  if (claudeAppHasExtension()) return { ...base, state: 'connected', detail: null, action: null }
  if (!claudeAppPath()) return { ...base, state: 'missing', detail: 'The Claude app was not found in Applications.', action: null }
  return { ...base, state: 'available', detail: null, action: 'install-extension' }
}

export async function agentClients(): Promise<AgentClientsStatus> {
  const tools = await findTools()
  const clients = await Promise.all([cliStatus('claude', tools), cliStatus('codex', tools), Promise.resolve(claudeAppStatus())])
  return { shimPath: shimPath(), clients }
}

// ---------- Actions ----------

const RESTART_HINT: Record<Cli, string> = {
  claude: 'Restart Claude Code or run /reload-plugins.',
  codex: 'Restart Codex (or the Codex app) to load the plugin.'
}

/** One action per CLI at a time: two config writes must not race. */
const queues: Record<Cli, Promise<unknown>> = { claude: Promise.resolve(), codex: Promise.resolve() }

function serial<T>(cli: Cli, task: () => Promise<T>): Promise<T> {
  const next = queues[cli].then(task, task)
  queues[cli] = next.catch(() => undefined)
  return next
}

/** Run one step; null on success, else the error line. */
async function step(cli: Cli, tools: Tools, args: string[], timeout: number): Promise<string | null> {
  const result = await run(tools[cli] as string, args, tools.env, timeout)
  const message = result.code === 0 ? null : failure(result)
  console.log(`connect: ${cli} ${args.join(' ')} → ${message ?? 'ok'}`)
  return message
}

/** Add the marketplace when it is missing, then install (or enable) the plugin. */
async function installPlugin(cli: Cli, tools: Tools): Promise<string | null> {
  const listed = await run(tools[cli] as string, ['plugin', 'marketplace', 'list', '--json'], tools.env, STATUS_TIMEOUT_MS)
  if (!(listed.code === 0 && hasMarketplace(parseJson(listed.stdout)))) {
    const error = await step(cli, tools, ['plugin', 'marketplace', 'add', MARKETPLACE_REPO], INSTALL_TIMEOUT_MS)
    if (error) return error
  }
  if (cli === 'codex') return step(cli, tools, ['plugin', 'add', PLUGIN_ID], INSTALL_TIMEOUT_MS)
  const state = await pluginState(tools.claude as string, tools.env)
  if (state.pluginDisabled) return step(cli, tools, ['plugin', 'enable', PLUGIN_ID, '--scope', 'user'], INSTALL_TIMEOUT_MS)
  return step(cli, tools, ['plugin', 'install', PLUGIN_ID, '--scope', 'user'], INSTALL_TIMEOUT_MS)
}

async function removeManual(cli: Cli, tools: Tools): Promise<string | null> {
  if (cli === 'claude') {
    const manual = await claudeManual(tools)
    if (manual.error) return manual.error
    if (!manual.manual) return null
    return step(cli, tools, ['mcp', 'remove', SERVER_NAME, '--scope', manual.scope], REMOVE_TIMEOUT_MS)
  }
  // `codex mcp remove` exits 0 when the entry is missing, so read the file back.
  const error = await step(cli, tools, ['mcp', 'remove', SERVER_NAME], REMOVE_TIMEOUT_MS)
  if (error) return error
  return codexHasManual(codexConfigText()) ? 'The manual entry is still in config.toml.' : null
}

async function cliAction(cli: Cli, action: AgentClientAction): Promise<ConnectResult> {
  const tools = await findTools()
  if (!tools[cli]) return { ok: false, message: `The ${cli} command was not found.` }
  return serial(cli, async () => {
    switch (action) {
      case 'install-plugin': {
        const error = await installPlugin(cli, tools)
        return error ? { ok: false, message: error } : { ok: true, message: `Plugin installed. ${RESTART_HINT[cli]}` }
      }
      case 'switch-to-plugin': {
        const installError = await installPlugin(cli, tools)
        if (installError) return { ok: false, message: installError }
        const removeError = await removeManual(cli, tools)
        if (removeError) return { ok: false, message: `Plugin installed, but the manual entry stays: ${removeError}` }
        return { ok: true, message: `Switched to the plugin. ${RESTART_HINT[cli]}` }
      }
      case 'remove-manual': {
        const error = await removeManual(cli, tools)
        return error ? { ok: false, message: error } : { ok: true, message: 'Manual entry removed. Restart the agent to drop the duplicate tools.' }
      }
      default:
        return { ok: false, message: `${LABELS[cli]} has no "${action}" action.` }
    }
  })
}

function mcpbPath(): string {
  return resourcePath('learning-space.mcpb')
}

async function installExtension(): Promise<ConnectResult> {
  const path = mcpbPath()
  if (!existsSync(path)) return { ok: false, message: 'The extension file is missing (run npm run build:mcpb).' }
  if (dryRunOpen) {
    console.log(`connect: dry run, would open ${path}`)
    return { ok: true, message: 'Opened in Claude. Confirm the install there.' }
  }
  const error = await shell.openPath(path)
  return error ? { ok: false, message: error } : { ok: true, message: 'Opened in Claude. Confirm the install there.' }
}

export async function connectAgentClient(id: AgentClientId, action: AgentClientAction): Promise<ConnectResult> {
  switch (id) {
    case 'claude-code':
      return cliAction('claude', action)
    case 'codex':
      return cliAction('codex', action)
    case 'claude-app':
      return action === 'install-extension' ? installExtension() : { ok: false, message: `The Claude app has no "${action}" action.` }
    default:
      return { ok: false, message: `Unknown agent app "${String(id)}".` }
  }
}

export function isAgentClientId(value: unknown): value is AgentClientId {
  return value === 'claude-code' || value === 'codex' || value === 'claude-app'
}

export function isAgentClientAction(value: unknown): value is AgentClientAction {
  return value === 'install-plugin' || value === 'switch-to-plugin' || value === 'remove-manual' || value === 'install-extension'
}
