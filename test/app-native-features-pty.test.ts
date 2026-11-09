import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Real terminal/input renderer; native service ownership is separately covered by NativeScene. */
test('PTY: fixed Todo, visibility/update, shared Settings canvas and file-only multipart restore terminal', { timeout: 90_000 }, async () => {
  const script = fileURLToPath(new URL('../scripts/pty-native-ui-batches.py', import.meta.url))
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile('python3', [script], { timeout: 80_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  assert.equal(result.error, null, result.stderr + result.stdout)
  const value: unknown = JSON.parse(result.stdout)
  assert.ok(value !== null && typeof value === 'object')
  const rows = (value as { ptyNativeUiBatches?: unknown }).ptyNativeUiBatches
  assert.ok(Array.isArray(rows) && rows.length === 2)
  for (const row of rows as Array<Record<string, unknown>>) {
    assert.equal(row.todoFixed, true)
    assert.equal(row.toggleAndUpdate, true)
    assert.equal(row.resizeKeepsEditor, true)
    assert.equal(row.settingsSharesCanvas, true)
    assert.equal(row.fileMultipart, true)
    assert.equal(row.terminalRestored, true)
    assert.equal(row.models, false)
    assert.equal(row.nativeApiTestedHere, false)
    assert.equal(row.explicitFixtureOnly, true)
  }
})
