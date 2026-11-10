// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '#pi-tui'
import { createCcKeymap } from '../src/input/index.ts'
import { HistorySearch } from '../src/history-search.ts'
import { asTui, createFakeTui } from '../src/input/testing/harness.ts'

type Complete = [text: string | undefined, execute: boolean]

const history = (): string[] => Array.from({ length: 40 }, (_, index) =>
  `prompt ${index} ${index % 3 === 0 ? 'target ' : ''}${'long words '.repeat(index % 5)}`.trim(),
)

interface Harness {
  search: HistorySearch
  tui: ReturnType<typeof createFakeTui>
  events: Complete[]
  plain: (lines: string[]) => string
  render: (width: number) => string[]
  measure: (width: number) => number
}

function harness(options: {
  mode?: 'inline' | 'fullscreen'
  rows?: number
  keymap?: ReturnType<typeof createCcKeymap>
  complete?: (text: string | undefined, execute: boolean) => void
} = {}): Harness {
  const tui = createFakeTui(options.rows ?? 60, 120)
  const events: Complete[] = []
  const search = new HistorySearch(
    asTui(tui),
    history(),
    options.keymap ?? createCcKeymap(),
    options.mode ?? 'inline',
    (text, execute) => {
      events.push([text, execute])
      options.complete?.(text, execute)
    },
  )
  search.focused = true
  return {
    search,
    tui,
    events,
    plain: lines => stripTerminalSequences(lines.join('\n')),
    render: width => search.render(width),
    measure: width => search.measureRows(width),
  }
}

/** Width-safe: every painted row fits the passed column budget. */
function assertWidths(lines: readonly string[], width: number): void {
  for (const line of lines) {
    const used = visibleWidth(stripTerminalSequences(line))
    assert.ok(used <= width, `row fits ${width} columns (got ${used}): ${JSON.stringify(stripTerminalSequences(line))}`)
  }
}

test('composer geometry: measureRows equals render and never exceeds the cap at 12/18/24/40 x 40/80/120', () => {
  for (const cap of [12, 18, 24, 40]) {
    for (const width of [40, 80, 120]) {
      const h = harness()
      h.search.setInteractionLayout({ placement: 'composer', maxHeight: cap })
      h.search.editor.setText('target')
      const lines = h.render(width)
      assert.equal(h.measure(width), lines.length, `measureRender equality cap=${cap} width=${width}`)
      assert.ok(lines.length <= cap, `bounded by cap=${cap} at width=${width}`)
      assertWidths(lines, width)
      assert.match(stripTerminalSequences(lines[0]!), /History search/)
      assert.match(stripTerminalSequences(lines.at(-1)!), /cancel|edit/, 'mode footer stays visible')
      // A short result set is not padded up to the cap.
      assert.ok(lines.length < cap, `no unnecessary padding at cap=${cap} width=${width}`)
      h.search.dispose()
    }
  }
})

test('a long query is bounded with the query and footer kept inside the cap', () => {
  const h = harness()
  h.search.setInteractionLayout({ placement: 'composer', maxHeight: 12 })
  h.search.editor.setText(Array.from({ length: 30 }, (_, index) => `query line ${index}`).join('\n'))
  const lines = h.render(60)
  assert.equal(h.measure(60), lines.length, 'measure matches render under truncation')
  assert.equal(lines.length, 12, 'the hard cap is used, never exceeded')
  assert.match(stripTerminalSequences(lines[0]!), /History search/)
  assert.match(stripTerminalSequences(lines.at(-1)!), /cancel|edit/)
  assert.ok(lines.some(line => line.includes(CURSOR_MARKER)), 'the cursor row survives query clipping')
  assertWidths(lines, 60)
})

test('layout updates are idempotent and presentation-only', () => {
  const h = harness()
  h.search.setInteractionLayout({ placement: 'composer', maxHeight: 18 })
  h.search.editor.setText('target')
  const editor = h.search.editor
  const before = h.measure(80)
  const requests = h.tui.renderRequests
  h.search.setInteractionLayout({ placement: 'composer', maxHeight: 18 })
  h.search.setInteractionLayout({ placement: 'composer', maxHeight: 18 })
  assert.equal(h.measure(80), before, 'repeated identical layout changes nothing')
  assert.equal(h.tui.renderRequests, requests, 'layout change never requests a frame')
  assert.equal(h.search.editor, editor, 'the one query editor is never replaced')
  assert.equal(h.search.focused, true, 'layout change never moves focus')
  assert.equal(h.search.isPasting, false)
  // A real cap change is reflected by the same pure measurement.
  h.search.setInteractionLayout({ placement: 'composer', maxHeight: 6 })
  assert.ok(h.measure(80) <= 6)
  assert.equal(h.measure(80), h.render(80).length)
  h.search.dispose()
})

test('the completion callback is delivered once and disposal retires the query listener', () => {
  const h = harness()
  h.search.setInteractionLayout({ placement: 'composer', maxHeight: 24 })
  h.search.handleInput('target')
  h.search.handleInput('\r')
  assert.equal(h.events.length, 1, 'one completion')
  assert.equal(typeof h.events[0]![0], 'string')
  assert.equal(h.events[0]![1], true, 'inline Enter sends')
  assert.equal(h.search.isCompleted, true)

  h.search.handleInput('\r')
  h.search.handleInput('\x1b')
  h.search.handleInput('\x03')
  assert.deepEqual(h.events.length, 1, 'late input cannot complete twice')

  const requests = h.tui.renderRequests
  h.search.dispose()
  h.search.dispose()
  assert.equal(h.search.isDisposed, true)
  assert.equal(h.search.editor.onChange, undefined, 'query listener retired')
  assert.equal(h.search.editor.onAction, undefined, 'action sink retired')
  h.search.handleInput('\r')
  assert.equal(h.events.length, 1)
  assert.equal(h.tui.renderRequests, requests, 'disposed input is inert')
})

test('disposal never completes, restores through the callback, and keeps one editor state', () => {
  const h = harness()
  const editor = h.search.editor
  h.search.editor.setText('target')
  h.search.dispose()
  assert.deepEqual(h.events, [], 'dispose is not a completion')
  assert.equal(h.search.editor, editor, 'no second main/query editor is created')
  assert.equal(h.measure(80), 0)
  assert.deepEqual(h.search.render(80), [])
})

test('inline Enter sends, Tab edits; fullscreen Enter edits; default local Ctrl+C restores', () => {
  const inline = harness()
  inline.search.handleInput('target')
  inline.search.handleInput('\t')
  assert.deepEqual(inline.events, [[inline.events[0]![0], false]], 'inline Tab inserts for editing')

  const fullscreen = harness({ mode: 'fullscreen' })
  fullscreen.search.handleInput('target')
  fullscreen.search.handleInput('\r')
  assert.equal(fullscreen.events.length, 1)
  assert.equal(fullscreen.events[0]![1], false, 'fullscreen Enter edits, never sends')

  const cancel = harness()
  cancel.search.handleInput('target')
  cancel.search.handleInput('\x03')
  assert.deepEqual(cancel.events, [[undefined, false]], 'default local Ctrl+C cancels and restores')
})

test('disabled/remapped local cancel never falls back to global app.clear', () => {
  const disabled = harness({ keymap: createCcKeymap({ bindings: { 'historySearch.cancel': null } }) })
  disabled.search.handleInput('target')
  disabled.search.handleInput('\x03')
  assert.deepEqual(disabled.events, [], 'disabled historySearch.cancel is not replaced by app.clear')
  assert.equal(disabled.search.isCompleted, false)
  assert.equal(disabled.search.editor.getExpandedText(), 'target', 'the query is untouched')

  const remapped = harness({ keymap: createCcKeymap({ bindings: { 'historySearch.cancel': 'ctrl+g' } }) })
  remapped.search.handleInput('target')
  remapped.search.handleInput('\x03')
  assert.deepEqual(remapped.events, [], 'the old Ctrl+C is inert after the remap')
  remapped.search.handleInput('\x07')
  assert.deepEqual(remapped.events, [[undefined, false]], 'the configured cancel key still works')

  // An explicit native interrupt override keeps local-first cancellation.
  const interrupt = harness({ keymap: createCcKeymap({ bindings: { 'app.interrupt': 'ctrl+c' } }) })
  interrupt.search.handleInput('target')
  interrupt.search.handleInput('\x03')
  assert.deepEqual(interrupt.events, [[undefined, false]], 'search cancels locally; no native abort from here')
})

test('bracketed paste treats Ctrl+C bytes as content, never a cancel', () => {
  const h = harness()
  h.search.handleInput('prefix ')
  h.search.handleInput('\x1b[200~x\x03y\x1b[201~')
  assert.deepEqual(h.events, [], 'a Ctrl+C byte inside a paste never cancels')
  assert.equal(h.search.isCompleted, false)
  const text = h.search.editor.getExpandedText()
  assert.equal(text, 'prefix xy', 'the paste is ordinary text content')
})
