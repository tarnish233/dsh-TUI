/**
 * Fullscreen image details overlay (read-only).
 *
 * One occurrence of the transcript's image sequence is shown in a dedicated,
 * full-width image area. The composition is deliberately *not* a transcript
 * card: Pi TUI's public `Image` component emits Kitty/iTerm2 APC lines and
 * reserves its own blank placement rows, so those lines must never pass through
 * the tool tree indentation, generic wrapping or `sanitize()` (which would strip
 * the graphics sequence). Only the APC lines produced by `Image` are exempt;
 * every other piece of metadata/name/error/source text is sanitized.
 *
 * Lifecycle:
 *   - construction starts one lazy `readImage` request (markers never prefetch);
 *   - `setImage(next)` supersedes it (abort + generation token); a reused key
 *     whose attachment identity/payload changed is reloaded;
 *   - `dispose()` aborts and goes inert; late results are ignored, not cached;
 *   - decode/transcode happens before the first ready frame, never in render.
 *
 * Layout never truncates an APC/blank-row block: the image area gets an explicit
 * row budget derived from the live `maxHeight`, and a too-short viewport falls
 * back to sanitized text while keeping the close hint visible. Cell-dimension
 * changes invalidate the retained `Image` instance; a changed row budget needs a
 * new instance because Pi's `maxHeightCells` is construction-time state.
 *
 * Input goes through `keymap.resolve(raw, 'imageDetails')`: the shared chord
 * state, interrupt priority and modal precedence apply, unknown global actions
 * stay inert, and hints show the effective binding (including chords).
 */
import {
  Image,
  getCapabilities,
  getCellDimensions,
  type Component,
  type Focusable,
  type ImageTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type TUI,
} from '#pi-tui'
import { formatBinding, type CcKeymap } from '../input/index.ts'
import type { ImageDetailsDialogOptions, ImageViewItem } from './image-view.ts'
import { imageAttachmentKey } from '../attachments.ts'
import { formatImageBytes, imageRefSummary, imageRefTitle } from './image-data.ts'
import { isAbortError, loadImageItem } from './image-loader.ts'
import type { DisplayImage } from './image-codec.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import { bold, cc, dim, t } from './theme.ts'
import { fit, oneLine, sanitize, visibleWidth } from './text.ts'

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly display: DisplayImage; readonly component: Image }
  | { readonly status: 'error'; readonly reason: string }

const CLOSE_ACTIONS = ['image.details.close', 'list.cancel', 'dialog.cancel', 'app.cancel'] as const

/** Rules, header, metadata, controls, status and hint outside the image area. */
const CHROME_ROWS = 9
const MIN_IMAGE_ROWS = 4
const DEFAULT_IMAGE_ROWS = 24

const imageTheme: ImageTheme = {
  fallbackColor: (text: string) => dim(t.subtle(text)),
}

/** Sanitized single-line metadata: no control bytes except our own styling. */
function clean(value: string, max = 200): string {
  return sanitize(oneLine(value, max))
}

export class ImageDetailsDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: ImageDetailsDialogOptions
  private readonly registry = new HitboxRegistry()
  private image: ImageViewItem
  private state: LoadState = { status: 'loading' }
  private controller: AbortController | undefined
  private generation = 0
  private disposed = false
  private done = false
  private focusedState = false
  private chordPending = false
  private hovered: string | undefined
  /** Geometry token for the retained Image instance (cell size + budget). */
  private geometryKey = ''
  private componentBudget = 0

  constructor(tui: TUI, options: ImageDetailsDialogOptions) {
    this.tui = tui
    this.options = options
    this.image = options.image
    this.keymap = options.keymap
    this.startLoad()
  }

  // -------------------------------------------------------------------------
  // Public surface (parent owns the overlay)

  get currentImage(): ImageViewItem {
    return this.image
  }

  get loadStatus(): LoadState['status'] {
    return this.state.status
  }

  /** Decoded PNG payload/metadata once ready; never a byte source for copying. */
  get decoded(): DisplayImage | undefined {
    return this.state.status === 'ready' ? this.state.display : undefined
  }

  get errorReason(): string | undefined {
    return this.state.status === 'error' ? this.state.reason : undefined
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    if (!value) this.cancelChord()
    this.focusedState = value
  }

  /** Release this modal's own pending chord only. */
  cancelChord(): void {
    if (!this.chordPending) return
    this.chordPending = false
    this.keymap.cancelChord()
  }

  /**
   * Recompute the Image's own cached frame. Cell-dimension (CSI 16t) changes
   * invalidate the retained instance so the new geometry is honored instead of
   * painting an old pixel-per-cell frame.
   */
  invalidate(): void {
    if (this.disposed) return
    this.geometryKey = ''
    if (this.state.status === 'ready') this.state.component.invalidate()
    this.requestRender()
  }

  /**
   * Show another occurrence.
   *
   * - Different bytes (or a different key) load again; a changed occurrence
   *   creates its own `Image` instance once bytes are ready.
   * - Same bytes with updated display metadata (label/name/originalDimensions)
   *   only refreshes the chrome and the fallback filename; bytes are reused.
   */
  setImage(next: ImageViewItem): void {
    if (this.disposed) return
    if (!sameImagePayload(this.image, next)) {
      this.image = next
      this.geometryKey = ''
      this.componentBudget = 0
      this.startLoad()
      return
    }
    if (sameImageDisplay(this.image, next)) return
    this.image = next
    if (this.state.status === 'ready') {
      this.state = { status: 'ready', display: this.state.display, component: this.createImageComponent(this.state.display) }
      this.componentBudget = this.rowBudget()
      this.geometryKey = this.geometryToken()
    }
    this.requestRender()
  }

  /** Reuse decoded bytes for a new viewport/metadata; never re-reads the source. */
  private createImageComponent(display: DisplayImage): Image {
    const name = this.attachmentName()
    return new Image(
      display.pngData,
      'image/png',
      imageTheme,
      {
        // The real overlay width bounds columns; the current viewport height
        // bounds rows. Never Pi's compact 60-cell default for this surface.
        maxWidthCells: 10_000,
        maxHeightCells: Math.max(1, this.rowBudget()),
        ...(name === undefined ? {} : { filename: name }),
      },
      { widthPx: display.width, heightPx: display.height },
    )
  }

  /** Idempotent teardown: abort the read, drop state, never call onClose. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.cancelChord()
    this.controller?.abort()
    this.controller = undefined
    this.state = { status: 'loading' }
    this.registry.clear()
    this.hovered = undefined
  }

  // -------------------------------------------------------------------------
  // Loading

  private startLoad(): void {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.generation += 1
    const generation = this.generation
    this.state = { status: 'loading' }
    this.requestRender()
    void loadImageItem(this.image, {
      readImage: this.options.readImage,
      signal: controller.signal,
    }).then(result => {
      if (this.disposed || generation !== this.generation || controller.signal.aborted) return
      this.controller = undefined
      if (!result.ok) {
        this.state = { status: 'error', reason: clean(result.reason) }
        this.requestRender()
        return
      }
      const component = this.createImageComponent(result.image)
      this.componentBudget = this.rowBudget()
      this.geometryKey = this.geometryToken()
      this.state = { status: 'ready', display: result.image, component }
      this.requestRender()
    }).catch(error => {
      if (this.disposed || generation !== this.generation || controller.signal.aborted) return
      if (isAbortError(error)) return
      this.controller = undefined
      this.state = { status: 'error', reason: clean(errorText(error)) }
      this.requestRender()
    })
  }

  private attachmentName(): string | undefined {
    const name = this.image.attachment?.name ?? this.image.upload?.name
    return name === undefined ? undefined : clean(name, 120)
  }

  private requestRender(): void {
    this.options.onRenderRequest?.()
  }

  // -------------------------------------------------------------------------
  // Input

  handleInput(raw: string): void {
    if (this.done || this.disposed) return
    const resolution = this.keymap.resolve(raw, 'imageDetails')
    if (resolution.kind === 'pending') {
      this.chordPending = true
      return
    }
    if (resolution.kind !== 'action') {
      // A mismatched chord/unknown key is consumed here; no global fallthrough.
      this.chordPending = false
      return
    }
    this.chordPending = false
    const id = resolution.action.id
    if (id === 'app.interrupt') {
      // Configured interrupt keeps priority and is delegated whole; the parent
      // decides between interrupting a busy turn and closing this viewer.
      if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
      else this.close()
      return
    }
    if ((CLOSE_ACTIONS as readonly string[]).includes(id)) {
      this.close()
      return
    }
    if (id === 'image.details.previous-image') {
      this.navigate(-1)
      return
    }
    if (id === 'image.details.next-image') {
      this.navigate(1)
      return
    }
    // Any other resolved global action is deliberately inert inside the viewer.
  }

  private navigation(): { index: number; total: number } {
    const navigation = this.options.getImageNavigation?.()
    if (navigation === undefined) return { index: 0, total: 1 }
    return { index: Math.max(0, navigation.index), total: Math.max(1, navigation.total) }
  }

  private canPrevious(): boolean {
    return this.navigation().index > 0 && this.options.onPreviousImage !== undefined
  }

  private canNext(): boolean {
    const { index, total } = this.navigation()
    return index < total - 1 && this.options.onNextImage !== undefined
  }

  private navigate(direction: -1 | 1): void {
    if (direction < 0) {
      if (!this.canPrevious()) return
      this.options.onPreviousImage?.()
      return
    }
    if (!this.canNext()) return
    this.options.onNextImage?.()
  }

  private close(): void {
    if (this.done || this.disposed) return
    this.done = true
    this.cancelChord()
    this.controller?.abort()
    this.controller = undefined
    this.options.onClose()
  }

  // -------------------------------------------------------------------------
  // Geometry and rendering

  /** Live viewport height converted to a row budget for the image component. */
  private limitRows(): number {
    const value = this.options.maxHeight
    if (value === undefined || !Number.isFinite(value)) return 0
    return Math.max(1, Math.floor(value))
  }

  /** Rows available to the image component; may be below MIN_IMAGE_ROWS. */
  private rowBudget(): number {
    const limit = this.limitRows()
    if (limit === 0) return DEFAULT_IMAGE_ROWS
    return Math.max(1, limit - CHROME_ROWS)
  }

  private geometryToken(): string {
    const cell = getCellDimensions()
    return `${this.rowBudget()}|${cell.widthPx}x${cell.heightPx}|${getCapabilities().images ?? 'none'}`
  }

  /** Invalidate/recreate only when real geometry changed, then render once. */
  private renderImageComponent(width: number, budget: number): Image {
    const state = this.state
    if (state.status !== 'ready') throw new Error('image component is not ready')
    const token = this.geometryToken()
    if (token !== this.geometryKey) {
      this.geometryKey = token
      if (this.componentBudget !== budget) {
        // Pi's maxHeightCells is fixed at construction; a row-budget change is a
        // real new viewport contract. Same-occurrence bytes stay cached.
        this.state = {
          status: 'ready',
          display: state.display,
          component: this.createImageComponent(state.display),
        }
        this.componentBudget = budget
      } else {
        state.component.invalidate()
      }
    }
    const current = this.state
    if (current.status !== 'ready') throw new Error('image component disappeared')
    return current.component
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const limit = this.limitRows()
    if (limit > 0 && limit < CHROME_ROWS + MIN_IMAGE_ROWS) return this.renderCompact(size, limit)

    const out: string[] = []
    const boxes: MouseHitbox[] = []
    const push = (line: string): number => {
      out.push(line)
      return out.length - 1
    }

    push(cc.inactive('─'.repeat(size)))
    const { index, total } = this.navigation()
    const position = total > 1 ? `Image ${index + 1} of ${total}` : 'Image'
    push(fit(` ${bold(cc.permission('Image details'))}${dim(' · ')}${t.text(position)}${dim(' · ')}${t.muted(clean(this.image.label, 60))}`, size))

    const ref = this.image.attachment
    const title = ref === undefined
      ? `${this.attachmentName() ?? 'clipboard image'} · ${this.image.upload.mediaType}`
      : imageRefTitle(ref)
    push(fit(` ${t.text(clean(title))}`, size))
    const meta = this.metaText()
    if (meta !== '') push(fit(` ${dim(meta)}`, size))
    this.renderControls(push, boxes, size)
    push(cc.inactive('─'.repeat(size)))

    // Dedicated full-width image area: Pi's lines are pushed verbatim (APC and
    // placement rows), never truncated or re-wrapped.
    const budget = this.rowBudget()
    if (budget < MIN_IMAGE_ROWS) {
      push(fit(` ${dim(t.muted('Viewport too short for an inline image.'))}`, size))
    } else {
      for (const line of this.imageLines(size, budget)) out.push(line)
    }
    push(cc.inactive('─'.repeat(size)))
    push(fit(` ${this.statusLine()}`, size))
    const hint = this.hintLine()
    if (hint !== '') push(fit(` ${dim(hint)}`, size))

    this.registry.sync(boxes)
    return out
  }

  /**
   * Very short viewport: text only, but the close affordance and the reason
   * stay visible. Nothing is sliced after the fact.
   */
  private renderCompact(width: number, limit: number): string[] {
    const { index, total } = this.navigation()
    const position = total > 1 ? `Image ${index + 1} of ${total}` : 'Image'
    const close = this.closeKey()
    const status = this.statusLine()
    const closeLine = fit(` ${status}${close === undefined ? '' : ` · ${close} close`}`, width)
    const title = fit(` ${bold(cc.permission('Image details'))}${dim(' · ')}${t.text(position)}`, width)
    const meta = this.metaText()
    // Always keep the close affordance, even at a one-row viewport.
    const lines = limit <= 1
      ? [closeLine]
      : limit === 2 || meta === ''
        ? [title, closeLine]
        : [title, fit(` ${dim(meta)}`, width), closeLine]
    this.registry.sync([])
    return lines
  }

  private imageLines(width: number, budget: number): string[] {
    if (this.state.status === 'loading') {
      return [fit(` ${dim(t.muted('Loading image…'))}`, width)]
    }
    if (this.state.status === 'error') {
      return [fit(` ${t.redSoft('Image unavailable')}${dim(' · ')}${t.muted(clean(this.state.reason))}`, width)]
    }
    const component = this.renderImageComponent(width, budget)
    const lines = component.render(width)
    if (lines.length > budget) {
      // Honest fallback instead of slicing APC lines while still claiming the
      // old image height: keep metadata/close available in text form.
      return [fit(` ${dim(t.muted('Image is taller than the available viewport; enlarge the terminal.'))}`, width)]
    }
    return lines
  }

  private metaText(): string {
    const ref = this.image.attachment
    if (this.state.status === 'ready') {
      const display = this.state.display
      const source = ref === undefined
        ? `${display.sourceMediaType} ${display.sourceWidth}×${display.sourceHeight}`
        : imageRefSummary(ref)
      const original = ref?.originalDimensions
      return clean([
        source,
        original === undefined ? '' : `original ${original.width}×${original.height}`,
        display.transcoded
          ? `PNG ${display.width}×${display.height} · ${formatImageBytes(display.decodedBytes)}`
          : '',
        this.cellText(display.width, display.height),
        ref === undefined ? '' : `id ${ref.attachmentId}`,
      ].filter(Boolean).join(' · '))
    }
    if (ref !== undefined) {
      const original = ref.originalDimensions
      return clean([
        imageRefSummary(ref),
        original === undefined ? '' : `original ${original.width}×${original.height}`,
        `id ${ref.attachmentId}`,
      ].filter(Boolean).join(' · '))
    }
    return clean(`${this.image.upload.mediaType} · ${formatImageBytes(Math.floor(this.image.upload.data.length * 3 / 4))}`)
  }

  /** Viewport-relative cell footprint of the decoded pixels. */
  private cellText(width: number, height: number): string {
    const cell = getCellDimensions()
    const columns = Math.max(1, Math.ceil(width / Math.max(1, cell.widthPx)))
    const rows = Math.max(1, Math.ceil(height / Math.max(1, cell.heightPx)))
    return `≈ ${columns}×${rows} cells`
  }

  private statusLine(): string {
    if (this.state.status === 'loading') return dim(t.muted('Loading…'))
    if (this.state.status === 'error') return cc.error('Unavailable')
    return terminalImages()
      ? cc.success('Ready')
      : `${cc.success('Ready')}${dim(' · ')}${dim('terminal cannot display inline images')}`
  }

  /** Clickable Close/Prev/Next controls using the shared hitbox layer. */
  private renderControls(
    push: (line: string) => number,
    boxes: MouseHitbox[],
    width: number,
  ): void {
    const plans: Array<{ id: string; label: string; enabled: boolean; run: () => void }> = [
      { id: 'image-prev', label: '‹ Prev', enabled: this.canPrevious(), run: () => this.navigate(-1) },
      { id: 'image-next', label: 'Next ›', enabled: this.canNext(), run: () => this.navigate(1) },
      { id: 'image-close', label: 'Close', enabled: true, run: () => this.close() },
    ]
    const parts: string[] = [' ']
    let used = 1
    const pending: Array<{ id: string; start: number; end: number; run: () => void }> = []
    for (const plan of plans) {
      const label = `[${plan.label}]`
      if (used + visibleWidth(label) >= width) break
      const hovered = this.hovered === plan.id
      const styled = plan.enabled
        ? hovered ? bold(cc.suggestion(label)) : t.text(label)
        : dim(label)
      const start = used
      parts.push(styled)
      used += visibleWidth(label)
      if (plan.enabled) pending.push({ id: plan.id, start, end: used - 1, run: plan.run })
      parts.push(' ')
      used += 1
    }
    const row = push(fit(parts.join(''), width))
    for (const control of pending) {
      boxes.push({
        id: control.id,
        startRow: row,
        endRow: row,
        startCol: control.start,
        endCol: control.end,
        claimPress: true,
        onClick: () => control.run(),
        onHover: (entering: boolean) => this.setHover(entering ? control.id : undefined),
      })
    }
  }

  private setHover(id: string | undefined): void {
    if (id === this.hovered) return
    this.hovered = id
    this.requestRender()
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    return this.registry.handleMouse(event)
  }

  /**
   * Effective key labels only (including chords); a remapped/disabled action
   * disappears instead of advertising a dead key. Boundary navigation is
   * labeled. The interrupt binding is never shown as close.
   */
  private hintLine(): string {
    const parts: string[] = []
    const previous = this.bindingLabel('image.details.previous-image')
    const next = this.bindingLabel('image.details.next-image')
    if (previous !== undefined) parts.push(`${previous} ${this.canPrevious() ? 'previous' : 'previous (at start)'}`)
    if (next !== undefined) parts.push(`${next} ${this.canNext() ? 'next' : 'next (at end)'}`)
    const close = this.closeKey()
    if (close !== undefined) parts.push(`${close} close`)
    return parts.join(' · ')
  }

  private bindingLabel(action: string): string | undefined {
    const binding = this.keymap.getBindings(action)[0]
    return binding === undefined ? undefined : formatBinding(binding.split(' '))
  }

  private closeKey(): string | undefined {
    const interrupt = new Set(this.keymap.getBindings('app.interrupt'))
    for (const action of CLOSE_ACTIONS) {
      const binding = this.keymap.getBindings(action).find(spec => !interrupt.has(spec))
      if (binding !== undefined) return formatBinding(binding.split(' '))
    }
    return undefined
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
}

function terminalImages(): boolean {
  return getCapabilities().images !== null
}

/** Byte identity of one occurrence: determines whether a read is needed. */
function sameImagePayload(a: ImageViewItem, b: ImageViewItem): boolean {
  if (a.key !== b.key) return false
  if (a.attachment !== undefined && b.attachment !== undefined) {
    return imageAttachmentKey(a.attachment) === imageAttachmentKey(b.attachment)
  }
  if (a.upload !== undefined && b.upload !== undefined) {
    return a.upload.mediaType === b.upload.mediaType && a.upload.data === b.upload.data
  }
  return false
}

/** Display metadata identity: label/name/original dimensions, not bytes. */
function sameImageDisplay(a: ImageViewItem, b: ImageViewItem): boolean {
  if (a.label !== b.label) return false
  if (a.attachment !== undefined && b.attachment !== undefined) {
    const left = a.attachment.originalDimensions
    const right = b.attachment.originalDimensions
    return a.attachment.name === b.attachment.name &&
      left?.width === right?.width && left?.height === right?.height
  }
  if (a.upload !== undefined && b.upload !== undefined) return a.upload.name === b.upload.name
  return false
}
