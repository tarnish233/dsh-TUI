/**
 * Native child Session view (controlled surface).
 *
 * The parent owns the child `TranscriptStore` and the child `TranscriptView`
 * (built from the same native codec/options as the main transcript). This
 * component only frames them:
 *
 *   breadcrumb → native status/mode/model · session-total tokens · timing
 *   ───────────
 *   child transcript (scrollable, no composer)
 *   ───────────
 *   effective key hints (+ Reply/Stop action chips when applicable)
 *
 * Intervention is requested, never performed: Reply calls `onReply` so the
 * **parent** returns to its main Editor (this surface never grows a second
 * editor state), Stop calls `onStop` only for a local child the native
 * lifecycle reports as running/initializing, and `subagent.reply` /
 * `subagent.interrupt` are resolved from the shared keymap. Esc always closes
 * and never stops anything.
 *
 * Input resolves in the `subagentSession` context (`subagentSession → list →
 * dialog → global`, no editor fallback), so typing cannot edit anything. The
 * global quit action (`app.exit`) is forwarded to the parent through
 * `onGlobalAction` instead of being swallowed.
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
import { createCcKeymap, formatBinding, type CcKeymap } from '../input/index.ts'
import type { TranscriptStore } from '../state/transcript.ts'
import type { TranscriptView } from './transcript.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
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
import { fit, sanitize, visibleWidth } from './text.ts'
import { bold, cc, dim, t } from './theme.ts'

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
  /** Height cap; defaults to the terminal rows minus two. */
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

/** One clickable footer action chip in component-local columns (inclusive). */
interface FooterChip {
  readonly action: 'reply' | 'stop'
  readonly startCol: number
  readonly endCol: number
}

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
  readonly keymap: CcKeymap
  readonly store: TranscriptStore
  readonly view: TranscriptView
  private readonly tui: TUI
  private readonly options: ChildSessionViewOptions
  private readonly scrollView: ScrollView
  private readonly registry = new HitboxRegistry()
  private entryValue: SubagentEntry
  private infoValue: SessionInfo | undefined
  private breadcrumbValue: readonly string[]
  private focusedState = false
  private done = false
  private disposed = false
  private chordPending = false
  private viewportRows = 1
  private loadingValue: boolean
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
    this.view.invalidate()
    this.requestRender()
  }

  /** Idempotent teardown; never calls `onClose`/`onInterrupt`. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelChord()
    this.registry.clear()
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
        // action may run from a child conversation.
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

  private runAction(action: 'reply' | 'stop'): void {
    if (action === 'reply') this.replyChild()
    else this.stopChild()
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

  private limitRows(): number {
    const rows = this.tui.terminal.rows
    const terminalCap = Number.isFinite(rows) && rows > 0 ? Math.max(6, Math.floor(rows) - 2) : 24
    const configured = this.options.maxHeight
    if (configured === undefined || !Number.isFinite(configured) || configured <= 0) return terminalCap
    return Math.max(6, Math.min(terminalCap, Math.floor(configured)))
  }

  private headerBreadcrumb(width: number): string {
    const parts = this.breadcrumbValue
      .map(part => sanitize(part).trim())
      .filter(part => part !== '')
    const text = parts.join(' › ')
    return fit(` ${dim('Agents')}${dim(' › ')}${t.text(text)}`, width)
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
    return fit(` ${pieces.join(dim(' · '))}`, width)
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
    return fit(` ${pieces.join(dim(' · '))}`, width)
  }

  /**
   * Footer line plus the clickable action chips it actually painted.
   *
   * Without `onReply`/`onStop` the surface is literally read-only for this row
   * and says so. With callbacks, only the actions the native row supports are
   * advertised (from the shared keymap), and a footer too narrow for the chips
   * drops them entirely so no unclickable/invisible affordance stays behind.
   */
  private footer(width: number): { line: string; chips: FooterChip[] } {
    const base: string[] = []
    const previous = this.bindingLabel('list.previous')
    const next = this.bindingLabel('list.next')
    const close = this.bindingLabel('list.cancel') ?? this.bindingLabel('app.cancel')
    if (previous !== undefined && next !== undefined) base.push(`${previous}/${next} scroll`)
    if (close !== undefined) base.push(`${close} close`)

    const actions: Array<{ action: 'reply' | 'stop'; text: string }> = []
    const replyKey = this.actionKey('subagent.reply')
    if (replyKey !== undefined && this.replyTarget() !== undefined) actions.push({ action: 'reply', text: `[${replyKey}] reply` })
    const stopKey = this.actionKey('subagent.interrupt')
    if (stopKey !== undefined && this.stopTarget() !== undefined) actions.push({ action: 'stop', text: `[${stopKey}] stop` })
    if (actions.length === 0) {
      if (this.options.onReply === undefined && this.options.onStop === undefined) base.push('read-only')
      return { line: base.join(' · '), chips: [] }
    }

    const plain = [...actions.map(action => action.text), ...base].join(' · ')
    if (visibleWidth(plain) > width) return { line: base.join(' · '), chips: [] }

    let line = ''
    const chips: FooterChip[] = []
    const pushPart = (text: string, styled: string, action?: 'reply' | 'stop'): void => {
      if (line !== '') line += dim(' · ')
      const start = visibleWidth(line)
      line += styled
      if (action !== undefined) chips.push({ action, startCol: start, endCol: start + visibleWidth(text) - 1 })
    }
    for (const action of actions) pushPart(action.text, t.accentBright(action.text), action.action)
    for (const part of base) pushPart(part, dim(part))
    return { line, chips }
  }

  private bindingLabel(action: string): string | undefined {
    const binding = this.keymap.getBindings(action)[0]
    return binding === undefined ? undefined : formatBinding(binding.split(' '))
  }

  /**
   * Effective key for one action in the `subagentSession` chain. A session-only
   * or disabled shared action never advertises a dead key here.
   */
  private actionKey(actionId: string): string | undefined {
    const action = this.keymap.getAction(actionId)
    if (action === undefined) return undefined
    const chain = this.keymap.getFallbackChain('subagentSession')
    if (!action.contexts.some(entry => chain.includes(entry))) return undefined
    const binding = this.keymap.getBindings(actionId)[0]
    return binding === undefined ? undefined : formatBinding(binding.split(' '))
  }

  /** True when this surface has any native intervention request available. */
  private interactive(): boolean {
    return this.options.onReply !== undefined || this.options.onStop !== undefined
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const limit = this.limitRows()
    const external = this.entryValue.mode === 'external' || this.entryValue.status === 'external'
    // 4 header rows (rule/breadcrumb/status/rule) + 3 footer rows
    // (rule/identity/hint); the conversation gets everything else.
    const chrome = 7
    if (limit < chrome + 2) return this.renderCompact(size, limit, external)

    const out: string[] = []
    const push = (line: string): void => {
      out.push(line)
    }
    push(cc.inactive('─'.repeat(size)))
    push(this.headerBreadcrumb(size))
    push(this.headerStatus(size))
    push(cc.inactive('─'.repeat(size)))

    const bodyHeight = Math.max(1, limit - chrome)
    this.viewportRows = bodyHeight
    if (this.loadingValue && !external) {
      // The native snapshot is still being read: state the pending read
      // honestly instead of claiming the conversation is empty, and lay out no
      // scroll content (there is none yet). Everything else on this surface —
      // breadcrumb, native status, totals, Reply/Stop gating, close keys — is
      // the normal chrome and stays exactly as it is once loaded.
      push(fit(` ${dim(t.muted(LOADING_TEXT))}`, size))
      for (let index = 1; index < bodyHeight; index += 1) push('')
    } else {
      let content: string[]
      if (external) {
        content = [fit(` ${dim(t.muted('External task: this child has no local Session transcript.'))}`, size)]
      } else {
        content = this.scrollView.render(size)
      }
      const total = content.length
      this.scrollView.updateLayout(total, bodyHeight, () => this.requestRender())
      const maxScroll = Math.max(0, total - bodyHeight)
      const top = Math.max(0, Math.min(this.scrollView.scrollTop, maxScroll))
      if (total === 0) {
        push(fit(` ${dim(t.muted('No messages in this agent session.'))}`, size))
        for (let index = 1; index < bodyHeight; index += 1) push('')
      } else {
        for (let offset = 0; offset < bodyHeight; offset += 1) {
          push(content[top + offset] ?? '')
        }
      }
    }

    push(cc.inactive('─'.repeat(size)))
    push(this.headerIdentity(size))
    const footer = this.footer(size)
    const boxes: MouseHitbox[] = []
    if (footer.line !== '') {
      const row = out.length
      push(fit(` ${footer.line}`, size))
      for (const chip of footer.chips) {
        boxes.push({
          id: `child-action:${chip.action}`,
          startRow: row,
          endRow: row,
          startCol: chip.startCol + 1,
          endCol: chip.endCol + 1,
          claimPress: true,
          onClick: () => this.runAction(chip.action),
        })
      }
    }
    // Never grow past the viewport, and never leave a hitbox on a clipped row.
    if (out.length > limit) out.length = limit
    this.registry.sync(boxes.filter(box => box.endRow < out.length))
    return out.map(line => fit(line, size))
  }

  /** Short viewport: identity + status + close affordance, never a hidden editor. */
  private renderCompact(width: number, limit: number, external: boolean): string[] {
    const close = this.bindingLabel('list.cancel') ?? this.bindingLabel('app.cancel') ?? 'Esc'
    const lines = [this.headerBreadcrumb(width), this.headerStatus(width)]
    if (this.loadingValue && !external) lines.push(fit(` ${dim(t.muted(LOADING_TEXT))}`, width))
    else if (external) lines.push(fit(` ${dim(t.muted('External task · no local transcript'))}`, width))
    lines.push(fit(` ${dim(`${close} close${this.interactive() ? '' : ' · read-only'}`)}`, width))
    this.viewportRows = 1
    // No chip is painted in a short viewport, so no action hitbox may exist.
    this.registry.sync([])
    return lines.slice(0, Math.max(1, limit)).map(line => fit(line, width))
  }

  // -------------------------------------------------------------------------
  // Mouse: wheel scrolls the conversation; Reply/Stop chips are clickable.

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0
      if (delta === 0 || this.loadingValue) return undefined
      this.scrollBy(delta)
      return { handled: true, render: true }
    }
    return this.registry.handleMouse(event)
  }
}