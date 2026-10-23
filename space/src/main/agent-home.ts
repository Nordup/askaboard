import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * ~/.learning-space/: what an agent needs to reach the app (the contract with
 * the learning-space-plugins repo).
 *
 *   bin/learning-space  the shim; `learning-space mcp` starts the stdio relay
 *   relay.json          { port, appVersion, updatedAt }: where the app listens
 *   tools.json          the tools/list result plus the server instructions, so
 *                       the relay can answer while the app is closed
 *
 * The app rewrites all three on every launch, so the shim always points at
 * the Electron binary and relay of the app that ran last.
 */

export function agentHomeDir(): string {
  // os.homedir() follows $HOME, so a check run with HOME=<scratch> writes there.
  return join(homedir(), '.learning-space')
}

export function shimPath(): string {
  return join(agentHomeDir(), 'bin', 'learning-space')
}

/**
 * The built relay. In dev and `npm start` it is `out/relay/index.js` next to
 * `out/main/`. A packaged app must keep it outside the asar archive (asarUnpack
 * `out/relay/**`), because the shim hands the path to Electron-as-Node; the
 * `app.asar.unpacked` rewrite below covers that layout.
 */
export function relayScriptPath(): string {
  return join(__dirname, '../relay/index.js').replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
}

/** A POSIX shell single-quoted word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Write through a temp file and rename, so a reader never sees half a file. */
async function writeAtomic(path: string, text: string, mode = 0o644): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, text, { mode })
  await chmod(temp, mode)
  await rename(temp, path)
}

function shimText(): string {
  // process.execPath is the Electron binary: node_modules/electron/dist/... in
  // dev, and "<App>.app/Contents/MacOS/<App>" in a packaged app. With
  // ELECTRON_RUN_AS_NODE=1 it runs the relay as plain Node, with no window.
  const version = app.getVersion()
  return [
    '#!/bin/sh',
    '# Learning Space agent shim. The app rewrites this file on every launch.',
    `# App ${version}, written ${new Date().toISOString()}.`,
    'case "$1" in',
    `  mcp) exec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(relayScriptPath())} "$@" ;;`,
    `  --version|-v) echo ${shellQuote(`learning-space ${version}`)} ;;`,
    '  *) echo "usage: learning-space mcp     start the MCP relay (stdio) to the Learning Space app" >&2',
    '     echo "       learning-space --version" >&2',
    '     exit 2 ;;',
    'esac',
    ''
  ].join('\n')
}

/** Write the shim (at launch, before the server listens). */
export async function installShim(): Promise<void> {
  await mkdir(join(agentHomeDir(), 'bin'), { recursive: true })
  await writeAtomic(shimPath(), shimText(), 0o755)
  console.log(`agent home: wrote ${shimPath()}`)
}

/** Write relay.json and tools.json once the MCP server owns its port. */
export async function writeRelayState(port: number, catalog: { tools: unknown[]; instructions: string }): Promise<void> {
  const dir = agentHomeDir()
  await mkdir(dir, { recursive: true })
  const appVersion = app.getVersion()
  const updatedAt = new Date().toISOString()
  await writeAtomic(join(dir, 'relay.json'), `${JSON.stringify({ port, appVersion, updatedAt }, null, 2)}\n`)
  await writeAtomic(join(dir, 'tools.json'), `${JSON.stringify({ appVersion, updatedAt, instructions: catalog.instructions, tools: catalog.tools }, null, 2)}\n`)
  console.log(`agent home: wrote relay.json (port ${port}) and tools.json (${catalog.tools.length} tools)`)
}
