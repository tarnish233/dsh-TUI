/** One input-adjacent presentation slot. It owns neither an editor nor native decision state. */
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { ComposerInteraction, InteractionLayout } from './interaction.ts'

export interface ComposerInteractionHostOptions {
  /** Parent-owned joint viewport/chrome/status budget. Must not measure this host recursively. */
  readonly maxHeight: (width: number) => number
}

const boundedRows = (value: number, maximum: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0

/** Runtime validation at the private app seam, not a second component registry. */
export function isComposerInteraction(component: Component): component is ComposerInteraction {
  const value = component as Partial<ComposerInteraction>
  return typeof value.setInteractionLayout === 'function' && typeof value.measureRows === 'function'
}

export class ComposerInteractionHost implements Component, Focusable {
  private readonly options: ComposerInteractionHostOptions
  private surface?: ComposerInteraction
  private focusedState = false

  constructor(options: ComposerInteractionHostOptions) { this.options = options }

  get active(): boolean { return this.surface !== undefined }
  get current(): ComposerInteraction | undefined { return this.surface }
  get focused(): boolean { return this.focusedState }
  set focused(value: boolean) {
    this.focusedState = value
    const surface = this.surface as (ComposerInteraction & Partial<Focusable>) | undefined
    if (surface !== undefined && typeof surface.focused === 'boolean') surface.focused = value
  }
  get capturesViewportInput(): boolean {
    return (this.surface as (ComposerInteraction & { capturesViewportInput?: boolean }) | undefined)?.capturesViewportInput === true
  }

  setSurface(surface: ComposerInteraction | undefined): void {
    if (this.surface === surface) return
    this.surface?.invalidate()
    this.surface = surface
  }

  private layout(width: number): InteractionLayout {
    const value = this.options.maxHeight(Math.max(1, width))
    return { placement: 'composer', maxHeight: Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1 }
  }

  measureRows(width: number): number {
    const surface = this.surface
    if (surface === undefined) return 0
    const layout = this.layout(width)
    surface.setInteractionLayout(layout)
    return boundedRows(surface.measureRows(width), layout.maxHeight)
  }

  render(width: number): string[] {
    const surface = this.surface
    if (surface === undefined) return []
    const layout = this.layout(width)
    surface.setInteractionLayout(layout)
    return surface.render(width).slice(0, layout.maxHeight)
  }

  /** Container has already rebased coordinates into this slot. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.surface?.handleMouse?.(event)
  }
  handleInput(data: string): void { this.surface?.handleInput?.(data) }
  invalidate(): void { this.surface?.invalidate() }
}
