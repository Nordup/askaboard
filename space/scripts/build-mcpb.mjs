// Build resources/askaboard.mcpb: the Claude app (desktop chat) extension.
// It holds only a manifest (and resources/icon.png when it exists). The
// manifest points at the shim the app writes on launch, so the extension runs
// the same stdio relay as Claude Code and Codex.
//
// The zip is deterministic: fixed file order, fixed mtimes, no extra fields
// (TZ=UTC zip -X). Usage: node scripts/build-mcpb.mjs  (npm run build:mcpb)
//
// The plugin repo (askaboard-plugins; the local folder is still named
// learning-space-plugins) owns the real artifact. When it is checked out next
// to this repo, the script copies that file; otherwise it
// builds this stand-in.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const out = join(root, 'resources', 'askaboard.mcpb')
const icon = join(root, 'resources', 'icon.png')
const shim = '${HOME}/.askaboard/bin/askaboard'

// The plugin repo owns the real artifact (with icon and long description).
// When it is checked out next to this repo, ship that file instead.
const pluginArtifact = resolve(root, '../../learning-space-plugins/claude-extensions/askaboard/dist/askaboard.mcpb')
if (existsSync(pluginArtifact)) {
  copyFileSync(pluginArtifact, out)
  console.log(`copied ${pluginArtifact} -> ${out}`)
  process.exit(0)
}

const manifest = {
  manifest_version: '0.3',
  name: 'askaboard',
  display_name: 'Askaboard',
  version: pkg.version,
  description: pkg.description,
  author: { name: 'Askaboard' },
  ...(existsSync(icon) ? { icon: 'icon.png' } : {}),
  server: {
    type: 'binary',
    entry_point: shim,
    mcp_config: { command: shim, args: ['mcp'] }
  },
  compatibility: { platforms: ['darwin', 'linux'] }
}

const stage = mkdtempSync(join(tmpdir(), 'askaboard-mcpb-'))
try {
  const files = ['manifest.json']
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (existsSync(icon)) {
    copyFileSync(icon, join(stage, 'icon.png'))
    files.push('icon.png')
  }
  // 2000-01-01T00:00:00Z for every entry.
  const fixed = new Date(Date.UTC(2000, 0, 1))
  for (const file of files) utimesSync(join(stage, file), fixed, fixed)
  rmSync(out, { force: true })
  execFileSync('zip', ['-X', '-q', '-D', out, ...files.sort()], { cwd: stage, env: { ...process.env, TZ: 'UTC' }, stdio: 'inherit' })
  console.log(`mcpb: wrote ${out} (${files.join(', ')})`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
