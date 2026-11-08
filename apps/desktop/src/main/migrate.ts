import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { agentHomeDir } from './agent-home'

/**
 * The one-time move from the old name (Learning Space, before 2026-11-08). At launch, before
 * the state is read: the app state (state.json) comes from the old userData folder, the sibling
 * "Learning Space" of the current one, when the new folder has none; the voice key (.env) and
 * the install id (anonymous-id) come from ~/.learning-space/ when ~/.askaboard/ has none.
 * It copies only, so the old folders stay as they were. Never throws.
 */
export function migrateFromLearningSpace(): void {
  const userData = app.getPath('userData')
  const copies: Array<[from: string, to: string]> = [
    [join(dirname(userData), 'Learning Space', 'state.json'), join(userData, 'state.json')],
    [join(homedir(), '.learning-space', '.env'), join(agentHomeDir(), '.env')],
    [join(homedir(), '.learning-space', 'anonymous-id'), join(agentHomeDir(), 'anonymous-id')]
  ]
  for (const [from, to] of copies) {
    try {
      if (existsSync(to) || !existsSync(from)) continue
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      console.log(`migrate: copied ${from} -> ${to}`)
    } catch (error) {
      console.error(`migrate: could not copy ${from}: ${String(error)}`)
    }
  }
}
