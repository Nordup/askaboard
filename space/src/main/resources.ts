import { join } from 'node:path'
import { app } from 'electron'

/**
 * The bundled `space/resources/` folder: the board guide, the server
 * instructions and the learning-folder templates. In dev and `npm start` the
 * app path is `space/`; a packaged app must ship the folder as
 * `extraResources` (`resources` → `resources`), next to `app.asar`.
 */
export function resourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
}

export function resourcePath(...parts: string[]): string {
  return join(resourcesDir(), ...parts)
}
