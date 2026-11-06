import assert from 'node:assert/strict'
import test from 'node:test'
import type { TuiMouseEvent, TuiMouseEventType } from '#pi-tui'
import type { MouseHit, MouseHitbox } from '../src/ui/mouse.ts'
import { HitboxRegistry } from '../src/ui/mouse.ts'

/**
 * Synthetic pi-tui events. `x`/`y` are already component-local, exactly what
 * TuiAltScreen hands a component after rewriting the layout box origin.
 */
function event(
  type: TuiMouseEventType,
  x: number,
  y: number,
  extra: Partial<Omit<TuiMouseEvent, 'type' | 'x' | 'y'>> = {},
): TuiMouseEvent {
  return {
    type,
    x,
    y,
    button: 'left',
    screenX: x + 10,
    screenY: y + 3,
    width: 40,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
    ...extra,
  }
}

type HitRecord = { readonly id: string; readonly hit: MouseHit }
type HoverRecord = { readonly id: string; readonly entering: boolean }

/** Registry seeded with instrumented copies of `boxes` (same ids and rects). */
function registry(boxes: readonly MouseHitbox[]) {
  const hits: HitRecord[] = []
  const hovers: HoverRecord[] = []
  const reg = new HitboxRegistry()
  /** Re-declare a frame while keeping the instrumentation (new rects, same ids). */
  const resync = (next: readonly MouseHitbox[]) => {
    reg.sync(
      next.map((box) => ({
        ...box,
        onClick: (hit: MouseHit) => {
          hits.push({ id: box.id, hit })
          box.onClick?.(hit)
        },
        onHover: (entering: boolean) => {
          hovers.push({ id: box.id, entering })
          box.onHover?.(entering)
        },
      })),
    )
  }
  resync(boxes)
  return { reg, hits, hovers, resync }
}

test('press over a hitbox is claimed without side effects; press elsewhere falls through', () => {
  const reg = new HitboxRegistry()
  let clicks = 0
  let hovers = 0
  reg.sync([{ id: 'tool', startRow: 2, endRow: 3, startCol: 4, endCol: 9, onClick: () => clicks++, onHover: () => hovers++ }])

  assert.deepEqual(reg.handleMouse(event('press', 5, 2)), { handled: true })
  assert.equal(clicks, 0, 'press must not run onClick')
  assert.equal(hovers, 0, 'press must not touch hover')
  assert.equal(reg.hoverTarget(), undefined)

  assert.equal(reg.handleMouse(event('press', 5, 6)), undefined, 'row outside the hitbox')
  assert.equal(reg.handleMouse(event('press', 2, 2)), undefined, 'column outside the hitbox')
})

test('click runs onClick with translated coordinates and modifiers', () => {
  let seen: MouseHit | undefined
  const reg = new HitboxRegistry()
  reg.sync([{ id: 'summary', startRow: 4, endRow: 6, startCol: 2, endCol: 20, onClick: (hit) => (seen = hit) }])

  const result = reg.handleMouse(event('click', 7, 5, { clickCount: 1, shift: true, alt: true, ctrl: true }))
  assert.deepEqual(result, { handled: true, render: true })
  assert.deepEqual(seen, { row: 5, col: 7, clickCount: 1, button: 'left', shift: true, alt: true, ctrl: true })
  assert.equal(reg.hoverTarget(), undefined, 'click does not change hover')

  seen = undefined
  assert.equal(reg.handleMouse(event('click', 7, 7)), undefined, 'click outside every hitbox')
  assert.equal(seen, undefined)
})

test('a hitbox without onClick still consumes the click', () => {
  const reg = new HitboxRegistry()
  reg.sync([{ id: 'bare', startRow: 0, endRow: 0 }])
  assert.deepEqual(reg.handleMouse(event('click', 1, 0)), { handled: true, render: true })
})

test('column bounds are honored, and an unbounded hitbox spans the whole row', () => {
  const bounded = registry([{ id: 'link', startRow: 0, endRow: 0, startCol: 10, endCol: 14 }])
  assert.equal(bounded.reg.handleMouse(event('click', 10, 0))?.handled, true)
  assert.equal(bounded.reg.handleMouse(event('click', 14, 0))?.handled, true)
  assert.equal(bounded.reg.handleMouse(event('click', 9, 0)), undefined)
  assert.equal(bounded.reg.handleMouse(event('click', 15, 0)), undefined)

  const full = registry([{ id: 'card', startRow: 1, endRow: 2 }])
  for (const col of [0, 1, 39, 400]) {
    assert.equal(full.reg.handleMouse(event('click', col, 1))?.handled, true, `col ${col} hits a full-width row`)
  }

  const openEnd = registry([{ id: 'tail', startRow: 1, endRow: 1, startCol: 5 }])
  assert.equal(openEnd.reg.handleMouse(event('click', 4, 1)), undefined)
  assert.equal(openEnd.reg.handleMouse(event('click', 5, 1))?.handled, true)
  assert.equal(openEnd.reg.handleMouse(event('click', 300, 1))?.handled, true)
})

test('clickCount passes through so double and triple clicks are distinguishable', () => {
  const { reg, hits } = registry([{ id: 'row', startRow: 0, endRow: 0 }])
  for (const count of [1, 2, 3]) {
    reg.handleMouse(event('click', 3, 0, { clickCount: count }))
    assert.equal(hits.at(-1)?.hit.clickCount, count)
  }
  reg.handleMouse(event('click', 3, 0))
  assert.equal(hits.at(-1)?.hit.clickCount, 1, 'absent clickCount defaults to a single click')
})

test('move enters and leaves a hitbox exactly once per transition', () => {
  const { reg, hovers } = registry([{ id: 'card', startRow: 2, endRow: 4, startCol: 0, endCol: 9 }])

  assert.deepEqual(reg.handleMouse(event('move', 5, 3)), { handled: true, render: true })
  assert.deepEqual(hovers, [{ id: 'card', entering: true }])
  assert.equal(reg.hoverTarget()?.id, 'card')

  assert.deepEqual(reg.handleMouse(event('move', 6, 3)), { handled: true }, 'same hitbox does not re-enter')
  assert.deepEqual(reg.handleMouse(event('move', 6, 4)), { handled: true })
  assert.equal(hovers.length, 1, 'no duplicate onHover(true)')

  assert.deepEqual(reg.handleMouse(event('move', 30, 3)), { handled: true, render: true }, 'leaving forces a render')
  assert.deepEqual(hovers, [
    { id: 'card', entering: true },
    { id: 'card', entering: false },
  ])
  assert.equal(reg.hoverTarget(), undefined)

  assert.equal(reg.handleMouse(event('move', 31, 3)), undefined, 'motion over nothing and leaving nothing is fully released')
  assert.equal(hovers.length, 2)
})

test('moving between two hitboxes exits the old one before entering the new one', () => {
  const { reg, hovers } = registry([
    { id: 'top', startRow: 0, endRow: 0 },
    { id: 'bottom', startRow: 1, endRow: 1 },
  ])
  reg.handleMouse(event('move', 0, 0))
  reg.handleMouse(event('move', 0, 1))
  assert.deepEqual(hovers, [
    { id: 'top', entering: true },
    { id: 'top', entering: false },
    { id: 'bottom', entering: true },
  ])
  assert.equal(reg.hoverTarget()?.id, 'bottom')
})

test('drag updates hover exactly like move', () => {
  const { reg, hovers } = registry([{ id: 'card', startRow: 0, endRow: 0 }])
  assert.deepEqual(reg.handleMouse(event('drag', 1, 0)), { handled: true, render: true })
  assert.deepEqual(reg.handleMouse(event('drag', 2, 5)), { handled: true, render: true })
  assert.deepEqual(hovers, [
    { id: 'card', entering: true },
    { id: 'card', entering: false },
  ])
})

test('sync reports a vanished hover without running callbacks', () => {
  const { reg, hovers } = registry([{ id: 'card', startRow: 0, endRow: 0 }])
  reg.handleMouse(event('move', 1, 0))
  assert.equal(reg.hoverTarget()?.id, 'card')

  const changes = reg.sync([{ id: 'other', startRow: 0, endRow: 0 }])
  assert.equal(changes.exited?.id, 'card')
  assert.equal(changes.entered, undefined)
  assert.equal(reg.hoverTarget(), undefined)
  assert.deepEqual(hovers, [{ id: 'card', entering: true }], 'sync itself never calls onHover')
})

test('sync keeps a stable hover and treats a moved rect as exit plus enter', () => {
  const { reg, hovers } = registry([{ id: 'card', startRow: 0, endRow: 0 }])
  reg.handleMouse(event('move', 1, 0))

  assert.deepEqual(reg.sync([{ id: 'card', startRow: 0, endRow: 0 }]), { entered: undefined, exited: undefined })
  assert.equal(reg.hoverTarget()?.id, 'card')

  const moved = reg.sync([{ id: 'card', startRow: 4, endRow: 6, startCol: 2, endCol: 8 }])
  assert.equal(moved.exited?.id, 'card')
  assert.equal(moved.entered?.id, 'card')
  assert.deepEqual([moved.entered?.startRow, moved.entered?.endRow], [4, 6])
  assert.equal(reg.hoverTarget()?.startRow, 4, 'hover follows the new rect')
  assert.deepEqual(hovers, [{ id: 'card', entering: true }], 'sync itself never calls onHover')
})

test('sync never invents an enter for a newly appearing hitbox', () => {
  const reg = new HitboxRegistry()
  reg.sync([])
  assert.deepEqual(reg.sync([{ id: 'fresh', startRow: 0, endRow: 0 }]), { entered: undefined, exited: undefined })
  assert.equal(reg.hoverTarget(), undefined)
})

test('non-left buttons, release and wheel are left to TuiAltScreen', () => {
  const { reg, hits, hovers } = registry([{ id: 'card', startRow: 0, endRow: 5 }])
  for (const button of ['right', 'middle', 'none'] as const) {
    assert.equal(reg.handleMouse(event('press', 1, 1, { button })), undefined, `press ${button}`)
    assert.equal(reg.handleMouse(event('click', 1, 1, { button })), undefined, `click ${button}`)
  }
  assert.equal(reg.handleMouse(event('release', 1, 1)), undefined)
  assert.equal(reg.handleMouse(event('wheel', 1, 1, { button: 'none', wheelDelta: -3 })), undefined)
  assert.deepEqual(hits, [])
  assert.deepEqual(hovers, [])
})

test('clear drops both frame and hover state', () => {
  const { reg } = registry([{ id: 'card', startRow: 0, endRow: 2 }])
  reg.handleMouse(event('move', 1, 1))
  assert.equal(reg.hoverTarget()?.id, 'card')

  reg.clear()
  assert.equal(reg.hoverTarget(), undefined)
  assert.equal(reg.handleMouse(event('press', 1, 1)), undefined)
  assert.equal(reg.handleMouse(event('click', 1, 1)), undefined)
  assert.equal(reg.handleMouse(event('move', 1, 1))?.render, undefined)
})

test('an empty registry ignores every event type', () => {
  const reg = new HitboxRegistry()
  for (const type of ['press', 'release', 'move', 'drag', 'click', 'wheel'] as const) {
    assert.equal(reg.handleMouse(event(type, 0, 0)), undefined, type)
  }
  assert.deepEqual(reg.sync([]), { entered: undefined, exited: undefined })
  for (const type of ['press', 'move', 'click'] as const) {
    assert.equal(reg.handleMouse(event(type, 0, 0)), undefined, type)
  }
})

test('overlapping hitboxes resolve to the first declared match', () => {
  const { reg, hits } = registry([
    { id: 'inner', startRow: 0, endRow: 0, startCol: 3, endCol: 5 },
    { id: 'outer', startRow: 0, endRow: 1 },
  ])
  reg.handleMouse(event('click', 4, 0))
  reg.handleMouse(event('click', 0, 1))
  assert.deepEqual(
    hits.map((record) => record.id),
    ['inner', 'outer'],
  )
})
// ---------------------------------------------------------------------------
// Press pinning: a repaint between press and release must not steal the click

test('a claimed press pins its hitbox, so a moved row cannot steal the click', () => {
  const { reg, hits, resync } = registry([
    { id: 'summary', startRow: 0, endRow: 0 },
    { id: 'other', startRow: 2, endRow: 2 },
  ])
  assert.deepEqual(reg.handleMouse(event('press', 3, 0)), { handled: true })

  // A repaint moved the summary down and a different region now sits at row 0 —
  // exactly what a streaming chunk or a follow-end scroll does between press and
  // release.
  resync([
    { id: 'other', startRow: 0, endRow: 0 },
    { id: 'summary', startRow: 2, endRow: 2 },
  ])

  assert.deepEqual(reg.handleMouse(event('click', 3, 0)), { handled: true, render: true })
  assert.deepEqual(hits.map((record) => record.id), ['summary'], 'the pressed region runs, not the row now under the pointer')
  assert.equal(hits[0]?.hit.row, 0, 'the hit keeps the press coordinates')

  // The pin is consumed by the click: the next click resolves by row again.
  reg.handleMouse(event('click', 3, 0))
  assert.deepEqual(hits.map((record) => record.id), ['summary', 'other'])
})

test('release keeps the pin because the native click is synthesized after it', () => {
  const { reg, hits, resync } = registry([{ id: 'summary', startRow: 0, endRow: 0 }])
  reg.handleMouse(event('press', 1, 0))
  assert.equal(reg.handleMouse(event('release', 1, 0)), undefined, 'release stays native')

  resync([{ id: 'summary', startRow: 3, endRow: 3 }])
  assert.deepEqual(reg.handleMouse(event('click', 1, 0)), { handled: true, render: true })
  assert.deepEqual(hits.map((record) => record.id), ['summary'])
})

test('drag, a new press, a vanished id and clear all drop the pin', () => {
  const dragged = registry([{ id: 'summary', startRow: 0, endRow: 0 }])
  dragged.reg.handleMouse(event('press', 1, 0))
  dragged.reg.handleMouse(event('drag', 5, 4))
  dragged.resync([{ id: 'summary', startRow: 5, endRow: 5 }])
  assert.equal(dragged.reg.handleMouse(event('click', 1, 0)), undefined, 'a drag means no click will be replayed')
  assert.deepEqual(dragged.hits, [])

  const fresh = registry([{ id: 'summary', startRow: 0, endRow: 0 }])
  fresh.reg.handleMouse(event('press', 1, 0))
  assert.equal(fresh.reg.handleMouse(event('press', 8, 9)), undefined, 'press outside every region is not claimed')
  fresh.resync([{ id: 'summary', startRow: 5, endRow: 5 }])
  assert.equal(fresh.reg.handleMouse(event('click', 1, 0)), undefined, 'the stale pin died with the new press')

  const gone = registry([{ id: 'summary', startRow: 0, endRow: 0 }])
  gone.reg.handleMouse(event('press', 1, 0))
  gone.resync([])
  assert.equal(gone.reg.handleMouse(event('click', 1, 0)), undefined, 'a vanished region stays inert')

  const cleared = registry([{ id: 'summary', startRow: 0, endRow: 0 }])
  cleared.reg.handleMouse(event('press', 1, 0))
  cleared.reg.clear()
  cleared.resync([{ id: 'summary', startRow: 4, endRow: 4 }])
  assert.equal(cleared.reg.handleMouse(event('click', 1, 0)), undefined)
})

test('claimPress:false regions are click-only: press, move and drag stay native', () => {
  const { reg, hits, hovers } = registry([
    { id: 'summary', startRow: 0, endRow: 0 },
    { id: 'body', startRow: 1, endRow: 4, claimPress: false },
  ])

  assert.equal(reg.handleMouse(event('press', 2, 2)), undefined, 'a body press starts native text selection')
  assert.equal(reg.handleMouse(event('move', 2, 2)), undefined, 'moving over body text is not intercepted')
  assert.equal(reg.handleMouse(event('drag', 2, 2)), undefined, 'dragging over body text stays native')
  assert.deepEqual(hovers, [], 'click-only regions own no hover')

  // TuiAltScreen synthesizes a click for an *undragged* press even when the press
  // was not claimed (handleSelectionMouseEvent); the registry consumes it.
  assert.deepEqual(reg.handleMouse(event('click', 2, 2)), { handled: true, render: true })
  assert.deepEqual(hits.map((record) => record.id), ['body'])

  // A claimed summary press keeps working next to the click-only body.
  assert.deepEqual(reg.handleMouse(event('press', 2, 0)), { handled: true })
  assert.deepEqual(reg.handleMouse(event('click', 2, 0)), { handled: true, render: true })
  assert.equal(hits.at(-1)?.id, 'summary')

  reg.handleMouse(event('move', 2, 0))
  assert.equal(reg.hoverTarget()?.id, 'summary')
  reg.handleMouse(event('press', 2, 2))
  assert.equal(reg.handleMouse(event('drag', 8, 2)), undefined, 'the first body drag after a hovered summary must stay native too')
  assert.equal(reg.hoverTarget(), undefined)
  assert.deepEqual(hovers.slice(-2), [
    { id: 'summary', entering: true },
    { id: 'summary', entering: false },
  ])

  const overlap = registry([
    { id: 'text', startRow: 1, endRow: 3, claimPress: false },
    { id: 'fallback', startRow: 0, endRow: 4 },
  ])
  assert.equal(overlap.reg.handleMouse(event('press', 2, 2)), undefined, 'a later claiming fallback cannot steal a click-only region')
  assert.equal(overlap.reg.handleMouse(event('move', 2, 2)), undefined)
  overlap.reg.handleMouse(event('click', 2, 2))
  assert.equal(overlap.hits[0]?.id, 'text')
})
