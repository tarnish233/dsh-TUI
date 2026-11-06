// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'

/**
 * Native `/compact` failures reach the UI as ONE ordinary error notice:
 * `store.report(result.text, 'error')`, rendered by the existing `NoticeBlock`
 * (`●` marker, red body). The backend may enrich a *correlated* compact error by
 * keeping the native generic text and appending a bounded, redacted
 * `Native cause: …` line.
 *
 * This file pins the frontend half of that contract only:
 *   - the generic text and the cause line are rendered verbatim and readably,
 *     inline and fullscreen, at narrow and normal widths;
 *   - no second notice plane, no re-labelling, no dropped detail;
 *   - the generic fallback (no detail) is unchanged;
 *   - a successful compact is never presented as an error;
 *   - terminal/control bytes in a native cause cannot paint the screen.
 *
 * Compaction itself, the correlation and the redaction are backend-owned and
 * deliberately not implemented or asserted here.
 */

const RED = '\x1b[38;2;255;123;114m'
/** Control bytes a notice must never paint (C0 except LF, DEL and C1). */
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/

/** The native generic text the correlated compact failure keeps first. */
const GENERIC = 'Compaction failed: /compact did not complete.'
/** The bounded, redacted native cause the backend appends (one physical line). */
const CAUSE =
  'Native cause: 400 InvalidParameter error: enable_thinking is not supported for this model (provider=deepseek, model=deepseek-chat, request=POST /v1/messages)'
const DETAILED = `${GENERIC}\n${CAUSE}`

const info = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: 's1',
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: ['streaming'],
  events,
})

function errorStore(text: string = DETAILED): TranscriptStore {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info())
  store.report(text, 'error')
  return store
}

function render(store: TranscriptStore, width: number, screen: 'inline' | 'fullscreen' = 'inline'): {
  raw: string[]
  plain: string[]
} {
  const raw = new TranscriptView(store, { showThinking: false, expandTools: false, screen }).render(width)
  return { raw, plain: raw.map(line => stripTerminalSequences(line)) }
}

const widths = [20, 24, 40, 60, 80, 100, 120] as const
const screens = ['inline', 'fullscreen'] as const

test('a detailed native compact error renders its generic text and cause verbatim', () => {
  const store = errorStore()
  // Wide enough that nothing needs reflowing: the rows must be the exact text.
  for (const screen of screens) {
    const { raw, plain } = render(store, 200, screen)
    assert.deepEqual(plain, [`● ${GENERIC}`, `  ${CAUSE}`], `${screen}: one notice, two verbatim rows`)
    assert.ok(raw[0]!.startsWith(`${RED}● `), `${screen}: the marker row is error red`)
    assert.ok(raw[1]!.startsWith(`  ${RED}`), `${screen}: the cause row keeps the error red`)
    // The concise native text is not a wire-level `agent error:` envelope, so
    // it must not be relabelled into a provider "API Error" headline.
    assert.ok(!plain.join('\n').includes('API Error'))
  }
})

test('the cause line stays readable at realistic terminal widths', () => {
  const store = errorStore()
  for (const width of [60, 80, 100, 120] as const) {
    for (const screen of screens) {
      const { raw, plain } = render(store, width, screen)
      assert.equal(plain[0]!.startsWith('● Compaction failed:'), true, `width ${width}: the headline owns the marker row`)
      assert.equal(plain.filter(line => line.includes('●')).length, 1, `width ${width}: exactly one marker row`)
      // The cause is its own paragraph: it always starts on a fresh row and is
      // never merged into the headline or dropped by the fold.
      const causeRow = plain.findIndex(line => line.startsWith('  Native cause:'));
      assert.ok(causeRow > 0, `width ${width}: the cause keeps its own row`)
      assert.ok(visibleWidth(raw[causeRow]!) <= width, `width ${width}: cause row fits`)
      // Readable, not a wall: the whole message stays a handful of rows.
      assert.ok(plain.length <= 5, `width ${width}: ${plain.length} rows`)
      assert.ok(raw.every(line => line.includes(RED)), `width ${width}: every row is the red notice body`)
    }
  }
})

test('no character of the generic text or the cause is lost when wrapping', () => {
  const store = errorStore()
  const squeezedSource = `${GENERIC}\n${CAUSE}`.replace(/\s+/g, '')
  for (const width of widths) {
    for (const screen of screens) {
      const { raw, plain } = render(store, width, screen)
      const squeezed = plain.join('\n').replace(/\s+/g, '')
      assert.ok(squeezed.includes(squeezedSource), `${screen} width ${width}: the message survived wrapping`)
      assert.ok(squeezed.includes('Nativecause:400InvalidParameter'), `${screen} width ${width}: the cause prefix survived`)
      assert.ok(squeezed.includes('enable_thinkingisnotsupported'), `${screen} width ${width}: the model-facing reason survived`)
      for (const line of raw) {
        assert.ok(visibleWidth(line) <= width, `${screen} width ${width}: ${visibleWidth(line)} > ${width}`)
        assert.doesNotMatch(stripTerminalSequences(line), CONTROL, `${screen} width ${width}: no control byte`)
      }
    }
  }
})

test('the generic fallback without a native detail is unchanged', () => {
  const store = errorStore('Compaction failed.')
  for (const screen of screens) {
    const { raw, plain } = render(store, 80, screen)
    assert.deepEqual(plain, ['● Compaction failed.'])
    assert.ok(raw[0]!.startsWith(`${RED}● `), `${screen}: the fallback keeps the error style`)
    assert.ok(!plain.join('\n').includes('Native cause'), `${screen}: no cause line is invented`)
  }
})

test('a successful compact is never presented as an error', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info())
  store.report('Compaction finished: 24 messages summarized.', 'info')
  for (const screen of screens) {
    const { raw, plain } = render(store, 80, screen)
    assert.deepEqual(plain, ['· Compaction finished: 24 messages summarized.'])
    assert.ok(!raw[0]!.includes(RED), `${screen}: a success row is muted, not red`)
    assert.ok(!plain[0]!.includes('●'), `${screen}: a success row carries no error marker`)
  }
})

test('the notice level decides the presentation; the text is never sniffed', () => {
  // The same detailed body reported as an ordinary (success/status) notice stays
  // muted: the renderer must not infer failure from words like `InvalidParameter`.
  const status = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  status.reset(info())
  status.report(DETAILED, 'info')
  const muted = render(status, 80)
  assert.ok(muted.plain[0]!.startsWith('· '))
  assert.ok(!muted.raw.some(line => line.includes(RED)), 'an info notice never turns red')
  assert.ok(!muted.plain.some(line => line.includes('●')))
  assert.ok(muted.plain.join('\n').includes('Native cause: 400 InvalidParameter'))

  // ...and a plain success string reported by a failing command is red, because
  // the command outcome (not the text) chose the level.
  const failed = errorStore('Compaction could not start.')
  const red = render(failed, 80)
  assert.ok(red.raw[0]!.startsWith(`${RED}● `))
})

test('terminal and control bytes in a native cause cannot paint the screen', () => {
  const hostile = [
    GENERIC,
    'Native cause: \x1b[31m400 InvalidParameter\x1b[0m \x1b]8;;http://evil.example\x07link\x1b]8;;\x07',
    '\x07\u009b31m\u0085 enable_thinking\tnot supported\x00\x7f for this model',
  ].join('\n')
  const store = errorStore(hostile)
  for (const width of widths) {
    const { raw, plain } = render(store, width)
    const text = plain.join('\n')
    assert.doesNotMatch(text, CONTROL, `width ${width}: no C0/C1/DEL byte reaches the terminal`)
    for (const line of raw) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} > ${width}`)
      const stripped = stripTerminalSequences(line)
      assert.doesNotMatch(stripped, CONTROL, `width ${width}: stripped row is control-free`)
    }
    // The printable content of the cause is still there, just inert.
    assert.ok(text.replace(/\s+/g, '').includes('400InvalidParameter'), `width ${width}: printable cause survived`)
    assert.ok(text.replace(/\s+/g, '').includes('enable_thinkingnotsupported'), `width ${width}: printable reason survived`)
  }
})

test('repeated compact failures keep one readable notice each, and never split the detail', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info())
  store.report(DETAILED, 'error')
  store.report(`${GENERIC}\nNative cause: 400 InvalidParameter error: enable_thinking is disabled`, 'error')
  const notices = store.items.filter(item => item.kind === 'notice')
  assert.equal(notices.length, 2, 'each attempt stays visible')
  assert.equal(notices.filter(item => item.kind === 'notice' && item.text.includes('Native cause:')).length, 2, 'the detail stays on its own notice')
  const { plain } = render(store, 80)
  assert.equal(plain.filter(line => line.includes('●')).length, 2, 'one marker row per failure')
  assert.equal(plain.filter(line => line.includes('Native cause:')).length, 2)
})

test('the notice plane keeps the detail verbatim and ignores empty reports', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info())
  store.report('   \n\t ', 'error')
  assert.equal(store.items.length, 0, 'a blank report adds no empty error row')
  store.report(DETAILED, 'error')
  const [notice] = store.items
  assert.equal(notice?.kind, 'notice')
  if (notice?.kind !== 'notice') return
  assert.equal(notice.level, 'error')
  assert.equal(notice.text, DETAILED, 'the generic text and the cause line are one notice, verbatim')
})

test('a compact failure notice never disturbs the tentative live stream', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info())
  store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'live-compact', revision: 1, turn: 1, step: 1 })
  store.handle({ type: 'stream_chunk', sessionId: 's1', attemptId: 'live-compact', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'still streaming' } })
  const live = store.items.filter(item => item.kind === 'attempt').map(item => structuredClone(item))
  assert.equal(live.length, 1)

  store.report(DETAILED, 'error')

  const liveAfter = store.items.filter(item => item.kind === 'attempt')
  assert.deepEqual(liveAfter, live, 'the pending stream keeps its own text/version')
  const notice = store.items[store.items.length - 1]
  assert.equal(notice?.kind, 'notice', 'the failure is appended after the tentative stream, never merged into it')

  const { plain } = render(store, 80)
  const text = plain.join('\n')
  assert.ok(text.includes('still streaming'))
  assert.ok(text.includes('Native cause: 400 InvalidParameter'))
  assert.ok(!text.includes('Incomplete response'), 'reporting a failure never settles the live attempt')
})