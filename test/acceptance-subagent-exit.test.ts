import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { nativeProfileFixture } from './helpers/native-profile.ts'

const streamFixture = new URL('./fixtures/subagent-stream.mjs', import.meta.url).href
const script = fileURLToPath(new URL('../scripts/pty-subagent-exit-smoke.py', import.meta.url))
const artifacts = fileURLToPath(new URL('../.cache/subagent-exit/pty/', import.meta.url))

// Real native child Agents + native profile exit, but all model streams are
// deterministic fixtures; no user profile, credentials or remote model calls.
for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native TUI exits with idle root and live continuable child (${screen})`, { timeout: 80_000 }, async () => {
    const fixture = await nativeProfileFixture()
    try {
      await mkdir(artifacts, { recursive: true })
      await writeFile(join(fixture.profileDir, 'cordis.patch.yml'), JSON.stringify([
        { id: 'session-title-llm', disabled: true },
        { id: 'llm-deepseek', config: { baseURL: 'http://127.0.0.1:9/anthropic', apiKeyEnv: 'DSH_NATIVE_EXIT_TEST_KEY', models: [{ id: 'deepseek-v4-flash' }] } },
        { insert: [{ id: 'native-exit-offline-stream', name: streamFixture }] },
      ]))
      const request = JSON.stringify({
        bin: fixture.bin, cwd: fixture.cwd, profileDir: fixture.profileDir, implicitFullscreen: true,
        env: { ...fixture.env, DSH_NATIVE_EXIT_TEST_KEY: 'synthetic-native-exit-test-key' },
        artifactsDir: artifacts, modes: [screen], actions: ['ctrl-c', 'slash-exit', 'sigint'],
      })
      const output = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
        execFile('python3', [script, request], { timeout: 70_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
      })
      if (output.error !== null) assert.fail('Native live-child exit failed:\n' + output.stderr)
      const result: unknown = JSON.parse(output.stdout)
      assert.ok(result !== null && typeof result === 'object' && 'nativeSubagentExitPty' in result)
      const rows = (result as { nativeSubagentExitPty: unknown }).nativeSubagentExitPty
      assert.ok(Array.isArray(rows))
      assert.equal(rows.length, 3)
      for (const row of rows as Record<string, unknown>[]) {
        assert.equal(row.nativeProfile, true)
        assert.equal(row.rootIdle, true)
        assert.equal(row.liveChildAtExit, true)
        assert.equal(row.terminalRestored, true)
        assert.equal(row.hermeticStream, true)
      }
    } finally { await fixture.cleanup() }
  })
}
