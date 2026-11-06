// npm run dist:mac — the macOS release: build the app with telemetry channel
// "stable", then package one .dmg per architecture into release/
// (electron-builder.yml). Extra arguments go to electron-builder (e.g. --arm64).
//
// Signing: a "Developer ID Application" identity in the keychain (or CSC_LINK /
// CSC_NAME) signs the app; electron-builder finds it by itself. Without one, the
// app is signed ad-hoc ("-") with the same hardened runtime and entitlements,
// plus disable-library-validation (build/entitlements.mac.adhoc.plist).
// Notarization: with a Developer ID and the notarytool keychain profile
// "learning-space-notary" (or APPLE_KEYCHAIN_PROFILE set by hand). Otherwise it
// is skipped, with a log line.
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NOTARY_PROFILE = 'learning-space-notary'

function quiet(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function run(file, args, env) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const developerId =
  !!process.env.CSC_LINK || !!process.env.CSC_NAME || /"Developer ID Application:/.test(quiet('security', ['find-identity', '-v', '-p', 'codesigning']) ?? '')

const builderEnv = {}
const builderArgs = ['--mac', ...process.argv.slice(2)]
if (!developerId) {
  console.log('dist:mac: no "Developer ID Application" identity: signing ad-hoc, notarization skipped.')
  // Ad-hoc code has no Team ID, so library validation would refuse the Electron Framework.
  builderArgs.push('-c.mac.identity=-', '-c.mac.entitlements=build/entitlements.mac.adhoc.plist', '-c.mac.entitlementsInherit=build/entitlements.mac.adhoc.plist')
} else if (process.env.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_ID || process.env.APPLE_API_KEY) {
  console.log('dist:mac: Developer ID signing; notarization with the Apple credentials from the environment.')
} else if (quiet('xcrun', ['notarytool', 'history', '--keychain-profile', NOTARY_PROFILE]) !== null) {
  console.log(`dist:mac: Developer ID signing; notarization with the keychain profile "${NOTARY_PROFILE}".`)
  builderEnv.APPLE_KEYCHAIN_PROFILE = NOTARY_PROFILE
} else {
  console.log(`dist:mac: Developer ID signing; notarization skipped (no notarytool profile "${NOTARY_PROFILE}").`)
}

run('npm', ['run', 'build'], { LEARNING_SPACE_TELEMETRY_CHANNEL: process.env.LEARNING_SPACE_TELEMETRY_CHANNEL || 'stable' })
run('npx', ['electron-builder', ...builderArgs], builderEnv)
