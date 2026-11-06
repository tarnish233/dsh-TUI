import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nativeProfileFixture } from './helpers/native-profile.ts'

test('real native profile PTY restores terminal across exit, SIGINT, suspend and plugin remount', { timeout: 90_000 }, async () => {
  const fixture = await nativeProfileFixture()
  try {
    const request = JSON.stringify({ bin: fixture.bin, cwd: fixture.cwd, profileDir: fixture.profileDir, implicitFullscreen: true,
      env: Object.fromEntries(Object.entries(fixture.env).filter(([, value]) => typeof value === 'string')) })
    const script = fileURLToPath(new URL('../scripts/pty-native-plugin.py', import.meta.url))
    const output = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
      execFile('python3', [script, request], { timeout: 80_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    })
    assert.equal(output.error, null, output.stderr)
    const result = JSON.parse(output.stdout) as { nativePluginPty: { mode: string; nativeProfile: boolean; terminalRestored: boolean; unmountRemountCycles?: number; implicitFullscreen?: boolean }[] }
    assert.equal(result.nativePluginPty.length, 8)
    assert.ok(result.nativePluginPty.every(item => item.nativeProfile && item.terminalRestored))
    assert.equal(result.nativePluginPty.filter(item => item.implicitFullscreen).length, 4, 'all fullscreen scenarios omit the screen flag')
    assert.equal(result.nativePluginPty.filter(item => item.unmountRemountCycles === 2).length, 2)
  } finally { await fixture.cleanup() }
})
