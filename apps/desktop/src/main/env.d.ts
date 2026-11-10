/// <reference types="electron-vite/node" />

declare module '*?raw' {
  const text: string
  export default text
}

/** A stage script, bundled into one classic script (electron.vite.config.ts, stageBundles). */
declare module '*?stage' {
  const code: string
  export default code
}

/** The usage-data channel, set at build time (electron.vite.config.ts): release or dev. */
declare const __LS_TELEMETRY_CHANNEL__: 'release' | 'dev'
