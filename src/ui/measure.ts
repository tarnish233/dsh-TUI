/**
 * Height measurement for the fixed status-dock members.
 *
 * The dock budget needs the real row count of the editor, queue, hint and
 * footer *before* the transcript is laid out, and `docs/FRONTEND-CONTRACT.md`
 * is explicit that the parent "never re-renders members to measure". A member
 * that can answer this from its own state implements
 * {@link MeasurableComponent.measureRows}; this module is the one entry point
 * the parent calls, so an added measurement never turns into a second paint
 * policy per component.
 */
import type { Component } from '#pi-tui'

/**
 * A component that can report its painted height without painting.
 *
 * The contract is exact and idempotent by definition:
 * `measureRows(width) === render(width).length` for every width, with no state,
 * hitbox, cache or hover change in between — measuring must not move the frame
 * it describes.
 */
export interface MeasurableComponent extends Component {
  measureRows(width: number): number
}

/**
 * Rows `component` paints at `width`.
 *
 * A member with its own `measureRows` answers from its state (that is the real
 * "measure without re-render" path). Otherwise this falls back to the paint the
 * parent is about to use anyway, which is free for a component that memoizes its
 * own lines by content and width — Pi's `Text` (`hint`, `footer`) keys its
 * wrapped lines that way, so the second `render(width)` is a cache hit.
 */
export function measureRows(component: Component, width: number): number {
  const measurable = component as Partial<MeasurableComponent>
  if (typeof measurable.measureRows === 'function') return measurable.measureRows(width)
  return component.render(width).length
}