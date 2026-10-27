import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BOARDS_DIR } from '@shared/board-format'
import { SCENES_DIR } from '@shared/scene-program'
import type { SetupItem, SetupPlan, SetupResult } from '@shared/space-api'
import { fillTemplate } from './brief-block'
import type { FolderSession } from './folder'
import { FOLDER_SETTINGS_DIR } from './guide'
import { resourcePath } from './resources'

/**
 * "Set up this folder for learning": the files the app offers to create. It
 * creates only what is missing and never overwrites. A folder is set up when
 * `AGENTS.md` exists at its root.
 */

export const SETUP_MARKER = 'AGENTS.md'

interface Spec {
  path: string
  kind: 'file' | 'dir'
  /** Files: the template, relative to resources/learning-folder/. */
  template?: string
  /** Files: put the brief block (brief-block.ts) in place of the template's placeholder. */
  brief?: boolean
  /** Dirs: add an empty .gitkeep, so Git keeps the empty folder. */
  gitkeep?: boolean
  note: string
}

const SPECS: Spec[] = [
  { path: SETUP_MARKER, kind: 'file', template: 'AGENTS.md', brief: true, note: 'Instructions for Codex and Claude Code' },
  { path: 'plan.md', kind: 'file', template: 'plan.md', note: 'Goals, current focus, next steps' },
  { path: 'learner.md', kind: 'file', template: 'learner.md', note: 'What the agent knows about you' },
  { path: 'sessions', kind: 'dir', gitkeep: true, note: 'One log per session' },
  { path: 'topics', kind: 'dir', gitkeep: true, note: 'Notes per topic' },
  { path: 'materials', kind: 'dir', gitkeep: true, note: 'Sources and readings' },
  { path: BOARDS_DIR, kind: 'dir', note: 'Boards' },
  { path: SCENES_DIR, kind: 'dir', note: 'Scene files and their libraries' },
  {
    path: `${FOLDER_SETTINGS_DIR}/guide.md`,
    kind: 'file',
    template: `${FOLDER_SETTINGS_DIR}/guide.md`,
    note: 'Your additions to the board guide'
  }
]

async function exists(full: string): Promise<boolean> {
  return lstat(full).then(
    () => true,
    () => false
  )
}

export async function isSetUp(session: FolderSession): Promise<boolean> {
  return exists(await session.resolvePath(SETUP_MARKER, { allowMissing: true }))
}

export async function setupPlan(session: FolderSession): Promise<SetupPlan> {
  const items: SetupItem[] = []
  for (const spec of SPECS) {
    const full = await session.resolvePath(spec.path, { allowMissing: true })
    items.push({ path: spec.path, kind: spec.kind, exists: await exists(full), note: spec.note })
  }
  return { items, setUp: items[0].exists }
}

/** Create the missing items. Every path goes through the folder's path guard; files are written with "wx" (never overwrite). */
export async function applySetup(session: FolderSession): Promise<SetupResult> {
  const created: string[] = []
  for (const spec of SPECS) {
    const full = await session.resolvePath(spec.path, { allowMissing: true })
    if (await exists(full)) continue
    if (spec.kind === 'dir') {
      await mkdir(full, { recursive: true })
      if (spec.gitkeep) {
        const keep = await session.resolvePath(`${spec.path}/.gitkeep`, { allowMissing: true })
        await writeFile(keep, '', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
      }
      created.push(`${spec.path}/`)
      continue
    }
    await mkdir(dirname(full), { recursive: true })
    // Re-check the parent after mkdir: a link created in between must not lead outside.
    await session.resolvePath(spec.path, { allowMissing: true })
    try {
      const template = resourcePath('learning-folder', spec.template ?? spec.path)
      if (spec.brief) await writeFile(full, fillTemplate(await readFile(template, 'utf8')), { flag: 'wx' })
      else await copyFile(template, full, constants.COPYFILE_EXCL)
      created.push(spec.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  return { created }
}
