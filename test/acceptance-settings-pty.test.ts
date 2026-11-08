import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/pty-settings-smoke.py', import.meta.url))

// Parent-owned real CLI/PTY plus independent ANSI-cell projection. Fixtures
// isolate HOME, cwd and preferences; the explicit demo never calls a model.
for (const screen of ['inline', 'fullscreen'] as const) {
  test(`Settings CLI/PTY (${screen}): continuous groups, Tab/Shift+Tab, mouse and child return`, { timeout: 45_000 }, async () => {
    const { stdout } = await execute('python3', [script, screen], { timeout: 35_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 })
    const result: unknown = JSON.parse(stdout)
    assert.ok(result !== null && typeof result === 'object' && 'ptySettingsAcceptance' in result)
    const rows = (result as { ptySettingsAcceptance: unknown }).ptySettingsAcceptance
    assert.ok(Array.isArray(rows))
    assert.equal(rows.length, 1)
    const row: unknown = rows[0]
    assert.ok(row !== null && typeof row === 'object' && !Array.isArray(row))
    const facts = row as Record<string, unknown>
    assert.equal(facts.mode, screen)
    assert.equal(facts.exit, 0)
    assert.equal(facts.modelCalls, 0)
    for (const key of ['singlePage', 'tabShiftTabAndArrowSectionJumps', 'crossSectionSearch', 'keyboardBackPosition',
      'resizeAndCrossGroupRows', 'navigationReadOnly', 'temporaryHomeAndWorkspace', 'terminalRestored']) {
      assert.equal(facts[key], true, key)
    }
    assert.equal(facts.mousePressNoRepaint, screen === 'fullscreen')
    assert.equal(facts.mousePickerRoundTrips, screen === 'fullscreen' ? 4 : 0)
    assert.ok(Array.isArray(facts.releaseToFirstRepaintMs))
    assert.ok(facts.releaseToFirstRepaintMs.every((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 3_000), 'each activated mouse release makes progress without stalling')
  })
}
