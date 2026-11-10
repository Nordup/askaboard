// Build a release that Gatekeeper can verify. Credentials stay in Keychain.
// npm run dist:mac [-- --arm64 | --x64] (universal is the default).
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.env.APPLE_KEYCHAIN_PROFILE || 'learning-space-notary'
const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && !['--arm64', '--x64', '--universal'].includes(args[0]))) {
  console.error('Usage: npm run dist:mac [-- --arm64 | --x64 | --universal]')
  process.exit(1)
}
const arch = (args[0] || '--universal').slice(2)

function run(file, argv, env = {}) {
  const result = spawnSync(file, argv, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function output(file, argv) {
  try { return execFileSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch { return null }
}

const identities = output('security', ['find-identity', '-v', '-p', 'codesigning']) || ''
if (!/"Developer ID Application:/.test(identities)) {
  console.error('A valid Developer ID Application identity is required in the keychain.')
  process.exit(1)
}
if (output('xcrun', ['notarytool', 'history', '--keychain-profile', profile]) === null) {
  console.error(`Notary credentials are unavailable for keychain profile "${profile}".`)
  process.exit(1)
}
// A profile is the single source of notarization credentials. Do not let a
// partial set of Apple environment variables take precedence in electron-builder.
const builderEnv = { ...process.env, APPLE_KEYCHAIN_PROFILE: profile }
for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete builderEnv[name]
run('npm', ['run', 'build:mcpb'])
run('npm', ['run', 'build'], { ASKABOARD_TELEMETRY_CHANNEL: 'release' })
const build = spawnSync('npx', ['electron-builder', '--mac', `--${arch}`, '-c.dmg.sign=true'], { cwd: root, stdio: 'inherit', env: builderEnv })
if (build.error) console.error(build.error.message)
if (build.status !== 0) process.exit(build.status ?? 1)

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const dmg = resolve(root, 'release', `${pkg.productName}-${pkg.version}-${arch}.dmg`)
// electron-builder notarizes and staples the app, but not the DMG it produces.
// Submit the signed DMG too, then staple and verify the exact artifact.
run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait'])
run('xcrun', ['stapler', 'staple', dmg])
run('xcrun', ['stapler', 'validate', dmg])
run('spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', dmg])
console.log(`\nRelease ready: ${dmg}`)
