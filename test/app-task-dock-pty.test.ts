import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Real PTY/input/rendering gate; business facts are explicitly offline fixtures. */
test('PTY: Todo/Goal/Subagent coexist in short multiline terminals and retire without stealing the draft', { timeout: 90_000 }, async () => {
  const script = fileURLToPath(new URL('../scripts/pty-task-dock-coexist.py', import.meta.url))
  const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
    execFile('python3', [script], { timeout: 80_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  assert.equal(result.error, null, result.stderr + result.stdout)
  const value: unknown = JSON.parse(result.stdout)
  assert.ok(value !== null && typeof value === 'object')
  const rows = (value as { ptyTaskDockCoexistence?: unknown }).ptyTaskDockCoexistence
  assert.ok(Array.isArray(rows) && rows.length === 2)
  const modes = new Set<string>()
  for (const row of rows as Array<Record<string, unknown>>) {
    assert.ok(row.mode === 'inline' || row.mode === 'fullscreen')
    modes.add(row.mode)
    for (const field of ['todoSurvivesChildStart', 'settlementReleasesSlot', 'allThreeCompact', 'expandedDetails',
      'toggleAndResize', 'multilineDraftPreserved', 'terminalRestored', 'explicitFixtureOnly']) assert.equal(row[field], true, field)
    assert.equal(row.models, false)
    assert.equal(row.nativeApiTestedHere, false)
  }
  assert.equal(modes.size, 2)
})
