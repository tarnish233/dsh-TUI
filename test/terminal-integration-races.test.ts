import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProgramStatus } from '#pi-tui'
import type { SessionInfo, SubagentEntry } from '../src/backend/types.ts'
import { defaults } from '../src/config.ts'
import { TerminalIntegration, terminalFileUrl, terminalSafeText, type TerminalPresentationSnapshot } from '../src/ui/terminal-integration.ts'
import { VirtualTerminal } from './helpers/terminal.ts'

class BoundedTerminal extends VirtualTerminal {
  peak = 0
  constructor() { super(); this.programStatusSupported = true }
  override setProgramStatus(status: ProgramStatus): void {
    super.setProgramStatus(status)
    this.peak = Math.max(this.peak, this.statusRecords.size)
  }
}

const info: SessionInfo = {
  sessionId: 'native-root', attachmentId: 'native-attachment', cwd: '/fixture/workspace',
  provider: 'fixture', model: 'fixture', capabilities: [], events: [],
}
const snapshot = (subagents: readonly SubagentEntry[]): TerminalPresentationSnapshot => ({ info, connected: true, busy: false, fatal: false, decisions: [], subagents })
const workers = (prefix: string): SubagentEntry[] => Array.from({ length: 63 }, (_, index) => ({
  id: prefix + index, parentSessionId: info.sessionId, mode: 'continuable', local: true,
  label: prefix + index, status: 'running', lastRunId: 'live-' + prefix + index,
}))

test('terminal record budget never transiently evicts the root while a full child roster is replaced', () => {
  const terminal = new BoundedTerminal()
  const integration = new TerminalIntegration({ terminal, cwd: '/fixture/shell', env: { TERM_PROGRAM: 'rex' }, hostname: () => 'fixture-host' })
  try {
    integration.update(snapshot([]), defaults); integration.start()
    integration.update(snapshot(workers('first-')), defaults)
    assert.equal(terminal.statusRecords.size, 64)
    integration.update(snapshot(workers('second-')), defaults)
    assert.equal(terminal.statusRecords.size, 64)
    assert.equal(terminal.statusRecords.get('')?.state, 'idle')
    assert.equal(terminal.peak, 64, 'obsolete child ids must be cleared before any replacement records are created')
    assert.ok([...terminal.statusRecords.values()].filter(record => record.id !== undefined).every(record => record.title?.startsWith('second-')))
  } finally { integration.dispose(); terminal.dispose() }
})

test('an ill-formed native workspace cannot crash terminal URL encoding or inject a control sequence', () => {
  assert.equal(terminalFileUrl('/fixture/\ud800', 'fixture-host'), null)
  assert.equal(terminalFileUrl('/fixture/\x1b]0;injected', 'fixture-host'), null)
  assert.equal(terminalFileUrl('/fixture/中文 😀;folder', 'fixture-host'), 'file://fixture-host/fixture/%E4%B8%AD%E6%96%87%20%F0%9F%98%80%3Bfolder')
})

test('native titles preserve emoji/language joiners while removing direction overrides and controls', () => {
  const label = 'Native 👩‍💻 خانواده‌'
  assert.equal(terminalSafeText(label, 160), label)
  assert.doesNotMatch(terminalSafeText('\u202eNative\x1b]0;injected\x07\u009b', 160), /\u202e|\u009b|\x1b|\x07/)
})

test('native ready is connection proof even when it precedes the next render snapshot', () => {
  const terminal = new BoundedTerminal()
  const integration = new TerminalIntegration({ terminal, cwd: info.cwd, env: { TERM_PROGRAM: 'rex' } })
  try {
    integration.update(snapshot([]), defaults); integration.start()
    integration.observe({ type: 'closed', code: 0 })
    integration.update({ ...snapshot([]), connected: false }, defaults)
    integration.observe({ type: 'ready', info })
    integration.update({ ...snapshot([]), busy: true }, defaults)
    assert.equal(terminal.statusRecords.get('')?.state, 'working')
    integration.observe({ type: 'closed', code: 0 })
    const next = { ...info, sessionId: 'next-root', attachmentId: 'next-attachment' }
    integration.observe({ type: 'ready', info: next })
    integration.update({ ...snapshot([]), info: next }, defaults)
    assert.equal(terminal.statusRecords.get('')?.state, 'idle')
  } finally { integration.dispose(); terminal.dispose() }
})
