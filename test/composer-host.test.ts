import assert from 'node:assert/strict'
import test from 'node:test'
import type { TuiMouseEvent } from '#pi-tui'
import { ComposerInteractionHost, isComposerInteraction } from '../src/ui/composer-interaction.ts'
import type { ComposerInteraction, InteractionLayout } from '../src/ui/interaction.ts'

class Surface implements ComposerInteraction {
  focused = false
  capturesViewportInput = false
  layout: InteractionLayout = { placement: 'workspace', maxHeight: 100 }
  paints = 0
  measures = 0
  invalidations = 0
  readonly keys: string[] = []
  readonly mouse: TuiMouseEvent[] = []
  readonly draft = { text: 'unchanged draft', cursor: 3, payload: 'fixture-only' }
  readonly naturalRows: number
  constructor(naturalRows: number) { this.naturalRows = naturalRows }
  setInteractionLayout(layout: InteractionLayout): void { this.layout = layout }
  measureRows(_width: number): number { this.measures++; return Math.min(this.layout.maxHeight, this.naturalRows) }
  render(_width: number): string[] { this.paints++; return Array.from({ length: Math.min(this.layout.maxHeight, this.naturalRows) }, (_, index) => 'row ' + index) }
  handleInput(data: string): void { this.keys.push(data) }
  handleMouse(event: TuiMouseEvent) { this.mouse.push(event); return { handled: true, render: false } }
  invalidate(): void { this.invalidations++ }
}

test('composer host is empty until a surface is explicitly mounted', () => {
  let samples = 0
  const host = new ComposerInteractionHost({ maxHeight: () => { samples++; return 8 } })
  assert.equal(host.active, false)
  assert.equal(host.current, undefined)
  assert.equal(host.measureRows(80), 0)
  assert.deepEqual(host.render(80), [])
  assert.equal(samples, 0)
})

test('composer measurement never paints or edits the underlying interaction', () => {
  const host = new ComposerInteractionHost({ maxHeight: () => 12 })
  const surface = new Surface(4)
  const before = structuredClone(surface.draft)
  host.setSurface(surface)
  assert.equal(host.measureRows(80), 4)
  assert.equal(host.measureRows(80), 4)
  assert.equal(surface.paints, 0)
  assert.deepEqual(surface.draft, before)
  assert.deepEqual(surface.layout, { placement: 'composer', maxHeight: 12 })
  assert.equal(host.render(80).length, 4, 'a cap must not pad a short view to the whole available area')
  assert.equal(surface.paints, 1)
  assert.deepEqual(surface.draft, before)
})

test('composer budget is re-sampled without moving ownership or replacing the surface', () => {
  let budget = 10
  const widths: number[] = []
  const host = new ComposerInteractionHost({ maxHeight: width => { widths.push(width); return budget } })
  const surface = new Surface(20)
  host.setSurface(surface)
  assert.equal(host.measureRows(80), 10)
  assert.equal(host.render(80).length, 10)
  budget = 3
  assert.equal(host.measureRows(40), 3)
  assert.equal(host.render(40).length, 3)
  assert.equal(host.current, surface)
  assert.deepEqual(widths, [80, 80, 40, 40])
})

test('composer forwards focus and input only to the current interaction', () => {
  const host = new ComposerInteractionHost({ maxHeight: () => 8 })
  const surface = new Surface(4)
  host.setSurface(surface)
  host.focused = true
  assert.equal(surface.focused, true)
  host.handleInput('x')
  assert.deepEqual(surface.keys, ['x'])
  assert.equal(host.capturesViewportInput, false)
  surface.capturesViewportInput = true
  assert.equal(host.capturesViewportInput, true)
  host.focused = false
  assert.equal(surface.focused, false)
  host.setSurface(undefined)
  host.handleInput('y')
  assert.deepEqual(surface.keys, ['x'])
})

test('composer replacement invalidates old mouse ownership and detach stays inert', () => {
  const host = new ComposerInteractionHost({ maxHeight: () => 8 })
  const first = new Surface(4), second = new Surface(3)
  host.setSurface(first)
  host.setSurface(first)
  assert.equal(first.invalidations, 0, 'same surface is an identity no-op')
  host.setSurface(second)
  assert.equal(first.invalidations, 1)
  assert.equal(host.current, second)
  host.setSurface(undefined)
  assert.equal(second.invalidations, 1)
  assert.equal(host.measureRows(80), 0)
  assert.deepEqual(host.render(80), [])
})

test('composer hard bounds fail closed for unusable parent budgets', () => {
  for (const budget of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const host = new ComposerInteractionHost({ maxHeight: () => budget })
    const surface = new Surface(20)
    host.setSurface(surface)
    assert.equal(host.measureRows(80), 1)
    assert.equal(host.render(80).length, 1)
  }
})

test('composer structural validation does not turn ordinary workspace components into dock views', () => {
  assert.equal(isComposerInteraction(new Surface(3)), true)
  assert.equal(isComposerInteraction({ render: () => [], invalidate: () => {} }), false)
})
