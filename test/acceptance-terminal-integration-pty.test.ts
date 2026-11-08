import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/pty-terminal-integration-smoke.py', import.meta.url))

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`Terminal CLI/PTY (${screen}): generic/Rex negotiation, Ghostty focus alerts and explicit protocol opt-out`, { timeout: 65_000 }, async () => {
    const { stdout } = await execute('python3', [script, screen], { timeout: 55_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 })
    const value: unknown = JSON.parse(stdout)
    assert.ok(value !== null && typeof value === 'object' && 'ptyTerminalIntegrationAcceptance' in value)
    const rows: unknown = (value as { ptyTerminalIntegrationAcceptance: unknown }).ptyTerminalIntegrationAcceptance
    assert.ok(Array.isArray(rows))
    assert.equal(rows.length, 4)
    assert.deepEqual(rows.map((row: unknown) => {
      assert.ok(row !== null && typeof row === 'object' && !Array.isArray(row))
      return (row as Record<string, unknown>).family
    }), ['rex', 'generic', 'ghostty', 'disabled'])
    for (const row of rows as Record<string, unknown>[]) {
      assert.equal(row.mode, screen)
      assert.equal(row.exit, 0)
      assert.equal(row.modelCalls, 0)
      assert.equal(row.privateHomeAndWorkspace, true)
      assert.equal(row.terminalRestored, true)
      assert.equal(row.genericNegotiation, true)
      assert.equal(row.programStatusSupported, row.family === 'rex' || row.family === 'generic')
      assert.equal(row.protocolOptOut, row.family === 'disabled')
      assert.equal(row.focusPasteIsolation, row.family === 'ghostty')
      assert.equal(row.nativeDecisionKinds, row.family !== 'disabled')
      assert.deepEqual(row.explicitNotifications, row.family === 'ghostty'
        ? ['Turn complete', 'Waiting for approval', 'Waiting for your answer', 'Turn complete'] : [])
    }
  })
}
