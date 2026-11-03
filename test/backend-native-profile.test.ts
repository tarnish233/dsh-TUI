import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveDshInstall } from '../src/backend/discover.ts'
import { loadNativeHelpers, type NativeHelpers, type NativeProfileApi } from '../src/backend/native-codec.ts'
import { APP_PROFILE_NAME, planProfile, type ProfilePlan } from '../src/backend/native-profile.ts'
import { prepareWorkspace } from '../src/backend/runtime-home.ts'
import type { JsonRecord } from '../src/backend/types.ts'

const CLI = fileURLToPath(new URL('../bin/dsh-tui.mjs', import.meta.url))
const BRIDGE = fileURLToPath(new URL('../runtime/bridge.mjs', import.meta.url))

let helpers: NativeHelpers | undefined
let installAnchor: string | undefined
try {
  const install = resolveDshInstall()
  installAnchor = install.packageJsonPath
  helpers = await loadNativeHelpers(install.packageJsonPath)
} catch { /* native-only tests skip without an installation */ }

const skip = helpers === undefined || installAnchor === undefined ? 'no @deepseek-ai/dsh installation found' : false

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cleanup(path: string | undefined): void {
  if (path !== undefined) rmSync(path, { recursive: true, force: true })
}

function writePackage(dir: string, manifest: JsonRecord): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}

/** One initialized native profile fixture, as `dsh plugin --profile` would write it. */
function profileFixture(home: string, name: string, bundles: readonly string[], patch?: unknown): string {
  const dir = join(home, 'profiles', name)
  writePackage(dir, { name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles: [...bundles] } } })
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify(patch, null, 2) + '\n', { mode: 0o600 })
  return dir
}

function profilePackage(profileDir: string, name: string, manifest: JsonRecord): void {
  writePackage(join(profileDir, 'node_modules', name), manifest)
}

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonRecord
}

describe('native profile planning', { skip }, () => {
  it('uses DSH DEFAULT_PROFILE_BUNDLES for the application composition', () => {
    const home = tempDir('dsh-native-plan-home-')
    try {
      const plan = planProfile({ native: helpers!.profile, installAnchor: installAnchor!, home })
      assert.equal(plan.name, APP_PROFILE_NAME)
      assert.deepEqual(plan.bundles, helpers!.profile.defaultBundles)
      assert.deepEqual(plan.replaced, [])
      assert.deepEqual(plan.warnings, [])
      assert.equal(plan.sourceDir, undefined)
    } finally { cleanup(home) }
  })

  it('keeps a selected profile configuration and replaces only recognized application surfaces', () => {
    const home = tempDir('dsh-native-plan-home-')
    try {
      const dir = profileFixture(home, 'selected', [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@deepseek-harness-tui/dsh-tui',
        'fixture-app-surface',
        'fixture-plugin',
      ])
      profilePackage(dir, 'fixture-app-surface', { name: 'fixture-app-surface', version: '1.0.0', bin: { surface: './cli.js' } })
      profilePackage(dir, 'fixture-plugin', { name: 'fixture-plugin', version: '1.0.0', main: './index.js' })
      const plan = planProfile({ native: helpers!.profile, installAnchor: installAnchor!, home, profile: 'selected' })
      assert.equal(plan.name, 'selected')
      assert.equal(plan.sourceDir, dir)
      // Utility bins are common in plugin packages and stay; only known
      // application surfaces are replaced, in their original bundle order.
      assert.deepEqual(plan.bundles, [...helpers!.profile.defaultBundles, 'fixture-app-surface', 'fixture-plugin'])
      assert.deepEqual(plan.replaced.map(item => item.bundle), ['@deepseek-ai/dsh-web-app', '@deepseek-harness-tui/dsh-tui'])
      assert.equal(plan.replaced[0]?.reason, 'DSH shipped application surface')
      assert.equal(plan.replaced[1]?.reason, 'recognized legacy DSH TUI')
      assert.equal(plan.warnings.length, 2)
      for (const warning of plan.warnings) assert.match(warning, /replaces that frontend with its own terminal/)
    } finally { cleanup(home) }
  })

  it('fails clearly for a missing, invalid or non-base profile', () => {
    const home = tempDir('dsh-native-plan-home-')
    try {
      const cases: Array<[string, string, RegExp]> = [
        ['../escape', 'INVALID_OPTIONS', /invalid DSH profile name/],
        ['missing', 'INVALID_OPTIONS', /does not exist.*dsh plugin --profile missing/],
      ]
      for (const [name, code, pattern] of cases) {
        assert.throws(
          () => planProfile({ native: helpers!.profile, installAnchor: installAnchor!, home, profile: name }),
          (error: unknown) => {
            assert.equal((error as { code?: string }).code, code)
            assert.match(String((error as Error).message), pattern)
            return true
          },
        )
      }
      profileFixture(home, 'standalone', ['@deepseek-ai/dsh-sdk-minimal'])
      assert.throws(
        () => planProfile({ native: helpers!.profile, installAnchor: installAnchor!, home, profile: 'standalone' }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'PROFILE_UNSUPPORTED')
          assert.match(String((error as Error).message), /does not mount the shared core bundle/)
          return true
        },
      )
    } finally { cleanup(home) }
  })

  it('disables a recognized frontend inserted by a native patch in the private overlay', () => {
    const home = tempDir('dsh-native-plan-home-')
    try {
      profileFixture(home, 'legacy-frontend', ['@deepseek-ai/dsh-base'], [
        { id: 'legacy-frontend-row', name: '@deepseek-harness-tui/dsh-tui' },
      ])
      const plan = planProfile({ native: helpers!.profile, installAnchor: installAnchor!, home, profile: 'legacy-frontend' })
      assert.deepEqual(plan.suppressedRows, [{
        id: 'legacy-frontend-row',
        name: '@deepseek-harness-tui/dsh-tui',
        source: join(home, 'profiles', 'legacy-frontend', 'cordis.patch.yml'),
      }])
      assert.match(plan.warnings.join('\n'), /disables that row in its private overlay/)
      const workspace = prepareWorkspace({ bridgePath: BRIDGE, plan, native: helpers!.profile, home })
      try {
        const overlay = readFileSync(workspace.patchPath, 'utf8')
        assert.match(overlay, /"id": "legacy-frontend-row"/)
        assert.match(overlay, /"disabled": true/)
        assert.match(readFileSync(join(home, 'profiles', 'legacy-frontend', 'cordis.patch.yml'), 'utf8'), /legacy-frontend-row/)
      } finally { workspace.cleanup() }
    } finally { cleanup(home) }
  })

  it('refuses an inserted frontend that has no stable row id', () => {
    const home = tempDir('dsh-native-plan-home-')
    try {
      profileFixture(home, 'anonymous-frontend', ['@deepseek-ai/dsh-base'], [
        { insert: [{ name: '@deepseek-ai/dsh-web-app' }] },
      ])
      assert.throws(
        () => planProfile({ native: helpers!.profile, installAnchor: installAnchor!, home, profile: 'anonymous-frontend' }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'PROFILE_UNSUPPORTED')
          assert.match(String((error as Error).message), /without a stable row id/)
          return true
        },
      )
    } finally { cleanup(home) }
  })

  it('never reads a profile the caller did not select', () => {
    const home = tempDir('dsh-native-plan-home-')
    try {
      profileFixture(home, 'untouched', ['@deepseek-ai/dsh-base'], [{ id: 'hmr', disabled: true }])
      const plan = planProfile({ native: helpers!.profile, installAnchor: installAnchor!, home })
      assert.equal(plan.sourceDir, undefined)
      assert.equal(existsSync(join(home, 'profiles', 'untouched', 'cordis.yml')), false)
    } finally { cleanup(home) }
  })
})

describe('native runtime workspace', { skip }, () => {
  it('mirrors a selected profile read-only and applies the bridge as the last native layer', () => {
    const home = tempDir('dsh-native-workspace-home-')
    try {
      mkdirSync(join(home, 'sessions'), { recursive: true })
      writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrecords: {}\nrefs: {}\n')
      const source = profileFixture(home, 'selected', ['@deepseek-ai/dsh-base', 'fixture-plugin'], [
        { id: 'llm-pi-ai', config: { providers: { 'native-route': { api: 'anthropic-messages', baseURL: 'http://127.0.0.1:1/anthropic', models: [{ id: 'native-model' }] } } } },
        { id: 'agent-default-model', config: { provider: 'native-route', model: 'native-model' } },
      ])
      profilePackage(source, 'fixture-plugin', { name: 'fixture-plugin', version: '1.0.0', main: './index.js' })
      writeFileSync(join(source, 'compatibility.json'), JSON.stringify({ 'fixture-plugin@1.0.0': ['0.2.1-rc.5'] }))
      const patchBefore = readFileSync(join(source, 'cordis.patch.yml'), 'utf8')
      const plan = planProfile({ native: helpers!.profile, installAnchor: installAnchor!, home, profile: 'selected' })
      const workspace = prepareWorkspace({ bridgePath: BRIDGE, plan, native: helpers!.profile, home })
      try {
        assert.equal(workspace.owned, true)
        assert.equal(workspace.profileName, 'selected')
        assert.notEqual(workspace.profileDir, source)
        assert.equal(workspace.dataHome, home)
        // The patch is a real scratch file so relative module anchors stay in
        // the scratch profile; its source is never edited.
        assert.equal(lstatSync(join(workspace.profileDir, 'cordis.patch.yml')).isSymbolicLink(), false)
        assert.equal(readFileSync(join(workspace.profileDir, 'cordis.patch.yml'), 'utf8'), patchBefore)
        assert.equal(lstatSync(join(workspace.profileDir, 'compatibility.json')).isSymbolicLink(), true)
        assert.equal(lstatSync(join(workspace.profileDir, 'node_modules')).isSymbolicLink(), true)
        assert.equal(existsSync(join(workspace.profileDir, 'node_modules', 'fixture-plugin', 'package.json')), true)
        // Only the launcher-owned root config and the scratch manifest are written.
        const scratchManifest = readJson(join(workspace.profileDir, 'package.json'))
        assert.deepEqual(
          (scratchManifest.dsh as JsonRecord).profile,
          { bundles: [...helpers!.profile.defaultBundles, 'fixture-plugin'] },
        )
        assert.equal(existsSync(join(source, 'cordis.yml')), false, 'no launcher write reaches the user profile')
        assert.equal(readFileSync(join(source, 'cordis.patch.yml'), 'utf8'), patchBefore)
        // The bridge overlay is the private highest-priority layer.
        const overlay = readFileSync(workspace.patchPath, 'utf8')
        assert.match(overlay, /dsh-pi-tui-bridge/)
        assert.match(overlay, /dsh-pi-tui-agent-preset-registry/)
        assert.equal(readFileSync(join(home, '.credentials.yaml'), 'utf8').includes('records'), true)
        assert.equal(lstatSync(join(workspace.homeDir, '.credentials.yaml')).isSymbolicLink(), true)
        assert.equal(lstatSync(join(workspace.homeDir, 'sessions')).isSymbolicLink(), true)
      } finally {
        workspace.cleanup()
      }
      assert.equal(existsSync(workspace.homeDir), false, 'only the scratch workspace is removed')
      assert.equal(existsSync(source), true)
      assert.equal(readFileSync(join(source, 'cordis.patch.yml'), 'utf8'), patchBefore)
    } finally { cleanup(home) }
  })

  it('initializes the application profile with native defaults and copies legacy settings', () => {
    const home = tempDir('dsh-native-workspace-home-')
    try {
      writeFileSync(join(home, 'settings.yaml'), 'ui-settings: { theme: light }\n')
      const plan: ProfilePlan = { name: APP_PROFILE_NAME, bundles: helpers!.profile.defaultBundles, replaced: [], warnings: [] }
      const workspace = prepareWorkspace({ bridgePath: BRIDGE, plan, native: helpers!.profile, home })
      try {
        const manifest = readJson(join(workspace.profileDir, 'package.json'))
        assert.deepEqual((manifest.dsh as JsonRecord).profile, { bundles: [...helpers!.profile.defaultBundles] })
        assert.equal(existsSync(join(workspace.profileDir, 'cordis.patch.yml')), true)
        assert.equal(existsSync(join(home, 'profiles', APP_PROFILE_NAME)), false, 'no profile is written into the real home')
        // The legacy settings document is imported from a copy, so the user's file is never archived.
        assert.equal(lstatSync(join(workspace.homeDir, 'settings.yaml')).isSymbolicLink(), false)
        assert.match(readFileSync(join(workspace.homeDir, 'settings.yaml'), 'utf8'), /theme: light/)
      } finally { workspace.cleanup() }
      assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'ui-settings: { theme: light }\n')
    } finally { cleanup(home) }
  })

  it('rejects a missing bridge before creating a workspace', () => {
    const home = tempDir('dsh-native-workspace-home-')
    try {
      const plan: ProfilePlan = { name: APP_PROFILE_NAME, bundles: helpers!.profile.defaultBundles, replaced: [], warnings: [] }
      assert.throws(
        () => prepareWorkspace({ bridgePath: join(home, 'missing-bridge.mjs'), plan, native: helpers!.profile, home }),
        /runtime bridge is missing/,
      )
    } finally { cleanup(home) }
  })
})

describe('dsh-tui command line', () => {
  it('fails a removed --models-file with native-configuration guidance and no fallback', () => {
    for (const args of [['--models-file', '/tmp/models.json'], ['--models-file=/tmp/models.json']]) {
      const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
      assert.equal(result.status, 2)
      assert.match(result.stderr, /--models-file was removed and no fallback is attempted/)
      assert.match(result.stderr, /DeepSeek Harness native configuration only/)
      assert.match(result.stderr, /--profile <name>/)
      assert.match(result.stderr, /never imported/)
      assert.equal(result.stdout, '')
    }
  })

  it('documents --profile and no Pi catalog option', () => {
    const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /^dsh-tui 0\.1\.0/)
    assert.match(result.stdout, /--profile <name>\s+Reuse a real DSH profile/)
    assert.doesNotMatch(result.stdout, /--models-file/)
    assert.match(result.stdout, /never reads Pi models\.json\/auth\.json/)
  })

  it('reports one version for the renamed entry point', () => {
    const result = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim(), '0.1.0')
  })
})