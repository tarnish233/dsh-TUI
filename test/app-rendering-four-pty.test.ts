import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('PTY: native title separation and exclusive fullscreen hover retire at the editor boundary', { timeout: 100_000 }, async () => {
  const script = fileURLToPath(new URL('../scripts/pty-rendering-four-fixes.py', import.meta.url))
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile('python3', [script], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  assert.equal(result.error, null, result.stderr + result.stdout)
  const value: unknown = JSON.parse(result.stdout)
  assert.ok(value !== null && typeof value === 'object')
  const rows = (value as { renderingFourFixes?: unknown }).renderingFourFixes
  assert.ok(Array.isArray(rows) && rows.length === 2)
  for (const row of rows as Array<Record<string, unknown>>) {
    assert.ok(row.mode === 'inline' || row.mode === 'fullscreen')
    assert.equal(row.nativeTitleSeparated, true)
    assert.equal(row.exclusivePointerHover, row.mode === 'fullscreen')
    assert.equal(row.editorBoundaryClearsHover, row.mode === 'fullscreen')
    assert.equal(row.terminalRestored, true)
    assert.equal(row.explicitFixtureOnly, true)
    assert.equal(row.models, false)
  }
})
