import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { visibleWidth } from '#pi-tui'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionEvent, SessionInfo, SubagentEntry } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'
import { imageFixture } from './helpers/images.ts'

interface Gate {
  readonly promise: Promise<void>
  release(): void
}
function gate(): Gate {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function userFact(text: string, seq: number): SessionEvent {
  return {
    type: 'user/message', seq, time: 1_750_000_000_000 + seq, surfaceOp: 'append',
    data: { id: `startup-user-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}
const nativeChild: SubagentEntry = {
  id: 'startup-child', parentSessionId: 'startup-root', label: 'Initializing native child',
  mode: 'continuable', status: 'initializing', local: true,
}

/** Deferred public reads only: no Agent, model, real profile or user session. */
class StartupBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly calls: Array<{ name: string; args: JsonRecord }> = []
  readonly following = new Set<string>()
  info: SessionInfo
  followGate?: Gate
  readGate?: Gate
  failRead = false
  cancels = 0
  sends = 0

  constructor(cwd: string) {
    this.info = {
      sessionId: nativeChild.parentSessionId, attachmentId: 'startup-attachment', cwd,
      provider: 'fixture', model: 'fixture-root-model', capabilities: ['commands', 'state', 'subagents', 'subagent-session', 'subagent-follow'],
      events: [], subagents: { entries: [nativeChild] },
    }
  }
  onEvent(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  }
  emit(event: BackendEvent): void { for (const listener of this.listeners) listener(event) }
  async connect(): Promise<SessionInfo> { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(): Promise<void> { this.sends += 1 }
  async cancel(): Promise<void> { this.cancels += 1 }
  async respond(): Promise<void> { throw new Error('startup fixture never answers decisions') }
  async close(): Promise<void> { this.followGate?.release(); this.readGate?.release() }
  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'state') return { pending: { nextTurn: 0, nextStep: 0 }, queued: 0, queue: [] }
    if (name === 'subagent-follow') {
      if (args.follow === true) await this.followGate?.promise
      const id = String(args.sessionId)
      if (args.follow === true) this.following.add(id)
      else this.following.delete(id)
      return { sessionId: id, follow: args.follow, following: this.following.has(id), supported: true }
    }
    if (name === 'subagent-session') {
      await this.readGate?.promise
      if (this.failRead) throw new Error('synthetic native snapshot refusal')
      return {
        sessionId: String(args.sessionId), cwd: this.info.cwd, provider: 'fixture', model: 'fixture-child-model', capabilities: [],
        events: [userFact(`Durable startup snapshot for ${String(args.sessionId)}`, 1)],
      } satisfies SessionInfo
    }
    throw new Error('Unexpected startup fixture command: ' + name)
  }
}
async function paint(terminal: VirtualTerminal): Promise<void> { await delay(45); await terminal.flush() }
async function fixture(screen: 'inline' | 'fullscreen') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-app-child-startup-'))
  const backend = new StartupBackend(directory), terminal = new VirtualTerminal(110, 38)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, registerSignals: false })
  try {
    await app.start(); await paint(terminal)
    return { app, backend, terminal, async close() {
      backend.followGate?.release(); backend.readGate?.release()
      try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
    } }
  } catch (error) {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}
async function openChild(f: Awaited<ReturnType<typeof fixture>>, screen: 'inline' | 'fullscreen'): Promise<void> {
  if (screen === 'inline') {
    f.terminal.type('\x18'); f.terminal.type('\x01'); await paint(f.terminal)
    f.terminal.type('\r')
  } else {
    const lines = f.terminal.screen().split('\n')
    const header = lines.findIndex(line => line.includes('● Agents'))
    const row = lines.findIndex((line, index) => index > header && line.includes(nativeChild.label!))
    assert.ok(row > header)
    const col = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf(nativeChild.label!))) + 1
    f.terminal.type(`\x1b[<0;${col + 1};${row + 1}M`); await paint(f.terminal)
    f.terminal.type(`\x1b[<0;${col + 1};${row + 1}m`)
  }
  await paint(f.terminal)
}
const agentsVisible = (terminal: VirtualTerminal): boolean => terminal.screen().split('\n').some(line => /(?<!● )Agents ·/.test(line))

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`initializing child opens a loading surface before its native snapshot arrives (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.readGate = gate()
      f.terminal.type('retained startup draft')
      const editor = f.app.editor, image = await imageFixture()
      editor.insertImage(image.upload)
      const draft = editor.captureDraft()
      await openChild(f, screen)
      assert.ok(f.backend.calls.some(call => call.name === 'subagent-session'), 'initializing permits a read immediately')
      assert.match(f.terminal.screen(), /Loading child session/, 'navigation visibly responds before disk/native reads finish')
      assert.equal(editor.focused, false, 'the child loading surface, not a hidden root Editor, owns input')
      assert.deepEqual(editor.captureDraft(), draft)
      assert.doesNotMatch(f.terminal.screen(), /Durable startup snapshot/)
      f.backend.emit({ type: 'session_event', sessionId: nativeChild.id, event: userFact('Buffered startup live fact', 2) })
      f.backend.readGate.release()
      await until(() => f.terminal.screen().includes('Durable startup snapshot') && f.terminal.screen().includes('Buffered startup live fact'), 'snapshot and buffered child frame render together')
      assert.doesNotMatch(f.terminal.screen(), /Loading child session/)
      assert.equal(f.app.store.subagentEntry(nativeChild.id)?.status, 'initializing', 'opening never waits for or invents running status')
      assert.equal(f.app.store.items.some(item => JSON.stringify(item).includes('Buffered startup live fact')), false)
      f.terminal.type('\x1b'); await paint(f.terminal)
      if (screen === 'inline') { assert.equal(agentsVisible(f.terminal), true); f.terminal.type('\x1b'); await paint(f.terminal) }
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(f.backend.cancels + f.backend.sends, 0)
    } finally { await f.close() }
  })

  test(`Esc cancels the loading child view without interrupting the root or reopening after late read (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.readGate = gate()
      f.terminal.type('loading close draft')
      const editor = f.app.editor, draft = editor.captureDraft()
      f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
      await openChild(f, screen)
      assert.match(f.terminal.screen(), /Loading child session/)
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.doesNotMatch(f.terminal.screen(), /Loading child session/)
      assert.equal(f.backend.cancels, 0, 'Esc while reading is navigation only, not a root cancellation')
      f.backend.readGate.release(); await paint(f.terminal)
      assert.doesNotMatch(f.terminal.screen(), /Durable startup snapshot/, 'a late read cannot resurrect a closed child view')
      assert.equal(f.backend.following.has(nativeChild.id), false)
      if (screen === 'inline') { assert.equal(agentsVisible(f.terminal), true); f.terminal.type('\x1b'); await paint(f.terminal) }
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(f.app.isBusy, true, 'view dismissal leaves native root activity untouched')
    } finally { await f.close() }
  })

  test(`Esc before a follow acknowledgement cannot leave an orphan follow or start a snapshot (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.followGate = gate()
      await openChild(f, screen)
      assert.match(f.terminal.screen(), /Loading child session/, 'even subscription latency has immediate navigation feedback')
      assert.equal(f.backend.calls.some(call => call.name === 'subagent-session'), false)
      f.terminal.type('\x1b'); await paint(f.terminal)
      f.backend.followGate.release(); await paint(f.terminal)
      assert.equal(f.backend.calls.some(call => call.name === 'subagent-session'), false, 'closed loading view does not begin a second native read')
      assert.equal(f.backend.following.has(nativeChild.id), false, 'a late acknowledgement releases its now-unowned follow')
      assert.doesNotMatch(f.terminal.screen(), /Loading child session|Durable startup snapshot/)
      assert.equal(f.backend.cancels, 0)
    } finally { await f.close() }
  })

  test(`a failed initial snapshot releases the loading surface and permits a fresh open (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.readGate = gate(); f.backend.failRead = true
      await openChild(f, screen)
      assert.match(f.terminal.screen(), /Loading child session/)
      f.backend.readGate.release(); await paint(f.terminal)
      assert.doesNotMatch(f.terminal.screen(), /Loading child session/)
      assert.equal(f.backend.following.has(nativeChild.id), false)
      if (screen === 'inline') { assert.equal(agentsVisible(f.terminal), true); f.terminal.type('\x1b'); await paint(f.terminal) }
      assert.match(f.terminal.screen(), /Could not open the child session|synthetic native snapshot refusal/)
      f.backend.failRead = false
      await openChild(f, screen)
      await until(() => f.terminal.screen().includes('Durable startup snapshot'), 'a fresh request succeeds without native child state change')
      assert.equal(f.backend.cancels + f.backend.sends, 0)
    } finally { await f.close() }
  })

  test(`a late old snapshot cannot unfollow a freshly reopened same-id child (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      const oldRead = gate(), newRead = gate()
      f.backend.readGate = oldRead
      await openChild(f, screen)
      f.terminal.type('\x1b'); await paint(f.terminal)
      f.backend.readGate = newRead
      await openChild(f, screen)
      assert.equal(f.backend.calls.filter(call => call.name === 'subagent-session').length, 2)
      oldRead.release(); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Loading child session/, 'only the new loading surface survives')
      assert.doesNotMatch(f.terminal.screen(), /Durable startup snapshot/)
      assert.equal(f.backend.following.has(nativeChild.id), true, 'the old read cannot release a new same-id owner')
      newRead.release()
      await until(() => f.terminal.screen().includes('Durable startup snapshot'), 'the new same-id read owns the conversation')
    } finally { await f.close() }
  })

  test(`a late old follow acknowledgement cannot steal a new same-id loading view (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      const oldFollow = gate(), newFollow = gate()
      f.backend.followGate = oldFollow
      await openChild(f, screen)
      f.terminal.type('\x1b'); await paint(f.terminal)
      f.backend.followGate = newFollow
      await openChild(f, screen)
      oldFollow.release(); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Loading child session/)
      assert.equal(f.backend.calls.some(call => call.name === 'subagent-session'), false, 'the stale acknowledgement cannot start a snapshot')
      newFollow.release()
      await until(() => f.terminal.screen().includes('Durable startup snapshot'), 'the current follow acknowledgement admits its own snapshot')
      assert.equal(f.backend.calls.filter(call => call.name === 'subagent-session').length, 1)
      assert.equal(f.backend.following.has(nativeChild.id), true)
    } finally { await f.close() }
  })

  test(`native membership removal closes a loading child and rejects its late snapshot (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.readGate = gate()
      f.terminal.type('removed child draft')
      const editor = f.app.editor, draft = editor.captureDraft()
      await openChild(f, screen)
      f.backend.emit({ type: 'subagents', sessionId: f.backend.info.sessionId, value: { entries: [] } })
      await paint(f.terminal)
      assert.doesNotMatch(f.terminal.screen(), /Loading child session|Initializing native child/)
      assert.equal(editor.focused, true)
      f.backend.readGate.release(); await paint(f.terminal)
      assert.doesNotMatch(f.terminal.screen(), /Durable startup snapshot/)
      assert.equal(f.backend.following.has(nativeChild.id), false)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(f.backend.cancels + f.backend.sends, 0)
    } finally { await f.close() }
  })
}

test('a stale child read cannot affect the same child id on a replacement attachment', async () => {
  const f = await fixture('fullscreen')
  try {
    const oldRead = gate(), newRead = gate()
    f.backend.readGate = oldRead
    await openChild(f, 'fullscreen')
    f.backend.following.clear() // Native attachment teardown owns its old follows.
    f.backend.info = { ...f.backend.info, attachmentId: 'replacement-startup-attachment' }
    f.backend.emit({ type: 'ready', info: f.backend.info }); await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /Loading child session/)
    f.backend.readGate = newRead
    await openChild(f, 'fullscreen')
    oldRead.release(); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Loading child session/)
    assert.equal(f.backend.following.has(nativeChild.id), true)
    newRead.release()
    await until(() => f.terminal.screen().includes('Durable startup snapshot'), 'only the replacement attachment snapshot is admitted')
    assert.equal(f.backend.cancels + f.backend.sends, 0)
  } finally { await f.close() }
})
