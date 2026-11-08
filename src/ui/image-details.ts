/**
 * Image details inspector (read-only) on the shared modal chrome.
 *
 * One occurrence of the transcript's image sequence is shown in a dedicated
 * image area inside `ModalFrame`. The composition is deliberately *not* a
 * transcript card: Pi TUI's public `Image` component emits Kitty/iTerm2 APC
 * lines and reserves its own blank placement rows. `ModalFrame` passes such
 * lines through verbatim (`\\x1b_G` / `\\x1b]1337;File=`), so they must never be
 * wrapped, truncated or `sanitize()`d as text; only metadata/name/error text is
 * sanitized and width-safe. Geometry comes from the same measured frame options
 * used for render, so the image budget always equals the real body rows.
 *
 * Preview display preference (renderer only):
 *   - `auto` starts exactly one lazy `readImage` when constructed, then paints
 *     the graphics (or the terminal fallback) once decoded;
 *   - `text` never starts a read/decode on open, keeps the metadata/ref
 *     identity, and aborts + tombstones a pending read if the mode changes
 *     while loading. Switching back reuses already-decoded bytes without a
 *     second read.
 * `setImage(next)` supersedes a pending read (abort + generation token); a
 * reused key whose attachment identity/payload changed is reloaded. `dispose()`
 * aborts and goes inert; late results are ignored, not cached.
 *
 * Input goes through `keymap.resolve(raw, 'imageDetails')`: the shared chord
 * state, interrupt priority and modal precedence apply, unknown global actions
 * stay inert, and hints show the effective binding (including chords). Chrome
 * close/actions and their mouse hitboxes belong to `ModalFrame`; the body only
 * contains image/status lines, so plain drag outside the chrome keeps native
 * text selection.
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
import type { ImageDetailsDialogOptions, ImagePreviewMode, ImageViewItem } from './image-view.ts'
import { imageAttachmentKey } from '../attachments.ts'
import { formatImageBytes, imageRefSummary, imageRefTitle } from './image-data.ts'
import { isAbortError, loadImageItem } from './image-loader.ts'
import type { DisplayImage } from './image-codec.ts'
import { ModalFrame, type ModalAction, type ModalFrameOptions, type ModalGeometry, type ModalSize } from './modal.ts'
import { cc, dim, t } from './theme.ts'
import { fit, oneLine, sanitize } from './text.ts'

type LoadState =
  /** Text preview requested: nothing was read or decoded for this view. */
  | { readonly status: 'text' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly display: DisplayImage; readonly component: Image }
  | { readonly status: 'error'; readonly reason: string }

const CLOSE_ACTIONS = ['image.details.close', 'list.cancel', 'dialog.cancel', 'app.cancel'] as const

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
  /** Parent-generic dialog hosting uses the wider content size. */
  readonly modalSize: ModalSize = 'wide'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: ImageDetailsDialogOptions
  private readonly frame = new ModalFrame()
  private image: ImageViewItem
  private state: LoadState = { status: 'loading' }
  private controller: AbortController | undefined
  private generation = 0
  private disposed = false
  private done = false
  private focusedState = false
  private chordPending = false
  /** Decoded payload kept across an auto → text → auto switch (no re-read). */
  private decodedPayload: DisplayImage | undefined
  /** Live body-row budget from the last measured frame. */
  private rowBudget = DEFAULT_IMAGE_ROWS
  /** Geometry token for the retained Image instance (cell size + budget). */
  private geometryKey = ''
  private componentBudget = 0
  /** Locally applied preview request while the parent persists the preference. */
  private requestedPreview: ImagePreviewMode | undefined
  private requestedFrom: ImagePreviewMode | undefined

  constructor(tui: TUI, options: ImageDetailsDialogOptions) {
    this.tui = tui
    this.options = options
    this.image = options.image
    this.keymap = options.keymap
    if (this.previewMode() === 'text') this.state = { status: 'text' }
    else this.startLoad()
  }

  // -------------------------------------------------------------------------
  // Public surface (parent owns the overlay)

  get currentImage(): ImageViewItem {
    return this.image
  }

  get loadStatus(): LoadState['status'] {
    return this.state.status
  }

  /** Effective display preference of this surface (`auto` unless configured). */
  get preview(): ImagePreviewMode {
    return this.previewMode()
  }

  /** Decoded PNG payload/metadata once ready; never a byte source for copying. */
  get decoded(): DisplayImage | undefined {
    return this.state.status === 'ready' ? this.state.display : this.decodedPayload
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
   * Apply a preview preference chosen in this surface. The parent persists it
   * through `setPreview`; the surface switches immediately either way, so a text
   * choice can never be blocked behind a settings round-trip.
   */
  setPreview(value: ImagePreviewMode): void {
    if (this.disposed) return
    this.requestedFrom = this.options.preview ?? 'auto'
    this.requestedPreview = value
    this.options.setPreview?.(value)
    this.applyPreviewMode()
    this.requestRender()
  }

  /**
   * Re-read the parent's live preference (hosts may call this after a settings
   * change). Enforces the text-mode contract: pending reads are aborted.
   */
  refreshPreview(): void {
    if (this.disposed) return
    this.applyPreviewMode()
    this.requestRender()
  }

  /**
   * Recompute the Image's own cached frame. Cell-dimension (CSI 16t) changes
   * invalidate the retained instance so the new geometry is honored instead of
   * painting an old pixel-per-cell frame.
   */
  invalidate(): void {
    if (this.disposed) return
    this.geometryKey = ''
    this.frame.invalidate()
    if (this.state.status === 'ready') this.state.component.invalidate()
    this.applyPreviewMode()
    this.requestRender()
  }

  /**
   * Show another occurrence.
   *
   * - Different bytes (or a different key) load again; a changed occurrence
   *   creates its own `Image` instance once bytes are ready.
   * - Same bytes with updated display metadata (label/name/originalDimensions)
   *   only refreshes the chrome and the fallback filename; bytes are reused.
   * - In text preview the new occurrence is never read/decoded.
   */
  setImage(next: ImageViewItem): void {
    if (this.disposed) return
    if (!sameImagePayload(this.image, next)) {
      this.image = next
      this.geometryKey = ''
      this.componentBudget = 0
      this.decodedPayload = undefined
      if (this.previewMode() === 'text') {
        this.abortRead()
        this.state = { status: 'text' }
        this.requestRender()
      } else {
        this.startLoad()
      }
      return
    }
    if (sameImageDisplay(this.image, next)) return
    this.image = next
    if (this.state.status === 'ready') {
      this.state = { status: 'ready', display: this.state.display, component: this.createImageComponent(this.state.display) }
      this.componentBudget = this.rowBudget
      this.geometryKey = this.geometryToken()
    }
    this.requestRender()
  }

  /** Effective mode: a local request wins until the parent's value changes. */
  private previewMode(): ImagePreviewMode {
    const option = this.options.preview ?? 'auto'
    if (this.requestedPreview !== undefined && (this.requestedFrom === undefined || option === this.requestedFrom || option === this.requestedPreview)) {
      return this.requestedPreview
    }
    return option
  }

  /**
   * Enter/leave text mode exactly once per transition. Entering text aborts and
   * tombstones any pending read; leaving text reuses decoded bytes when this
   * occurrence was already decoded, otherwise a single new read starts.
   */
  private applyPreviewMode(): void {
    if (this.disposed) return
    if (this.previewMode() === 'text') {
      if (this.state.status === 'ready') {
        this.decodedPayload = this.state.display
        this.state = { status: 'text' }
      } else if (this.state.status === 'loading') {
        this.abortRead()
        this.state = { status: 'text' }
      } else if (this.state.status === 'error') {
        this.state = { status: 'text' }
      }
      return
    }
    if (this.state.status !== 'text') return
    if (this.decodedPayload !== undefined) {
      this.state = { status: 'ready', display: this.decodedPayload, component: this.createImageComponent(this.decodedPayload) }
      this.componentBudget = this.rowBudget
      this.geometryKey = this.geometryToken()
      return
    }
    this.startLoad()
  }

  /** Abort the pending read and drop its controller; late results stay inert. */
  private abortRead(): void {
    this.controller?.abort()
    this.controller = undefined
    this.generation += 1
  }

  /** Reuse decoded bytes for a new viewport/metadata; never re-reads the source. */
  private createImageComponent(display: DisplayImage): Image {
    const name = this.attachmentName()
    return new Image(
      display.pngData,
      'image/png',
      imageTheme,
      {
        // The measured body width bounds columns; the body-height budget bounds
        // rows. Never Pi's compact 60-cell default for this surface.
        maxWidthCells: 10_000,
        maxHeightCells: Math.max(1, this.rowBudget),
        ...(name === undefined ? {} : { filename: name }),
      },
      { widthPx: display.width, heightPx: display.height },
    )
  }

  /** Idempotent teardown: abort the read, drop state, never call onClose. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abortRead()
    this.cancelChord()
    this.decodedPayload = undefined
    this.state = { status: 'text' }
    this.frame.invalidate()
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
      // A text-mode switch that happened while the read was in flight still
      // wins: the result is dropped and never painted or treated as ready.
      if (this.previewMode() === 'text') {
        this.state = { status: 'text' }
        this.requestRender()
        return
      }
      if (!result.ok) {
        this.state = { status: 'error', reason: clean(result.reason) }
        this.requestRender()
        return
      }
      this.decodedPayload = result.image
      const component = this.createImageComponent(result.image)
      this.componentBudget = this.rowBudget
      this.geometryKey = this.geometryToken()
      this.state = { status: 'ready', display: result.image, component }
      this.requestRender()
    }).catch(error => {
      if (this.disposed || generation !== this.generation || controller.signal.aborted) return
      if (isAbortError(error)) return
      this.controller = undefined
      if (this.previewMode() === 'text') {
        this.state = { status: 'text' }
        this.requestRender()
        return
      }
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
    this.tui.requestRender()
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
    if (id === 'image.details.toggle-preview') {
      this.setPreview(this.previewMode() === 'text' ? 'auto' : 'text')
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
    this.abortRead()
    this.options.onClose()
  }

  // -------------------------------------------------------------------------
  // Geometry and rendering

  private geometryToken(): string {
    const cell = getCellDimensions()
    return `${this.rowBudget}|${cell.widthPx}x${cell.heightPx}|${getCapabilities().images ?? 'none'}`
  }

  private limitRows(): number {
    const value = this.options.maxHeight
    if (value === undefined || !Number.isFinite(value)) return 0
    return Math.max(1, Math.floor(value))
  }

  /** Invalidate/recreate only when real geometry changed, then render once. */
  private renderImageComponent(budget: number): Image {
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

  /**
   * Two-pass layout shared by `render` and the public `measure` (tests/hosts):
   * the inner width sizes the metadata rows, then the same options object sizes
   * the image body budget. Mouse/geometry helpers can never disagree with the
   * painted frame.
   */
  private layoutFor(size: number): { options: ModalFrameOptions; geometry: ModalGeometry } {
    const base = this.frameOptions(size)
    const first = this.frame.measure(size, base)
    const options: ModalFrameOptions = {
      ...base,
      before: this.beforeLines(first.bodyWidth),
      after: this.afterLines(first.bodyWidth),
    }
    return { options, geometry: this.frame.measure(size, options) }
  }

  /** Geometry of the frame that `render(width)` would produce right now. */
  measure(width: number): ModalGeometry {
    return this.layoutFor(Math.max(1, Math.floor(width))).geometry
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const { options, geometry } = this.layoutFor(size)
    this.rowBudget = Math.max(1, geometry.bodyHeight)
    // Enforce a live preference change (e.g. parent settings) without waiting
    // for a host callback; text mode aborts any read that is still pending.
    this.applyPreviewMode()
    const body = this.bodyLines(geometry.bodyWidth, geometry.bodyHeight)
    return this.frame.render(size, body, options)
  }

  private frameOptions(width: number): ModalFrameOptions {
    void width
    const { index, total } = this.navigation()
    const position = total > 1 ? `Image ${index + 1} of ${total}` : 'Image'
    return {
      title: 'Image details',
      // Occurrence identity + preview mode: a pressed footer action never acts
      // on a different occurrence or the opposite preview mode after repaint.
      ownerKey: `image:${this.image.key}:${this.previewMode()}`,
      subtitle: `${position} · ${clean(this.image.label, 60)}`,
      actions: this.frameActions(),
      onClose: () => this.close(),
      maxHeight: this.limitRows() === 0 ? 24 : this.limitRows(),
      keymap: this.keymap,
    }
  }

  /**
   * Action chips: real key bindings for navigation/close, plus a mouse-toggle for
   * the preview mode. The preview action is deliberately unbound: the input
   * registry has no image-preview action yet, so no fake shortcut is printed.
   */
  private frameActions(): ModalAction[] {
    const next = this.previewMode() === 'text' ? 'auto' : 'text'
    const actions: ModalAction[] = []
    if (this.options.onPreviousImage !== undefined) {
      actions.push({
        id: 'prev',
        label: 'Prev',
        action: 'image.details.previous-image',
        disabled: !this.canPrevious(),
        onActivate: () => this.navigate(-1),
      })
    }
    if (this.options.onNextImage !== undefined) {
      actions.push({
        id: 'next',
        label: 'Next',
        action: 'image.details.next-image',
        disabled: !this.canNext(),
        onActivate: () => this.navigate(1),
      })
    }
    actions.push({
      // The action id carries the real binding when the registry has one; a
      // click-only capability without a binding still renders as a clickable
      // label with no fake key (the frame prints the binding only when bound).
      id: 'preview',
      label: next === 'text' ? 'Text only' : 'Preview image',
      action: 'image.details.toggle-preview',
      onActivate: () => this.setPreview(next),
    })
    actions.push({ id: 'close', label: 'Close', action: 'image.details.close', onActivate: () => this.close() })
    return actions
  }

  /** Reference identity/metadata rows; always width-safe and sanitized. */
  private beforeLines(width: number): string[] {
    const inner = Math.max(1, width)
    const ref = this.image.attachment
    const title = ref === undefined
      ? `${this.attachmentName() ?? 'clipboard image'} · ${this.image.upload.mediaType}`
      : imageRefTitle(ref)
    const lines = [fit(` ${t.text(clean(title))}`, inner)]
    const meta = this.metaText()
    if (meta !== '') lines.push(fit(` ${dim(meta)}`, inner))
    return lines
  }

  private afterLines(width: number): string[] {
    const inner = Math.max(1, width)
    const lines = [fit(` ${this.statusLine()}`, inner)]
    const hint = this.hintLine()
    if (hint !== '') lines.push(fit(` ${dim(hint)}`, inner))
    return lines
  }

  private bodyLines(width: number, height: number): string[] {
    const rows = Math.max(0, Math.floor(height))
    if (rows === 0) return []
    if (this.previewMode() === 'text') return this.textPreviewLines(width, rows)
    if (rows < MIN_IMAGE_ROWS) {
      // Very short viewport: text only, but the close affordance stays visible.
      const close = this.closeKey()
      const suffix = close === undefined ? '' : ` · ${close} close`
      return [fit(` ${dim(t.muted('Viewport too short for an inline image.'))}${dim(suffix)}`, width)]
    }
    const lines = this.imageLines(width, rows)
    while (lines.length < rows) lines.push('')
    return lines.slice(0, rows)
  }

  /** Text-only preview: metadata was already rendered; no read/decode happened. */
  private textPreviewLines(width: number, rows: number): string[] {
    const close = this.closeKey()
    const suffix = close === undefined ? '' : ` · ${close} close`
    const lines = [
      fit(` ${t.text('Text preview')}${dim(' · ')}${dim('automatic image preview is off')}`, width),
      fit(` ${dim('The image was not read or decoded in this mode.')}${dim(suffix)}`, width),
    ]
    while (lines.length < rows) lines.push('')
    return lines.slice(0, rows)
  }

  private imageLines(width: number, budget: number): string[] {
    if (this.state.status === 'text') return this.textPreviewLines(width, budget)
    if (this.state.status === 'loading') {
      return [fit(` ${dim(t.muted('Loading image…'))}`, width)]
    }
    if (this.state.status === 'error') {
      return [fit(` ${t.redSoft('Image unavailable')}${dim(' · ')}${t.muted(clean(this.state.reason))}`, width)]
    }
    const component = this.renderImageComponent(budget)
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
    const display = this.state.status === 'ready' ? this.state.display : this.decodedPayload
    if (display !== undefined) {
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
    switch (this.state.status) {
      case 'text':
        return `${t.muted('Text preview')}${dim(' · automatic preview off')}`
      case 'loading':
        return dim(t.muted('Loading…'))
      case 'error':
        return cc.error('Unavailable')
      case 'ready':
        return terminalImages()
          ? cc.success('Ready')
          : `${cc.success('Ready')}${dim(' · ')}${dim('terminal cannot display inline images')}`
      default: {
        const exhaustive: never = this.state
        return t.muted(String(exhaustive))
      }
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    // Chrome owns the close/action hitboxes; body cells stay with the native
    // renderer so text selection and copy-on-select keep working.
    return this.frame.handleMouse(event)
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