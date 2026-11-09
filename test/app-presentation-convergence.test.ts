import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTerminalSequences, type Component } from '#pi-tui'
import { App } from '../src/app.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import type { Backend, BackendEvent, JsonRecord, SessionEvent, SessionInfo } from '../src/backend/types.ts'
import type { GoalRead } from '../src/backend/native-inspection.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

/** Explicit offline facts; projection tests never execute the fixture tool. */
class PresentationBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private seq = 0
  readonly info: SessionInfo
  goal: GoalRead
  constructor(cwd: string) {
    this.info = { sessionId: 'presentation-root', attachmentId: 'presentation-attachment', cwd,
      provider: 'fixture-only', model: 'no-model-calls', capabilities: ['commands', 'native-goal'], events: [] }
    this.goal = { available: true, complete: true, sessionId: this.info.sessionId, goal: {
      id: 'presentation-goal', revision: 1, objective: 'PRESENTATION GOAL OBJECTIVE', phase: 'active',
      roundsStarted: 1, maxGoalRounds: 6, activation: 'armed' } }
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  append(type: string, data: unknown, surfaceOp?: 'append') {
    const event: SessionEvent = { type, seq: this.seq++, data, ...(surfaceOp ? { surfaceOp } : {}) }
    this.emit({ type: 'session_event', sessionId: this.info.sessionId, event })
  }
  seed() {
    this.emit({ type: 'todos', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId,
      value: Array.from({ length: 6 }, (_, index) => ({ content: `PRESENTATION TODO ${index}`, status: index === 0 ? 'in_progress' as const : 'pending' as const })) })
    this.children(false)
    this.emit({ type: 'native_ui_changed', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId, domain: 'goal' })
  }
  children(settled: boolean) {
    this.emit({ type: 'subagents', sessionId: this.info.sessionId, value: { entries: [
      { id: 'presentation-child', parentSessionId: this.info.sessionId, mode: 'continuable', local: true,
        status: settled ? 'completed' : 'running', label: 'PRESENTATION CHILD', ...(settled ? {} : { lastActivity: 'PRESENTATION ACTIVE DETAIL' }) },
    ] } })
  }
  mixed() {
    this.append('tool/call', { turn: 1, step: 1, callId: 'presentation-read', name: 'fixture_read', arguments: '{}' })
    this.append('tool/result', { turn: 1, step: 1, message: { id: 'presentation-result', role: 'tool',
      toolCallId: 'presentation-read', source: { kind: 'tool', callId: 'presentation-read' },
      content: [{ type: 'text', text: 'one\ntwo\nthree' }] } }, 'append')
    const summary = 'Fixture child finished; this is a status update, not a tool.'
    this.append('user/message', { id: 'presentation-notice', role: 'user', source: { kind: 'subagent-settled', form: 'notice',
      senderSessionId: 'presentation-child', summary }, content: [{ type: 'text', text: summary + '\n\nPRESENTATION NOTICE BODY' }] }, 'append')
  }
  message() {
    this.append('user/message', { id: 'presentation-real-message', role: 'user', source: { kind: 'agent-message',
      senderSessionId: 'presentation-child' }, content: [{ type: 'text', text: 'Agent presentation-child sent a message: PRESENTATION REAL MESSAGE' }] }, 'append')
  }
  async connect() { return this.info }
  async send() { throw new Error('Offline presentation projection never sends a real prompt') }
  async respond() { throw new Error('No native decision in the presentation fixture') }
  async cancel() {}
  async close() {}
  async command(name: string, _args?: JsonRecord): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'native-goal') return this.goal
    if (name === 'state') return { queue: [], queued: 0, pending: { nextTurn: 0, nextStep: 0 } }
    throw new Error('No native business operation in this fixture: ' + name)
  }
}

async function fixture(mode: 'inline' | 'fullscreen', flags = { groupTools: true, groupSubagentMessages: true }) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-presentation-'))
  await writeFile(join(cwd, 'settings.json'), JSON.stringify(flags))
  const backend = new PresentationBackend(cwd), terminal = new VirtualTerminal(110, 36)
  const app = new App({ backend, terminal, cwd, configDir: cwd, screen: mode, demo: true, registerSignals: false })
  const paint = async () => { await delay(50); await terminal.flush() }
  const close = async () => { try { await app.shutdown() } finally { terminal.dispose(); await rm(cwd, { recursive: true, force: true }) } }
  try { await app.start(); backend.seed(); await paint() } catch (error) { await close(); throw error }
  const docks = () => (app as unknown as { statusDockStack: Component }).statusDockStack.render(terminal.columns).map(stripTerminalSequences)
  return { app, backend, terminal, paint, close, docks }
}

function header(lines: readonly string[], name: 'Todos' | 'Goal' | 'Agents') {
  const mark = name === 'Agents' ? '●' : '⏺'
  return lines.findIndex(line => line.trimStart().startsWith(mark + ' ' + name))
}

for (const mode of ['inline', 'fullscreen'] as const) {
  test(`Presentation App ${mode}: one stack owns uniform gaps and removes whitespace before compacting content`, async () => {
    const f = await fixture(mode)
    try {
      let lines = f.docks()
      const indexes = (['Todos', 'Goal', 'Agents'] as const).map(name => header(lines, name))
      assert.ok(indexes.every(index => index >= 0))
      assert.equal(lines[indexes[1]! - 1], '')
      assert.equal(lines[indexes[2]! - 1], '')
      assert.notEqual(lines.at(-1), '', 'no panel owns an after-last spacer')
      f.app.editor.replaceDraftText('line one\nline two\n中文 😀\nline four\nPRESENTATION DRAFT')
      for (const [cols, rows] of [[80, 16], [40, 18], [110, 36]] as const) {
        f.terminal.resize(cols, rows)
        await f.paint()
        lines = f.docks()
        const goal = header(lines, 'Goal'), agents = header(lines, 'Agents')
        assert.ok(header(lines, 'Todos') >= 0 && goal >= 0 && agents >= 0)
        assert.equal(lines[goal - 1] === '', lines[agents - 1] === '', 'gaps are uniform, never partial')
        assert.notEqual(lines.at(-1), '')
        assert.match(f.terminal.screen(), /PRESENTATION DRAFT/)
        assert.equal(f.app.editor.focused, true)
        if (rows <= 18) assert.deepEqual(lines.filter(line => line === ''), [], 'tight pool buys useful rows before gaps')
      }
      const before = f.app.editor.captureDraft()
      f.terminal.type('\x14')
      await f.paint()
      lines = f.docks()
      assert.equal(header(lines, 'Todos'), -1)
      assert.ok(header(lines, 'Goal') >= 0 && header(lines, 'Agents') >= 0)
      assert.deepEqual(f.app.editor.captureDraft(), before)
      f.backend.children(true)
      await f.paint()
      lines = f.docks()
      assert.equal(header(lines, 'Agents'), -1)
      assert.equal(lines.filter(line => line === '').length, 0, 'one visible Goal has no phantom gaps')
    } finally { await f.close() }
  })

  test(`Presentation App ${mode}: mixed group preserves native item counts, shared disclosure and actual message visibility`, async () => {
    const f = await fixture(mode)
    try {
      f.backend.mixed()
      await f.paint()
      assert.match(f.terminal.screen(), /Activities|Activity/)
      assert.match(f.terminal.screen(), /1 tool/)
      assert.match(f.terminal.screen(), /1 (?:status )?update/)
      assert.doesNotMatch(f.terminal.screen(), /PRESENTATION NOTICE BODY/)
      assert.equal(f.app.store.items.filter(item => item.kind === 'tool').length, 1)
      assert.equal(f.app.store.items.filter(item => item.kind === 'subagent-message').length, 1)
      f.terminal.type('presentation kept draft')
      const before = f.app.editor.captureDraft()
      f.terminal.type('\x0f')
      await f.paint()
      assert.match(f.terminal.screen(), /PRESENTATION NOTICE BODY/)
      assert.deepEqual(f.app.editor.captureDraft(), before)
      f.backend.message()
      f.terminal.type('\x0f')
      await f.paint()
      assert.match(f.terminal.screen(), /PRESENTATION REAL MESSAGE/)
      assert.doesNotMatch(f.terminal.screen(), /PRESENTATION NOTICE BODY/)
      assert.deepEqual(f.app.editor.captureDraft(), before)
      assert.equal(f.app.store.items.filter(item => item.kind === 'tool').length, 1)
    } finally { await f.close() }
  })

  for (const flags of [{ groupTools: false, groupSubagentMessages: true }, { groupTools: true, groupSubagentMessages: false }]) {
    test(`Presentation App ${mode}: flags stay independent (${JSON.stringify(flags)})`, async () => {
      const f = await fixture(mode, flags)
      try {
        f.backend.mixed()
        await f.paint()
        assert.doesNotMatch(f.terminal.screen(), /Activities|Activity/)
        assert.match(f.terminal.screen(), /Subtask status updated/)
        assert.match(f.terminal.screen(), /PRESENTATION NOTICE BODY/)
        assert.equal(f.app.store.items.filter(item => item.kind === 'tool').length, 1)
      } finally { await f.close() }
    })
  }
}
