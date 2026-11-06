import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import type { Backend, BackendEvent, DecisionRequest, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

/** Explicit transport/UI fixture; no Agent, policy or model implementation. */
class ControlBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly commands: Array<{ name: string; args: JsonRecord }> = []
  readonly responses: Array<{ id: string; value: unknown }> = []
  readonly listeners = new Set<(event: BackendEvent) => void>()
  info: SessionInfo
  heldResponse?: { id: string; promise: Promise<void> }
  execute?: (line: string) => Promise<unknown>
  constructor(cwd: string) { this.info = { sessionId: 'ui-session', attachmentId: 'attachment-1', cwd, provider: 'fixture', model: 'fixture', capabilities: ['commands', 'execute', 'new', 'state'] } }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send() {}
  async cancel() {}
  async command(name: string, args: JsonRecord = {}) {
    this.commands.push({ name, args })
    if (name === 'commands') return [{ name: 'custom', description: 'Native custom command' }, { name: 'compact', description: 'Native compact command' }]
    if (name === 'execute') return this.execute ? await this.execute(String(args.line)) : { commandId: 'native-ui-fixture', result: { kind: 'success', text: 'Native result rendered.' } }
    if (name === 'new') { this.info = { ...this.info, sessionId: 'new-ui-session', attachmentId: 'attachment-2', events: [] }; this.emit({ type: 'ready', info: this.info }) }
    return this.info
  }
  async respond(id: string, value: unknown) {
    this.responses.push({ id, value })
    this.emit({ type: 'decision_closed', sessionId: this.info.sessionId, id })
    if (this.heldResponse?.id === id) await this.heldResponse.promise
  }
  async close() {}
}

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen') {
  const cwd = await mkdtemp(join(tmpdir(), 'ui-native-boundary-'))
  const backend = new ControlBackend(cwd), terminal = new VirtualTerminal(100, 35)
  const app = new App({ backend, cwd, configDir: cwd, terminal, screen, registerSignals: false })
  await app.start()
  return { backend, terminal, app, async close() { await app.shutdown(); terminal.dispose(); await rm(cwd, { recursive: true, force: true }) } }
}
const paint = async (terminal: VirtualTerminal) => { await delay(25); await terminal.flush() }
const decision = (id: string, title: string): DecisionRequest => ({ id, kind: 'approval', title, options: [{ label: 'Allow', value: { outcome: 'allowed-once', nativeOpaqueId: id } }] })

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`multiple native decisions are FIFO and a late old acknowledgement cannot hide the next (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      let release!: () => void
      f.backend.heldResponse = { id: 'first', promise: new Promise(resolve => { release = resolve }) }
      f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: decision('first', 'FIRST native decision') })
      f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: decision('second', 'SECOND native decision') })
      await paint(f.terminal)
      assert.equal(f.app.pendingDecisionCount, 2)
      assert.match(f.terminal.screen(), /FIRST native decision/)
      assert.ok(!f.terminal.screen().includes('SECOND native decision'))
      f.terminal.type('\r')
      await until(() => f.app.pendingDecisionCount === 1, 'first closes and second receives focus')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /SECOND native decision/)
      assert.deepEqual(f.backend.responses[0], { id: 'first', value: { outcome: 'allowed-once', nativeOpaqueId: 'first' } })
      release(); await paint(f.terminal)
      assert.match(f.terminal.screen(), /SECOND native decision/, 'acknowledgement of first cannot hide second')
      f.terminal.type('\x1b')
      await until(() => f.app.pendingDecisionCount === 0, 'second cancellation settles its exact request')
      assert.deepEqual(f.backend.responses[1], { id: 'second', value: { cancelled: true } })
      assert.equal(f.app.editor.focused, true)
    } finally { await f.close() }
  })
}

test('native command discovery drives help and /compact forwards raw input, not toolkit business logic', async () => {
  const f = await fixture()
  try {
    await f.app.submit('/help')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /Custom commands/)
    assert.match(f.terminal.screen(), /\/custom\b/)
    assert.match(f.terminal.screen(), /Native custom command/)
    assert.match(f.terminal.screen(), /\/compact\b/)
    assert.match(f.terminal.screen(), /Native compact command/)
    assert.deepEqual(f.app.store.items.filter(item => item.kind === 'notice'), [])
    f.terminal.type('\x1b'); await paint(f.terminal)
    const line = '/compact \t exact  whitespace\nand second line  '
    await f.app.submit(line)
    const calls = f.backend.commands.filter(command => command.name === 'execute')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.args.line, line)
    assert.equal(f.backend.commands.some(command => command.name === 'compact'), false)
    await paint(f.terminal)
    assert.match(f.terminal.document(), /Native result rendered/)
    f.backend.execute = async () => { throw new Error('Native command error remains authoritative.') }
    await f.app.submit('/custom')
    await paint(f.terminal)
    assert.match(f.terminal.document(), /Native command error remains authoritative/)
    assert.ok(!f.terminal.document().includes('No native command matched'), 'transport error is not misreported as an unknown command')
  } finally { await f.close() }
})

test('metadata updates preserve live output but native Agent reattachment resets revision identity', async () => {
  const f = await fixture()
  try {
    const start = () => f.backend.emit({ type: 'stream_start', sessionId: f.backend.info.sessionId, attemptId: 'same-attempt-id', revision: 1, turn: 1, step: 1 })
    const chunk = (text: string) => f.backend.emit({ type: 'stream_chunk', sessionId: f.backend.info.sessionId, attemptId: 'same-attempt-id', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text } })
    start(); chunk('old attachment text')
    assert.equal(f.app.store.hasLiveAttempt, true)
    const liveId = f.app.store.items.find(item => item.kind === 'attempt')?.id
    f.backend.info = { ...f.backend.info, model: 'updated-metadata-only' }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    assert.equal(f.app.store.items.find(item => item.kind === 'attempt')?.id, liveId)
    f.backend.info = { ...f.backend.info, attachmentId: 'attachment-2', events: [] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    assert.equal(f.app.store.hasLiveAttempt, false)
    start(); chunk('new attachment text')
    const live = f.app.store.items.find(item => item.kind === 'attempt')
    assert.equal(live?.kind, 'attempt')
    if (live?.kind === 'attempt') assert.equal(live.text, 'new attachment text')
    assert.ok(!f.app.store.items.some(item => 'text' in item && item.text.includes('old attachment text')))
  } finally { await f.close() }
})

test('session switch invalidates old decisions and expired queued requests do not displace the active one', async () => {
  const f = await fixture()
  try {
    const oldSession = f.backend.info.sessionId
    f.backend.emit({ type: 'decision', sessionId: oldSession, request: decision('old', 'OLD decision') })
    await f.app.submit('/new')
    assert.equal(f.app.pendingDecisionCount, 0)
    f.backend.emit({ type: 'decision', sessionId: oldSession, request: decision('late-old', 'STALE decision') })
    assert.equal(f.app.pendingDecisionCount, 0)
    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: decision('active', 'ACTIVE decision') })
    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: decision('expired', 'EXPIRED decision') })
    f.backend.emit({ type: 'decision_closed', sessionId: f.backend.info.sessionId, id: 'expired' })
    assert.equal(f.app.pendingDecisionCount, 1)
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /ACTIVE decision/)
    assert.ok(!f.terminal.screen().includes('EXPIRED decision'))
  } finally { await f.close() }
})


for (const screen of ['inline', 'fullscreen'] as const) {
  test('normal streaming has one working indicator and no attempt placeholder (' + screen + ')', async () => {
    const f = await fixture(screen)
    try {
      const sessionId = f.backend.info.sessionId
      f.backend.emit({ type: 'status', sessionId, status: 'running' })
      f.backend.emit({ type: 'stream_start', sessionId, attemptId: 'plain-stream', revision: 1, turn: 1, step: 1 })
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Working…/)
      assert.doesNotMatch(f.terminal.screen(), /Streaming attempt|◌/)
      const workingBorder = f.terminal.screen().split('\n').find(line => line.includes('Working…')) ?? ''
      assert.match(workingBorder, /──/, 'working status is embedded in the editor top border')
      assert.doesNotMatch(workingBorder, /^──/, 'the spinner aligns with the prompt marker, not a border notch')
      f.backend.emit({ type: 'stream_chunk', sessionId, attemptId: 'plain-stream', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'Visible incremental response' } })
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Visible incremental response/)
      assert.doesNotMatch(f.terminal.screen(), /Streaming attempt/)
      assert.match(f.terminal.screen(), /Working… \(↓ \d+ tokens · 0s/)
      assert.equal((f.terminal.screen().match(/Working…/g) ?? []).length, 1)
      f.terminal.type('draft while streaming')
      assert.equal(f.app.editor.getText(), 'draft while streaming')
    } finally { await f.close() }
  })
}
