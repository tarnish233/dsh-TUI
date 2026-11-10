// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type {
  InspectedJob,
  JobOutputSnapshot,
  JobsRead,
} from '../src/backend/native-inspection.ts'
import { asTui, createFakeTui } from '../src/input/testing/harness.ts'
import { createCcKeymap } from '../src/input/keymap.ts'
import {
  formatJobDuration,
  jobIsLive,
  jobOutputLines,
  jobStatusGlyph,
  jobStatusText,
  JobsDialog,
} from '../src/ui/jobs-dialog.ts'

/**
 * Native jobs inspector: presentation-only projection of the backend
 * `JobsRead`/`JobOutputSnapshot` DTOs. No DSH runtime, no model, no timer, no
 * stdout, no job mutation.
 */

const DOWN = '\x0e'
const UP = '\x10'
const ENTER = '\r'
const ESC = '\x1b'
const HOME = '\x1b[H'
const END = '\x1b[F'
const PAGE_DOWN = '\x1b[6~'
const CTRL_C = '\x03'

const SESSION = 'session-1'

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

function job(id: string, over: Partial<InspectedJob> = {}): InspectedJob {
  return {
    id,
    kind: 'bash',
    label: id,
    status: 'running',
    owned: true,
    startedAt: 1_000,
    output: { total: 0, earliest: 0, evicted: false },
    ...over,
  }
}

function snapshot(jobs: readonly InspectedJob[], over: Partial<JobsRead & { readonly available: true }> = {}): JobsRead {
  return { available: true, complete: true, sessionId: SESSION, jobs, ...over }
}

function outputPage(id: string, chunks: JobOutputSnapshot['chunks'], over: Partial<JobOutputSnapshot> = {}): JobOutputSnapshot {
  const source = [...chunks]
  return {
    available: true,
    complete: true,
    sessionId: SESSION,
    job: job(id, { status: 'completed', finishedAt: 2_000, label: 'job ' + id }),
    from: 0,
    next: source.length,
    lossy: false,
    truncated: false,
    chunks: source,
    ...over,
  }
}

const JOBS = [
  job('bash-1a2b', { label: 'pnpm test', progress: '3/10' }),
  job('bash-2c3d', { label: 'build', status: 'completed', finishedAt: 9_300 }),
  job('wf-9x', { kind: 'workflow', label: 'offline workflow', status: 'unknown' }),
] as const

interface Harness {
  dialog: JobsDialog
  events: string[]
  opened: string[]
  readonly text: (width?: number) => string
  readonly lines: (width?: number) => string[]
}

function harness(options: {
  snapshot?: JobsRead
  getSnapshot?: () => JobsRead | undefined
  loading?: boolean
  maxOutputLines?: number
  initialState?: { selectedId?: string; mode: 'list' | 'output'; listScroll: number; outputScroll: number }
  /** false omits the native read callback entirely (the "not wired" parent). */
  wired?: boolean
  onOpenOutput?: (entry: InspectedJob) => void
  onRefresh?: () => void
  onInterrupt?: () => void
  rows?: number
  keymap?: ReturnType<typeof createCcKeymap>
} = {}): Harness {
  const tui = createFakeTui(options.rows ?? 26, 100)
  const events: string[] = []
  const opened: string[] = []
  const dialog = new JobsDialog(asTui(tui), {
    ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
    ...(options.getSnapshot === undefined ? {} : { getSnapshot: options.getSnapshot }),
    ...(options.loading === undefined ? {} : { loading: options.loading }),
    ...(options.maxOutputLines === undefined ? {} : { maxOutputLines: options.maxOutputLines }),
    ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
    keymap: options.keymap ?? createCcKeymap(),
    ...(options.onInterrupt === undefined ? {} : { onInterrupt: options.onInterrupt }),
    ...(options.wired === false ? {} : {
      onOpenOutput: (entry: InspectedJob) => {
        opened.push(entry.id)
        options.onOpenOutput?.(entry)
      },
    }),
    ...(options.onRefresh === undefined ? {} : { onRefresh: options.onRefresh }),
    onClose: () => { events.push('close') },
  })
  dialog.focused = true
  return {
    dialog,
    events,
    opened,
    lines: (width = 100) => dialog.render(width),
    text: (width = 100) => plain(dialog.render(width)).join('\n'),
  }
}

function assertWidths(lines: readonly string[], width: number, label: string): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `${label}: width ${width} got ${visibleWidth(line)} :: ${JSON.stringify(stripTerminalSequences(line))}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Honest empty / unavailable / loading states

test('no read, unavailable and loading reads never look like an empty job list', () => {
  const unread = harness()
  assert.match(unread.text(), /have not been read/)
  assert.equal(unread.dialog.selectedId, undefined)

  const unavailable = harness({ snapshot: { available: false, reason: 'missing-service' } })
  assert.match(unavailable.text(), /Native jobs are unavailable/)
  assert.match(unavailable.text(), /\(missing-service\)/)
  assert.doesNotMatch(unavailable.text(), /No native background jobs/)

  const loading = harness({ loading: true })
  assert.match(loading.text(), /Reading native jobs/)
  assert.doesNotMatch(loading.text(), /No native background jobs/)

  const empty = harness({ snapshot: snapshot([]) })
  assert.match(empty.text(), /No native background jobs/)
  assert.match(empty.text(), /Native jobs/)
  assert.ok(plain(empty.lines()).some(line => line.includes('output') && line.includes('close')),
    'the footer keeps its inert action labels')
})

test('an incomplete native roster is marked, a complete one is not', () => {
  assert.match(harness({ snapshot: snapshot(JOBS, { complete: false }) }).text(), /incomplete/)
  assert.doesNotMatch(harness({ snapshot: snapshot(JOBS) }).text(), /incomplete/)
})

// ---------------------------------------------------------------------------
// Native order, native facts, no guessed status or elapsed time

test('rows keep native registration order and paint only native facts', () => {
  const f = harness({ snapshot: snapshot(JOBS) })
  const text = f.text()
  const first = text.indexOf('pnpm test')
  const second = text.indexOf('build')
  const third = text.indexOf('offline workflow')
  assert.ok(first >= 0 && second > first && third > second, 'native order is preserved (no time/status sort)')
  assert.match(text, /running · 3\/10/)
  assert.match(text, /completed · 8\.3s/)
  assert.match(text, /unknown/)
  // A live row has no native `finishedAt`, so no locally computed elapsed time.
  assert.doesNotMatch(text, /running · 3\/10 · \d/)
  // The selected row shows its exact opaque native id; other rows do not.
  assert.match(text, /bash-1a2b/)
  assert.equal(text.match(/bash-2c3d/g), null)
})

test('status helpers never upgrade an unknown value to a known lifecycle word', () => {
  assert.equal(jobStatusText('running'), 'running')
  assert.equal(jobStatusText('unknown'), 'unknown')
  assert.equal(jobStatusText('plugin-extended'), 'plugin-extended')
  assert.equal(jobStatusText(''), 'status unknown')
  assert.equal(jobStatusText(7), 'status unknown')
  assert.equal(jobStatusGlyph('completed'), '☑')
  assert.equal(jobStatusGlyph('plugin-extended'), '?')
  assert.equal(jobIsLive('running'), true)
  assert.equal(jobIsLive('stopping'), true)
  assert.equal(jobIsLive('unknown'), false)
  assert.equal(jobIsLive('plugin-extended'), false)
  assert.equal(formatJobDuration(1_000, 1_500), '500ms')
  assert.equal(formatJobDuration(1_000, 9_300), '8.3s')
  assert.equal(formatJobDuration(1_000, 125_000), '2m 04s')
  assert.equal(formatJobDuration(1_000, undefined), '', 'a live job has no derived duration')
  assert.equal(formatJobDuration(undefined, 2_000), '')
  assert.equal(formatJobDuration(5_000, 4_000), '', 'a backwards native stamp invents nothing')
})

test('hostile native text is sanitized and every width is safe', () => {
  const hostile = job('bash-ansi', {
    label: '\x1b[31mred\x1b[0m 中文 🚀\ttab',
    progress: '\x07bell',
    detail: 'exit code: 3',
    status: 'failed',
    finishedAt: 2_500,
  })
  const f = harness({ snapshot: snapshot([hostile]) })
  for (const width of [8, 12, 20, 24, 33, 40, 57, 80, 120]) {
    assertWidths(f.lines(width), width, `jobs list at ${width}`)
    assert.ok(!f.text(width).includes('\x1b'), 'no escape sequence survives sanitization')
  }
  assert.match(f.text(120), /中文 🚀/)
})

// ---------------------------------------------------------------------------
// Selection identity across native refresh

test('selection is the opaque native id: refresh keeps it, removal retires it', () => {
  let current: JobsRead = snapshot(JOBS)
  const f = harness({ getSnapshot: () => current })
  assert.equal(f.dialog.selectedId, 'bash-1a2b')

  f.dialog.handleInput(DOWN)
  assert.equal(f.dialog.selectedId, 'bash-2c3d')

  // Reorder: a new job lands first, the selected id keeps its row.
  current = snapshot([job('bash-new0'), ...JOBS])
  f.dialog.handleInput(DOWN) // repaint
  assert.equal(f.dialog.selectedId, 'bash-2c3d')
  assert.equal(f.dialog.mode, 'list')

  // The selected id disappears: the nearest still-listed row is selected.
  current = snapshot([job('bash-new0'), JOBS[0]!])
  f.dialog.handleInput(UP)
  assert.equal(f.dialog.selectedId, 'bash-1a2b')

  // An empty roster clears the selection without resurrecting the old id.
  current = snapshot([])
  f.dialog.handleInput(UP)
  assert.equal(f.dialog.selectedId, undefined)
  current = snapshot(JOBS)
  assert.equal(f.dialog.selectedId, 'bash-1a2b', 'a later roster selects a listed row, not the vanished one')
})

test('list keys follow the shared list actions; default Ctrl+C closes locally and an explicit interrupt stays native', () => {
  const f = harness({ snapshot: snapshot(JOBS), onInterrupt: () => { f.events.push('interrupt') } })
  f.dialog.handleInput(END)
  assert.equal(f.dialog.selectedId, 'wf-9x')
  f.dialog.handleInput(HOME)
  assert.equal(f.dialog.selectedId, 'bash-1a2b')
  f.dialog.handleInput(UP)
  assert.equal(f.dialog.selectedId, 'wf-9x', 'list.previous wraps in native order')
  f.dialog.handleInput(CTRL_C)
  assert.deepEqual(f.events, ['close'], 'default app.clear is the local list.cancel here')
  assert.deepEqual(f.dialog.render(80), [], 'a closed modal paints nothing')

  const explicit = harness({
    snapshot: snapshot(JOBS),
    keymap: createCcKeymap({ bindings: { 'app.interrupt': 'ctrl+c' } }),
    onInterrupt: () => { explicit.events.push('interrupt') },
  })
  explicit.dialog.handleInput(CTRL_C)
  assert.deepEqual(explicit.events, ['interrupt'], 'an explicit app.interrupt override is forwarded')
  assert.equal(explicit.dialog.isDone, false)
  explicit.dialog.handleInput(ESC)
  assert.deepEqual(explicit.events, ['interrupt', 'close'])
})

test('a disposed or closed dialog ignores late native snapshots', () => {
  const f = harness({ snapshot: snapshot(JOBS) })
  f.dialog.handleInput(ESC)
  f.dialog.setSnapshot(snapshot([job('bash-late')]))
  f.dialog.setLoading(true)
  assert.deepEqual(f.dialog.render(80), [])
  f.dialog.dispose()
  f.dialog.setSnapshot(snapshot(JOBS))
  assert.deepEqual(f.dialog.render(80), [])
})

// ---------------------------------------------------------------------------
// Explicit output view

test('Enter opens an explicit output view only when the parent wires the read', () => {
  const unwired = harness({ snapshot: snapshot(JOBS), wired: false })
  unwired.dialog.handleInput(ENTER)
  assert.equal(unwired.dialog.mode, 'list', 'no native read callback means no fake output view')
  assert.deepEqual(unwired.opened, [])
  assert.match(unwired.text(), /output/, 'the label stays visible without a fake key')
  assert.doesNotMatch(unwired.text(), /\[enter output\]/, 'a disabled action advertises no binding')

  const f = harness({ snapshot: snapshot(JOBS) })
  f.dialog.handleInput(ENTER)
  assert.deepEqual(f.opened, ['bash-1a2b'], 'exactly one native read request per open')
  assert.equal(f.dialog.mode, 'output')
  assert.equal(f.dialog.outputId, 'bash-1a2b')
  assert.match(f.text(), /Job output/)
  assert.match(f.text(), /Reading native output/)
  // The header shows the exact native job identity, never a row index.
  assert.match(f.text(), /bash-1a2b/)
})

test('an output page is accepted only for the open job; late pages never revive another view', () => {
  const f = harness({ snapshot: snapshot(JOBS) })
  f.dialog.handleInput(ENTER) // bash-1a2b
  f.dialog.setOutput('bash-2c3d', outputPage('bash-2c3d', [{ at: 0, text: 'wrong job\n' }]))
  assert.doesNotMatch(f.text(), /wrong job/, 'a page for another job is dropped')

  f.dialog.setOutput('bash-1a2b', outputPage('bash-1a2b', [{ at: 0, text: 'hello\nworld\n', channel: 'stdout' }]))
  assert.match(f.text(), /hello/)
  assert.match(f.text(), /world/)

  // Switching views: the old page is gone, and its late page stays gone.
  f.dialog.handleInput(DOWN) // inert in the output view
  f.dialog.handleInput(ESC) // back to list
  assert.equal(f.dialog.mode, 'list')
  f.dialog.setOutput('bash-1a2b', outputPage('bash-1a2b', [{ at: 0, text: 'stale page\n' }]))
  assert.doesNotMatch(f.text(), /stale page/, 'a late page cannot reopen a closed output view')

  f.dialog.handleInput(DOWN) // select bash-2c3d
  f.dialog.handleInput(ENTER)
  assert.deepEqual(f.opened, ['bash-1a2b', 'bash-2c3d'])
  f.dialog.setOutput('bash-1a2b', outputPage('bash-1a2b', [{ at: 0, text: 'first job output\n' }]))
  assert.doesNotMatch(f.text(), /first job output/, 'a late page for the previous job is dropped')
})

test('Esc returns from the output view to the list, then closes from the list', () => {
  const f = harness({ snapshot: snapshot(JOBS) })
  f.dialog.handleInput(ENTER)
  assert.equal(f.dialog.mode, 'output')
  f.dialog.handleInput(ESC)
  assert.equal(f.dialog.mode, 'list', 'Esc in the output view is a back, not a close')
  assert.deepEqual(f.events, ['close'].slice(1))
  f.dialog.handleInput(ESC)
  assert.deepEqual(f.events, ['close'])
  assert.equal(f.dialog.isDone, true)
})

test('output loss and truncation are explicit, and page lines are bounded', () => {
  const chunks = [{ at: 0, text: 'first\n', channel: 'stdout' as const }, { at: 6, gapBefore: true as const, text: 'after gap\n' }]
  const f = harness({ snapshot: snapshot(JOBS), maxOutputLines: 12 })
  f.dialog.handleInput(ENTER)
  f.dialog.setOutput('bash-1a2b', outputPage('bash-1a2b', chunks, { lossy: true, truncated: true }))
  assert.match(f.text(), /earlier output was lost/)
  assert.match(f.text(), /bounded by the native read limit/)

  const many = Array.from({ length: 30 }, (_, index) => ({ at: index, text: `line ${index}\n` }))
  f.dialog.setOutput('bash-1a2b', outputPage('bash-1a2b', many))
  assert.match(f.text(), /Showing the last 12 of 30 lines/)
  assert.match(f.text(), /line 29/)
  assert.doesNotMatch(f.text(), /line 17/, 'the bounded page keeps only its tail')
})

test('native stream channels are reported from the page, never invented', () => {
  const f = harness({ snapshot: snapshot(JOBS) })
  f.dialog.handleInput(ENTER)
  f.dialog.setOutput('bash-1a2b', outputPage('bash-1a2b', [
    { at: 0, text: 'out\n', channel: 'stdout' },
    { at: 4, text: 'err\n', channel: 'stderr' },
    { at: 8, text: 'out again\n', channel: 'stdout' },
  ]))
  assert.match(f.text(), /streams stdout\+stderr/, 'native stream labels in native order, deduplicated')
  // A page whose chunks carry no channel label does not claim any stream.
  f.dialog.setOutput('bash-1a2b', outputPage('bash-1a2b', [{ at: 0, text: 'plain\n' }]))
  assert.doesNotMatch(f.text(), /streams/)
})

test('native output chunks keep order, gap markers and no trailing phantom line', () => {
  const lines = jobOutputLines([
    { at: 0, text: 'a\nb', channel: 'stdout' },
    { at: 3, text: '\nc\n', channel: 'stderr' },
  ])
  assert.deepEqual(lines, ['a', 'b', 'c'])
  const gapped = jobOutputLines([{ at: 0, text: 'x\n' }, { at: 2, gapBefore: true, text: 'y\n' }])
  assert.deepEqual(gapped, ['x', '', '⋯ earlier output was lost ⋯', 'y'])
})

test('the output view scrolls lines with list.first/last and page keys, not the job selection', () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ at: index, text: `row-${String(index).padStart(2, '0')}\n` }))
  const f = harness({ snapshot: snapshot(JOBS), rows: 24 })
  f.dialog.handleInput(ENTER)
  f.dialog.setOutput('bash-1a2b', outputPage('bash-1a2b', many))
  assert.match(f.text(), /row-59/, 'a fresh page opens at its newest line')
  assert.doesNotMatch(f.text(), /row-00/)
  f.dialog.handleInput(HOME)
  assert.match(f.text(), /row-00/)
  f.dialog.handleInput(PAGE_DOWN)
  assert.doesNotMatch(f.text(), /row-00 /, 'page-down moves the painted line window')
  f.dialog.handleInput(END)
  assert.match(f.text(), /row-59/)
  assert.equal(f.dialog.selectedId, 'bash-1a2b', 'scrolling never changes the selected job')
})

test('output errors are honest and bound to the open job', () => {
  const f = harness({ snapshot: snapshot(JOBS) })
  f.dialog.handleInput(ENTER)
  f.dialog.setOutputUnavailable('bash-1a2b', 'native-failed')
  assert.match(f.text(), /Native output is unavailable \(native-failed\)/)
  f.dialog.setOutputUnavailable('bash-2c3d', 'missing-service')
  assert.doesNotMatch(f.text(), /missing-service/, 'a late failure for another job is dropped')
  f.dialog.handleInput(ESC)
  f.dialog.handleInput(ENTER)
  f.dialog.setOutput('bash-1a2b', outputPage('bash-1a2b', [{ at: 0, text: 'recovered\n' }]))
  assert.match(f.text(), /recovered/, 'a real page replaces the previous error')
  assert.doesNotMatch(f.text(), /unavailable/)
})

test('a job that leaves the native list keeps its read view and says so', () => {
  let current: JobsRead = snapshot(JOBS)
  const f = harness({ getSnapshot: () => current })
  f.dialog.handleInput(ENTER)
  f.dialog.setOutput('bash-1a2b', outputPage('bash-1a2b', [{ at: 0, text: 'kept\n' }]))
  current = snapshot([JOBS[1]!])
  assert.match(f.text(), /This job is no longer in the native list/)
  assert.match(f.text(), /kept/, 'the already-read page is not silently erased')
  assert.equal(f.dialog.mode, 'output', 'no automatic close, kill or re-resolution')
})

// ---------------------------------------------------------------------------
// Mouse

function clickAt(f: Harness, row: number, col: number, width = 100, type: 'press' | 'click' | 'wheel' | 'drag' = 'click'): void {
  const rendered = f.lines(width)
  f.dialog.handleMouse({
    type,
    button: 'left',
    x: col, y: row, screenX: col, screenY: row,
    width, height: rendered.length,
    shift: false, alt: false, ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  })
}

function rowOf(f: Harness, needle: string, width = 100): number {
  const index = f.lines(width).findIndex(line => stripTerminalSequences(line).includes(needle))
  assert.ok(index >= 0, `${needle} is painted`)
  return index
}

test('mouse selects by native id and a second click opens the output view', () => {
  const f = harness({ snapshot: snapshot(JOBS) })
  const buildRow = rowOf(f, 'build')
  clickAt(f, buildRow, 10)
  assert.equal(f.dialog.selectedId, 'bash-2c3d')
  assert.equal(f.dialog.mode, 'list')
  clickAt(f, buildRow, 10)
  assert.equal(f.dialog.mode, 'output')
  assert.deepEqual(f.opened, ['bash-2c3d'])
})

test('a press pins the native row identity, and a drag or invalidation voids it', () => {
  let current: JobsRead = snapshot(JOBS)
  const f = harness({ getSnapshot: () => current })
  const buildRow = rowOf(f, 'build')
  clickAt(f, buildRow, 10, 100, 'press')
  // A new native job lands first: the same screen row now paints another id.
  current = snapshot([job('bash-new0'), ...JOBS])
  clickAt(f, buildRow, 10, 100, 'click')
  assert.equal(f.dialog.selectedId, 'bash-2c3d', 'the pinned id wins over the row now under the pointer')

  // Drag voids the pin: the click no longer selects a row.
  current = snapshot(JOBS)
  const first = rowOf(f, 'pnpm test')
  clickAt(f, first, 10, 100, 'press')
  clickAt(f, first, 10, 100, 'drag')
  clickAt(f, first, 10, 100, 'click')
  assert.equal(f.dialog.selectedId, 'bash-2c3d', 'a drag never becomes a click jump')

  // Invalidation (layout/resize) voids the pin as well.
  clickAt(f, first + 1, 10, 100, 'press')
  f.dialog.invalidate()
  clickAt(f, first + 1, 10, 100, 'click')
  assert.equal(f.dialog.mode, 'list', 'an invalidated gesture cannot open an output view')
})

test('the wheel moves the list selection and scrolls the output view', () => {
  const f = harness({ snapshot: snapshot(JOBS), rows: 26 })
  const bodyRow = rowOf(f, 'pnpm test')
  clickAt(f, bodyRow, 10, 100, 'wheel')
  assert.equal(f.dialog.selectedId, 'bash-2c3d')

  f.dialog.handleInput(ENTER)
  const many = Array.from({ length: 40 }, (_, index) => ({ at: index, text: `wheel-${String(index).padStart(2, '0')}\n` }))
  f.dialog.setOutput('bash-2c3d', outputPage('bash-2c3d', many))
  assert.match(f.text(), /wheel-39/, 'a page opens at its newest line')
  f.dialog.handleInput(HOME)
  const firstRow = rowOf(f, 'wheel-00')
  clickAt(f, firstRow, 10, 100, 'wheel')
  assert.match(f.text(), /wheel-03/, 'the wheel scrolls output lines, not the job selection')
  assert.equal(f.dialog.selectedId, 'bash-2c3d')
})

// ---------------------------------------------------------------------------
// Restore

test('captureView/initialState restore only ephemeral list state', () => {
  const f = harness({ snapshot: snapshot(JOBS) })
  f.dialog.handleInput(DOWN)
  const view = f.dialog.captureView()
  assert.deepEqual(view, { selectedId: 'bash-2c3d', mode: 'list', listScroll: 0, outputScroll: 0 })

  const restored = harness({ snapshot: snapshot(JOBS), initialState: view })
  assert.equal(restored.dialog.selectedId, 'bash-2c3d')

  f.dialog.handleInput(ENTER)
  f.dialog.setOutput('bash-2c3d', outputPage('bash-2c3d', [{ at: 0, text: 'restored?\n' }]))
  const outputView = f.dialog.captureView()
  const reopened = harness({ snapshot: snapshot(JOBS), initialState: outputView })
  // The output page is parent state: a stale page is never replayed into a new
  // modal, so the reopened surface sits on the native list.
  assert.equal(reopened.dialog.mode, 'list')
  assert.equal(reopened.dialog.outputId, undefined)
  assert.equal(reopened.dialog.selectedId, 'bash-2c3d')
})
// ---------------------------------------------------------------------------
// Explicit refresh (no polling)

test('explicit refresh reuses the existing redraw binding and never polls', () => {
  const CTRL_L = '\x0c'
  const refreshes: string[] = []
  const f = harness({ snapshot: snapshot(JOBS), onRefresh: () => { refreshes.push('refresh') } })
  assert.match(f.text(), /\[ctrl\+l refresh\]/, 'the wired refresh advertises the real keymap binding')
  f.dialog.handleInput(CTRL_L)
  assert.deepEqual(refreshes, ['refresh'])
  assert.equal(f.dialog.mode, 'list', 'refresh is not a navigation or mutation')

  f.dialog.handleInput(ENTER)
  assert.equal(f.dialog.outputId, 'bash-1a2b', 'the parent can re-read the open output via outputId')
  f.dialog.handleInput(CTRL_L)
  assert.deepEqual(refreshes, ['refresh', 'refresh'])
  f.dialog.handleInput(ESC)
  assert.equal(f.dialog.outputId, undefined)

  // Not wired: the chip keeps no key and the key stays inert (no local read).
  const unwired = harness({ snapshot: snapshot(JOBS) })
  unwired.dialog.handleInput(CTRL_L)
  assert.doesNotMatch(unwired.text(), /refresh/)
  assert.equal(unwired.dialog.mode, 'list')
})

test('a throwing refresh callback cannot break the mounted modal', () => {
  const f = harness({ snapshot: snapshot(JOBS), onRefresh: () => { throw new Error('native read exploded') } })
  assert.doesNotThrow(() => f.dialog.handleInput('\x0c'))
  assert.match(f.text(), /pnpm test/)
})
