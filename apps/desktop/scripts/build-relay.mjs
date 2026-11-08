// Bundle the stdio relay (src/relay/index.ts) into one self-contained CommonJS
// file, out/relay/index.js, with the MCP SDK inlined. The shim runs it with
// Electron's binary as Node (ELECTRON_RUN_AS_NODE=1), so it must not need
// node_modules at run time. `npm run build` and `npm run dev` call this.
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: resolve(root, 'src/relay/index.ts'),
    outDir: resolve(root, 'out/relay'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } }
  }
})
console.log('relay: built out/relay/index.js')
