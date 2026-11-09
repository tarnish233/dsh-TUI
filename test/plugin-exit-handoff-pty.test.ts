import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nativeProfileFixture } from './helpers/native-profile.ts'

/** The real production plugin + native launcher own this test, not a copied exit controller. */
for (const screen of ['inline', 'fullscreen'] as const) {
  for (const held of ['settings', 'backend'] as const) {
    test(`native exit handoff PTY: ${held} cleanup cannot postpone the native deadline (${screen})`, { timeout: 40_000 }, async () => {
      const fixture = await nativeProfileFixture()
      const marker = join(fixture.directory, 'controlled-hold-entered')
      const modulePath = join(fixture.cwd, 'held-cleanup-fixture.mjs')
      const moduleURL = new URL(held === 'settings' ? '../lib/config.js' : '../lib/backend/context.js', import.meta.url).href
      const constructor = held === 'settings' ? 'SettingsStore' : 'DshContextBackend'
      const method = held === 'settings' ? 'flush' : 'close'
      try {
        // In-memory fault injection lives only in this child process. It cannot
        // modify source/global installations or survive the owned fixture.
        await writeFile(modulePath, `
import { writeFileSync } from 'node:fs';
import { ${constructor} } from ${JSON.stringify(moduleURL)};
export const name = 'native-held-cleanup-fixture';
export function apply() {
  ${constructor}.prototype.${method} = function () {
    writeFileSync(${JSON.stringify(marker)}, 'synthetic controlled cleanup hold');
    return new Promise(() => {});
  };
}
`)
        await writeFile(join(fixture.profileDir, 'cordis.patch.yml'), JSON.stringify([
          { id: 'session-title-llm', disabled: true },
          { insert: [{ id: 'held-cleanup-fixture', name: pathToFileURL(modulePath).href }] },
        ]))
        const request = JSON.stringify({ bin: fixture.bin, cwd: fixture.cwd, directory: fixture.directory,
          heldMarker: marker, held, screen, out: fileURLToPath(new URL('../.cache/native-api-fixes/exit-pty/', import.meta.url)),
          env: Object.fromEntries(Object.entries(fixture.env).filter(([, value]) => typeof value === 'string')) })
        const script = fileURLToPath(new URL('../scripts/pty-native-exit-handoff.py', import.meta.url))
        const output = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
          execFile('python3', [script, request], { cwd: fixture.cwd, env: fixture.env, timeout: 32_000,
            maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
        })
        assert.equal(output.error, null, output.stderr + output.stdout)
        const result: unknown = JSON.parse(output.stdout)
        assert.ok(result !== null && typeof result === 'object')
        const record = result as Record<string, unknown>
        assert.equal(record.nativeLauncherOwnedExit, true)
        assert.equal(record.controlledHoldEntered, true)
        assert.equal(record.terminalRestored, true)
        assert.equal(record.exit, 0)
        assert.equal(record.providerCalls, false)
        assert.ok(typeof record.nativeDeadlineSeconds === 'number' && record.nativeDeadlineSeconds >= 4.5 && record.nativeDeadlineSeconds < 7)
        assert.ok(typeof record.terminalRestoreSeconds === 'number' && record.terminalRestoreSeconds < 1.5)
      } finally { await fixture.cleanup() }
    })
  }
}
