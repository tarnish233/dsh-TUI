// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, type TuiMouseEvent, visibleWidth } from '#pi-tui'
import type { SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import type { ToolTranscriptItem } from '../src/state/transcript.ts'
import { HitboxRegistry, HoverOwnership, hoverExitEvent } from '../src/ui/mouse.ts'
import { t } from '../src/ui/theme.ts'
import { clearThinkingExpansion } from '../src/ui/thinking-block.ts'
import { clearToolExpansion, setToolExpanded, toolExpansionKey, toolGroupExpansionKey } from '../src/ui/tool-expansion.ts'
import { TranscriptView } from '../src/ui/transcript.ts'

/**
 * Hover ownership: one ephemeral blue hint per visible pointer target.
 *
 * The bug these tests pin down: pointer motion is routed to *one* block per
 * event, so a card/group the pointer left kept its `hovered` hitbox forever and
 * painted a blue "click to expand / show more" hint on historical rows nobody
 * was pointing at. Only the current target may be blue; every other hint is the
 * neutral default again.
 */

// ---------------------------------------------------------------------------
// Fixtures (synthetic DSH events only; no backend, no model, no stdout)

const info = (events: SessionEvent[] = [], sessionId = 's1'): SessionInfo => ({
  sessionId,
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: [],
  events,
})

const ev = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  data,
  ...extra,
})

const userEvent = (seq: number, text: string): SessionEvent =>
  ev('user/message', seq, {
    id: `u${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })

const callEvent = (seq: number, callId: string, name: string, args: string): SessionEvent =>
  ev('tool/call', seq, { turn: 1, step: 1, callId, name, arguments: args })

const resultEvent = (seq: number, callId: string, text: string): SessionEvent =>
  ev('tool/result', seq, {
    turn: 1,
    step: 1,
    message: {
      id: `res-${seq}`,
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError: false,
      source: { kind: 'tool', callId },
    },
  }, { surfaceOp: 'append' })

const assistantThinking = (seq: number, reasoning: string, text = 'answer'): SessionEvent =>
  ev('assistant/message', seq, {
    turn: 1,
    step: 1,
    message: {
      id: `a${seq}`,
      role: 'assistant',
      content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }],
      source: { kind: 'model', provider: 'demo', model: 'demo' },
    },
    stream: [],
  }, { surfaceOp: 'append' })

function newStore(events: SessionEvent[] = []): TranscriptStore {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info(events))
  return store
}

interface ViewOverrides {
  showThinking?: boolean
  expandTools?: boolean
  groupTools?: boolean
  screen?: 'inline' | 'fullscreen'
  thinkingPreviewLines?: number
  mouseBlocked?: boolean
  hints?: { expand?: string; toolsDetails?: string; thinking?: string }
  onRenderRequest?: () => void
  onSubagentDetails?: (sessionId: string) => void
}

function view(store: TranscriptStore, overrides: ViewOverrides = {}): TranscriptView {
  return new TranscriptView(store, {
    showThinking: overrides.showThinking ?? false,
    expandTools: overrides.expandTools ?? false,
    groupTools: overrides.groupTools ?? false,
    // Fullscreen is the mode that prints `click to expand` on the hover target.
    screen: overrides.screen ?? 'fullscreen',
    hints: overrides.hints ?? {},
    ...(overrides.thinkingPreviewLines === undefined ? {} : { thinkingPreviewLines: overrides.thinkingPreviewLines }),
    ...(overrides.mouseBlocked === undefined ? {} : { mouseBlocked: overrides.mouseBlocked }),
    ...(overrides.onRenderRequest === undefined ? {} : { onRenderRequest: overrides.onRenderRequest }),
    ...(overrides.onSubagentDetails === undefined ? {} : { onSubagentDetails: overrides.onSubagentDetails }),
  })
}

type MouseKind = TuiMouseEvent['type']

const mouseAt = (type: MouseKind, x: number, y: number, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type,
  button: type === 'move' ? 'none' : 'left',
  x,
  y,
  screenX: x,
  screenY: y,
  width: 70,
  height: 40,
  shift: false,
  alt: false,
  ctrl: false,
  ...overrides,
})

const reset = (): void => {
  clearToolExpansion()
  clearThinkingExpansion()
}

const linesOf = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

const rowIndexOf = (lines: readonly string[], needle: string): number =>
  linesOf(lines).findIndex(line => line.includes(needle))

/** Rows whose hint is painted in the hover accent (blue). */
const blueHintRows = (lines: readonly string[], hint: string): number[] =>
  lines.flatMap((line, row) =>
    (line.includes(t.accent(hint)) || line.includes(t.accent(` · ${hint}`)) ? [row] : []))

/** Rows whose hint is painted in the neutral default tier. */
const neutralHintRows = (lines: readonly string[], hint: string): number[] =>
  lines.flatMap((line, row) =>
    (line.includes(t.subtle(hint)) || line.includes(t.muted(` · ${hint}`)) ? [row] : []))

// ---------------------------------------------------------------------------
// The shared helper

test('the synthetic leave is a plain motion outside every declarable rect', () => {
  const base = mouseAt('press', 4, 2, { shift: true })
  const exit = hoverExitEvent(base)
  assert.equal(exit.type, 'move', 'never press/click/drag: no gesture may be invented')
  assert.equal(exit.x, -1)
  assert.equal(exit.y, -1)
  assert.equal(exit.shift, true, 'modifier shape of the real gesture is preserved')

  const hovered: boolean[] = []
  let clicks = 0
  let presses = 0
  const reg = new HitboxRegistry()
  reg.sync([{
    id: 'hint',
    startRow: 2,
    endRow: 2,
    onClick: () => { clicks++ },
    onHover: entering => hovered.push(entering),
  }])
  const press = reg.handleMouse(mouseAt('press', 4, 2))
  assert.deepEqual(press, { handled: true })
  presses += 1
  assert.equal(hovered.length, 0, 'a press never touches hover')

  assert.deepEqual(reg.handleMouse(mouseAt('move', 4, 2)), { handled: true, render: true })
  assert.deepEqual(hovered, [true])
  // The synthetic leave clears exactly the hover; the pinned press survives so
  // the synthesized click still lands on the row the user pressed.
  reg.handleMouse(exit)
  assert.deepEqual(hovered, [true, false])
  assert.equal(reg.hoverTarget(), undefined)
  assert.equal(presses, 1)
  assert.deepEqual(reg.handleMouse(mouseAt('click', 4, 2)), { handled: true, render: true })
  assert.equal(clicks, 1, 'the press pin was not dropped just to clear the hover')
})

test('one hover owner: a new target releases the previous one, a repeat does not', () => {
  const entered: string[] = []
  const make = (id: string) => ({
    render: () => [],
    invalidate: () => {},
    handleMouse: (event: TuiMouseEvent) => {
      entered.push(`${id}:${event.type}@${event.x},${event.y}`)
      return { handled: true as const }
    },
  })
  const a = make('a')
  const b = make('b')
  const ownership = new HoverOwnership()
  const move = mouseAt('move', 3, 7)
  ownership.moveTo({ component: a, slot: 'row 0' }, move)
  assert.equal(ownership.current, a)
  ownership.moveTo({ component: a, slot: 'row 0' }, move)
  assert.equal(ownership.current, a)
  // Same component re-based to another row is a different target.
  ownership.moveTo({ component: b, slot: 'row 4' }, move)
  assert.equal(ownership.current, b)
  ownership.release()
  assert.equal(ownership.current, undefined)
  assert.equal(ownership.placement, undefined)
  ownership.retain([{ component: b, slot: 'row 4' }])
  assert.equal(ownership.current, undefined, 'release is idempotent')
})

test('a nested leave from a host never drops the target being adopted', () => {
  // Mirrors a group: its own synthetic leave is delivered as a nested
  // `handleMouse` that re-enters the *same* helper. The target being adopted
  // must survive that re-entry, or a child-to-child move would leave the
  // previous child blue (the three-blue-hints bug).
  const exits: string[] = []
  const ownership = new HoverOwnership()
  const host = {
    render: () => [],
    invalidate: () => {},
    handleMouse: (event: TuiMouseEvent) => {
      if (event.y < 0) ownership.moveTo(undefined, event)
      return { handled: true as const }
    },
  }
  const child = (id: string) => ({
    render: () => [],
    invalidate: () => {},
    handleMouse: (event: TuiMouseEvent) => {
      if (event.y < 0) exits.push(id)
      return { handled: true as const }
    },
  })
  const first = child('first')
  const second = child('second')

  ownership.moveTo({ component: host, slot: 'header' }, mouseAt('move', 1, 0))
  ownership.moveTo({ component: first, slot: 'row 1' }, mouseAt('move', 1, 1))
  assert.equal(ownership.current, first, 'the adopted child was not dropped by the nested leave')
  assert.deepEqual(exits, [], 'the newly adopted child never heard an exit')

  ownership.moveTo({ component: second, slot: 'row 4' }, mouseAt('move', 1, 4))
  assert.equal(ownership.current, second)
  assert.deepEqual(exits, ['first'], 'exactly the previous child was released')
})

// ---------------------------------------------------------------------------
// Two standalone cards

function twoCardView(overrides: ViewOverrides = {}): { view1: TranscriptView; render: () => string[] } {
  const store = newStore([
    userEvent(1, 'run the two commands'),
    callEvent(2, 'call-a', 'bash', '{"command":"npm test"}'),
    resultEvent(3, 'call-a', 'ok\n'),
    callEvent(4, 'call-b', 'bash', '{"command":"npm run build"}'),
    resultEvent(5, 'call-b', 'built\n'),
  ])
  const view1 = view(store, overrides)
  return { view1, render: () => view1.render(70) }
}

test('two standalone cards: hovering one row leaves the other hint neutral', () => {
  reset()
  const { view1, render } = twoCardView()
  const first = render()
  const rows = first.flatMap((line, row) => (stripTerminalSequences(line).includes('click to expand') ? [row] : []))
  assert.equal(rows.length, 2, 'both cards advertise one click hint')
  assert.deepEqual(blueHintRows(first, 'click to expand'), [], 'nothing is blue before the pointer moves')
  assert.equal(neutralHintRows(first, 'click to expand').length, 2)

  // Hover the first card's result row.
  view1.handleMouse(mouseAt('move', 4, rows[0]!))
  const one = render()
  assert.deepEqual(blueHintRows(one, 'click to expand'), [rows[0]!])
  assert.equal(view1.hoverOwnerItemId, 'tool:call-a')

  // Hover the second: the first hint must revert to neutral in the same frame.
  view1.handleMouse(mouseAt('move', 4, rows[1]!))
  const two = render()
  assert.deepEqual(blueHintRows(two, 'click to expand'), [rows[1]!])
  assert.equal(view1.hoverOwnerItemId, 'tool:call-b')
  // Only the pointed row is blue; both hints stay painted exactly once each.
  assert.equal(neutralHintRows(two, 'click to expand').length, 1)
})

test('moving into the row gap or out of the transcript releases the hint', () => {
  reset()
  const { view1, render } = twoCardView()
  const first = render()
  const rows = first.flatMap((line, row) => (stripTerminalSequences(line).includes('click to expand') ? [row] : []))
  const gapRow = linesOf(first).findIndex(line => line === '')

  view1.handleMouse(mouseAt('move', 4, rows[0]!))
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [rows[0]!])

  // A block with nothing clickable is still the new pointer target: the card the
  // pointer left reverts, and a plain text row paints no hover at all.
  view1.handleMouse(mouseAt('move', 4, 0))
  assert.notEqual(view1.hoverOwnerItemId, 'tool:call-a', 'the new block owns the hover')
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [])

  // A row outside every block (empty transcript root) has no target at all.
  view1.handleMouse(mouseAt('move', 4, rows[1]!))
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [rows[1]!])
  view1.handleMouse(mouseAt('move', 4, 9_999))
  assert.equal(view1.hoverOwnerItemId, undefined)
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [])

  // The blank separator line between blocks belongs to no block either.
  assert.ok(gapRow >= 0, 'the frame separates blocks with a blank row')
  view1.handleMouse(mouseAt('move', 4, rows[0]!))
  view1.handleMouse(mouseAt('move', 4, gapRow))
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [])
  assert.equal(view1.hoverOwnerItemId, undefined)

  // Re-enter, then the parent reports the pointer leaving the transcript box
  // (editor/status/overlay): the view never sees that motion itself.
  view1.handleMouse(mouseAt('move', 4, rows[1]!))
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [rows[1]!])
  view1.releaseHover()
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [])
  assert.equal(view1.hoverOwnerItemId, undefined)
})

test('a wheel scroll and a terminal resize release a hint the pointer no longer covers', () => {
  reset()
  const { view1, render } = twoCardView()
  const rows = render().flatMap((line, row) => (stripTerminalSequences(line).includes('click to expand') ? [row] : []))
  view1.handleMouse(mouseAt('move', 4, rows[0]!))
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [rows[0]!])

  // Wheel: every hitbox scrolled under a stationary pointer.
  view1.handleMouse(mouseAt('wheel', 4, rows[0]!, { wheelDelta: -1 }))
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [])
  assert.equal(view1.hoverOwnerItemId, undefined)

  // Re-enter, then a resize re-flows the rows.
  view1.handleMouse(mouseAt('move', 4, rows[0]!))
  view1.render(40)
  assert.deepEqual(blueHintRows(view1.render(40), 'click to expand'), [])
  assert.equal(view1.hoverOwnerItemId, undefined)
})

test('a modal overlay owns the pointer: the transcript hint goes neutral', () => {
  reset()
  const { view1, render } = twoCardView()
  const rows = render().flatMap((line, row) => (stripTerminalSequences(line).includes('click to expand') ? [row] : []))
  view1.handleMouse(mouseAt('move', 4, rows[0]!))
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [rows[0]!])

  view1.options.mouseBlocked = true
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [])
  assert.equal(view1.hoverOwnerItemId, undefined)
  // The blocked view also refuses to adopt a new target behind the overlay.
  assert.equal(view1.handleMouse(mouseAt('move', 4, rows[1]!)), undefined)
  assert.equal(view1.hoverOwnerItemId, undefined)
})

test('a drag moves the hover but never opens a block', () => {
  reset()
  const { view1, render } = twoCardView()
  const rows = render().flatMap((line, row) => (stripTerminalSequences(line).includes('click to expand') ? [row] : []))
  view1.handleMouse(mouseAt('move', 4, rows[0]!))
  // A drag is not a click: no disclosure may flip, and hover still follows the pointer.
  view1.handleMouse(mouseAt('drag', 4, rows[1]!))
  assert.equal(view1.expandedDisclosureCount, 0)
  assert.deepEqual(blueHintRows(render(), 'click to expand'), [rows[1]!])
  assert.equal(view1.hoverOwnerItemId, 'tool:call-b')
})

test('reasoning hover and tool hover never stay blue together', () => {
  reset()
  const store = newStore([
    assistantThinking(1, ['first thought line', 'second thought line', 'third thought line'].join('\n')),
    callEvent(2, 'call-a', 'bash', '{"command":"npm test"}'),
    resultEvent(3, 'call-a', 'ok\n'),
  ])
  const view1 = view(store, { showThinking: true, thinkingPreviewLines: 0 })
  const first = view1.render(70)
  const thoughtRow = rowIndexOf(first, 'click to show more')
  const toolRow = rowIndexOf(first, 'click to expand')
  assert.ok(thoughtRow >= 0 && toolRow >= 0)

  view1.handleMouse(mouseAt('move', 4, thoughtRow))
  const thoughtHover = view1.render(70)
  assert.deepEqual(blueHintRows(thoughtHover, 'click to show more'), [thoughtRow])
  assert.deepEqual(blueHintRows(thoughtHover, 'click to expand'), [])

  // Moving to the tool card releases the reasoning summary it just left.
  view1.handleMouse(mouseAt('move', 4, toolRow))
  const toolHover = view1.render(70)
  assert.deepEqual(blueHintRows(toolHover, 'click to expand'), [toolRow])
  assert.deepEqual(blueHintRows(toolHover, 'click to show more'), [])
  assert.deepEqual(neutralHintRows(toolHover, 'click to show more'), [thoughtRow])
})

// ---------------------------------------------------------------------------
// Groups

test('group header and expanded children: exactly one hint is blue at a time', () => {
  reset()
  const store = newStore([
    callEvent(1, 'call-a', 'bash', '{"command":"npm test"}'),
    resultEvent(2, 'call-a', 'ok\n'),
    callEvent(3, 'call-b', 'bash', '{"command":"npm run build"}'),
    resultEvent(4, 'call-b', 'built\n'),
  ])
  const view1 = view(store, { groupTools: true })
  const collapsed = view1.render(70)
  const headerRow = linesOf(collapsed).findIndex(line => line.includes('click to show more'))
  assert.ok(headerRow >= 0)

  // Collapsed group: only the header row advertises the click.
  view1.handleMouse(mouseAt('move', 4, headerRow))
  assert.deepEqual(blueHintRows(view1.render(70), 'click to show more'), [headerRow])
  assert.equal(view1.hoverOwnerItemId, 'tool:call-a')

  // Open it: the header row does not move, so the pointer is still on it and its
  // (re-worded) hint stays blue; no child may advertise a hover it never got.
  setToolExpanded(toolGroupExpansionKey('call-a'), true)
  const expanded = view1.render(70)
  const hintRows = expanded.flatMap((line, row) =>
    (stripTerminalSequences(line).includes('click to collapse') ? [row] : []))
  assert.equal(hintRows.length, 3, 'header plus both expanded child cards')
  assert.equal(headerRow, hintRows[0], 'the group header stays on row 0')
  assert.deepEqual(blueHintRows(expanded, 'click to collapse'), [headerRow])
  assert.equal(view1.hoverOwnerItemId, 'tool:call-a')

  // Hover child 1, then child 2: only the pointed child stays blue.
  view1.handleMouse(mouseAt('move', 6, hintRows[1]!))
  assert.deepEqual(blueHintRows(view1.render(70), 'click to collapse'), [hintRows[1]!])
  view1.handleMouse(mouseAt('move', 6, hintRows[2]!))
  const second = view1.render(70)
  assert.deepEqual(blueHintRows(second, 'click to collapse'), [hintRows[2]!])
  assert.equal(neutralHintRows(second, 'click to collapse').length, 2)

  // Back to the header: the child reverts, the header turns blue.
  view1.handleMouse(mouseAt('move', 4, headerRow))
  const headerHover = view1.render(70)
  assert.deepEqual(blueHintRows(headerHover, 'click to collapse'), [headerRow])
  assert.equal(neutralHintRows(headerHover, 'click to collapse').length, 2)

  // The parent seam (pointer left the transcript box) releases the header and
  // never re-adopts it while the pointer is elsewhere.
  view1.releaseHover()
  assert.deepEqual(blueHintRows(view1.render(70), 'click to collapse'), [])
  assert.equal(view1.hoverOwnerItemId, undefined)
})

test('collapsing a group releases the child hover it painted before', () => {
  reset()
  const store = newStore([
    callEvent(1, 'call-a', 'bash', '{"command":"npm test"}'),
    resultEvent(2, 'call-a', 'ok\n'),
    callEvent(3, 'call-b', 'bash', '{"command":"npm run build"}'),
    resultEvent(4, 'call-b', 'built\n'),
  ])
  const view1 = view(store, { groupTools: true })
  // First paint establishes the session, then the group is opened.
  view1.render(70)
  setToolExpanded(toolGroupExpansionKey('call-a'), true)
  const expanded = view1.render(70)
  const hintRows = expanded.flatMap((line, row) =>
    (stripTerminalSequences(line).includes('click to collapse') ? [row] : []))
  assert.equal(hintRows.length, 3)
  view1.handleMouse(mouseAt('move', 6, hintRows[1]!))
  assert.deepEqual(blueHintRows(view1.render(70), 'click to collapse'), [hintRows[1]!])

  // Disclosure change: the collapsed frame paints none of the child rows.
  setToolExpanded(toolGroupExpansionKey('call-a'), false)
  const collapsed = view1.render(70)
  assert.deepEqual(blueHintRows(collapsed, 'click to collapse'), [])
  // Re-open: the child's cached hint must not come back blue without a pointer.
  setToolExpanded(toolGroupExpansionKey('call-a'), true)
  assert.deepEqual(blueHintRows(view1.render(70), 'click to collapse'), [])
  // The group row itself is still under the pointer, but it owns no blue hint:
  // the collapsed/expanded disclosure did not re-enter the child it dropped.
  assert.equal(view1.hoverOwnerItemId, 'tool:call-a')
})

test('a repaint that re-bases the hovered block releases its hint', () => {
  reset()
  const store = newStore([
    callEvent(1, 'call-a', 'bash', '{"command":"npm test"}'),
    resultEvent(2, 'call-a', 'ok\n'),
    callEvent(3, 'call-b', 'bash', '{"command":"npm run build"}'),
    resultEvent(4, 'call-b', 'built\n'),
  ])
  const view1 = view(store)
  const before = view1.render(70)
  const cardRows = before.flatMap((line, row) =>
    (stripTerminalSequences(line).includes('click to expand') ? [row] : []))
  const secondCardRow = cardRows[1]!
  view1.handleMouse(mouseAt('move', 4, secondCardRow))
  assert.equal(view1.hoverOwnerItemId, 'tool:call-b')
  assert.deepEqual(blueHintRows(view1.render(70), 'click to expand'), [secondCardRow])

  // The first card grows (its disclosure opens), pushing the hovered second card
  // down: its hitbox moved away from the stationary pointer.
  setToolExpanded(toolExpansionKey('call-a'), true)
  view1.render(70)
  assert.equal(view1.hoverOwnerItemId, undefined, 'a re-based hitbox is not the same pointer target')
  assert.deepEqual(blueHintRows(view1.render(70), 'click to expand'), [])
})

// ---------------------------------------------------------------------------
// Width safety of the hover row and the header separator
test('every hover frame stays inside the given width, with one blue hint at most', () => {
  reset()
  const store = newStore([
    callEvent(1, 'call-a', 'read_image', '{"path":"/Users/fulei/图片/a.png"}'),
    resultEvent(2, 'call-a', 'ok\n'),
    callEvent(3, 'call-b', 'run_code', '{"code":"print(1)"}'),
    resultEvent(4, 'call-b', '1\n'),
  ])
  const view1 = view(store, { groupTools: false })
  for (const width of [16, 24, 40, 80]) {
    const lines = view1.render(width)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `row wider than ${width}: ${stripTerminalSequences(line)}`)
    }
    const rows = lines.flatMap((line, row) =>
      (stripTerminalSequences(line).includes('click to expand') ? [row] : []))
    for (const row of rows) {
      view1.handleMouse(mouseAt('move', 2, row))
      const hovered = view1.render(width)
      assert.ok(blueHintRows(hovered, 'click to expand').length <= 1, 'never two blue hints')
      for (const line of hovered) assert.ok(visibleWidth(line) <= width)
    }
  }
})