import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { nativeDshManifest, nativeProfileFixture } from './helpers/native-profile.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ALIAS = join(ROOT, 'bin/dsh-tui.mjs')
const DRIVER = join(ROOT, 'scripts/pty-attachment-plugin.py')
const APP = 'dsh-tui'
const OLD_APP = ['dsh', 'pi', 'tui'].join('-')
const OUTPUT = join(ROOT, '.cache/rename-attach/pty')
const PRESERVED_PATCH = '[]\n# untouched native profile patch fixture\n'

type Scene = 'first-attach' | 'fresh-profile' | 'already-mounted' | 'name-upgrade' | 'package-failure' | 'interrupt-install' | 'disabled-app-rows'

async function scenario(scene: Scene) {
  const fixture = await nativeProfileFixture(PRESERVED_PATCH)
  try {
    await mkdir(OUTPUT, { recursive: true })
    const nativeRequire = createRequire(await nativeDshManifest())
    const boot = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-app-boot')).href) as {
      readProfileManifest(bin: string, dir: string): Record<string, unknown>
      writeProfileManifest(dir: string, manifest: Record<string, unknown>): void
    }
    const manifest = boot.readProfileManifest('dsh-test', fixture.profileDir)
    const dsh = manifest.dsh as Record<string, unknown>
    const profile = dsh.profile as Record<string, unknown>
    if (!['already-mounted', 'disabled-app-rows'].includes(scene)) {
      await rm(join(fixture.profileDir, 'node_modules', APP))
      boot.writeProfileManifest(fixture.profileDir, {
        ...manifest, dependencies: {},
        dsh: { ...dsh, profile: { ...profile, bundles: ['@deepseek-ai/dsh-base'], preservedMarker: 'native-owned' } },
        preservedMarker: 'unchanged',
      })
    }
    if (scene === 'fresh-profile') await rm(fixture.profileDir, { recursive: true, force: true })
    if (scene === 'name-upgrade') {
      const previous = boot.readProfileManifest('dsh-test', fixture.profileDir)
      const oldDsh = previous.dsh as Record<string, unknown>
      const oldProfile = oldDsh.profile as Record<string, unknown>
      boot.writeProfileManifest(fixture.profileDir, {
        ...previous, dependencies: { [OLD_APP]: `link:${ROOT}` },
        dsh: { ...oldDsh, profile: { ...oldProfile, bundles: ['@deepseek-ai/dsh-base', OLD_APP] } },
      })
      await symlink(ROOT, join(fixture.profileDir, 'node_modules', OLD_APP), 'dir')
    }
    if (scene === 'disabled-app-rows') {
      await writeFile(join(fixture.profileDir, 'cordis.patch.yml'), JSON.stringify([
        { id: 'dsh-tui-startup', disabled: true }, { id: 'dsh-tui', disabled: true },
      ]) + '\n')
    }
    const env: NodeJS.ProcessEnv = { ...fixture.env, NPM_CONFIG_USERCONFIG: '/dev/null' }
    const startedFile = join(fixture.directory, 'pnpm-started')
    const forbiddenMarker = 'synthetic-package-diagnostic-marker'
    if (scene === 'package-failure' || scene === 'interrupt-install') {
      const fakeBin = join(fixture.directory, 'controlled-bin')
      await mkdir(fakeBin, { recursive: true })
      const fakePnpm = join(fakeBin, 'pnpm')
      await writeFile(fakePnpm, scene === 'package-failure'
        ? `#!/bin/sh\nprintf '%s\\n' '${forbiddenMarker}' >&2\nexit 17\n`
        : `#!/bin/sh\nprintf '%s\\n' started > '${startedFile}'\nsleep 60\n`)
      await chmod(fakePnpm, 0o755)
      env.PATH = fakeBin + delimiter + (env.PATH ?? '')
    }
    const expectReady = !['package-failure', 'interrupt-install', 'disabled-app-rows'].includes(scene)
    const expectedExit = expectReady ? 0 : scene === 'interrupt-install' ? 130 : 1
    const result = spawnSync('python3', [DRIVER, JSON.stringify({
      scenario: scene, node: process.execPath, alias: ALIAS, cwd: fixture.cwd, env,
      expectReady, expectedExit, startedFile, forbiddenMarker,
      output: join(OUTPUT, scene + '.ansi'),
    })], { cwd: fixture.cwd, env, encoding: 'utf8', timeout: 40_000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout) as Record<string, unknown>
    assert.equal(report.terminalRestored, true)
    assert.equal(report.noModelPromptSent, true)
    assert.equal(report.exit, expectedExit)
    if (expectReady) {
      assert.equal(report.fullscreen, true)
      assert.equal(report.attachNotice, scene !== 'already-mounted')
      const after = boot.readProfileManifest('dsh-test', fixture.profileDir)
      const afterDsh = after.dsh as { profile?: { bundles?: string[]; preservedMarker?: string } }
      const dependencies = after.dependencies as Record<string, unknown>
      assert.ok(afterDsh.profile?.bundles?.includes(APP))
      const source = dependencies[APP]
      assert.equal(typeof source, 'string')
      assert.ok((source as string).startsWith('link:'))
      assert.equal(await realpath(resolve(fixture.profileDir, (source as string).slice(5))), await realpath(ROOT))
      assert.equal(dependencies[OLD_APP], undefined)
      if (scene !== 'fresh-profile') {
        assert.equal(await readFile(join(fixture.profileDir, 'cordis.patch.yml'), 'utf8'), PRESERVED_PATCH)
      }
      if (!['already-mounted', 'fresh-profile'].includes(scene)) {
        assert.equal(after.preservedMarker, 'unchanged')
        assert.equal(afterDsh.profile?.preservedMarker, 'native-owned')
      }
    }
    if (scene === 'disabled-app-rows') assert.equal(report.activationFailure, true)
    await writeFile(join(OUTPUT, scene + '.json'), JSON.stringify(report, null, 2) + '\n')
  } finally {
    await fixture.cleanup()
  }
}

for (const scene of ['first-attach', 'fresh-profile', 'already-mounted', 'name-upgrade', 'package-failure', 'interrupt-install', 'disabled-app-rows'] as const) {
  test(`native plain alias startup: ${scene}`, async () => { await scenario(scene) })
}
