import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeProfileFixture } from './helpers/native-profile.ts'

const streamFixture = new URL('./fixtures/skills-stream.mjs', import.meta.url).href
const script = fileURLToPath(new URL('../scripts/pty-skills-native-smoke.py', import.meta.url))
const artifactsDir = fileURLToPath(new URL('../.cache/skills-followup/native-pty', import.meta.url))

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`production native Skills menu works before and after an ordinary first message (${screen})`, { timeout: 65_000 }, async () => {
    const fixture = await nativeProfileFixture()
    try {
      await mkdir(artifactsDir, { recursive: true })
      for (const root of [join(fixture.home, 'skills'), join(fixture.home, '.dsh', 'skills')]) {
        for (const name of ['skill-studio', 'fixture-skill-one', 'fixture-skill-two', 'fixture-skill-three', 'fixture-skill-four', 'fixture-skill-five']) {
          const directory = join(root, name)
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Native home ${name} metadata.\n---\nSYNTHETIC_NATIVE_HOME_BODY\n`)
        }
      }
      await writeFile(join(fixture.profileDir, 'cordis.patch.yml'), JSON.stringify([
        { id: 'session-title-llm', disabled: true },
        { id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:9/anthropic', apiKeyEnv: 'DSH_SKILLS_PTY_TEST_KEY', models: [{ id: 'deepseek-v4-flash' }] } },
        { insert: [{ id: 'native-skills-offline-stream', name: streamFixture }] },
      ]))
      const request = JSON.stringify({
        bin: fixture.bin, cwd: fixture.cwd, profileDir: fixture.profileDir,
        env: { ...fixture.env, DSH_SKILLS_PTY_TEST_KEY: 'synthetic-native-skills-pty-key' },
        artifactsDir, modes: [screen],
      })
      const output = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
        execFile('python3', [script, request], { timeout: 55_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 },
          (error, stdout, stderr) => resolve({ error, stdout, stderr }))
      })
      if (output.error !== null) assert.fail('Native Skills CLI/PTY failed:\n' + output.stderr)
      const result: unknown = JSON.parse(output.stdout)
      assert.ok(result !== null && typeof result === 'object' && 'nativeSkillsPty' in result)
      const rows = (result as { nativeSkillsPty: unknown }).nativeSkillsPty
      assert.ok(Array.isArray(rows))
      assert.equal(rows.length, 1)
      const row = rows[0] as Record<string, unknown>
      assert.equal(row.nativeProfile, true)
      assert.equal(row.demo, false)
      assert.equal(row.firstMenuBeforeMessage, true)
      assert.equal(row.ordinaryFirstMessageThenSamePrefix, true)
      assert.equal(row.enterSubmitsCompletedSkillAndBody, true)
      assert.equal(row.nativeUserHomeCatalog, 6)
      assert.equal(row.productionPluginAndTerminalLease, true)
      assert.equal(row.terminalRestored, true)
      assert.equal(row.hermeticStream, true)
    } finally { await fixture.cleanup() }
  })
}
