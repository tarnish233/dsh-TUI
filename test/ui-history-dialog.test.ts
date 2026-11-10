// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type {
  HistoryTurnEntry,
  HistoryTurnsResult,
  HistoryWindowResult,
  SessionEvent,
  SessionInfo,
} from '../src/backend/types.ts'
import { asTui, createFakeTui } from '../src/input/testing/harness.ts'
import { createCcKeymap } from '../src/input/keymap.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import {
  HISTORY_PAGE_LIMIT,
  HistoryDialog,
  type HistoryWindowRequest,
} from '../src/ui/history-dialog.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import {
  isToolExpanded,
  setToolExpanded,
  toolExpansionKey,
  toolGroupExpansionKey,
} from '../src/ui/tool-expansion.ts'
import {
  isThinkingExpanded,
  setThinkingExpanded,
  thinkingExpansionKey,
} from '../src/ui/thinking-block.ts'

/**
 * Native long-history UI: presentation-only projection of the parent-owned
 * `HistoryTurnsResult` outline and bounded `HistoryWindowResult` pages. No DSH
 * runtime, provider/profile, model, network, timer or stdout write is involved.
 */

const DOWN = '\x0e'
const UP = '\x10'
const ENTER = '\r'
const ESC = '\x1b'
const HOME = '\x1b[H'
const END = '\x1b[F'
const CTRL_C = '\x03'

const SESSION: SessionInfo = {
  sessionId: 'session-history',
  cwd: '/tmp/history-work',
  provider: 'deepseek',
  model: 'deepseek-chat',
  capabilities: [],
}

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

function textEvent(seq: number, turn: number, role: 'user' | 'assistant', text: string): SessionEvent {
  if (role === 'user') {
    return { type: 'user/message', seq, data: { turn, content: [{ type: 'text', text }] } }
  }
  return {
    type: 'assistant/message',
    seq,
    data: { turn, message: { content: [{ type: 'text', text }] } },
  }
}

/** A turn with `count` native events where the last one is its `turn/end`. */
function turnEvents(start: number, count: number, turn: number, prefix = `turn ${turn}`): SessionEvent[] {
  assert.ok(count >= 2)
  const events: SessionEvent[] = []
  for (let index = 0; index < count - 1; index += 1) {
    events.push(textEvent(start + index, turn, index === 0 ? 'user' : 'assistant', `${prefix} line ${index + 1}`))
  }
  events.push({ type: 'turn/end', seq: start + count - 1, data: { turn, reason: { kind: 'completed' } } })
  return events
}

function row(turn: number, seq: number, prompt?: string, response?: string): HistoryTurnEntry {
  return {
    turn,
    seq,
    prompt: prompt ?? `Prompt for turn ${turn}`,
    response: response ?? `Response for turn ${turn}`,
  }
}

function outlineOf(entries: readonly HistoryTurnEntry[], over: Partial<HistoryTurnsResult> = {}): HistoryTurnsResult {
  return { available: true, sessionId: SESSION.sessionId, entries, ...over }
}

interface SourceOptions {
  readonly async?: boolean
  readonly transform?: (request: HistoryWindowRequest, result: HistoryWindowResult) => HistoryWindowResult
}

interface WindowSource {
  readonly requests: HistoryWindowRequest[]
  readonly pending: number
  attach(dialog: HistoryDialog): void
  load(request: HistoryWindowRequest): void
  flush(limit?: number): number
  resultFor(request: HistoryWindowRequest): HistoryWindowResult
  deliver(requestId: number, result: HistoryWindowResult): void
  fail(requestId: number, message: string): void
}

/** Bounded native-window emulation: before/after events around targetSeq. */
function createSource(events: readonly SessionEvent[], options: SourceOptions = {}): WindowSource {
  const requests: HistoryWindowRequest[] = []
  const queue: HistoryWindowRequest[] = []
  let dialog: HistoryDialog | undefined
  const sorted = [...events].sort((left, right) => left.seq - right.seq)
  const resultFor = (request: HistoryWindowRequest): HistoryWindowResult => {
    let index = sorted.findIndex(event => event.seq >= request.targetSeq)
    if (index < 0) index = sorted.length
    const start = Math.max(0, index - request.before)
    const end = Math.min(sorted.length, index + request.after + 1)
    const slice = sorted.slice(start, end)
    return {
      sessionId: request.sessionId,
      ...(request.attachmentId === undefined ? {} : { attachmentId: request.attachmentId }),
      targetSeq: request.targetSeq,
      startSeq: slice[0]?.seq ?? request.targetSeq,
      endSeq: slice[slice.length - 1]?.seq ?? request.targetSeq,
      inheritedEventCount: 0,
      hasOlder: start > 0,
      events: slice,
    }
  }
  const deliver = (request: HistoryWindowRequest): void => {
    const result = resultFor(request)
    dialog!.setWindow(request.requestId, options.transform?.(request, result) ?? result)
  }
  return {
    requests,
    get pending() {
      return queue.length
    },
    attach(value) {
      dialog = value
    },
    load(request) {
      requests.push(request)
      if (options.async === true) queue.push(request)
      else deliver(request)
    },
    flush(limit = 100) {
      let delivered = 0
      while (queue.length > 0 && delivered < limit) {
        const request = queue.shift()
        if (request === undefined) break
        deliver(request)
        delivered += 1
      }
      return delivered
    },
    resultFor,
    deliver(requestId, result) {
      dialog!.setWindow(requestId, result)
    },
    fail(requestId, message) {
      dialog!.failWindow(requestId, message)
    },
  }
}

test('zero-context native windows stop boundedly and mark a known incomplete outline cut as partial', () => {
  const events = turnEvents(1, 5, 1)
  const source = createSource(events, {
    transform: (request, result) => {
      const event = events.find(event => event.seq === request.targetSeq)
      assert.ok(event)
      return { ...result, startSeq: event.seq, endSeq: event.seq, events: [event] }
    },
  })
  const h = harness({ outline: outlineOf([row(1, 1)], { asOfSeq: 5 }), source })
  try {
    h.dialog.openSelectedTurn()
    assert.equal(source.requests.length, 2, 'one anchor and one cached no-progress page, never a retry loop')
    assert.deepEqual(h.dialog.detailEventSeqs, [1])
    assert.equal(h.dialog.detailMessage, '', 'the anchor is valid native data, not a fabricated failure')
    assert.equal(h.dialog.detailHasNewer, false)
    assert.equal(h.dialog.detailIsTruncated, true, 'the known unread outline cut is not declared complete')
    assert.match(h.text(), /Partial turn: the native event reader made no forward progress/)
    assert.doesNotMatch(h.text(), /1200-event read cap/, 'a no-progress stop must not be mislabeled as the event cap')
  } finally { h.dialog.dispose() }
})

interface HarnessOptions {
  readonly outline?: HistoryTurnsResult
  readonly loading?: boolean
  readonly events?: readonly SessionEvent[]
  readonly source?: WindowSource
  readonly async?: boolean
  readonly maxEvents?: number
  readonly maxBytes?: number
  readonly maxPages?: number
  readonly onInterrupt?: () => void
  readonly loadTurns?: () => void
  readonly rows?: number
  readonly keymap?: ReturnType<typeof createCcKeymap>
}

interface Harness {
  readonly dialog: HistoryDialog
  readonly source: WindowSource
  readonly closed: string[]
  readonly interrupts: string[]
  readonly renders: number
  readonly lines: (width?: number) => string[]
  readonly text: (width?: number) => string
}

function harness(options: HarnessOptions = {}): Harness {
  const tui = createFakeTui(options.rows ?? 32, 120)
  const source = options.source ?? createSource(options.events ?? [], { async: options.async })
  const closed: string[] = []
  const interrupts: string[] = []
  let renders = 0
  const dialog = new HistoryDialog(asTui(tui), {
    session: SESSION,
    ...(options.outline === undefined ? {} : { outline: options.outline }),
    ...(options.loading === undefined ? {} : { loading: options.loading }),
    keymap: options.keymap ?? createCcKeymap(),
    ...(options.loadTurns === undefined ? {} : { loadTurns: options.loadTurns }),
    loadWindow: request => source.load(request),
    ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.onInterrupt === undefined ? {} : { onInterrupt: () => { interrupts.push('interrupt'); options.onInterrupt?.() } }),
    onClose: () => { closed.push('close') },
    onRenderRequest: () => { renders += 1 },
  })
  source.attach(dialog)
  dialog.focused = true
  return {
    dialog,
    source,
    closed,
    interrupts,
    get renders() {
      return renders
    },
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

const THREE_TURNS = outlineOf([row(1, 100), row(2, 300), row(3, 500)], { asOfSeq: 519 })

// ---------------------------------------------------------------------------
// Honest outline states

test('unread, loading, unavailable, malformed, empty and failed outlines stay distinct', () => {
  const unread = harness()
  assert.match(unread.text(), /has not been read/)
  assert.doesNotMatch(unread.text(), /No native turns/)
  assert.equal(unread.dialog.selectedSeq, undefined)

  const loading = harness({ loading: true })
  assert.match(loading.text(), /Reading native turn history/)
  assert.doesNotMatch(loading.text(), /No native turns/)

  const unavailable = harness({
    outline: { ...outlineOf([]), available: false, ...({ reason: 'missing-service' } as object) } as HistoryTurnsResult,
  })
  assert.match(unavailable.text(), /Native turn history is unavailable/)
  assert.match(unavailable.text(), /\(missing-service\)/)
  assert.doesNotMatch(unavailable.text(), /No native turns/)

  const malformed = harness({
    outline: {
      available: true,
      sessionId: SESSION.sessionId,
      entries: [null, { turn: 'x', seq: 1 }, { turn: 2, seq: -3, prompt: 'p', response: 'r' }],
    } as unknown as HistoryTurnsResult,
  })
  assert.match(malformed.text(), /malformed/i)
  assert.doesNotMatch(malformed.text(), /No native turns/)

  const empty = harness({ outline: outlineOf([]) })
  assert.match(empty.text(), /No native turns in this session/)

  const failed = harness({ outline: THREE_TURNS })
  failed.dialog.setTurnsError('Native turn outline failed (stale-handle).')
  assert.match(failed.text(), /stale-handle/)
  assert.match(failed.text(), /Prompt for turn 1/, 'already-known native rows stay visible')

  const wrongSession = harness({ outline: THREE_TURNS })
  wrongSession.dialog.setOutline({ ...THREE_TURNS, sessionId: 'other-session' })
  assert.match(wrongSession.text(), /different session/)
  assert.equal(wrongSession.dialog.selectedSeq, undefined)
})

test('a partially malformed outline keeps valid rows and states the skipped count', () => {
  const f = harness({
    outline: {
      available: true,
      sessionId: SESSION.sessionId,
      entries: [null, row(1, 100), { turn: 2, seq: 'bad' }],
    } as unknown as HistoryTurnsResult,
  })
  assert.match(f.text(), /Prompt for turn 1/)
  assert.match(f.text(), /2 malformed native outline rows were skipped/)
  assert.equal(f.dialog.selectedSeq, 100)
})

// ---------------------------------------------------------------------------
// Native order and selection identity

test('turn rows keep native outline order and paint #turn plus both previews', () => {
  const f = harness({ outline: THREE_TURNS })
  const text = f.text(120)
  const first = text.indexOf('#1')
  const second = text.indexOf('#2')
  const third = text.indexOf('#3')
  assert.ok(first >= 0 && second > first && third > second, 'outline order is preserved (no sort)')
  assert.match(text, /Prompt for turn 1/)
  assert.match(text, /Response for turn 1/)
  assert.match(text, /Prompt for turn 3/)
  assert.match(text, /Response for turn 3/)
  assert.equal(f.dialog.selectedSeq, 100)

  f.dialog.handleInput(DOWN)
  assert.equal(f.dialog.selectedSeq, 300)
  f.dialog.handleInput(UP)
  assert.equal(f.dialog.selectedSeq, 100)
  f.dialog.handleInput(UP)
  assert.equal(f.dialog.selectedSeq, 500, 'list.previous wraps in native order')
  f.dialog.handleInput(HOME)
  assert.equal(f.dialog.selectedSeq, 100)
  f.dialog.handleInput(END)
  assert.equal(f.dialog.selectedSeq, 500)
})

test('opening a turn requests one bounded anchor window and never touches the live store', () => {
  const events = [...turnEvents(300, 20, 2), ...turnEvents(500, 20, 3), ...turnEvents(100, 20, 1)]
  const live = new TranscriptStore()
  live.reset({
    sessionId: SESSION.sessionId,
    cwd: SESSION.cwd,
    provider: SESSION.provider,
    model: SESSION.model,
    capabilities: [],
    events: turnEvents(100, 3, 1),
  })
  const liveBefore = [...live.items]
  const liveSession = live.sessionId

  const f = harness({ outline: THREE_TURNS, events })
  f.dialog.handleInput(DOWN)
  f.dialog.handleInput(ENTER)

  assert.equal(f.dialog.mode, 'turn')
  assert.equal(f.dialog.detailTurn?.seq, 300)
  assert.equal(f.source.requests.length >= 1, true)
  const first = f.source.requests[0]!
  assert.equal(first.sessionId, SESSION.sessionId)
  assert.equal(first.turn, 2)
  assert.equal(first.targetSeq, 300)
  assert.equal(first.page, 'anchor')
  assert.ok(first.before <= HISTORY_PAGE_LIMIT)
  assert.ok(first.after <= HISTORY_PAGE_LIMIT)
  assert.deepEqual(f.dialog.detailEventSeqs, Array.from({ length: 20 }, (_, index) => 300 + index))
  assert.match(f.text(), /History › #2/)
  assert.match(f.text(), /Prompt for turn 2/)

  assert.equal(live.sessionId, liveSession)
  assert.deepEqual(live.items, liveBefore, 'the main live transcript is neither reset nor extended')
})

// ---------------------------------------------------------------------------
// Bounded paging

test('a >50-event turn is loaded through bounded pages, in native seq order, without duplicates', () => {
  const events = [...turnEvents(100, 130, 1, 'long turn'), ...turnEvents(900, 4, 2)]
  const f = harness({
    outline: outlineOf([row(1, 100), row(2, 900)]),
    events,
  })
  f.dialog.handleInput(ENTER)

  assert.deepEqual(f.dialog.detailEventSeqs, Array.from({ length: 130 }, (_, index) => 100 + index))
  assert.equal(f.dialog.detailEventCount, 130)
  assert.equal(new Set(f.dialog.detailEventSeqs).size, 130, 'no duplicate native seq')
  assert.equal(f.dialog.detailIsTruncated, false)
  assert.ok(f.source.requests.length >= 3, `paging used ${f.source.requests.length} requests`)
  for (const request of f.source.requests) {
    assert.ok(request.before >= 0 && request.before <= HISTORY_PAGE_LIMIT)
    assert.ok(request.after >= 0 && request.after <= HISTORY_PAGE_LIMIT)
    assert.equal(request.sessionId, SESSION.sessionId)
    assert.equal(request.turn, 1)
  }
  const forward = f.source.requests.filter(request => request.page === 'newer')
  assert.deepEqual(forward.map(request => request.targetSeq), [150, 200])
  f.dialog.handleInput(END)
  assert.match(f.text(), /long turn line 129/)
})

test('overlapping native pages merge by seq and stop when a page adds nothing', () => {
  const events = Array.from({ length: 61 }, (_, index) =>
    textEvent(100 + index, 1, index === 0 ? 'user' : 'assistant', `overlap ${index + 1}`))
  const f = harness({
    outline: outlineOf([row(1, 100), row(2, 900)]),
    events,
    source: createSource(events, {
      transform: request => {
        if (request.page === 'anchor') {
          return {
            sessionId: request.sessionId,
            targetSeq: request.targetSeq,
            startSeq: 100,
            endSeq: 150,
            inheritedEventCount: 0,
            hasOlder: false,
            events: events.filter(event => event.seq >= 100 && event.seq <= 150),
          }
        }
        if (request.targetSeq <= 160) {
          return {
            sessionId: request.sessionId,
            targetSeq: request.targetSeq,
            startSeq: 145,
            endSeq: 160,
            inheritedEventCount: 0,
            hasOlder: true,
            events: events.filter(event => event.seq >= 145 && event.seq <= 160),
          }
        }
        return {
          sessionId: request.sessionId,
          targetSeq: request.targetSeq,
          startSeq: request.targetSeq,
          endSeq: request.targetSeq,
          inheritedEventCount: 0,
          hasOlder: true,
          events: [],
        }
      },
    }),
  })
  f.dialog.handleInput(ENTER)

  assert.deepEqual(f.dialog.detailEventSeqs, Array.from({ length: 61 }, (_, index) => 100 + index))
  assert.equal(new Set(f.dialog.detailEventSeqs).size, 61, 'overlap never duplicates a native seq')
  assert.equal(f.dialog.detailEventCount, 61)
  assert.equal(f.source.requests.length, 3, 'the duplicate page stops boundedly')
  assert.equal(f.dialog.detailIsTruncated, true, 'the next-turn anchor at 900 still proves this 100..160 window is incomplete')
  assert.match(f.text(), /no forward progress/)
})

test('turn/next-turn boundaries clip a page that also contains the next turn', () => {
  const events = [...turnEvents(100, 20, 1, 'first'), ...turnEvents(120, 20, 2, 'second')]
  const f = harness({
    outline: outlineOf([row(1, 100), row(2, 120)]),
    events,
  })
  f.dialog.handleInput(ENTER)

  assert.deepEqual(f.dialog.detailEventSeqs, Array.from({ length: 20 }, (_, index) => 100 + index))
  assert.equal(f.dialog.detailEventSeqs.includes(120), false, 'next turn seq is exclusive')
  assert.doesNotMatch(f.text(), /second line/)
})

test('an anchor that starts after the turn start pages older until the turn boundary', () => {
  const events = [...turnEvents(150, 11, 1), ...turnEvents(100, 50, 1, 'older')]
  // Synthetic split: the anchor page claims only 150..160, while the native
  // window proves older events exist. Older paging must fill 100..149.
  const f = harness({
    outline: outlineOf([row(1, 100), row(2, 900)]),
    events,
    source: createSource(events, {
      transform: request => {
        if (request.page === 'anchor') {
          const slice = events.filter(event => event.seq >= 150 && event.seq <= 160)
          return {
            sessionId: request.sessionId,
            targetSeq: request.targetSeq,
            startSeq: 150,
            endSeq: 160,
            inheritedEventCount: 0,
            hasOlder: true,
            events: slice,
          }
        }
        return {
          sessionId: request.sessionId,
          targetSeq: request.targetSeq,
          startSeq: 100,
          endSeq: 149,
          inheritedEventCount: 0,
          hasOlder: false,
          events: events.filter(event => event.seq >= 100 && event.seq <= 149),
        }
      },
    }),
  })
  f.dialog.handleInput(ENTER)

  const older = f.source.requests.filter(request => request.page === 'older')
  assert.equal(older.length, 1)
  assert.equal(older[0]?.after, 0)
  assert.ok((older[0]?.before ?? 0) <= HISTORY_PAGE_LIMIT)
  assert.equal(older[0]?.targetSeq, 150)
  assert.equal(f.dialog.detailEventSeqs[0], 100)
  assert.equal(f.dialog.detailEventSeqs.at(-1), 160)
  assert.equal(new Set(f.dialog.detailEventSeqs).size, 61)
})

// ---------------------------------------------------------------------------
// Caps and honest truncation

test('the event cap stops paging with an explicit truncation marker', () => {
  const events = [...turnEvents(100, 130, 1), ...turnEvents(900, 4, 2)]
  const f = harness({
    outline: outlineOf([row(1, 100), row(2, 900)]),
    events,
    maxEvents: 10,
  })
  f.dialog.handleInput(ENTER)

  assert.deepEqual(f.dialog.detailEventSeqs, Array.from({ length: 10 }, (_, index) => 100 + index))
  assert.equal(f.dialog.detailIsTruncated, true)
  assert.match(f.text(), /Partial turn: the 10-event read cap was reached/)
  assert.equal(f.dialog.detailHasNewer, true, 'the window proves the rest of the turn remains')
})

test('the byte cap and page cap also report partial reads instead of an empty history', () => {
  const long = 'x'.repeat(150)
  const events = [
    ...turnEvents(100, 130, 1, long),
    ...turnEvents(900, 4, 2),
  ]
  const bytes = harness({
    outline: outlineOf([row(1, 100), row(2, 900)]),
    events,
    maxBytes: 500,
  })
  bytes.dialog.handleInput(ENTER)
  assert.ok(bytes.dialog.detailEventCount > 0)
  assert.ok(bytes.dialog.detailEventCount < 130)
  assert.equal(bytes.dialog.detailIsTruncated, true)
  assert.match(bytes.text(), /byte read cap/)

  const pages = harness({
    outline: outlineOf([row(1, 100), row(2, 900)]),
    events,
    maxPages: 1,
  })
  pages.dialog.handleInput(ENTER)
  assert.equal(pages.dialog.detailEventCount, 51)
  assert.equal(pages.dialog.detailIsTruncated, true)
  assert.match(pages.text(), /automatic paging stopped after 1 page/)
  assert.match(pages.text(), /newer/, 'the footer still offers proven newer navigation')
})

test('the explicit newer action loads one more proven page after the automatic page limit', () => {
  const events = [...turnEvents(100, 130, 1), ...turnEvents(900, 4, 2)]
  const f = harness({
    outline: outlineOf([row(1, 100), row(2, 900)]),
    events,
    maxPages: 1,
  })
  f.dialog.handleInput(ENTER)
  assert.equal(f.dialog.detailEventCount, 51)
  assert.equal(f.dialog.detailHasNewer, true)
  const requestsBefore = f.source.requests.length

  const lines = plain(f.lines(100))
  const y = lines.findIndex(line => line.includes('[newer]'))
  assert.ok(y >= 0, 'the proven newer chip is painted')
  const x = lines[y]!.indexOf('[newer]') + 2
  const event = (type: 'press' | 'click') => ({
    type,
    button: 'left' as const,
    x,
    y,
    screenX: x,
    screenY: y,
    width: 100,
    height: 32,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  })
  f.dialog.handleMouse(event('press'))
  f.dialog.handleMouse(event('click'))

  assert.equal(f.source.requests.length, requestsBefore + 1, 'one explicit page, not a poll loop')
  const request = f.source.requests.at(-1)!
  assert.equal(request.page, 'newer')
  assert.equal(request.before, 0)
  assert.ok(request.after <= HISTORY_PAGE_LIMIT)
  assert.equal(f.dialog.detailEventCount, 101)
  assert.deepEqual(f.dialog.detailEventSeqs.slice(0, 3), [100, 101, 102])
  assert.equal(new Set(f.dialog.detailEventSeqs).size, 101)
})

test('newer navigation appears only with native window proof and disappears when exhausted', () => {
  const events = [
    textEvent(100, 1, 'user', 'first prompt'),
    textEvent(101, 1, 'assistant', 'first response'),
    ...turnEvents(300, 20, 2),
  ]
  const f = harness({
    outline: outlineOf([row(1, 100), row(2, 300)]),
    events,
    async: true,
  })
  f.dialog.handleInput(ENTER)
  f.source.flush(1) // the anchor page only
  assert.equal(f.dialog.detailHasNewer, true)
  assert.match(f.text(), /newer/)

  // The next forward page proves there are no more events in this turn: a
  // short/empty native window must not keep offering a fake "newer".
  const next = f.source.requests.at(-1)!
  assert.equal(next.page, 'newer')
  // A real native read always includes its target event; this window proves
  // there is nothing after the latest loaded seq.
  f.source.deliver(next.requestId, {
    sessionId: SESSION.sessionId,
    targetSeq: next.targetSeq,
    startSeq: next.targetSeq,
    endSeq: next.targetSeq,
    inheritedEventCount: 0,
    hasOlder: true,
    events: events.filter(event => event.seq === next.targetSeq),
  })
  assert.equal(f.dialog.detailHasNewer, false)
  assert.doesNotMatch(plain(f.lines()).join('\n'), /newer/)
})

// ---------------------------------------------------------------------------
// Honest failures and malformed windows

test('throwing, unavailable, malformed and empty window reads stay distinguishable', () => {
  // A throwing native read must not break the mounted modal.
  const throwingDialog = new HistoryDialog(asTui(createFakeTui(30, 100)), {
    session: SESSION,
    outline: THREE_TURNS,
    keymap: createCcKeymap(),
    loadWindow: () => { throw new Error('native boom') },
    onClose: () => {},
  })
  throwingDialog.focused = true
  throwingDialog.handleInput(ENTER)
  assert.match(plain(throwingDialog.render(100)).join('\n'), /could not be read/)
  assert.doesNotMatch(plain(throwingDialog.render(100)).join('\n'), /No native events/)
  throwingDialog.dispose()

  const unavailable = harness({ outline: THREE_TURNS, async: true })
  unavailable.dialog.handleInput(ENTER)
  const pending = unavailable.source.requests.at(-1)!
  unavailable.source.fail(pending.requestId, 'Native history window is unavailable (gone).')
  assert.match(unavailable.text(), /unavailable \(gone\)/)

  const empty = harness({ outline: THREE_TURNS, events: [] })
  empty.dialog.handleInput(ENTER)
  assert.match(empty.text(), /native window returned no events/)

  const malformed = harness({
    outline: THREE_TURNS,
    async: true,
  })
  malformed.dialog.handleInput(ENTER)
  const bad = malformed.source.requests.at(-1)!
  malformed.source.deliver(bad.requestId, {
    sessionId: SESSION.sessionId,
    targetSeq: bad.targetSeq,
    startSeq: bad.targetSeq,
    endSeq: bad.targetSeq,
    inheritedEventCount: 0,
    hasOlder: false,
    events: [{ nope: true }],
  } as unknown as HistoryWindowResult)
  assert.match(malformed.text(), /malformed/i)

  // A malformed page after a good page keeps the loaded facts visible.
  const partial = harness({
    outline: outlineOf([row(1, 100), row(2, 300)]),
    events: Array.from({ length: 11 }, (_, index) => textEvent(100 + index, 1, index === 0 ? 'user' : 'assistant', `partial ${index}`)),
    async: true,
  })
  partial.dialog.handleInput(ENTER)
  const first = partial.source.requests.at(-1)!
  partial.source.deliver(first.requestId, partial.source.resultFor(first))
  const loaded = partial.dialog.detailEventCount
  const next = partial.source.requests.at(-1)!
  partial.source.deliver(next.requestId, {
    sessionId: SESSION.sessionId,
    targetSeq: next.targetSeq,
    startSeq: next.targetSeq,
    endSeq: next.targetSeq,
    inheritedEventCount: 0,
    hasOlder: false,
    events: [null],
  } as unknown as HistoryWindowResult)
  assert.match(partial.text(), /malformed/i)
  assert.equal(partial.dialog.detailEventCount, loaded, 'accepted native events are not erased by a bad page')
})

// ---------------------------------------------------------------------------
// Late pages, close and superseded selection

test('late pages after close and after a superseded selection are discarded', () => {
  const events = [...turnEvents(100, 20, 1), ...turnEvents(300, 20, 2)]
  const f = harness({
    outline: outlineOf([row(1, 100), row(2, 300)]),
    events,
    async: true,
  })
  f.dialog.handleInput(ENTER) // turn 1
  const first = f.source.requests.at(-1)!
  assert.equal(first.turn, 1)

  f.dialog.handleInput(ESC) // back to list
  assert.equal(f.dialog.mode, 'list')
  f.dialog.handleInput(DOWN) // turn 2
  f.dialog.handleInput(ENTER)
  const second = f.source.requests.at(-1)!
  assert.equal(second.turn, 2)
  assert.notEqual(second.requestId, first.requestId)

  // The superseded turn-1 request arrives late carrying turn-2 seqs. Only the
  // request identity (not seq arithmetic) can reject it; a live late page must
  // never repaint the view that superseded it.
  f.source.deliver(first.requestId, {
    sessionId: SESSION.sessionId,
    targetSeq: 300,
    startSeq: 300,
    endSeq: 319,
    inheritedEventCount: 0,
    hasOlder: false,
    events: events.filter(event => event.seq >= 300 && event.seq <= 319),
  })
  assert.equal(f.dialog.detailTurn?.turn, 2)
  assert.deepEqual(f.dialog.detailEventSeqs, [], 'the late page never repaints turn 2')

  // The right page is accepted.
  f.source.deliver(second.requestId, f.source.resultFor(second))
  assert.deepEqual(f.dialog.detailEventSeqs, Array.from({ length: 20 }, (_, index) => 300 + index))

  // Esc back then Esc closes; every later page is dropped and nothing paints.
  f.dialog.handleInput(ESC)
  f.dialog.handleInput(ESC)
  assert.deepEqual(f.closed, ['close'])
  assert.deepEqual(f.dialog.render(100), [])
  const last = f.source.requests.at(-1)!
  f.source.deliver(last.requestId, f.source.resultFor(last))
  assert.deepEqual(f.dialog.render(100), [])
})

test('a session change drops the pending detail and late pages for the old session', () => {
  const events = turnEvents(100, 20, 1)
  const f = harness({ outline: outlineOf([row(1, 100)]), events, async: true })
  f.dialog.handleInput(ENTER)
  const pending = f.source.requests.at(-1)!

  f.dialog.setSession({ ...SESSION, sessionId: 'session-other' })
  assert.equal(f.dialog.mode, 'list')
  assert.equal(f.dialog.detailTurn === undefined, true)
  assert.equal(f.dialog.turnsStatus, 'unread')

  // Clicking a row from the old session must never own a new session's page.
  f.dialog.setOutline({ ...outlineOf([row(1, 100)]), sessionId: 'session-other' })
  f.dialog.handleInput(ENTER)
  const fresh = f.source.requests.at(-1)!
  assert.notEqual(fresh.requestId, pending.requestId)
  assert.equal(fresh.sessionId, 'session-other')

  f.source.deliver(pending.requestId, f.source.resultFor(pending))
  assert.equal(f.dialog.detailTurn?.seq, 100)
  assert.deepEqual(f.dialog.detailEventSeqs, [], 'the old-session page never enters the new projection')

  f.source.deliver(fresh.requestId, f.source.resultFor(fresh))
  assert.deepEqual(f.dialog.detailEventSeqs, Array.from({ length: 20 }, (_, index) => 100 + index))
})

// ---------------------------------------------------------------------------
// Esc / interrupt semantics and shared keys

test('Esc backs out of a turn, then closes; default Ctrl+C cancels the local layer and an explicit interrupt stays native', () => {
  const f = harness({
    outline: THREE_TURNS,
    events: turnEvents(100, 20, 1),
    onInterrupt: () => {},
  })
  f.dialog.handleInput(ENTER)
  assert.equal(f.dialog.mode, 'turn')

  f.dialog.handleInput(ESC)
  assert.equal(f.dialog.mode, 'list', 'Esc in the read-only turn view returns to the outline')
  assert.deepEqual(f.closed, [])

  f.dialog.handleInput(CTRL_C)
  assert.deepEqual(f.interrupts, [], 'default app.clear is never forwarded as a native interrupt')
  assert.deepEqual(f.closed, ['close'], 'default Ctrl+C closes the focused surface locally')
  assert.deepEqual(f.dialog.render(80), [])

  // The turn detail layer is cancelled first, exactly like Esc.
  const layered = harness({ outline: THREE_TURNS, events: turnEvents(100, 20, 1) })
  layered.dialog.handleInput(ENTER)
  layered.dialog.handleInput(CTRL_C)
  assert.equal(layered.dialog.mode, 'list', 'Ctrl+C backs out of the read-only turn view')
  assert.deepEqual(layered.closed, [])
  layered.dialog.handleInput(CTRL_C)
  assert.deepEqual(layered.closed, ['close'])

  // Only an explicit user override makes Ctrl+C native; the parent owns the outcome.
  const explicit = harness({
    outline: THREE_TURNS,
    events: turnEvents(100, 20, 1),
    keymap: createCcKeymap({ bindings: { 'app.interrupt': 'ctrl+c' } }),
    onInterrupt: () => {},
  })
  explicit.dialog.handleInput(CTRL_C)
  assert.deepEqual(explicit.interrupts, ['interrupt'])
  assert.deepEqual(explicit.closed, [], 'a parent interrupt callback owns the outcome')
  assert.equal(explicit.dialog.isDone, false)
  explicit.dialog.handleInput(ESC)
  assert.deepEqual(explicit.closed, ['close'])
})

test('explicit refresh uses the shared redraw binding and never polls', () => {
  let refreshes = 0
  const f = harness({
    outline: THREE_TURNS,
    loadTurns: () => { refreshes += 1 },
  })
  f.dialog.handleInput('\x0c') // Ctrl+L / app.redraw
  assert.equal(refreshes, 1)
  assert.match(f.text(), /Reading native turn history/)
  f.dialog.setOutline(THREE_TURNS)
  assert.match(f.text(), /Prompt for turn 1/)
  assert.equal(refreshes, 1, 'only the explicit key reads the outline; no timer/poll exists')
})

// ---------------------------------------------------------------------------
// Width safety and no stdout

test('list and turn views are width-safe at 40/80/120/160 and write no stdout', () => {
  const events = [
    ...turnEvents(100, 60, 1, '宽度安全检查 🚀'),
    ...turnEvents(300, 5, 2, '\x1b[31mhostile\x1b[0m\ttext'),
  ]
  const hostile = outlineOf([
    row(1, 100, '\x1b[31mred\x1b[0m 中文 🚀\ttab', 'response \x07bell'),
    row(2, 300, 'second prompt', 'second response'),
  ], { asOfSeq: 304 })
  const f = harness({ outline: hostile, events })

  for (const width of [40, 80, 120, 160]) assertWidths(f.lines(width), width, `history list at ${width}`)
  assert.doesNotMatch(f.text(120), /\x1b\[31mred/)

  f.dialog.handleInput(ENTER)
  for (const width of [40, 80, 120, 160]) assertWidths(f.lines(width), width, `history turn at ${width}`)

  const out: unknown[] = []
  const err: unknown[] = []
  const originalOut = process.stdout.write
  const originalErr = process.stderr.write
  process.stdout.write = ((chunk: unknown) => { out.push(chunk); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => { err.push(chunk); return true }) as typeof process.stderr.write
  try {
    f.lines(40)
    f.dialog.handleInput(DOWN)
    f.dialog.handleInput(ESC)
    f.lines(160)
  } finally {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }
  assert.deepEqual(out, [], 'the renderer owner writes the terminal, never this component')
  assert.deepEqual(err, [])
})

// ---------------------------------------------------------------------------
// Mouse

test('a clicked turn selects first and opens on the second click; wheel follows list order', () => {
  const f = harness({ outline: THREE_TURNS, events: turnEvents(100, 20, 1) })
  const lines = plain(f.lines(100))
  const turn2Row = lines.findIndex(line => line.includes('#2'))
  assert.ok(turn2Row >= 0)
  const event = (type: 'press' | 'click') => ({
    type,
    button: 'left' as const,
    x: 5,
    y: turn2Row,
    screenX: 5,
    screenY: turn2Row,
    width: 100,
    height: 32,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  })
  assert.deepEqual(f.dialog.handleMouse(event('press')) ?? { handled: false }, { handled: true, render: false })
  assert.deepEqual(f.dialog.handleMouse(event('click')) ?? { handled: false }, { handled: true, render: true })
  assert.equal(f.dialog.selectedSeq, 300)
  assert.equal(f.dialog.mode, 'list')
  f.dialog.handleMouse(event('press'))
  f.dialog.handleMouse(event('click'))
  assert.equal(f.dialog.mode, 'turn')
  assert.equal(f.dialog.detailTurn?.seq, 300)
})
// ---------------------------------------------------------------------------
// R4: the read-only detail never reads, clears, retains or transfers the
// module-level disclosure maps the live transcript paints from.

/** One tool card + one multi-line reasoning run, keyed identically in both planes. */
function disclosureEvents(): SessionEvent[] {
  return [
    { type: 'user/message', seq: 299, data: { turn: 2, content: [{ type: 'text', text: 'live prompt' }] } },
    {
      type: 'assistant/message',
      seq: 300,
      data: {
        turn: 2,
        message: {
          content: [
            { type: 'reasoning', text: Array.from({ length: 24 }, (_, index) => `reasoning line ${index + 1}`).join('\n') },
            { type: 'tool-call', id: 'live-a', name: 'bash', arguments: '{"command":"echo a"}' },
            { type: 'tool-call', id: 'live-b', name: 'bash', arguments: '{"command":"echo b"}' },
          ],
        },
      },
    },
    { type: 'tool/call', seq: 301, data: { turn: 2, step: 1, callId: 'live-a', name: 'bash', arguments: '{"command":"echo a"}' } },
    { type: 'tool/call', seq: 302, data: { turn: 2, step: 1, callId: 'live-b', name: 'bash', arguments: '{"command":"echo b"}' } },
    {
      type: 'tool/result',
      seq: 303,
      data: {
        turn: 2,
        step: 1,
        message: { toolCallId: 'live-a', content: [{ type: 'text', text: `expanded-only-output\n`.repeat(30) }] },
      },
    },
    { type: 'tool/result', seq: 304, data: { turn: 2, step: 1, message: { toolCallId: 'live-b', content: [{ type: 'text', text: 'b done' }] } } },
    { type: 'turn/end', seq: 305, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

const liveSession = (): SessionInfo => ({ ...SESSION, events: [] })

function liveViewWithOpenDisclosures(): { store: TranscriptStore; view: TranscriptView; before: string } {
  const store = new TranscriptStore()
  store.reset(liveSession())
  for (const event of disclosureEvents()) store.handle({ type: 'session_event', sessionId: SESSION.sessionId, event })
  const view = new TranscriptView(store, {
    showThinking: true,
    expandTools: false,
    screen: 'fullscreen',
    groupTools: true,
  })
  view.render(100) // first paint syncs the session id
  setToolExpanded(toolExpansionKey('live-a'), true)
  setToolExpanded(toolGroupExpansionKey('live-a'), true)
  setThinkingExpanded(thinkingExpansionKey('assistant:300', 0), true)
  const before = stripTerminalSequences(view.render(100).join('\n'))
  assert.match(before, /click to collapse|to collapse/, 'the live card really is expanded')
  return { store, view, before }
}

function assertLiveDisclosureIntact(live: { view: TranscriptView; before: string }, label: string): void {
  assert.equal(isToolExpanded(toolExpansionKey('live-a')), true, `${label}: live tool override kept`)
  assert.equal(isToolExpanded(toolGroupExpansionKey('live-a')), true, `${label}: live group override kept`)
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:300', 0)), true, `${label}: live reasoning override kept`)
  const after = stripTerminalSequences(live.view.render(100).join('\n'))
  assert.equal(after, live.before, `${label}: the live frame is byte-identical after the historical read`)
}

test('history detail keeps the live tool/group/thinking overrides across read, paging, invalidate and dispose', () => {
  const live = liveViewWithOpenDisclosures()
  // A multi-page historical turn with the same native item/call keys.
  const f = harness({
    outline: THREE_TURNS,
    events: turnEvents(300, 120, 2),
    async: true,
  })
  const detailView = (): TranscriptView => {
    const view = f.dialog.view
    assert.ok(view !== undefined, 'the detail view exists while a turn is open')
    return view
  }

  f.lines()
  f.dialog.handleInput(DOWN)
  f.dialog.handleInput(ENTER)
  // First detail paint can never clear the live maps (the reported failure).
  assert.ok(detailView().readonlyDisclosure, 'the detail view is a read-only disclosure projection')
  f.lines()
  assertLiveDisclosureIntact(live, 'first detail render')

  // Deliver the anchor + automatic forward pages.
  let delivered = 0
  for (let round = 0; round < 20 && f.source.pending > 0; round += 1) delivered += f.source.flush()
  assert.ok(delivered > 1, `the turn was read over several pages (${delivered})`)
  assert.ok(f.dialog.detailEventCount >= 100, 'the historical window really grew')
  f.lines()
  assertLiveDisclosureIntact(live, 'paging')

  f.dialog.invalidate()
  f.lines()
  assertLiveDisclosureIntact(live, 'invalidate')

  f.dialog.closeTurn()
  f.dialog.openSelectedTurn()
  f.lines()
  assertLiveDisclosureIntact(live, 'reopen')

  const view = detailView()
  f.dialog.dispose()
  assert.equal(view.isDisposed, true)
  assertLiveDisclosureIntact(live, 'dispose')
  live.view.dispose()
})

test('the read-only detail stays independently collapsed despite same-key live overrides', () => {
  const live = liveViewWithOpenDisclosures()
  const f = harness({ outline: THREE_TURNS, events: disclosureEvents() })
  f.lines()
  f.dialog.handleInput(DOWN)
  f.dialog.handleInput(ENTER)
  for (let round = 0; round < 5 && f.source.pending > 0; round += 1) f.source.flush()
  const text = f.text()
  assert.doesNotMatch(text, /click to collapse/, 'the detail never inherits an expanded live override')
  assert.doesNotMatch(text, /expanded-only-output/, 'the detail paints the collapsed card, not the live body')
  assertLiveDisclosureIntact(live, 'same-key read-only render')

  // Public toggles on the read-only view are inert and cannot mutate the maps.
  const view = f.dialog.view!
  const expandTools = view.options.expandTools
  view.toggleToolsExpanded()
  assert.equal(view.options.expandTools, expandTools, 'Ctrl+O on a read-only view changes nothing')
  assert.equal(view.toggleLatestThinking(), false, 'the reasoning toggle is inert in a read-only view')
  assertLiveDisclosureIntact(live, 'read-only public toggles')
  view.dispose()
  live.view.dispose()
})

test('the dialog enforces read-only disclosure for a host-supplied createView', () => {
  const live = liveViewWithOpenDisclosures()
  const stores: TranscriptStore[] = []
  const tui = createFakeTui(32, 120)
  const source = createSource(disclosureEvents())
  const dialog = new HistoryDialog(asTui(tui), {
    session: SESSION,
    outline: THREE_TURNS,
    keymap: createCcKeymap(),
    loadWindow: request => source.load(request),
    onClose: () => {},
    // The host factory returns an ordinary live-shaped view (no readonly flag).
    createView: store => {
      stores.push(store)
      return new TranscriptView(store, {
        showThinking: true,
        expandTools: true,
        screen: 'fullscreen',
        groupTools: false,
      })
    },
  })
  source.attach(dialog)
  dialog.focused = true
  dialog.handleInput(DOWN)
  dialog.handleInput(ENTER)
  for (let round = 0; round < 5 && source.pending > 0; round += 1) source.flush()
  const view = dialog.view
  assert.ok(view !== undefined)
  assert.equal(stores.length, 1)
  assert.equal(view.readonlyDisclosure, true, 'the dialog owns the read-only guarantee')
  assert.equal(view.options.readonlyDisclosure, true)
  const text = plain(dialog.render(120)).join('\n')
  assert.doesNotMatch(text, /click to collapse/, 'even expandTools:true stays collapsed in a read-only detail')
  assert.equal(view.toggleLatestThinking(), false)
  view.toggleToolsExpanded()
  assert.equal(view.options.expandTools, true, 'the read-only view never flips its global default')
  assertLiveDisclosureIntact(live, 'custom createView enforcement')
  dialog.dispose()
  live.view.dispose()
})
