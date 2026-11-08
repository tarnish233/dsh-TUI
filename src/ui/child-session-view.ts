/**
 * Native child Session view (controlled, large read-only modal).
 *
 * The parent owns the child `TranscriptStore` and the child `TranscriptView`
 * (built from the same native codec/options as the main transcript). This
 * component only frames them with the shared `ModalFrame`:
 *
 *   title: Agents › <native child label>
 *   subtitle: <root session> › <native label>
 *   before: native status/mode/model · session-total tokens · timing, identity
 *   ───────────
 *   child transcript (scrollable, no composer)
 *   ───────────
 *   status: parent message / read-only notice
 *   actions: Reply / Stop / Close (real effective bindings)
 *
 * Intervention is requested, never performed: Reply calls `onReply` so the
 * **parent** returns to its main Editor (this surface never grows a second
 * editor state), Stop calls `onStop` only for a local child the native
 * lifecycle reports as running/initializing, and `subagent.reply` /
 * `subagent.interrupt` are resolved from the shared keymap. Esc always closes
 * and never stops anything.
 *
 * Input resolves in the `subagentSession` context (`subagentSession → list →
 * dialog → global`, no editor fallback), so typing cannot edit anything and no
 * second composer exists. The global quit action (`app.exit`) is forwarded to
 * the parent through `onGlobalAction` instead of being swallowed.
 *
 * No timer is created: native timing is folded from `settledMs`/`activeSince`
 * on each frame, and the parent's renderer decides when to repaint.
 *
 * Loading shell: a freshly navigated child is readable only after the parent's
 * `subagent-follow` + `subagent-session` reads resolve. `loading: true` (or
 * `setLoading(true)`) replaces only the conversation body with
 * `Loading child session…` so navigation responds immediately without a fake
 * `SessionInfo`, a second Editor or a fabricated empty transcript. The parent
 * owns when it turns off: reset the child store from the native snapshot, then
 * `setLoading(false)`.
 *
 * Search is intentionally not implemented in this pass: a safe search would
 * have to copy durable transcript facts into a second index. The surface remains
 * fully readable/scrollable, and `modal.search` is inert here rather than
 * pretending to search.
 */
import {
  ScrollView,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type { SessionInfo, SubagentEntry } from '../backend/types.ts'
import { createCcKeymap, type CcKeymap } from '../input/index.ts'
import type { TranscriptStore } from '../state/transcript.ts'
import type { TranscriptView } from './transcript.ts'
import { modalBinding, modalHeight, ModalFrame, type ModalAction, type ModalFrameOptions, type ModalSize } from './modal.ts'
import {
  subagentCanReply,
  subagentCanStop,
  subagentLabel,
  subagentModeLabel,
  subagentRouteLabel,
  subagentStatusLabel,
  subagentTimingLabel,
  subagentTokensLabel,
  subagentTone,
  type SubagentTone,
} from './subagent-format.ts'
import { fit, sanitize } from './text.ts'
import { dim, t } from './theme.ts'

export interface ChildSessionViewOptions {
  /** Durable child catalog entry this view belongs to. */
  entry: SubagentEntry
  /** Child Session snapshot when already read by the parent (model fallback). */
  info?: SessionInfo
  /** Parent-owned child transcript projection. Read-only here. */
  store: TranscriptStore
  /** Parent-owned child transcript view (same options as the main view). */
  view: TranscriptView
  /** Shared keymap; defaults to the CC defaults for standalone hosts/tests. */
  keymap?: CcKeymap
  /** Defaults to `[parentSessionId, label]`. */
  breadcrumb?: readonly string[]
  /** Esc / configured cancel. Parent hides this surface. */
  onClose: () => void
  /**
   * Request a follow-up prompt for this child. The parent switches to its main
   * Editor (this view never creates one) and owns the prompt call; called only
   * for a local continuable child.
   */
  onReply?: (entry: SubagentEntry) => void
  /**
   * Request a native interrupt for this child. Called only when the entry is
   * local and `running`/`initializing`.
   */
  onStop?: (entry: SubagentEntry) => void
  /** `app.interrupt` inside the child view; defaults to closing it. */
  onInterrupt?: () => void
  /**
   * Reserved for truly global app actions (`app.exit`). Parent tool/model/
   * permission/settings actions are deliberately never forwarded here.
   */
  onGlobalAction?: (actionId: string) => void
  onRenderRequest?: () => void
  /** Height cap combined with the shared `modalHeight` token. */
  maxHeight?: number
  /** Clock for the native session-total duration; injectable for tests. */
  now?: () => number
  /** Start following the end of a live child conversation (default true). */
  follow?: boolean
  /** Dispose the supplied `view` with this component (default true). */
  ownsView?: boolean
  /**
   * Display a loading shell instead of the conversation while the parent's
   * native follow/snapshot read is still in flight (default false). It is
   * presentation only: the parent supplies the real entry and, later, the real
   * native `SessionInfo` through `setEntry`/`update({info})`. No fake snapshot
   * is created and no editor is added here.
   */
  loading?: boolean
}

const CLOSE_ACTIONS: ReadonlySet<string> = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])

/** Body line while the parent's native child snapshot is pending. */
const LOADING_TEXT = 'Loading child session…'

const TONE_STYLE: Readonly<Record<SubagentTone, (text: string) => string>> = {
  running: t.accent,
  done: t.green,
  idle: t.muted,
  failed: t.redSoft,
  stopped: t.yellow,
  external: t.subtle,
  unknown: t.subtle,
}

function toneGlyph(tone: SubagentTone): string {
  switch (tone) {
    case 'running': return t.accent('⏺')
    case 'done': return t.green('●')
    case 'failed': return t.redSoft('●')
    case 'stopped': return t.yellow('◌')
    case 'idle': return t.muted('○')
    case 'external': return t.subtle('◌')
    case 'unknown': return t.subtle('◌')
  }
}

export class ChildSessionView implements Component, Focusable {
  readonly capturesViewportInput = true
  /** Parent generic dialog hosting uses the wide modal token. */
  readonly modalSize: ModalSize = 'wide'
  readonly keymap: CcKeymap
  readonly store: TranscriptStore
  readonly view: TranscriptView
  private readonly tui: TUI
  private readonly options: ChildSessionViewOptions
  private readonly scrollView: ScrollView
  private readonly frame = new ModalFrame()
  private entryValue: SubagentEntry
  private infoValue: SessionInfo | undefined
  private breadcrumbValue: readonly string[]
  private focusedState = false
  private done = false
  private disposed = false
  private chordPending = false
  private viewportRows = 1
  private loadingValue: boolean
  private messageValue: { readonly text: string; readonly error: boolean } | undefined
  private readonly now: () => number

  constructor(tui: TUI, options: ChildSessionViewOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.store = options.store
    this.view = options.view
    this.entryValue = options.entry
    this.infoValue = options.info
    this.breadcrumbValue = options.breadcrumb ?? [options.entry.parentSessionId, subagentLabel(options.entry)]
    this.loadingValue = options.loading === true
    this.now = options.now ?? Date.now
    this.scrollView = new ScrollView(options.view, {
      scrollbar: 'hidden',
      follow: options.follow === false ? 'none' : 'end',
    })
  }

  // -------------------------------------------------------------------------
  // Public surface

  get entry(): SubagentEntry {
    return this.entryValue
  }

  get info(): SessionInfo | undefined {
    return this.infoValue
  }

  get breadcrumb(): readonly string[] {
    return this.breadcrumbValue
  }

  get isDone(): boolean {
    return this.done
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** True while the parent's native snapshot for this child is still pending. */
  get loading(): boolean {
    return this.loadingValue
  }

  /**
   * Switch the loading shell on/off. Idempotent, never touches the entry, the
   * store, focus, callbacks or the scroll position; the parent calls this with
   * `false` once it has reset the child store from the native snapshot.
   */
  setLoading(loading: boolean): void {
    if (this.disposed || this.loadingValue === loading) return
    this.loadingValue = loading
    this.invalidate()
  }

  /**
   * Visible status for a parent-owned native action failure/confirmation
   * (reply/stop). Shown in this surface's own status row, never behind the
   * transcript. `undefined` clears it.
   */
  setMessage(message?: string, error = false): void {
    if (this.disposed) return
    const text = message === undefined ? '' : sanitize(message).trim()
    if (text === '') this.messageValue = undefined
    else this.messageValue = { text, error }
    this.requestRender()
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    if (!value) this.cancelChord()
    this.focusedState = value
  }

  cancelChord(): void {
    if (!this.chordPending) return
    this.chordPending = false
    this.keymap.cancelChord()
  }

  /** Replace the header row for the same or a newly opened child. */
  setEntry(entry: SubagentEntry): void {
    if (this.disposed) return
    const different = entry.id !== this.entryValue.id
    this.entryValue = entry
    if (different) {
      this.scrollView.scrollToStart()
      this.viewportRows = 1
    }
    this.invalidate()
  }

  /** Pick this view's row out of a full native catalog snapshot. */
  setEntries(entries: readonly SubagentEntry[]): void {
    if (this.disposed) return
    const current = entries.find(candidate => candidate.id === this.entryValue.id)
    if (current !== undefined) this.setEntry(current)
  }

  /**
   * Generic parent update. No arguments asks for a repaint only; `view`/`store`
   * changes remain the parent's responsibility (it owns the child backend).
   */
  update(change: { entry?: SubagentEntry; entries?: readonly SubagentEntry[]; info?: SessionInfo } = {}): void {
    if (this.disposed) return
    if (change.entries !== undefined) this.setEntries(change.entries)
    if (change.entry !== undefined) this.setEntry(change.entry)
    if (change.info !== undefined) this.infoValue = change.info
    this.invalidate()
  }

  invalidate(): void {
    if (this.disposed) return
    this.frame.invalidate()
    this.view.invalidate()
    this.requestRender()
  }

  /** Idempotent teardown; never calls `onClose`/`onInterrupt`. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelChord()
    this.frame.invalidate()
    if (this.options.ownsView !== false) this.view.dispose()
    else this.view.invalidate()
  }

  private requestRender(): void {
    if (this.disposed) return
    this.options.onRenderRequest?.()
    this.tui.requestRender()
  }

  // -------------------------------------------------------------------------
  // Input (no editor layer)

  handleInput(raw: string): void {
    if (this.done || this.disposed) return
    const resolution = this.keymap.resolve(raw, 'subagentSession')
    if (resolution.kind === 'pending') {
      this.chordPending = true
      return
    }
    if (resolution.kind !== 'action') {
      this.chordPending = false
      return
    }
    this.chordPending = false
    const id = resolution.action.id
    if (CLOSE_ACTIONS.has(id)) {
      this.close()
      return
    }
    // A loading shell has no laid-out conversation yet: scroll keys stay inert
    // until the native snapshot arrives. Esc/global/intervention keys are
    // resolved above and keep working exactly as in the loaded surface.
    if (this.loadingValue && id.startsWith('list.')) return
    switch (id) {
      case 'app.interrupt':
        // Ctrl+C stops an active child; it never closes the surface. A child
        // that cannot be stopped keeps the historical interrupt/close path.
        if (this.stopChild()) return
        if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
        else this.close()
        return
      case 'subagent.reply':
        // The parent decides where the reply goes (its own main Editor).
        this.replyChild()
        return
      case 'subagent.interrupt':
        this.stopChild()
        return
      case 'app.exit':
        // Global quit is not ours to swallow: the parent's normal exit path
        // decides, including its empty-draft/armed-exit semantics.
        this.options.onGlobalAction?.(id)
        return
      case 'list.previous':
        this.scrollBy(-1)
        return
      case 'list.next':
        this.scrollBy(1)
        return
      case 'list.page-up':
        this.scrollBy(-Math.max(1, this.viewportRows - 1))
        return
      case 'list.page-down':
        this.scrollBy(Math.max(1, this.viewportRows - 1))
        return
      case 'list.first':
        this.scrollView.scrollToStart()
        this.requestRender()
        return
      case 'list.last':
        this.scrollView.scrollToEnd()
        this.requestRender()
        return
      default:
        // No editor fallback and no parent model/permission/tool/settings
        // action may run from a child conversation. `modal.search` is inert
        // here (no second fact index, see the module doc).
        return
    }
  }

  /**
   * Reply target: the current child when it is a local continuable child and
   * the parent supplied `onReply`; otherwise reply is completely inert.
   */
  private replyTarget(): SubagentEntry | undefined {
    if (this.options.onReply === undefined) return undefined
    return subagentCanReply(this.entryValue) ? this.entryValue : undefined
  }

  /** Stop target: the current child when local and running/initializing. */
  private stopTarget(): SubagentEntry | undefined {
    if (this.options.onStop === undefined) return undefined
    return subagentCanStop(this.entryValue) ? this.entryValue : undefined
  }

  /** Returns whether a request was issued; never mutates state itself. */
  private replyChild(): boolean {
    const entry = this.replyTarget()
    const callback = this.options.onReply
    if (entry === undefined || callback === undefined) return false
    callback(entry)
    return true
  }

  private stopChild(): boolean {
    const entry = this.stopTarget()
    const callback = this.options.onStop
    if (entry === undefined || callback === undefined) return false
    callback(entry)
    return true
  }

  private scrollBy(lines: number): void {
    this.scrollView.scrollBy(lines)
    this.requestRender()
  }

  private close(): void {
    if (this.done || this.disposed) return
    this.done = true
    this.cancelChord()
    this.options.onClose()
  }

  // -------------------------------------------------------------------------
  // Rendering

  /**
   * Height budget from the shared wide token plus any parent cap. The frame
   * measures its own chrome; this component never subtracts a chrome constant.
   */
  private limitRows(): number {
    const token = modalHeight(this.tui, this.modalSize)
    const configured = this.options.maxHeight
    if (configured === undefined || !Number.isFinite(configured) || configured <= 0) return token
    return Math.max(1, Math.min(token, Math.floor(configured)))
  }

  private innerWidth(size: number, limit: number): number {
    return size >= 8 && limit >= 6 ? Math.max(1, size - 4) : size
  }

  private headerBreadcrumb(width: number): string {
    const parts = this.breadcrumbValue
      .map(part => sanitize(part).trim())
      .filter(part => part !== '')
    const suffix = this.external() ? dim(' · no local transcript') : ''
    return fit(t.text(parts.join(' › ')) + suffix, width)
  }

  private headerStatus(width: number): string {
    const entry = this.effectiveEntry()
    const tone = subagentTone(entry)
    const status = subagentStatusLabel(entry)
    const pieces: string[] = [`${toneGlyph(tone)} ${TONE_STYLE[tone](status)}`]
    // External rows already say `external`; repeating the mode is noise.
    if (entry.mode !== 'external' && entry.status !== 'external') {
      pieces.push(dim(subagentModeLabel(entry.mode)))
    }
    const route = subagentRouteLabel(entry)
    if (route !== undefined) pieces.push(dim(sanitize(route)))
    const tokens = subagentTokensLabel(entry.totalTokens)
    if (tokens !== undefined) pieces.push(dim(tokens))
    const timing = subagentTimingLabel(entry.timing, this.now())
    if (timing !== undefined) pieces.push(dim(timing))
    return fit(pieces.join(dim(' · ')), width)
  }

  private effectiveEntry(): SubagentEntry {
    const info = this.infoValue
    if (info === undefined) return this.entryValue
    return {
      ...this.entryValue,
      provider: this.entryValue.provider ?? info.provider,
      model: this.entryValue.model ?? info.model,
    }
  }

  private headerIdentity(width: number): string {
    const entry = this.effectiveEntry()
    const pieces = [dim('id ' + sanitize(entry.id))]
    if (this.infoValue !== undefined) pieces.push(dim(`session ${sanitize(this.infoValue.sessionId)}`))
    if (entry.mode === 'external' || entry.status === 'external') {
      pieces.push(dim('external task · no local transcript'))
    }
    return fit(pieces.join(dim(' · ')), width)
  }

  private external(): boolean {
    return this.entryValue.mode === 'external' || this.entryValue.status === 'external'
  }

  /** True when this surface has any native intervention request available. */
  private interactive(): boolean {
    return this.options.onReply !== undefined || this.options.onStop !== undefined
  }

  private statusLines(width: number): readonly string[] {
    if (this.messageValue !== undefined) {
      const style = this.messageValue.error ? t.redSoft : t.muted
      return [fit(style(this.messageValue.text), width)]
    }
    if (this.external()) {
      return [fit(dim(t.muted('External task · no local transcript · read-only')), width)]
    }
    if (!this.interactive()) {
      return [fit(dim(t.muted('read-only · viewing native facts')), width)]
    }
    return []
  }

  private modalActions(limit: number): readonly ModalAction[] {
    const actions: ModalAction[] = []
    // A real native capability stays clickable even when its key binding is
    // disabled: the frame paints the label without a fictitious shortcut.
    const reply = this.replyTarget()
    if (reply !== undefined) {
      actions.push({ id: `reply:${reply.id}`, label: 'reply', action: 'subagent.reply', onActivate: () => { if (this.entryValue.id === reply.id) this.replyChild() } })
    }
    const stop = this.stopTarget()
    if (stop !== undefined) {
      actions.push({ id: `stop:${stop.id}`, label: 'stop', action: 'subagent.interrupt', onActivate: () => { if (this.entryValue.id === stop.id) this.stopChild() } })
    }
    const closeBinding = modalBinding(this.keymap, 'list.cancel', true) ?? modalBinding(this.keymap, 'app.cancel', true)
    const closeAction: ModalAction = {
      id: 'close',
      label: 'close',
      ...(closeBinding === undefined ? {} : { action: 'list.cancel' }),
      onActivate: () => this.close(),
    }
    // Keep the real return affordance first when only one footer row fits.
    if (limit < 6) return [closeAction, ...actions.slice(0, 1)]
    actions.push(closeAction)
    return actions
  }

  private frameOptions(size: number, limit: number): ModalFrameOptions {
    const width = this.innerWidth(size, limit)
    return {
      title: `Agents › ${sanitize(subagentLabel(this.entryValue))}`,
      // Stable child Session identity: a press cannot survive a different
      // child, even when both rows carry the same action label.
      ownerKey: `child:${this.entryValue.id}`,
      subtitle: this.headerBreadcrumb(width),
      before: [this.headerStatus(width), this.headerIdentity(width)],
      after: this.statusLines(width),
      actions: this.modalActions(limit),
      onClose: () => this.close(),
      maxHeight: limit,
      keymap: this.keymap,
    }
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const limit = this.limitRows()
    const external = this.external()
    const options = this.frameOptions(size, limit)
    const probe = this.frame.measure(size, options)
    const bodyHeight = Math.max(0, probe.bodyHeight)
    const bodyWidth = Math.max(1, probe.bodyWidth)
    this.viewportRows = Math.max(1, bodyHeight)

    const body: string[] = []
    if (this.loadingValue && !external) {
      // The native snapshot is still being read: state the pending read
      // honestly instead of claiming the conversation is empty, and lay out no
      // scroll content (there is none yet). Everything else on this surface —
      // breadcrumb, native status, totals, Reply/Stop gating, close keys — is
      // the normal chrome and stays exactly as it is once loaded.
      body.push(fit(dim(t.muted(LOADING_TEXT)), bodyWidth))
      for (let index = 1; index < bodyHeight; index += 1) body.push('')
    } else if (external) {
      body.push(fit(dim(t.muted('External task: this child has no local Session transcript.')), bodyWidth))
      for (let index = 1; index < bodyHeight; index += 1) body.push('')
    } else {
      const content = this.scrollView.render(bodyWidth)
      this.scrollView.updateLayout(content.length, Math.max(1, bodyHeight), () => this.requestRender())
      const maxScroll = Math.max(0, content.length - Math.max(1, bodyHeight))
      const top = Math.max(0, Math.min(this.scrollView.scrollTop, maxScroll))
      if (content.length === 0) {
        body.push(fit(dim(t.muted('No messages in this agent session.')), bodyWidth))
        for (let index = 1; index < bodyHeight; index += 1) body.push('')
      } else {
        for (let offset = 0; offset < bodyHeight; offset += 1) body.push(content[top + offset] ?? '')
      }
    }

    const lines = this.frame.render(size, body, options)
    return lines.map(line => fit(line, size))
  }

  // -------------------------------------------------------------------------
  // Mouse: frame owns chrome/action chips; body delegates to the transcript.

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0
      if (delta === 0 || this.loadingValue) return undefined
      this.scrollBy(delta)
      return { handled: true, render: true }
    }
    const chrome = this.frame.handleMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.frame.bodyMouse(event)
    if (body === undefined) return undefined
    return this.view.handleMouse(body)
  }
}
