import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'
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
  timedOut: boolean
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
      const reason = error ? (error.killed ? `timed out after ${Math.round(timeout / 1000)} s` : error.message) : null
      resolve({ code, stdout: String(stdout), stderr: String(stderr), error: reason, timedOut: Boolean(error?.killed) })
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
  /** The folders of the login PATH, then the fallback folders. */
  dirs: string[]
  claude: string | null
  codex: string | null
}

/** Shells that take `-lc` and POSIX `printf`: only these run the login PATH script. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh'])

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The learner's login shell when it is POSIX-style (fish and others print another syntax), else /bin/sh. */
function loginShell(): string {
  let account: string | undefined
  try {
    account = userInfo().shell ?? undefined
  } catch {
    account = undefined
  }
  const shell = [account, process.env.SHELL].find((path) => path && isAbsolute(path) && POSIX_SHELLS.has(basename(path)) && isExecutable(path))
  return shell ?? '/bin/sh'
}

/** The usual install folders of the CLIs on macOS and Linux, for a PATH that the login shell does not set. */
function fallbackDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.local/bin'),
    join(home, '.claude/local'),
    join(home, '.npm-global/bin'),
    join(home, '.bun/bin'),
    join(home, '.volta/bin'),
    join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin'
  ]
}

/** The first executable file with this name in the folders. An alias or a shell function is not a file, so it never counts. */
function which(name: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * An app started from the Dock or a desktop launcher gets a short PATH, so ask
 * the learner's login shell (`$SHELL -lc`, a POSIX shell only) for its PATH.
 * The CLIs are then found by a walk over that PATH and the usual install
 * folders (a PATH set in .zshrc or .bashrc only is not in a login shell).
 */
async function findTools(): Promise<Tools> {
  const result = await run(loginShell(), ['-lc', 'printf "\\n__LS_PATH=%s\\n" "$PATH"'], process.env, SHELL_TIMEOUT_MS)
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('__LS_PATH='))
  const loginPath = line?.slice('__LS_PATH='.length).trim() || process.env.PATH || '/usr/bin:/bin'
  const dirs = [...new Set([...loginPath.split(delimiter).filter(Boolean), ...fallbackDirs()])]
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: dirs.join(delimiter) }
  // The CLIs must not inherit the dev hook that runs Electron as Node.
  delete env.ELECTRON_RUN_AS_NODE
  return { env, dirs, claude: which('claude', dirs), codex: which('codex', dirs) }
}

// ---------- Status ----------

type Cli = 'claude' | 'codex'

const LABELS: Record<Cli, string> = { claude: 'Claude Code', codex: 'ChatGPT and Codex' }
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

/** A status as the check finds it; agentClients adds the last action. */
type Detected = Omit<AgentClientStatus, 'last'>

function toStatus(cli: Cli, value: Found): Detected {
  const base = { id: CLIENT_OF[cli], label: LABELS[cli] }
  if (value.plugin && value.manual) return { ...base, state: 'both', detail: null, action: 'remove-manual' }
  if (value.plugin) return { ...base, state: 'plugin', detail: null, action: null }
  if (value.error) {
    console.log(`connect: ${cli} check → ${value.error}`)
    return { ...base, state: 'unknown', detail: `Couldn't check ${LABELS[cli]}. Try again.`, action: 'install-plugin' }
  }
  if (value.manual) return { ...base, state: 'manual', detail: null, action: 'switch-to-plugin' }
  const detail = value.pluginDisabled ? 'The plugin is installed but disabled.' : null
  return { ...base, state: 'available', detail, action: 'install-plugin' }
}

async function cliStatus(cli: Cli, tools: Tools): Promise<Detected> {
  if (!tools[cli]) {
    const base = { id: CLIENT_OF[cli], label: LABELS[cli], action: null }
    // Without the CLI, only Codex's config file can still be read.
    if (cli === 'codex') {
      const text = codexConfigText()
      const plugin = codexHasPluginTable(text)
      const manual = codexHasManual(text)
      if (plugin || manual) return { ...base, state: plugin && manual ? 'both' : plugin ? 'plugin' : 'manual', detail: NOT_INSTALLED.codex }
    }
    return { ...base, state: 'missing', detail: NOT_INSTALLED[cli] }
  }
  return toStatus(cli, await found(cli, tools))
}

/** Where Claude Desktop is installed. executable: the program to run, when it is known (Linux). */
export interface ClaudeApp {
  path: string
  executable: string | null
}

/** The XDG folders of .desktop files, and the Flatpak export folders. */
function applicationDirs(): string[] {
  const home = homedir()
  const dataHome = process.env.XDG_DATA_HOME || join(home, '.local/share')
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  const roots = [dataHome, ...dataDirs, join(home, '.local/share/flatpak/exports/share'), '/var/lib/flatpak/exports/share']
  return [...new Set(roots.filter((root) => isAbsolute(root)).map((root) => join(root, 'applications')))]
}

const DESKTOP_FILE = /^(claude-desktop|claude|com\.anthropic\.claude.*)\.desktop$/i

/** A field code of a .desktop Exec line, such as %U: the launcher puts the files there. */
const FIELD_CODE = /^%[fFuUdDnNickvm]$/

/**
 * The program of a .desktop file's Exec line, when the line is one executable file and field codes only. Any other
 * line (`flatpak run …`, `env FOO=1 …`) gives null: the caller then lets gio run the .desktop file itself.
 */
function desktopExecutable(file: string, dirs: string[]): string | null {
  try {
    // The Exec line of the [Desktop Entry] group, not of a [Desktop Action …] group after it.
    const entry = readFileSync(file, 'utf8').split(/^\[/m).find((group) => group.startsWith('Desktop Entry]')) ?? ''
    const exec = /^Exec\s*=(.*)$/m.exec(entry)?.[1]?.trim()
    const words = exec?.match(/"[^"]*"|\S+/g) ?? []
    const program = words[0]?.replace(/^"|"$/g, '')
    if (!program || !words.slice(1).every((word) => FIELD_CODE.test(word))) return null
    if (isAbsolute(program)) return isExecutable(program) ? program : null
    // "claude" on PATH is the Claude Code CLI, not the app: gio runs such a .desktop file as the desktop does.
    if (program === 'claude') return null
    return which(program, dirs)
  } catch {
    return null
  }
}

function claudeApp(dirs: string[]): ClaudeApp | null {
  if (process.platform === 'darwin') {
    const path = ['/Applications/Claude.app', join(homedir(), 'Applications/Claude.app')].find((candidate) => existsSync(candidate))
    return path ? { path, executable: null } : null
  }
  if (process.platform !== 'linux') return null
  const executable = which('claude-desktop', dirs)
  if (executable) return { path: executable, executable }
  for (const dir of applicationDirs()) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const name = names.find((entry) => DESKTOP_FILE.test(entry))
    if (name) return { path: join(dir, name), executable: desktopExecutable(join(dir, name), dirs) }
  }
  return null
}

/**
 * The Claude app unpacks each extension into its own folder under "Claude
 * Extensions", in its folder of the app data (macOS: ~/Library/Application
 * Support/Claude, Linux: ~/.config/Claude). The folder name is not a published
 * contract, so any folder whose name holds "learning-space" counts.
 */
function claudeAppHasExtension(): boolean {
  try {
    // On macOS, Electron's appData ignores HOME, so a lab instance with a scratch HOME would read the real folder.
    const data = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') : app.getPath('appData')
    const dir = join(data, 'Claude', 'Claude Extensions')
    return readdirSync(dir).some((name) => name.toLowerCase().includes(SERVER_NAME))
  } catch {
    return false
  }
}

function claudeAppStatus(dirs: string[]): Detected {
  const base = { id: 'claude-app' as const, label: 'Claude Desktop' }
  if (claudeAppHasExtension()) return { ...base, state: 'connected', detail: null, action: null }
  if (!claudeApp(dirs)) {
    const detail = process.platform === 'darwin' ? 'Claude Desktop was not found in Applications.' : 'Claude Desktop was not found.'
    return { ...base, state: 'missing', detail, action: null }
  }
  return { ...base, state: 'available', detail: null, action: 'install-extension' }
}

export async function agentClients(): Promise<AgentClientsStatus> {
  const tools = await findTools()
  const found = await Promise.all([cliStatus('claude', tools), cliStatus('codex', tools), Promise.resolve(claudeAppStatus(tools.dirs))])
  const clients = found.map((client) => {
    const last = lastActions.get(client.id) ?? null
    const installed = client.state === 'plugin' || client.state === 'both' || client.state === 'manual' || client.state === 'connected'
    return { ...client, last: last && !last.result.ok && installed ? null : last }
  })
  return { shimPath: shimPath(), clients }
}

// ---------- Actions ----------

// The row's lines, the one source for the popover and Settings (ConnectAgents.tsx shows result.message as it is).

const THIS_COMPUTER = process.platform === 'darwin' ? 'this Mac' : 'this computer'
/** After a plugin change: the app loads the plugin at its next start. */
const RESTART_LINE: Record<Cli, string> = { claude: 'Restart Claude Code to finish', codex: 'Restart ChatGPT or Codex to finish' }
const NOT_INSTALLED: Record<Cli, string> = { claude: `Claude Code isn't installed on ${THIS_COMPUTER}.`, codex: `Codex isn't installed on ${THIS_COMPUTER}.` }
const TOO_LONG = 'This took too long.'
const INSTALL_FAILED = "Couldn't install. Try again."
const REMOVE_FAILED = "Couldn't remove the entry added by hand. Try again."
const OPENED = 'Confirm the install in Claude Desktop'

/** A failed step: its line goes to the console log, the row says only whether it took too long. */
interface StepError {
  line: string
  timedOut: boolean
}

const failed = (error: StepError, line: string): ConnectResult => ({ ok: false, message: error.timedOut ? TOO_LONG : line })

/** A failure that is not a step's (a check, a missing file): logged here, and the row gets line. */
function refused(what: string, reason: string, line: string): ConnectResult {
  console.log(`connect: ${what} → ${reason}`)
  return { ok: false, message: line }
}

/** The last action per app in this run (AgentClientStatus.last). */
const lastActions = new Map<AgentClientId, { action: AgentClientAction; result: ConnectResult }>()

/** One action per CLI at a time: two config writes must not race. */
const queues: Record<Cli, Promise<unknown>> = { claude: Promise.resolve(), codex: Promise.resolve() }

function serial<T>(cli: Cli, task: () => Promise<T>): Promise<T> {
  const next = queues[cli].then(task, task)
  queues[cli] = next.catch(() => undefined)
  return next
}

/** Run one step; null on success, else the error (its line is logged here). */
async function step(cli: Cli, tools: Tools, args: string[], timeout: number): Promise<StepError | null> {
  const result = await run(tools[cli] as string, args, tools.env, timeout)
  const error = result.code === 0 ? null : { line: failure(result), timedOut: result.timedOut }
  console.log(`connect: ${cli} ${args.join(' ')} → ${error?.line ?? 'ok'}`)
  return error
}

/** Add the marketplace when it is missing, then install (or enable) the plugin. */
async function installPlugin(cli: Cli, tools: Tools): Promise<StepError | null> {
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

async function removeManual(cli: Cli, tools: Tools): Promise<StepError | null> {
  if (cli === 'claude') {
    const manual = await claudeManual(tools)
    if (manual.error) {
      console.log(`connect: claude mcp get ${SERVER_NAME} → ${manual.error}`)
      return { line: manual.error, timedOut: /^timed out/.test(manual.error) }
    }
    if (!manual.manual) return null
    return step(cli, tools, ['mcp', 'remove', SERVER_NAME, '--scope', manual.scope], REMOVE_TIMEOUT_MS)
  }
  // `codex mcp remove` exits 0 when the entry is missing, so read the file back.
  const error = await step(cli, tools, ['mcp', 'remove', SERVER_NAME], REMOVE_TIMEOUT_MS)
  if (error) return error
  if (!codexHasManual(codexConfigText())) return null
  console.log('connect: codex: the manual entry is still in config.toml')
  return { line: 'The manual entry is still in config.toml.', timedOut: false }
}

async function cliAction(cli: Cli, action: AgentClientAction): Promise<ConnectResult> {
  const tools = await findTools()
  if (!tools[cli]) return refused(cli, `the ${cli} command was not found`, NOT_INSTALLED[cli])
  return serial(cli, async () => {
    switch (action) {
      case 'install-plugin': {
        const error = await installPlugin(cli, tools)
        return error ? failed(error, INSTALL_FAILED) : { ok: true, message: RESTART_LINE[cli] }
      }
      case 'switch-to-plugin': {
        const installError = await installPlugin(cli, tools)
        if (installError) return failed(installError, INSTALL_FAILED)
        const removeError = await removeManual(cli, tools)
        if (removeError) return failed(removeError, REMOVE_FAILED)
        return { ok: true, message: RESTART_LINE[cli] }
      }
      case 'remove-manual': {
        const error = await removeManual(cli, tools)
        return error ? failed(error, REMOVE_FAILED) : { ok: true, message: RESTART_LINE[cli] }
      }
      default:
        return refused(cli, `${LABELS[cli]} has no "${action}" action`, INSTALL_FAILED)
    }
  })
}

/** Absolute: Claude Desktop on Linux reads the path from its argv and ignores the working directory. */
function mcpbPath(): string {
  return resolve(resourcePath('learning-space.mcpb'))
}

/**
 * The environment for another Electron app: the CLIs' env (no ELECTRON_RUN_AS_NODE), without what this app's
 * Electron and Chromium set for themselves. CHROME_DESKTOP names our .desktop file (Chromium sets it at start);
 * ELECTRON_* holds electron-vite's dev renderer URL and Electron's own switches; an older Electron moved the
 * desktop name to ORIGINAL_XDG_CURRENT_DESKTOP, so that value goes back.
 */
function otherAppEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of Object.keys(env)) if (/^(ELECTRON|CHROME)_/.test(key)) delete env[key]
  if (env.ORIGINAL_XDG_CURRENT_DESKTOP) env.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP
  delete env.ORIGINAL_XDG_CURRENT_DESKTOP
  return env
}

/** How long a launch may still fail: a launcher that cannot start the app exits within this time. */
const LAUNCH_SETTLE_MS = 1500

/**
 * Start a program and leave it running. null: it still runs after LAUNCH_SETTLE_MS, or it exited with 0 (a launcher
 * that handed the file to a running Claude Desktop). Else the error: a start error (ENOENT and the like) or a
 * non-zero exit. stdio is ignored, so a program that lives on never blocks on a full pipe.
 */
function launch(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((done) => {
    let settled = false
    const settle = (error: string | null): void => {
      if (settled) return
      settled = true
      done(error)
    }
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', env })
      child.once('error', (error) => settle(error.message))
      child.once('exit', (code, signal) => {
        if (code === 0) settle(null)
        else settle(`${basename(file)} stopped (${signal ? `signal ${signal}` : `exit code ${code}`}).`)
      })
      child.once('spawn', () => {
        child.unref()
        setTimeout(() => settle(null), LAUNCH_SETTLE_MS)
      })
    } catch (error) {
      settle(error instanceof Error ? error.message : String(error))
    }
  })
}

/**
 * On Linux, Claude Desktop opens its install dialog for a .mcpb path in its argv, at start and from a second
 * instance. Its launcher may live as long as the app, so only the first moments of it are awaited.
 */
async function installExtensionLinux(path: string): Promise<ConnectResult> {
  const tools = await findTools()
  const found = claudeApp(tools.dirs)
  if (!found) return refused('claude-app', 'Claude Desktop was not found', `Claude Desktop isn't installed on ${THIS_COMPUTER}.`)
  const gio = found.executable ? null : which('gio', tools.dirs)
  if (!found.executable && !gio) return refused('claude-app', `no gio to open ${path} with`, INSTALL_FAILED)
  const [file, args] = found.executable ? [found.executable, [path]] : [gio as string, ['launch', found.path, path]]
  const env = otherAppEnv(tools.env)
  if (dryRunOpen) {
    const removed = Object.keys(process.env).filter((key) => !(key in env))
    const changed = Object.keys(env).filter((key) => key in process.env && env[key] !== process.env[key])
    console.log(`connect: dry run, would run ${JSON.stringify([file, ...args])}; env removed ${JSON.stringify(removed)}, changed ${JSON.stringify(changed)}`)
    return { ok: true, message: OPENED }
  }
  const error = await launch(file, args, env)
  console.log(`connect: ${file} ${args.join(' ')} → ${error ?? 'started'}`)
  return error ? { ok: false, message: INSTALL_FAILED } : { ok: true, message: OPENED }
}

async function installExtension(): Promise<ConnectResult> {
  const path = mcpbPath()
  if (!existsSync(path)) return refused('claude-app', `the extension file ${path} is missing (npm run build:mcpb makes it)`, INSTALL_FAILED)
  if (process.platform === 'linux') return installExtensionLinux(path)
  if (dryRunOpen) {
    console.log(`connect: dry run, would open ${path}`)
    return { ok: true, message: OPENED }
  }
  const error = await shell.openPath(path)
  return error ? refused('claude-app', `open ${path}: ${error}`, INSTALL_FAILED) : { ok: true, message: OPENED }
}

export async function connectAgentClient(id: AgentClientId, action: AgentClientAction): Promise<ConnectResult> {
  const result = await clientAction(id, action)
  lastActions.set(id, { action, result })
  return result
}

function clientAction(id: AgentClientId, action: AgentClientAction): Promise<ConnectResult> {
  switch (id) {
    case 'claude-code':
      return cliAction('claude', action)
    case 'codex':
      return cliAction('codex', action)
    case 'claude-app':
      return action === 'install-extension' ? installExtension() : Promise.resolve(refused('claude-app', `Claude Desktop has no "${action}" action`, INSTALL_FAILED))
  }
}

export function isAgentClientId(value: unknown): value is AgentClientId {
  return value === 'claude-code' || value === 'codex' || value === 'claude-app'
}

export function isAgentClientAction(value: unknown): value is AgentClientAction {
  return value === 'install-plugin' || value === 'switch-to-plugin' || value === 'remove-manual' || value === 'install-extension'
}
