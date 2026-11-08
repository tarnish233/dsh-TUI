// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences, type TuiMouseEvent } from '#pi-tui'
import { asTui, createFakeTui } from '../src/input/testing/harness.ts'
import {
  isPrintableByte,
  listStatusLines,
  ModalListSurface,
  windowList,
  type ListBlock,
  type ListBody,
} from '../src/ui/modal-list.ts'

const rows = (count: number, prefix = 'row'): ListBlock[] =>
  Array.from({ length: count }, (_, index) => ({
    lines: [`${prefix} ${index}`],
    index,
    key: `${prefix}:${index}`,
    ...(index === 0 ? { focused: true } : {}),
  }))

const focused = (index: number, count = 10): ListBlock[] =>
  Array.from({ length: count }, (_, item) => ({
    lines: [`row ${item}`],
    index: item,
    key: `row:${item}`,
    ...(item === index ? { focused: true } : {}),
  }))

const event = (type: TuiMouseEvent['type'], x: number, y: number): TuiMouseEvent => ({
  type,
  button: 'left',
  x,
  y,
  screenX: x + 5,
  screenY: y + 5,
  width: 60,
  height: 20,
  shift: false,
  alt: false,
  ctrl: false,
  ...(type === 'click' ? { clickCount: 1 } : {}),
})

// ---------------------------------------------------------------------------
// windowList

test('windowList keeps the focused block visible and reports exact hit rows', () => {
  const window = windowList(focused(8), 4)
  assert.equal(window.lines.length, 4)
  assert.ok(window.lines.includes('row 8'), 'the focused row is in the window')
  assert.deepEqual(window.hits.map(hit => hit.index), [6, 7, 8, 9])
  assert.deepEqual(window.rows, [6, 7, 8, 9])
  for (const hit of window.hits) {
    assert.ok(hit.startRow <= hit.endRow)
    assert.ok(hit.endRow < window.lines.length, 'no hit points at a clipped row')
    assert.match(window.lines[hit.startRow]!, new RegExp(`row ${hit.index}`))
  }
})

test('windowList restores a preferred start when it keeps the focus visible', () => {
  const above = windowList(focused(4), 4, { start: 2 })
  assert.equal(above.start, 2)
  assert.deepEqual(above.hits.map(hit => hit.index), [2, 3, 4, 5])

  // A stale offset below the focus is clamped, and an offset that would hide
  // the focus is re-derived around it (the focus always wins).
  const below = windowList(focused(3), 3, { start: 8 })
  assert.equal(below.start, 3, 'the focused block clamps a stale scroll offset')
  assert.deepEqual(below.hits.map(hit => hit.index), [3, 4, 5])

  const hidden = windowList(focused(8), 4, { start: 3 })
  assert.ok(hidden.hits.some(hit => hit.index === 8))
  assert.equal(hidden.start, 6)
})

test('windowList centers a short picker around its focused row', () => {
  const blocks = focused(7, 12)
  const window = windowList(blocks, 4, { center: true })
  const start = 7 - Math.floor(4 / 2)
  assert.deepEqual(window.hits.map(hit => hit.index), [start, start + 1, start + 2, start + 3])
  assert.ok(window.hits.some(hit => hit.index === 7), 'the center keeps the focused value visible')
  assert.ok(window.hits.every(hit => hit.startRow < 4 && hit.endRow < 4))
})

test('windowList clips a tall block hit to the painted rows and skips non-selectable headers', () => {
  const blocks: ListBlock[] = [
    { lines: ['header'] },
    { lines: ['a1', 'a2', 'a3', 'a4'], index: 0, key: 'a', focused: true },
  ]
  const window = windowList(blocks, 3, { start: 0 })
  assert.deepEqual(window.lines, ['header', 'a1', 'a2'])
  assert.deepEqual(window.hits, [{ startRow: 1, endRow: 2, index: 0, key: 'a' }])
  assert.deepEqual(window.rows, [undefined, 0, 0])
})

test('windowList never backfills an oversized focused block out of the window', () => {
  const blocks: ListBlock[] = [
    { lines: ['before 0'], index: 0, key: 'before:0' },
    { lines: ['before 1'], index: 1, key: 'before:1' },
    { lines: ['tall 1', 'tall 2', 'tall 3'], index: 2, key: 'tall', focused: true },
  ]
  const window = windowList(blocks, 2, { start: 2 })
  assert.deepEqual(window.lines, ['before 1', 'tall 1'], 'backfill leaves one visible focused line')
  assert.deepEqual(window.hits.at(-1), { startRow: 1, endRow: 1, index: 2, key: 'tall' })
  assert.ok(window.hits.every(hit => hit.endRow < window.lines.length))
})

test('windowList claims every block when the budget fits and keeps indexes intact', () => {
  const blocks: ListBlock[] = [
    { lines: ['A'] },
    { lines: ['one', 'two'], index: 4, key: 'x' },
    { lines: ['tail'], index: 9, key: 'y' },
  ]
  const window = windowList(blocks, 10, { start: 2 })
  assert.equal(window.start, 0)
  assert.equal(window.end, 3)
  assert.deepEqual(window.lines, ['A', 'one', 'two', 'tail'])
  assert.deepEqual(window.hits.map(hit => [hit.startRow, hit.endRow, hit.index, hit.key]), [
    [1, 2, 4, 'x'],
    [3, 3, 9, 'y'],
  ])
  assert.deepEqual(windowList(blocks, 0).lines, [])
})

// ---------------------------------------------------------------------------
// ModalListSurface

const surface = () => new ModalListSurface(asTui(createFakeTui(20, 60)))

const config = (ownerKey = 'row:0') => ({
  title: 'List',
  ownerKey,
  beforeRows: 1,
  before: () => ['hdr'],
  status: () => ([] as string[]),
} as const)

const body = (blocks: readonly ListBlock[]): ListBody => windowList(blocks, 12)

function bodyRowOf(lines: readonly string[], needle: string): number {
  const index = lines.findIndex(line => stripTerminalSequences(line).includes(needle))
  assert.ok(index >= 0, `${needle} is painted`)
  return index
}

test('the surface measures before building and maps header/body mouse coordinates', () => {
  const list = surface()
  const seen: Array<[number, number]> = []
  const lines = list.render(60, config(), (bodyWidth, bodyHeight) => {
    seen.push([bodyWidth, bodyHeight])
    return body(focused(0))
  })
  assert.ok(seen.length >= 1)
  assert.ok(seen[0]![0] > 0 && seen[0]![1] > 0, 'the body is built for the measured inner size')
  for (const line of lines) assert.ok(stripTerminalSequences(line).length <= 60)

  // Framed layout: title row 0, one header row 1, separator row 2, body row 3.
  assert.equal(list.beforeIndex(0), undefined)
  assert.equal(list.beforeIndex(1), 0)
  assert.equal(list.beforeIndex(2), undefined)
  const translated = list.bodyMouse(event('move', 4, 3))
  assert.ok(translated !== undefined)
  assert.equal(translated.x, 2)
  assert.equal(translated.y, 0)
  assert.equal(list.bodyMouse(event('move', 1, 3)), undefined, 'the frame border is not body')
  assert.equal(list.bodyHits.length, Math.min(10, list.bodyGeometry!.bodyHeight))
})

test('status rows participate in measurement so the focused row and its hit stay visible', () => {
  const list = new ModalListSurface(asTui(createFakeTui(20, 60)), { maxHeight: 10 })
  const clicks: number[] = []
  const painted = list.render(60, { ...config(), status: () => ['Saving…'] }, (width, height) => {
    assert.ok(width > 0)
    return windowList(focused(9), height)
  })
  assert.match(stripTerminalSequences(painted.join('\n')), /Saving…/)
  const y = bodyRowOf(painted, 'row 9')
  assert.equal(list.bodyHits.at(-1)?.index, 9, 'the focused row is the final painted body row')
  list.rowMouse(event('click', 8, y), 'row:0', hit => clicks.push(hit.index))
  assert.deepEqual(clicks, [9])
})

test('a short list shrinks to its content but keeps a usable frame', () => {
  const list = surface()
  const short = list.render(60, config(), () => body(focused(0).slice(0, 2)))
  assert.ok(short.length < 20)
  assert.ok(short.some(line => stripTerminalSequences(line).includes('row 1')))
})

test('a row press pins the gesture without a redundant repaint and the click activates once', () => {
  const list = surface()
  const painted = list.render(60, config(), () => body(focused(0)))
  const y = bodyRowOf(painted, 'row 3')
  const hits: number[] = []
  const onClick = (hit: { index: number }) => hits.push(hit.index)
  assert.deepEqual(list.rowMouse(event('press', 8, y), 'row:0', onClick), { handled: true, render: false }, 'pinning has no visible state change')
  assert.deepEqual(hits, [], 'press does not activate or move the selected row')
  assert.deepEqual(list.rowMouse(event('release', 8, y), 'row:0', onClick), undefined)
  assert.deepEqual(list.rowMouse(event('click', 8, y), 'row:0', onClick), { handled: true, render: true })
  assert.deepEqual(hits, [3])
})

test('a press pins the pressed row and a repaint cannot move that click', () => {
  const list = surface()
  // First paint: row 4 sits under its own body row.
  let blocks: ListBlock[] = focused(4).map((block, index) => ({ ...block, focused: index === 4 }))
  let painted = list.render(60, config('row:4'), () => body(blocks))
  const y = bodyRowOf(painted, 'row 4')
  const x = 8
  assert.equal(list.rowMouse(event('press', x, y), 'row:4', () => {})?.handled, true)

  // A repaint inserts a spacer block, so "row 4" moves one row down.
  blocks = [{ lines: ['spacer'] }, ...focused(4).map((block, index) => ({ ...block, focused: index === 4 }))]
  painted = list.render(60, config('row:4'), () => body(blocks))
  const clicks: number[] = []
  const result = list.rowMouse(event('click', x, y), 'row:4', hit => clicks.push(hit.index))
  assert.deepEqual(result, { handled: true, render: true })
  assert.deepEqual(clicks, [4], 'the pressed identity wins over the moved paint row')
})

test('a click without a press still selects the painted row', () => {
  const list = surface()
  const painted = list.render(60, config(), () => body(focused(0)))
  const hits: number[] = []
  assert.equal(list.rowMouse(event('click', 8, bodyRowOf(painted, 'row 3')), 'row:0', hit => hits.push(hit.index))?.handled, true)
  assert.deepEqual(hits, [3])
})

test('drag, owner change, vanished rows and non-left buttons void a pinned click', () => {
  const list = surface()
  const pressAt = (needle: string, owner: string): number => {
    const painted = list.render(60, config(owner), () => body(focused(0)))
    const y = bodyRowOf(painted, needle)
    assert.equal(list.rowMouse(event('press', 8, y), owner, () => {})?.handled, true)
    return y
  }

  // Drag drops the pin: a later click resolves whatever is painted now.
  const dragY = pressAt('row 3', 'row:0')
  const shifted = [{ lines: ['spacer'] }, ...focused(0).map((block, index) => ({ ...block, focused: index === 0 }))]
  list.render(60, config('row:0'), () => body(shifted))
  assert.equal(list.rowMouse(event('drag', 8, dragY), 'row:0', () => {}), undefined)
  const afterDrag: number[] = []
  assert.equal(list.rowMouse(event('click', 8, dragY), 'row:0', hit => afterDrag.push(hit.index))?.handled, true)
  assert.deepEqual(afterDrag, [2], 'the click sees the row painted under the pointer, not the old pin')

  // The owner key changed (the footer target moved on) before the release.
  const ownerY = pressAt('row 3', 'row:0')
  list.render(60, config('row:2'), () => body(focused(2)))
  assert.deepEqual(list.rowMouse(event('click', 8, ownerY), 'row:2', () => {}), { handled: true, render: false })

  // The pressed row was clipped away by a new window.
  const goneY = pressAt('row 3', 'row:0')
  const painted = list.render(60, config('row:0'), () => windowList(focused(9), 4))
  assert.ok(!painted.some(line => stripTerminalSequences(line).includes('row 3')))
  assert.deepEqual(list.rowMouse(event('click', 8, goneY), 'row:0', () => {}), { handled: true, render: false })

  // Non-left buttons never become a list action.
  const painted2 = list.render(60, config('row:0'), () => body(focused(0)))
  const y = bodyRowOf(painted2, 'row 3')
  assert.equal(list.rowMouse({ ...event('click', 8, y), button: 'right' as const }, 'row:0', () => {}), undefined)
})

test('chrome is not body, and body hits never outlive a clear', () => {
  const list = surface()
  const painted = list.render(60, config(), () => body(focused(0)))
  assert.ok(painted.length > 0)
  assert.equal(list.bodyMouse(event('click', 8, 0)), undefined, 'title/chrome row')
  list.invalidate()
  assert.equal(list.bodyGeometry, undefined)
  assert.deepEqual(list.bodyHits, [])
  assert.equal(list.rowMouse(event('click', 8, 3), 'row:0', () => {}), undefined)
})

// ---------------------------------------------------------------------------
// Small shared helpers

test('status rows are bounded and empty messages paint nothing', () => {
  assert.deepEqual(listStatusLines('', false, 40), [])
  assert.deepEqual(listStatusLines('Saved', false, 40).map(stripTerminalSequences), [' Saved'])
  const long = listStatusLines('failure '.repeat(30), true, 30)
  assert.equal(long.length, 2)
  for (const line of long) assert.ok(stripTerminalSequences(line).length <= 30)
})

test('a printable byte is text while navigation keys are not', () => {
  assert.equal(isPrintableByte('j'), true)
  assert.equal(isPrintableByte(' '), true)
  assert.equal(isPrintableByte('\x0e'), false)
  assert.equal(isPrintableByte('\x1b[B'), false)
  assert.equal(isPrintableByte('ab'), false)
})