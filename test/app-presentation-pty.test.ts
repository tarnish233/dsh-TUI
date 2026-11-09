import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('PTY: unified dock spacing, native-shaped mixed activity, mouse offsets and one-editor restore', { timeout: 100_000 }, async () => {
  const script = fileURLToPath(new URL('../scripts/pty-presentation-convergence.py', import.meta.url))
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile('python3', [script], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  assert.equal(result.error, null, result.stderr + result.stdout)
  const value: unknown = JSON.parse(result.stdout)
  assert.ok(value !== null && typeof value === 'object')
  const rows = (value as { presentationConvergence?: unknown }).presentationConvergence
  assert.ok(Array.isArray(rows) && rows.length === 2)
  for (const row of rows as Array<Record<string, unknown>>) {
    for (const flag of ['uniformRoomyGaps', 'compactDropsAllGaps', 'mixedDisclosure', 'genuineMessageVisible', 'agentsNavigation',
      'toggleAndMultiline', 'terminalRestored', 'explicitFixtureOnly']) assert.equal(row[flag], true, flag)
    assert.equal(row.dockMouseOffset, row.mode === 'fullscreen', 'real SGR mouse belongs to fullscreen renderer')
    assert.equal(row.models, false)
    assert.equal(row.nativeApiTestedHere, false)
  }
})
