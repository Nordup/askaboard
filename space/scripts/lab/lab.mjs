#!/usr/bin/env node
/**
 * Start, stop or show the lab app: an own Learning Space instance for
 * live-drawing experiments, with a scratch HOME, user-data-dir, traces and a
 * learning folder with one board under /private/tmp/claude-501/ls-lab/<name>/.
 *
 *   node scripts/lab/lab.mjs start [--name lab] [--built] [--fresh] [--no-code] [--no-html] [--brief <file>] [--mcp-port 47890] [--debug-port 9490]
 *   node scripts/lab/lab.mjs stop [--name lab]
 *   node scripts/lab/lab.mjs status [--name lab]
 *
 * Default: the dev renderer (electron-vite dev, React StrictMode). --built runs
 * `electron .` on out/ (run `npm run build` first). --fresh starts with an empty
 * folder and board. --no-code sets the lab switch LS_LAB_NO_CODE=1 (no code
 * items for agents; src/main/lab-switch.ts), --no-html LS_LAB_NO_HTML=1 (no HTML
 * material), --brief <file> LS_LAB_BRIEF (a draft brief). stop kills only the PIDs in the state file.
 */
import { resolve } from 'node:path'
import { args, alive, portInUse, readState, startInstance, stopInstance } from './common.mjs'

const { option, flag, positional } = args()
const command = positional[0]
const name = option('--name', 'lab')

async function main() {
  if (command === 'start') {
    if (flag('--no-code')) process.env.LS_LAB_NO_CODE = '1'
    else delete process.env.LS_LAB_NO_CODE
    if (flag('--no-html')) process.env.LS_LAB_NO_HTML = '1'
    else delete process.env.LS_LAB_NO_HTML
    const brief = option('--brief', null)
    if (brief) process.env.LS_LAB_BRIEF = resolve(brief)
    else delete process.env.LS_LAB_BRIEF
    const state = await startInstance({
      name,
      mcpPort: Number(option('--mcp-port', '47890')),
      debugPort: Number(option('--debug-port', '9490')),
      built: flag('--built'),
      fresh: flag('--fresh')
    })
    console.log(`lab "${name}" running (${state.mode}): MCP http://127.0.0.1:${state.mcpPort}/mcp, debug ${state.debugPort}, PIDs ${state.pids.join(', ')}`)
    console.log(`folder ${state.folder}\nlog ${state.log}`)
  } else if (command === 'stop') {
    const stopped = await stopInstance(name)
    console.log(stopped.length ? `lab "${name}" stopped (PIDs ${stopped.join(', ')})` : `lab "${name}" was not running`)
  } else if (command === 'status') {
    const state = readState(name)
    if (!state) return console.log(`lab "${name}": not running`)
    const live = state.pids.filter(alive)
    console.log(JSON.stringify({ ...state, alive: live, mcpOpen: await portInUse(state.mcpPort) }, null, 2))
  } else {
    console.log('usage: node scripts/lab/lab.mjs start|stop|status [--name lab] [--built] [--fresh] [--mcp-port 47890] [--debug-port 9490]')
    process.exitCode = command ? 1 : 0
  }
}

main().catch((error) => {
  console.error(`lab: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
