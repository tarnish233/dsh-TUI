import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Tests the built public CLI alias, not a standalone replacement renderer. */
test('CLI PTY: --demo tasks exposes Todo/Goal/Subagents and finite controls without native DSH', { timeout: 100_000 }, async () => {
  const script = fileURLToPath(new URL('../scripts/pty-demo-tasks.py', import.meta.url))
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile('python3', [script], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  assert.equal(result.error, null, result.stderr + result.stdout)
  const value: unknown = JSON.parse(result.stdout)
  assert.ok(value !== null && typeof value === 'object')
  const rows = (value as { demoTasks?: unknown }).demoTasks
  assert.ok(Array.isArray(rows) && rows.length === 2)
  const modes = new Set<string>()
  for (const row of rows as Array<Record<string, unknown>>) {
    assert.ok(row.mode === 'inline' || row.mode === 'fullscreen')
    modes.add(row.mode)
    for (const field of ['publicCliEntry', 'allThreeDocks', 'initialMixedActivity', 'independentDemoChildMessage', 'nextDoneClearRestart', 'historyAndCompactResize',
      'toggleAndExistingOverlays', 'multilineEditorPreserved', 'terminalRestored', 'nativeCommandWasUnusable',
      'explicitOfflineDemo']) assert.equal(row[field], true, field)
    assert.equal(row.models, false)
  }
  assert.equal(modes.size, 2)
})
