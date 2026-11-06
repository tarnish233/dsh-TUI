import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo, StatsSnapshot, UsageSnapshot } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

/**
 * Parent-owned acceptance for the bridge's `metrics` projection frames.
 *
 * DSH pushes `{type:'metrics', sessionId, usage?, stats?}` per step / durable
 * event (and a baseline after attach). They are the live source of the footer
 * chips; the `state` command stays the baseline/fallback. The fixture only
 * replays what the bridge reports: no model calls, no local rate estimate.
 */
class MetricsBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  /** Native `state` facts. Kept absent in the live-frame tests on purpose. */
  usage: JsonRecord | undefined
  stats: JsonRecord | undefined
  /** Every `state` pull, so a test can prove chips did not come from one. */
  readonly stateCalls: number[] = []
  info: SessionInfo
  constructor(cwd: string) {
    this.info = {
      sessionId: 'metrics-session', attachmentId: 'metrics-attachment', cwd,
      provider: 'fixture-provider', model: 'fixture-model', preset: 'standard',
      capabilities: ['commands', 'state'],
    }
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send() {}
  async respond() { throw new Error('metrics test never answers decisions') }
  async close() {}
  async cancel() {}
  async command(name: string, _args: JsonRecord = {}): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'state') {
      this.stateCalls.push(Date.now())
      return {
        pending: { nextTurn: 0, nextStep: 0 }, queued: 0,
        ...(this.usage === undefined ? {} : { usage: this.usage }),
        ...(this.stats === undefined ? {} : { stats: this.stats }),
      }
    }
    throw new Error('Unexpected control from the metrics test: ' + name)
  }
  /** One bridge projection frame; an omitted field means "projection unavailable". */
  metrics(usage: UsageSnapshot | undefined, stats: StatsSnapshot | undefined, sessionId = this.info.sessionId): void {
    this.emit({
      type: 'metrics',
      sessionId,
      ...(usage === undefined ? {} : { usage }),
      ...(stats === undefined ? {} : { stats }),
    })
  }
  /** DSH replaced the attachment (resume/new/pending materialization). */
  replace(info: SessionInfo): void {
    this.info = info
    this.emit({ type: 'ready', info })
  }
}

const WIDE = 200
async function paint(terminal: VirtualTerminal) { await delay(60); await terminal.flush() }

async function fixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), name))
  const backend = new MetricsBackend(directory)
  const terminal = new VirtualTerminal(WIDE, 32)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', registerSignals: false })
  return { directory, backend, terminal, app }
}

test('parent metrics: projection frames update the footer chips without a state pull', async () => {
  const { directory, backend, terminal, app } = await fixture('dsh-parent-metrics-live-')
  try {
    await app.start()
    await until(() => terminal.screen().includes('fixture-provider/fixture-model'), 'the footer paints the model')
    await paint(terminal)
    const pullsBefore = backend.stateCalls.length

    backend.metrics(
      { used: 250_000, size: 1_000_000, cachePct: 42, totalTokens: 12_000 },
      { turns: 2, steps: 4, decodeMs: 10_000, decodeTokens: 200, ttftMs: 1_500, ttftSteps: 1 },
    )
    await until(() => {
      const screen = terminal.screen()
      return screen.includes('25%/1.0M') && screen.includes('2 turns 4 steps')
    }, 'the frame feeds the context bar and the turn/step chip')
    const screen = terminal.screen()
    // The whole chip row comes from this one frame, in the unchanged order.
    assert.match(screen, /███░░░░░░░ 25%\/1\.0M · 12k tok · 󰆼 42% · 2 turns 4 steps · 20 tok\/s · TTFT: 1\.5s/)
    assert.equal(backend.stateCalls.length, pullsBefore, 'no `state` pull was needed to refresh the chips')

    // A second frame inside the same turn keeps the footer live.
    backend.metrics(
      { used: 250_000, size: 1_000_000, cachePct: 42, totalTokens: 12_000 },
      { turns: 2, steps: 5, decodeMs: 10_000, decodeTokens: 260, ttftMs: 1_500, ttftSteps: 1 },
    )
    await until(() => terminal.screen().includes('2 turns 5 steps'), 'the next frame lands')
    assert.match(terminal.screen(), /2 turns 5 steps · 26 tok\/s/, 'the rate chip follows the newest fold')
    assert.equal(backend.stateCalls.length, pullsBefore, 'the second frame also needs no `state` pull')
  } finally {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('parent metrics: a stats-only frame repaints and absent fields keep the current chips', async () => {
  const { directory, backend, terminal, app } = await fixture('dsh-parent-metrics-stats-')
  try {
    await app.start()
    backend.metrics({ used: 370_000, size: 1_000_000, cachePct: 99, totalTokens: 1_200_000 }, undefined)
    await until(() => terminal.screen().includes('37%/1.0M'), 'the usage frame lands')

    // Nothing but the sessionStats fold changes: it must still reach the screen.
    backend.metrics(undefined, { turns: 5, steps: 9, decodeMs: 100_000, decodeTokens: 1_400, ttftMs: 9_400, ttftSteps: 2 })
    await until(() => terminal.screen().includes('5 turns 9 steps'), 'a stats-only frame repaints the footer')
    assert.match(terminal.screen(), /37%\/1\.0M · 1\.2M tok · 󰆼 99% · 5 turns 9 steps · 14 tok\/s · TTFT: 4\.7s/,
      'the absent usage field keeps the usage chips and the changed fold lands beside them')

    // A frame whose fields are all absent is a no-op: the chips stay.
    backend.metrics(undefined, undefined)
    await paint(terminal)
    assert.match(terminal.screen(), /37%\/1\.0M · 1\.2M tok · 󰆼 99% · 5 turns 9 steps/, 'an empty frame never clears the chips')
  } finally {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('parent metrics: a `state` baseline that only changes stats also repaints the footer', async () => {
  const { directory, backend, terminal, app } = await fixture('dsh-parent-metrics-baseline-')
  backend.usage = { used: 370_000, size: 1_000_000, cachePct: 99, totalTokens: 1_200_000 }
  backend.stats = { turns: 3, steps: 5 }
  try {
    await app.start()
    await until(() => terminal.screen().includes('3 turns 5 steps'), 'the baseline state pull paints the chips')

    // Only the sessionStats fold differs in the next `state` response. The
    // status frame's own repaint happens before the async pull resolves, so
    // the chips land only if applyStats repaints on a value change.
    backend.stats = { turns: 4, steps: 6 }
    backend.emit({ type: 'status', sessionId: backend.info.sessionId, status: 'idle' })
    await until(() => terminal.screen().includes('4 turns 6 steps'), 'the changed fold repaints after the pull')
    assert.match(terminal.screen(), /37%\/1\.0M · 1\.2M tok · 󰆼 99% · 4 turns 6 steps/, 'the unchanged usage chips stay put')
  } finally {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('parent metrics: replacing the session drops the previous chips and ignores its late frames', async () => {
  const { directory, backend, terminal, app } = await fixture('dsh-parent-metrics-replace-')
  backend.usage = { used: 370_000, size: 1_000_000, cachePct: 99, totalTokens: 1_200_000 }
  backend.stats = { turns: 3, steps: 5, decodeMs: 100_000, decodeTokens: 1_400, ttftMs: 9_400, ttftSteps: 2 }
  try {
    await app.start()
    await until(() => terminal.screen().includes('3 turns 5 steps'), 'the first session shows its chips')

    // The resumed/pending session reports no projections: the chips must go.
    const previousSession = backend.info.sessionId
    backend.usage = undefined
    backend.stats = undefined
    backend.replace({
      ...backend.info, sessionId: 'resumed-session', attachmentId: 'resumed-attachment', events: [],
    })
    await until(() => {
      const screen = terminal.screen()
      return !screen.includes('turns') && !screen.includes('37%') && !screen.includes('tok/s')
    }, 'stale usage/stats chips are cleared on the new session')
    assert.match(terminal.screen(), /fixture-provider\/fixture-model · ready · standard/, 'the new session footer is intact')

    // A late frame of the replaced session is filtered out by sessionId.
    backend.metrics(
      { used: 900_000, size: 1_000_000, cachePct: 11, totalTokens: 999_000 },
      { turns: 99, steps: 99, decodeMs: 1_000, decodeTokens: 1_000 },
      previousSession,
    )
    await paint(terminal)
    assert.doesNotMatch(terminal.screen(), /90%|99 turns|999 tok/, 'the replaced session never repaints the footer')

    // The current session's own frames still apply.
    backend.metrics({ used: 100_000, size: 1_000_000 }, { turns: 1, steps: 1 })
    await until(() => terminal.screen().includes('10%/1.0M'), 'the new session frame lands')
    assert.match(terminal.screen(), /10%\/1\.0M · 1 turns 1 steps/, 'the new session owns the chips')
  } finally {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('parent metrics: the transcript store consumes frames of any session as a silent no-op', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  const info: SessionInfo = {
    sessionId: 'metrics-store-session', cwd: '/tmp/metrics-store', provider: 'fixture-provider',
    model: 'fixture-model', capabilities: ['state'],
  }
  store.reset(info)
  assert.equal(store.items.length, 0)
  // The app calls store.handle() before its own sessionId filter, so even a
  // foreign session's frame must be swallowed here.
  store.handle({ type: 'metrics', sessionId: info.sessionId, usage: { used: 1, size: 2 }, stats: { turns: 1 } })
  store.handle({ type: 'metrics', sessionId: 'other-session', usage: { used: 3, size: 4 }, stats: { turns: 2 } })
  assert.equal(store.items.length, 0, 'metrics never becomes a transcript entry')
  assert.equal(store.status, 'idle', 'metrics never changes the transcript status')
})