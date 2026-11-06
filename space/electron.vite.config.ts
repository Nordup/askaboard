import { dirname, resolve } from 'node:path'
import { build, type Plugin } from 'vite'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

/**
 * `import code from './file.ts?stage'`: the file and everything it imports,
 * bundled into one classic script (IIFE), as a string. The main process serves
 * these strings as the stage page's scripts (main/stage-process.ts), the
 * same in dev and in a build.
 */
function stageBundles(): Plugin {
  const PREFIX = '\0stage-bundle:'
  return {
    name: 'stage-bundles',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.endsWith('?stage') || !importer) return null
      return PREFIX + resolve(dirname(importer), source.slice(0, -'?stage'.length))
    },
    async load(id) {
      if (!id.startsWith(PREFIX)) return null
      const entry = id.slice(PREFIX.length)
      const result = await build({
        configFile: false,
        logLevel: 'warn',
        publicDir: false,
        root: dirname(entry),
        build: { write: false, minify: false, target: 'esnext', emptyOutDir: false, lib: { entry, formats: ['iife'], name: 'stage', fileName: () => 'bundle.js' } }
      })
      const outputs = (Array.isArray(result) ? result : [result]) as Array<{ output: Array<{ type: string; code?: string; moduleIds?: string[] }> }>
      const chunk = outputs.flatMap((o) => o.output).find((o) => o.type === 'chunk')
      if (!chunk?.code) throw new Error(`stage bundle: no output for ${entry}`)
      for (const file of chunk.moduleIds ?? []) if (!file.startsWith('\0')) this.addWatchFile(file.replace(/\?.*$/, ''))
      return `export default ${JSON.stringify(chunk.code)}`
    }
  }
}

// Usage data (main/analytics.ts): our release builds set the channel; local builds and forks send "dev".
const TELEMETRY_CHANNELS = ['stable', 'nightly', 'preview', 'dev']
const telemetryChannel = process.env.LEARNING_SPACE_TELEMETRY_CHANNEL?.trim() || 'dev'
if (!TELEMETRY_CHANNELS.includes(telemetryChannel)) {
  throw new Error(`LEARNING_SPACE_TELEMETRY_CHANNEL must be one of ${TELEMETRY_CHANNELS.join(', ')}, got "${telemetryChannel}".`)
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    define: { __LS_TELEMETRY_CHANNEL__: JSON.stringify(telemetryChannel) },
    plugins: [stageBundles()]
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts'), stage: resolve(__dirname, 'src/preload/stage.ts') } } }
  },
  renderer: {
    resolve: { alias: { '@shared': shared } },
    plugins: [react()],
    // Dev only (components/splash/art.ts): SPACE_SPLASH_ART=<artwork id> shows that artwork at every launch.
    define: { __SPACE_SPLASH_ART__: JSON.stringify(process.env.SPACE_SPLASH_ART ?? '') },
    // A dev server names its bundled dependencies anew each time it builds them, and each name stayed in the app's disk caches (500 MB). Dev only: a built app reads its files from disk.
    server: { headers: { 'Cache-Control': 'no-store' } }
  }
})
