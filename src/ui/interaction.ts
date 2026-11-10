/** Presentation-only contract. Native DSH requests and the main editor stay owned by App. */
import type { Component } from '#pi-tui'

/** A transient input-adjacent interaction, or an independently browsed workspace surface. */
export type InteractionPlacement = 'composer' | 'workspace'

/** Hard bounds supplied by the parent for this frame; never a second terminal renderer. */
export interface InteractionLayout {
  readonly placement: InteractionPlacement
  readonly maxHeight: number
}

/** Optional structural seam so existing independent surfaces remain unchanged. */
export interface ComposerInteraction extends Component {
  /** Idempotent, presentation-only. It must not fetch, answer, focus, or request another frame. */
  setInteractionLayout(layout: InteractionLayout): void
  /** Pure row count using the same layout as render; never call render merely to measure. */
  measureRows(width: number): number
}
