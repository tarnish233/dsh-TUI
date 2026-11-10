// Must stay FIRST: forces truecolor before src modules snapshot terminal mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import test from 'node:test'
import { foregroundAnsi, getTerminalColorMode, parseColor } from '#pi-tui'
// Importing the theme is the startup path every UI surface takes: it must not
// pull highlight.js into the process.
import '../src/ui/theme.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import type { DecisionRequest, SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import {
  clearHighlightCache,
  ensureHighlightRuntime,
  highlightCacheSize,
  highlightCode,
  highlightGeneration,
  highlightRuntimeImportCount,
  highlightRuntimeState,
  highlightRuntimeSubscriberCount,
  isHighlightRuntimeReady,
  resetHighlightRuntimeForTests,
  setHighlightRuntimeLoaderForTests,
  subscribeHighlightRuntime,
  whenHighlightRuntimeReady,
} from '../src/ui/highlight.ts'
import { plainHighlightLines } from '../src/ui/highlight-palette.ts'
import type { HighlightRuntime } from '../src/ui/highlight.ts'
import { ImageContentBody } from '../src/ui/image-content.ts'
import { TranscriptView } from '../src/ui/transcript.ts'

const require = createRequire(import.meta.url)

/** The real grammar module, loaded on demand by the probe loaders below. */
async function loadRealRuntime(): Promise<HighlightRuntime> {
  return (await import('../src/ui/highlight-runtime.ts')).highlightRuntime
}

/** One loader that counts its invocations and then loads the real grammars. */
function countingLoader(): { loader: () => Promise<HighlightRuntime>; calls: () => number } {
  let calls = 0
  return {
    loader: async () => {
      calls += 1
      return loadRealRuntime()
    },
    calls: () => calls,
  }
}

const FENCED = 'Here is the fix:\n\n```ts\nconst value: number = 1\nexport default value\n```\n'

const info = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: 's1',
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: [],
  events,
})

const assistantEvent = (seq: number, text: string): SessionEvent => ({
  type: 'assistant/message',
  seq,
  time: 0,
  data: {
    turn: 1,
    step: 1,
    message: {
      id: `a${seq}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'demo', model: 'demo' },
    },
    stream: [],
  },
  surfaceOp: 'append',
})

const view = (store: TranscriptStore, onRenderRequest?: () => void): TranscriptView =>
  new TranscriptView(store, {
    showThinking: false,
    expandTools: false,
    groupTools: true,
    hints: {},
    screen: 'fullscreen',
    ...(onRenderRequest === undefined ? {} : { onRenderRequest }),
  })

// ---------------------------------------------------------------------------
// Startup: no highlight.js in the process

test('importing the theme does not import highlight.js', () => {
  // `highlight.js/lib/core` is CommonJS: if anything on the startup path had
  // loaded it, Node's own require cache would hold it. This is a process-level
  // proof, not a source-code guess.
  assert.equal(
    require.cache[require.resolve('highlight.js/lib/core')],
    undefined,
    'the grammar core must not be loaded by the startup module graph',
  )
  assert.equal(highlightRuntimeState(), 'idle')
  assert.equal(isHighlightRuntimeReady(), false)
  assert.equal(highlightRuntimeImportCount(), 0)
  assert.equal(highlightGeneration(), 0)
})

// ---------------------------------------------------------------------------
// Fallback + single flight

test('the pre-ready fallback is byte-identical plain text and starts exactly one load', async () => {
  resetHighlightRuntimeForTests()
  const counting = countingLoader()
  setHighlightRuntimeLoaderForTests(counting.loader)
  const code = 'const value: number = 1'

  const first = highlightCode(code, 'ts')
  assert.deepEqual(first, plainHighlightLines(code), 'the fallback is the shared plain rendering')
  assert.equal(highlightRuntimeState(), 'loading')
  // Three more synchronous calls: still one import, still the same fallback,
  // and nothing is cached (a cached plain row would survive the load).
  for (let index = 0; index < 3; index += 1) assert.deepEqual(highlightCode(code, 'ts'), plainHighlightLines(code))
  assert.equal(counting.calls(), 1)
  assert.equal(highlightRuntimeImportCount(), 1)
  assert.equal(highlightCacheSize(), 0, 'the fallback is never cached')

  await whenHighlightRuntimeReady()
  assert.equal(highlightRuntimeState(), 'ready')
  assert.equal(highlightGeneration(), 1)

  // After readiness the same input paints real syntax colors and is cached.
  const highlighted = highlightCode(code, 'ts')
  assert.notDeepEqual(highlighted, first, 'the ready paint differs from the fallback')
  assert.match(highlighted.join(''), /\x1b\[38;2;\d+;\d+;\d+m/)
  const real = (await loadRealRuntime()).highlight(code, 'ts')
  assert.deepEqual(highlighted, real, 'the facade returns exactly the runtime rows')
  assert.equal(highlightCacheSize(), 1)
  assert.equal(highlightCode(code, 'ts'), highlighted, 'a cache hit returns the identical array')
})

test('concurrent loads join one import and resolve once', async () => {
  resetHighlightRuntimeForTests()
  let release: (runtime: HighlightRuntime) => void = () => {}
  const gate = new Promise<HighlightRuntime>(resolve => { release = resolve })
  let calls = 0
  setHighlightRuntimeLoaderForTests(async () => { calls += 1; return gate })

  const a = ensureHighlightRuntime()
  const b = whenHighlightRuntimeReady()
  const c = ensureHighlightRuntime()
  assert.equal(a, b, 'every caller awaits the same attempt')
  assert.equal(b, c)
  assert.equal(calls, 1)
  assert.equal(highlightRuntimeImportCount(), 1)
  release(await loadRealRuntime())
  await Promise.all([a, b, c])
  assert.equal(highlightRuntimeState(), 'ready')
  assert.equal(highlightGeneration(), 1)
  // A settled attempt is not repeated.
  await ensureHighlightRuntime()
  assert.equal(calls, 1)
})

test('a failed load is explicit, silent and permanent', async () => {
  resetHighlightRuntimeForTests()
  let calls = 0
  setHighlightRuntimeLoaderForTests(async () => { calls += 1; throw new Error('no grammar tables') })
  const events: string[] = []
  subscribeHighlightRuntime(event => { events.push(`${event.state}:${event.generation}`) })

  await assert.doesNotReject(whenHighlightRuntimeReady(), 'a missing grammar never throws at a frame')
  assert.equal(highlightRuntimeState(), 'failed')
  assert.equal(isHighlightRuntimeReady(), false)
  assert.equal(highlightGeneration(), 0)
  assert.deepEqual(events, ['failed:0'])

  // No retry storm: the state is terminal until a reset.
  assert.deepEqual(highlightCode('const value = 1', 'ts'), plainHighlightLines('const value = 1'))
  await ensureHighlightRuntime()
  assert.equal(calls, 1)
  assert.equal(highlightCacheSize(), 0)
})

test('subscribers are isolated, notified once and disposable', async () => {
  resetHighlightRuntimeForTests()
  const seen: Array<{ state: string; generation: number }> = []
  let disposedCalls = 0
  const dispose = subscribeHighlightRuntime(event => { seen.push({ ...event }) })
  const disposeBroken = subscribeHighlightRuntime(() => { throw new Error('subscriber bug') })
  const disposeLate = subscribeHighlightRuntime(() => { disposedCalls += 1 })
  disposeLate()

  setHighlightRuntimeLoaderForTests(loadRealRuntime)
  await whenHighlightRuntimeReady()
  assert.deepEqual(seen, [{ state: 'ready', generation: 1 }])
  assert.equal(disposedCalls, 0, 'a disposed subscription is not called')

  // The throwing subscriber did not break the load or the others.
  assert.equal(highlightRuntimeState(), 'ready')
  dispose()
  disposeBroken()

  // A second successful load after a reset notifies only live subscribers.
  resetHighlightRuntimeForTests()
  const after: string[] = []
  subscribeHighlightRuntime(event => { after.push(event.state) })
  setHighlightRuntimeLoaderForTests(loadRealRuntime)
  await whenHighlightRuntimeReady()
  assert.deepEqual(after, ['ready'])
  assert.deepEqual(seen, [{ state: 'ready', generation: 1 }], 'the disposed listener stays silent')
})

// ---------------------------------------------------------------------------
// Invalidation: a Markdown instance cache is not a block cache

test('a Markdown body drops its own line cache so no plain row survives readiness', async () => {
  resetHighlightRuntimeForTests()
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  setHighlightRuntimeLoaderForTests(async () => { await gate; return loadRealRuntime() })

  const body = new ImageContentBody('markdown')
  const item = {
    kind: 'assistant' as const,
    id: 'assistant:1',
    text: FENCED,
    thinking: '',
    interrupted: false,
    version: 1,
  }
  body.setItem(item)
  const before = body.render(60, { interactive: false }).lines
  // The fallback still paints the default code color (that is the plain look),
  // so "no syntax colors" means one color per row, not zero escapes.
  const colorRuns = (row: string): number => (row.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []).length
  assert.ok(before.every(row => colorRuns(row) <= 1), 'pre-ready rows are single-color plain code')
  // The body's own renderer would otherwise return these rows again: the exact
  // same call is a cache hit before invalidation.
  assert.deepEqual(body.render(60, { interactive: false }).lines, before)

  release()
  await whenHighlightRuntimeReady()
  assert.equal(highlightRuntimeState(), 'ready')

  // Without the invalidation edge the Markdown instance would keep painting the
  // plain rows; with it, the same text repaints with real colors.
  body.invalidate()
  const after = body.render(60, { interactive: false }).lines
  assert.notDeepEqual(after, before, 'the grammar edge repaints the same body')
  assert.ok(after.some(row => colorRuns(row) > 1), 'syntax colors appear after readiness')
  assert.equal(after.length, before.length, 'row count is unchanged: only colors differ')
})

test('the transcript view invalidates on readiness and never repaints after dispose', async () => {
  resetHighlightRuntimeForTests()
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  setHighlightRuntimeLoaderForTests(async () => { await gate; return loadRealRuntime() })

  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([assistantEvent(1, FENCED)]))
  let repaints = 0
  const view1 = view(store, () => { repaints += 1 })
  const before = view1.render(60)
  const colorRuns = (row: string): number => (row.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []).length
  assert.ok(before.length > 0, 'the assistant body painted')
  assert.ok(before.every(row => colorRuns(row) <= 1), 'the first paint is the single-color fallback')

  release()
  await whenHighlightRuntimeReady()
  assert.equal(repaints, 1, 'the ready edge asks for exactly one repaint')
  const after = view1.render(60)
  assert.notDeepEqual(after, before, 'the transcript repaints with syntax colors')
  assert.ok(after.some(row => colorRuns(row) > 1), 'at least one row carries several syntax colors')
  assert.equal(after.length, before.length, 'only colors change, never the row count')

  const subscribersBeforeDispose = highlightRuntimeSubscriberCount()
  assert.ok(subscribersBeforeDispose >= 1, 'the live view holds one subscription')
  view1.dispose()
  assert.equal(
    highlightRuntimeSubscriberCount(),
    subscribersBeforeDispose - 1,
    'dispose releases the view subscription itself',
  )
  // A later load cannot reach a disposed view: its subscription is gone.
  resetHighlightRuntimeForTests()
  setHighlightRuntimeLoaderForTests(loadRealRuntime)
  const repaintsBefore = repaints
  await whenHighlightRuntimeReady()
  assert.equal(repaints, repaintsBefore, 'a disposed transcript never repaints')
})

test('the cache is not polluted by a failed or pending load', async () => {
  resetHighlightRuntimeForTests()
  setHighlightRuntimeLoaderForTests(async () => loadRealRuntime())
  clearHighlightCache()
  assert.equal(highlightCacheSize(), 0)
  highlightCode('const pending = 1', 'ts')
  assert.equal(highlightCacheSize(), 0, 'a fallback row is not an entry')
  await whenHighlightRuntimeReady()
  highlightCode('const pending = 1', 'ts')
  assert.equal(highlightCacheSize(), 1, 'only the real grammar result is cached')
  resetHighlightRuntimeForTests()
  assert.equal(highlightCacheSize(), 0, 'a reset drops the LRU with the runtime')
})

// ---------------------------------------------------------------------------
// A second direct Markdown owner: the decision/question detail body

test('a question detail drops its own Markdown cache on readiness, and never after dispose', async () => {
  resetHighlightRuntimeForTests()
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  setHighlightRuntimeLoaderForTests(async () => { await gate; return loadRealRuntime() })

  // The dialog uses the real input owner's CcEditor, so the vendored seam must
  // be installed before the module is imported.
  const input = await loadInputModule()
  const { DecisionDialog } = await import('../src/ui/dialogs.ts')
  const tui = createFakeTui(30, 80)
  const request: DecisionRequest = {
    id: 'q1',
    kind: 'question',
    title: 'Plan review',
    questions: [{
      question: 'Apply this plan?',
      header: 'Plan',
      detail: 'Plan body:\n\n```ts\nconst planStep: number = 1\nexport default planStep\n```\n',
      options: [{ label: 'Apply' }, { label: 'Reject' }],
    }],
  }
  let cancelled = 0
  const dialog = new DecisionDialog(asTui(tui), {
    request,
    keymap: input.createCcKeymap(),
    onSubmit: () => {},
    onCancel: () => { cancelled += 1 },
  })
  dialog.focused = true

  const colorRuns = (row: string): number => (row.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []).length
  // The content palette's keyword swatch (#ff7b72) only exists when the grammar
  // actually ran: the plain fallback paints one default color for the whole row.
  const keyword = foregroundAnsi(parseColor('#ff7b72'), getTerminalColorMode())
  const strip = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, '')
  /** The painted fenced-code row, matched on its plain text and returned raw. */
  const codeRow = (frame: readonly string[]): string => {
    const index = frame.findIndex(row => strip(row).includes('const planStep'))
    return index < 0 ? '' : frame[index]!
  }
  const before = dialog.render(70)
  assert.ok(before.length > 0, 'the question surface painted')
  assert.ok(strip(codeRow(before)).includes('const planStep'), 'the fenced detail row is painted')
  assert.ok(!codeRow(before).includes(keyword), 'no syntax keyword color before readiness')
  const beforeRuns = colorRuns(codeRow(before))
  // The detail renderer would keep returning these exact rows: this is the cache
  // the transcript's ready edge cannot reach.
  assert.deepEqual(dialog.render(70), before, 'the pre-ready detail is a cache hit')
  assert.equal(tui.renderRequests, 0, 'no repaint was requested before readiness')

  const requestsBefore = tui.renderRequests
  release()
  await whenHighlightRuntimeReady()
  assert.equal(highlightRuntimeState(), 'ready')
  assert.equal(tui.renderRequests, requestsBefore + 1, 'the ready edge asks for exactly one repaint')

  const after = dialog.render(70)
  assert.notDeepEqual(after, before, 'the same detail repaints with syntax colors')
  assert.ok(codeRow(after).includes(keyword), 'the code row carries the real keyword color')
  assert.ok(colorRuns(codeRow(after)) > beforeRuns, 'the row is split into more syntax colors')
  assert.equal(after.length, before.length, 'only colors change, never the row count')
  // Exactly the detail renderer was dropped: the painted plain text is identical.
  assert.deepEqual(after.map(strip), before.map(strip), 'the painted text is identical')

  // Decision input semantics are untouched by the repaint edge: Esc still
  // dismisses the question surface through the real keymap.
  dialog.handleInput('\x1b')
  assert.equal(dialog.dismissed, true, 'Esc still dismisses the question')
  assert.equal(cancelled, 1, 'the dismissal still reaches the parent hook')
  const subscribersBeforeDispose = highlightRuntimeSubscriberCount()
  assert.ok(subscribersBeforeDispose >= 1, 'the live dialog holds one subscription')
  dialog.dispose()
  assert.equal(dialog.isDisposed, true)
  assert.equal(
    highlightRuntimeSubscriberCount(),
    subscribersBeforeDispose - 1,
    'dispose releases the dialog subscription itself',
  )

  // Disposal: a later readiness (e.g. a reloaded module) neither invalidates nor
  // paints, and dispose stays idempotent.
  resetHighlightRuntimeForTests()
  setHighlightRuntimeLoaderForTests(loadRealRuntime)
  const requestsAtDispose = tui.renderRequests
  await whenHighlightRuntimeReady()
  assert.equal(tui.renderRequests, requestsAtDispose, 'a disposed decision dialog never repaints')
  dialog.dispose()
  assert.equal(dialog.isDisposed, true, 'dispose is idempotent')
  assert.equal(tui.renderRequests, requestsAtDispose)
})