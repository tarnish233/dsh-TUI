import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { nativeProfileFixture } from './helpers/native-profile.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const EMITTER = new URL('./fixtures/native-diagnostics.mjs', import.meta.url).href
const DRIVER = join(ROOT, 'scripts/pty-native-diagnostics.py')
const OUTPUT = join(ROOT, '.cache/diagnostic-fix/native-pty')

for (const mode of ['inline', 'fullscreen'] as const) {
  for (const scenario of ['ordinary', 'remount', 'fatal'] as const) {
    test(`native diagnostic isolation: ${mode}/${scenario}`, async () => {
      const fixture = await nativeProfileFixture()
      try {
        await mkdir(OUTPUT, { recursive: true })
        const control = join(fixture.directory, 'diagnostic-control.json')
        const ack = join(fixture.directory, 'diagnostic-ack.json')
        const configDir = join(fixture.directory, 'tui')
        await writeFile(join(fixture.profileDir, 'cordis.patch.yml'), JSON.stringify([
          { id: 'session-title-llm', disabled: true },
          { insert: [{ id: 'native-diagnostic-emitter', name: EMITTER, config: { control, ack } }] },
        ]))
        const env: NodeJS.ProcessEnv = { ...fixture.env, NPM_CONFIG_USERCONFIG: '/dev/null' }
        const result = spawnSync('python3', [DRIVER, JSON.stringify({
          node: process.execPath, bin: fixture.bin, cwd: fixture.cwd, profileDir: fixture.profileDir,
          configDir, control, ack, mode, scenario, env,
          output: join(OUTPUT, `${mode}-${scenario}.ansi`),
        })], { cwd: fixture.cwd, env, encoding: 'utf8', timeout: 55_000 })
        assert.equal(result.status, 0, result.stderr || result.stdout)
        const report: unknown = JSON.parse(result.stdout)
        assert.ok(report !== null && typeof report === 'object')
        const facts = report as Record<string, unknown>
        for (const name of ['catalogLogIsolated', 'stdoutLogIsolated', 'splitSecretRedacted', 'warningVisible', 'draftPreserved', 'terminalRestored', 'noModelCall']) assert.equal(facts[name], true, name)
        assert.equal(facts.exit, scenario === 'fatal' ? 1 : 0)
        await writeFile(join(OUTPUT, `${mode}-${scenario}.json`), JSON.stringify(facts, null, 2) + '\n')
      } finally {
        await fixture.cleanup()
      }
    })
  }
}
