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
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

/** Minimal native-shaped backend: only the event plane this suite drives. */
class LifecycleBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly info: SessionInfo
  /** Resolved by `releaseClose`; lets a test hold `close()` open. */
  closeGate?: Promise<void>
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
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
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