/**
 * Parent-owned lifecycle hardening for the terminal application.
 *
 * These three invariants are only observable at the App boundary, so they live
 * here rather than in the backend/input/frontend suites:
 *
 * 1. A process-level crash handler exists exactly while the App owns the
 *    visible terminal. Without it an escaping error prints a stack trace into
 *    alt-screen + raw mode and the user is left with a corrupted screen.
 * 2. One backend event paints one frame. `TranscriptStore` notifies on every
 *    mutation, and the event handler also renders, so a naive wiring paints
 *    twice per streaming chunk.
 * 3. A second exit request escalates instead of joining a bounded native drain
 *    for seconds, and a suspend whose SIGTSTP is ignored rolls back instead of
 *    leaving the UI paused forever.
 * 4. The pre-ready buffer replays only frames whose fact the ready snapshot
 *    cannot carry, keeps a decision when the bound is hit, and reports the
 *    overflow once instead of per frame.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { App } from '../src/app.ts'
import type { Backend, BackendEvent, DecisionRequest, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import type { TranscriptItem } from '../src/state/transcript.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

/** Minimal native-shaped backend: only the event plane this suite drives. */
class LifecycleBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly info: SessionInfo
  /** Resolved by `releaseClose`; lets a test hold `close()` open. */
  closeGate?: Promise<void>
  /** Runs immediately before the ready frame, while App.info is still absent. */
  beforeReady?: () => void
  private releaseClose?: () => void
  closed = 0

  constructor(cwd: string) {
    this.info = {
      sessionId: 'lifecycle-session', attachmentId: 'lifecycle-attachment', cwd,
      provider: 'fixture-provider', model: 'fixture-model', preset: 'standard',
      capabilities: ['commands', 'state'],
    }
  }

  holdClose(): void {
    this.closeGate = new Promise(resolve => { this.releaseClose = resolve })
  }

  finishClose(): void { this.releaseClose?.() }

  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.beforeReady?.(); this.emit({ type: 'ready', info: this.info }); return this.info }
  async send() {}
  async respond() { throw new Error('the lifecycle fixture never answers decisions') }
  async cancel() {}
  async close() { this.closed += 1; await this.closeGate }
  async command(name: string, _args: JsonRecord = {}): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'state') return { pending: { nextTurn: 0, nextStep: 0 }, queued: 0 }
    throw new Error('unexpected command ' + name)
  }
}

interface AppInternals {
  render(): void
}

async function paint(terminal: VirtualTerminal): Promise<void> {
  await delay(40)
  await terminal.flush()
}

async function fixture(options: { installCrashHandlers?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-app-lifecycle-'))
  const backend = new LifecycleBackend(directory)
  const terminal = new VirtualTerminal(100, 30)
  const app = new App({
    backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen',
    registerSignals: false, allowSuspend: true,
    ...(options.installCrashHandlers === undefined ? {} : { installCrashHandlers: options.installCrashHandlers }),
  })
  const close = async () => {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
  return { app, backend, terminal, directory, close }
}

test('crash handlers cover exactly the lifetime during which the App owns the terminal', async () => {
  const baseline = {
    exception: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
  }
  const off = await fixture({ installCrashHandlers: false })
  try {
    await off.app.start()
    assert.equal(process.listenerCount('uncaughtException'), baseline.exception,
      'a test-owned App that does not own process signals installs no crash handler')
  } finally { await off.close() }

  const on = await fixture({ installCrashHandlers: true })
  try {
    await on.app.start()
    assert.equal(process.listenerCount('uncaughtException'), baseline.exception + 1)
    assert.equal(process.listenerCount('unhandledRejection'), baseline.rejection + 1)
    await on.app.shutdown()
    assert.equal(process.listenerCount('uncaughtException'), baseline.exception,
      'shutdown removes the crash handler so a later App never inherits it')
    assert.equal(process.listenerCount('unhandledRejection'), baseline.rejection)
  } finally { on.terminal.dispose(); await rm(on.directory, { recursive: true, force: true }) }
})

test('one backend event paints one frame', async () => {
  const { app, backend, terminal, close } = await fixture({})
  try {
    await app.start()
    const internals = app as unknown as AppInternals
    const original = internals.render.bind(app)
    let frames = 0
    internals.render = () => { frames += 1; original() }

    // `stream_start` mutates the store (which notifies) and also renders from
    // the event tail. A second paint here is the duplicate this guards.
    backend.emit({
      type: 'stream_start', sessionId: backend.info.sessionId,
      attemptId: 'attempt-1', revision: 1, turn: 1, step: 1,
    })
    await paint(terminal)
    assert.equal(frames, 1, 'stream_start paints once')
  } finally { await close() }
})

test('an escaping error is painted, then hands the terminal back', async () => {
  const { app, terminal, close } = await fixture({ installCrashHandlers: true })
  try {
    await app.start()
    ;(app as unknown as { handleFatal(label: string, value: unknown): void })
      .handleFatal('Fatal error', new Error('renderer exploded: Authorization: Bearer sk-live-abcdef123456'))
    await until(() => terminal.screen().includes('Fatal error'), 'the fatal reason renders')
    assert.ok(terminal.screen().includes('[redacted]'), 'the reason is redacted before it reaches the screen')
    assert.ok(!terminal.screen().includes('sk-live-abcdef123456'))
    assert.equal(await app.exited, 1, 'an escaping error exits non-zero')
  } finally { await close() }
})

test('a repeated interrupt stops waiting for the bounded drain, keeping the first code', async () => {
  const { app, backend, close } = await fixture({})
  try {
    await app.start()
    backend.holdClose()
    const first = app.shutdown(130)
    // The first request is now parked inside the backend's bounded close.
    await delay(20)
    let escalated = false
    const second = app.interruptShutdown(0)
    void app.exited.then(() => { escalated = true })
    await delay(10)
    assert.equal(escalated, true, 'the owner-visible exit settles on the repeated interrupt')
    assert.equal(await app.exited, 130, 'the first requested code wins')
    void second
    backend.finishClose()
    await first
  } finally { await close() }
})

test('a suspend whose SIGTSTP is ignored rolls the UI back instead of pausing forever', async () => {
  const { app, backend, terminal, close } = await fixture({})
  const realKill = process.kill
  try {
    await app.start()
    // Simulate an environment where SIGTSTP is ignored: the signal is accepted
    // but the process is never stopped, so no SIGCONT can ever arrive.
    process.kill = (() => true) as typeof process.kill
    terminal.type('\x1a') // Ctrl+Z (app.suspend)
    await until(() => terminal.screen().includes('Suspend is unavailable'), 'the rollback message renders')
    // The renderer AND stdin must be live again: both are removed by the pause
    // and only the rollback puts them back.
    terminal.type('still here')
    await paint(terminal)
    assert.ok(terminal.screen().includes('still here'), 'input reaches the one editor after a rolled-back suspend')
  } finally {
    process.kill = realKill
    await close()
  }
})

test('a decision emitted before the first ready is buffered, not dropped', async () => {
  const { app, backend, terminal, close } = await fixture({})
  try {
    const request: DecisionRequest = {
      id: 'pre-ready-decision',
      kind: 'approval',
      title: 'Early approval',
      options: [
        { label: 'Allow once', value: 'allowed-once' },
        { label: 'Reject', value: 'rejected' },
      ],
    }
    backend.beforeReady = () => backend.emit({
      type: 'decision',
      sessionId: backend.info.sessionId,
      request,
    })
    await app.start()
    await paint(terminal)
    assert.match(terminal.screen(), /Early approval/, 'the pre-ready native decision reaches the UI')
  } finally { await close() }
})

test('connected keybinding reloads do not duplicate an unchanged diagnostic', async () => {
  const { app, terminal, directory, close } = await fixture({})
  try {
    await writeFile(join(directory, 'keybindings.json'), JSON.stringify({ 'list.next': 'not-a-key' }))
    await app.start()
    await paint(terminal)
    const internals = app as unknown as { reloadKeys(): boolean }
    internals.reloadKeys()
    internals.reloadKeys()
    await paint(terminal)
    assert.equal(terminal.screen().match(/Keybinding:/g)?.length ?? 0, 1,
      'an unchanged keybinding document is not re-reported on every reload')
  } finally { await close() }
})

test('startup keybinding diagnostics are replayed once, not duplicated', async () => {
  const { app, terminal, directory, close } = await fixture({})
  try {
    await writeFile(join(directory, 'keybindings.json'), JSON.stringify({ 'list.next': 'not-a-key' }))
    await app.start()
    await paint(terminal)
    const occurrences = terminal.screen().match(/Keybinding:/g)?.length ?? 0
    assert.equal(occurrences, 1, 'one invalid binding produces one visible diagnostic')
  } finally { await close() }
})

test('a malformed keybinding document is reported once across repeated reloads', async () => {
  const { app, terminal, directory, close } = await fixture({})
  try {
    const file = join(directory, 'keybindings.json')
    const internals = app as unknown as { reloadKeys(): boolean }
    await writeFile(file, '{ INVALID JSON')
    await app.start()
    await paint(terminal)
    assert.equal(terminal.screen().match(/Keybindings not applied/g)?.length ?? 0, 1, 'the broken document is reported once at startup')
    // Every watcher tick over the same broken bytes parses the same error; the
    // error text is part of the dedupe signature, so nothing is re-reported.
    internals.reloadKeys()
    internals.reloadKeys()
    await paint(terminal)
    assert.equal(terminal.screen().match(/Keybindings not applied/g)?.length ?? 0, 1, 'repeated reloads of one broken file stay quiet')
    // A repaired document applies, and a later break is a new state that is
    // worth reporting again.
    await writeFile(file, JSON.stringify({ 'app.model.select': 'ctrl+x ctrl+m' }))
    internals.reloadKeys()
    assert.deepEqual(app.keymap.getBindings('app.model.select'), ['ctrl+x ctrl+m'])
    await writeFile(file, 'not json at all')
    internals.reloadKeys()
    await paint(terminal)
    assert.equal(terminal.screen().match(/Keybindings not applied/g)?.length ?? 0, 2, 'a newly broken file is reported again')
  } finally { await close() }
})

test('pre-ready projections cannot overwrite the ready snapshot', async () => {
  const { app, backend, terminal, close } = await fixture({})
  try {
    backend.info.permissions = { currentValue: 'workspace-write' }
    backend.beforeReady = () => {
      const sessionId = backend.info.sessionId
      // Last-writer-wins facts the ready payload already answers newer.
      backend.emit({ type: 'permissions', sessionId, value: { currentValue: 'stale-permission' } })
      backend.emit({ type: 'model_route', sessionId, provider: 'stale-provider', model: 'stale-model' })
      backend.emit({ type: 'title', sessionId, value: 'stale title' })
      // Snapshot-only projections: the newest frame is the fact to keep.
      backend.emit({ type: 'todos', sessionId, value: [{ content: 'stale todo', status: 'pending' }] })
      backend.emit({ type: 'todos', sessionId, value: [{ content: 'newest todo', status: 'in_progress' }] })
      backend.emit({ type: 'plan', sessionId, value: { active: true } })
      backend.emit({ type: 'models_changed', sessionId })
    }
    await app.start()
    await paint(terminal)
    assert.equal(app.session?.permissions?.currentValue, 'workspace-write', 'the ready permission wins over a buffered one')
    assert.equal(app.session?.model, 'fixture-model', 'the ready route wins over a buffered route')
    assert.equal(app.session?.provider, 'fixture-provider')
    assert.notEqual(app.session?.title, 'stale title', 'the ready title is not replaced by a buffered copy')
    assert.doesNotMatch(terminal.screen(), /stale permission|stale-model|stale-provider|stale todo|stale title/)
    assert.match(terminal.screen(), /newest todo/, 'the newest snapshot-only projection still replays')
    assert.match(terminal.screen(), /Plan mode is active\./, 'a resumed plan state is still announced')
  } finally { await close() }
})

test('a pre-ready decision survives a full buffer and the overflow is reported once', async () => {
  const { app, backend, terminal, close } = await fixture({})
  try {
    const request: DecisionRequest = {
      id: 'priority-decision',
      kind: 'approval',
      title: 'Buffered approval',
      options: [
        { label: 'Allow once', value: 'allowed-once' },
        { label: 'Reject', value: 'rejected' },
      ],
    }
    backend.beforeReady = () => {
      const sessionId = backend.info.sessionId
      for (let index = 0; index < 512; index++) backend.emit({ type: 'status', sessionId, status: 'idle' })
      // A decision outranks the oldest buffered non-decision frame.
      backend.emit({ type: 'decision', sessionId, request })
      // The buffer is full again; these non-decision frames are dropped.
      backend.emit({ type: 'status', sessionId, status: 'running' })
      backend.emit({ type: 'status', sessionId, status: 'idle' })
    }
    await app.start()
    await paint(terminal)
    assert.match(terminal.screen(), /Buffered approval/, 'the decision is never the frame the bound discards')
    const drops = app.store.items.filter((item): item is Extract<TranscriptItem, { kind: 'notice' }> =>
      item.kind === 'notice' && item.text.startsWith('Dropped '))
    assert.equal(drops.length, 1, 'one overflow summary per start, not one notice per dropped frame')
    assert.match(drops[0]!.text, /^Dropped 2 startup events/)
    assert.equal(app.isBusy, false, 'a dropped status frame never becomes the live busy state')
  } finally { await close() }
})
