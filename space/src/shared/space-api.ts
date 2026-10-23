/**
 * The bridge between the preload script and the renderer.
 * The preload exposes one object of this type as `window.space`.
 */
export interface SpaceApi {
  /** The Node `process.platform` value, for example `darwin`. */
  readonly platform: string
  /** The app version from package.json. */
  readonly version: string
}

/** IPC channel names. The main process and the preload share them. */
export const IPC = {
  appVersion: 'space:app-version'
} as const
