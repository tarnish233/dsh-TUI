/**
 * Native Agents overlay (temporary modal).
 *
 * One list of DSH's child catalog: direct children and the nested children the
 * native rows already identify through `parentSessionId`. This surface owns no
 * pane, starts no timer and never polls: `setEntries`/`setEntry` replace native
 * snapshots, and the parent owns every render/close decision.
 *
 * Input is resolved through the shared `CcKeymap` in the `subagentList` context
 * (`subagentList → list → dialog → global`, no editor fallback), so list
 * movement, Enter and Esc come from the real keymap and a remapped/disabled
 * action never advertises a dead key. Any other resolved global action is
 * deliberately inert inside this modal; the parent action
 * `app.subagents.details` opened it, it cannot re-enter itself.
 *
 * Intervention is requested, never performed: `subagent.reply` / the Reply
 * action chip call `onReply` and `subagent.interrupt` / the Stop chip call
 * `onStop` only when that callback exists *and* the selected native row is
 * applicable (`subagentCanReply` / `subagentCanStop`). The parent owns the
 * backend command, the Agent and the scheduler; this component never creates an
 * editor, never sends a prompt and never invents a status.
 *
 * External tasks are real catalog rows but have no local child Session, so they
 * are selectable and never open a transcript. Width-safe rows drop mode,
 * activity, tokens and timing in that priority order before the label/status.
 */
import {
  ScrollView,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type { SubagentEntry, SubagentSnapshot } from '../backend/types.ts'
import { createCcKeymap, formatBinding, type CcKeymap } from '../input/index.ts'
import {
  buildSubagentTree,
  flattenSubagentTree,
  SubagentProjection,
  type SubagentTreeNode,
} from '../state/subagents.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import {
  subagentActivity,
  subagentCanReply,
  subagentCanStop,
  subagentLabel,
  subagentModeLabel,
  subagentOpenable,
  subagentStatusLabel,
  subagentTimingLabel,
  subagentTokensLabel,
  subagentTone,
  type SubagentTone,
} from './subagent-format.ts'
import { fit, sanitize, truncateToWidth, visibleWidth } from './text.ts'
import { bold, cc, dim, t } from './theme.ts'

export interface AgentsOverlayOptions {
  /** Initial native catalog entries (direct and nested). */
  entries: readonly SubagentEntry[]
  /** True only when the native read is known to be incomplete. */
  truncated?: boolean
  /** Shared keymap; defaults to the CC defaults for tests/standalone hosts. */
  keymap?: CcKeymap
  /** Esc / configured cancel. Parent hides and disposes this instance. */
  onClose: () => void
  /**
   * Open one local child's read-only session view. External rows never call
   * this, because DSH has no local child Session for them.
   */
  onOpen?: (entry: SubagentEntry) => void
  /**
   * Request a native follow-up prompt for the selected child. Called only when
   * this callback exists and the row is a local continuable child; the parent
   * owns the prompt/backend call and any Editor it opens.
   */
  onReply?: (entry: SubagentEntry) => void
  /**
   * Request a native interrupt for the selected child. Called only when this
   * callback exists and the row is local and `running`/`initializing`.
   */
  onStop?: (entry: SubagentEntry) => void
  /** Global interrupt (`app.interrupt`); defaults to closing the overlay. */
  onInterrupt?: () => void
  /**
   * Reserved for truly global app actions. Only `app.exit` is forwarded here,
   * matching `ChildSessionView`; parent tools/model/permission/settings/
   * subagent actions stay inert inside this read-only modal.
   */
  onGlobalAction?: (actionId: string) => void
  /** Repaint hook; the component itself never writes stdout. */
  onRenderRequest?: () => void
  /** Overlay height cap; defaults to the terminal rows minus two. */
  maxHeight?: number
  /** Clock for the native session-total duration; injectable for tests. */
  now?: () => number
}

const CLOSE_ACTIONS: ReadonlySet<string> = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])

/** One clickable footer action chip in component-local columns (inclusive). */
interface FooterChip {
  readonly action: 'reply' | 'stop'
  readonly startCol: number
  readonly endCol: number
}

const CHROME_ROWS = 6

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

/** Empty host child: ScrollView owns the public scroll state; rows are sliced here. */
class EmptyBody implements Component {
  render(): string[] {
    return []
  }

  invalidate(): void {}
}

export class AgentsOverlay implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: AgentsOverlayOptions
  private readonly registry = new HitboxRegistry()
  private readonly projectionValue = new SubagentProjection()
  private readonly scrollView: ScrollView
  private selectedId: string | undefined
  private focusedState = false
  private done = false
  private disposed = false
  private chordPending = false
  /** Last rendered viewport height, used by page navigation. */
  private viewportRows = 1
  private readonly now: () => number

  constructor(tui: TUI, options: AgentsOverlayOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.now = options.now ?? Date.now
    this.scrollView = new ScrollView(new EmptyBody(), { scrollbar: 'hidden' })
    this.projectionValue.applySnapshot({
      entries: options.entries,
      ...(options.truncated === true ? { truncated: true } : {}),
    })
    this.selectedId = this.flatRows()[0]?.entry.id
  }

  // -------------------------------------------------------------------------
  // Public surface (parent owns the overlay lifecycle)

  get entries(): readonly SubagentEntry[] {
    return this.projectionValue.entries
  }

  get truncated(): boolean {
    return this.projectionValue.truncated
  }

  get selectedEntry(): SubagentEntry | undefined {
    return this.projectionValue.get(this.selectedId) ?? this.flatRows()[0]?.entry
  }

  get isDone(): boolean {
    return this.done
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

  /** Release only this instance's pending chord. */
  cancelChord(): void {
    if (!this.chordPending) return
    this.chordPending = false
    this.keymap.cancelChord()
  }

  /**
   * Replace the whole native catalog entry list. An omitted `truncated` keeps
   * the current completeness flag instead of silently clearing a real native
   * truncation; pass `{ truncated: false }` when a fresh complete read owns it.
   */
  setEntries(entries: readonly SubagentEntry[], options: { truncated?: boolean } = {}): void {
    if (this.disposed) return
    const truncated = options.truncated ?? this.truncated
    const changed = this.projectionValue.applySnapshot({
      entries,
      ...(truncated ? { truncated: true } : {}),
    })
    this.afterCatalogChange(changed)
  }

  /** Apply a full native snapshot object. */
  setSnapshot(snapshot: SubagentSnapshot): void {
    if (this.disposed) return
    const changed = this.projectionValue.applySnapshot(snapshot)
    this.afterCatalogChange(changed)
  }

  /** Apply one live upsert (keeps a known cold catalog anchor). */
  setEntry(entry: SubagentEntry): void {
    if (this.disposed) return
    const changed = this.projectionValue.applyEntry(entry)
    this.afterCatalogChange(changed)
  }

  /**
   * Parent-facing generic update: one entry, a full entry list, or a native
   * snapshot. With no catalog argument it only asks for a repaint (the parent
   * may have new native timing for the same rows).
   */
  update(change: {
    entry?: SubagentEntry
    entries?: readonly SubagentEntry[]
    truncated?: boolean
    snapshot?: SubagentSnapshot
  } = {}): void {
    if (this.disposed) return
    if (change.snapshot !== undefined) {
      this.setSnapshot(change.snapshot)
      return
    }
    if (change.entry !== undefined) {
      this.setEntry(change.entry)
      return
    }
    if (change.entries !== undefined) {
      this.setEntries(change.entries, change.truncated === undefined ? {} : { truncated: change.truncated })
      return
    }
    this.requestRender()
  }

  /** Idempotent teardown; never calls `onClose` and never moves focus. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelChord()
    this.registry.clear()
  }

  invalidate(): void {
    if (this.disposed) return
    this.requestRender()
  }

  private afterCatalogChange(changed: boolean): void {
    const rows = this.flatRows()
    if (this.selectedId === undefined || this.projectionValue.get(this.selectedId) === undefined) {
      this.selectedId = rows[0]?.entry.id
    }
    if (changed) this.requestRender()
  }

  private requestRender(): void {
    if (this.disposed) return
    this.options.onRenderRequest?.()
    this.tui.requestRender()
  }

  // -------------------------------------------------------------------------
  // Input

  handleInput(raw: string): void {
    if (this.done || this.disposed) return
    const resolution = this.keymap.resolve(raw, 'subagentList')
    if (resolution.kind === 'pending') {
      this.chordPending = true
      return
    }
    if (resolution.kind !== 'action') {
      // A mismatched chord/unknown key is consumed by the modal.
      this.chordPending = false
      return
    }
    this.chordPending = false
    this.dispatch(resolution.action.id)
  }

  private dispatch(id: string): void {
    if (CLOSE_ACTIONS.has(id)) {
      this.close()
      return
    }
    switch (id) {
      case 'app.interrupt':
        // Ctrl+C is the interrupt escape hatch, so it stops a stoppable child
        // instead of dropping the whole surface; Esc still closes (above).
        if (this.stopSelected()) return
        if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
        else this.close()
        return
      case 'subagent.reply':
        // Explicit reply action: applicable rows only, otherwise inert (a
        // one-shot/external row must never advertise a prompt it cannot send).
        this.replySelected()
        return
      case 'subagent.interrupt':
        this.stopSelected()
        return
      case 'list.previous':
        this.move(-1)
        return
      case 'list.next':
        this.move(1)
        return
      case 'list.page-up':
        this.move(-Math.max(1, this.viewportRows - 1))
        return
      case 'list.page-down':
        this.move(Math.max(1, this.viewportRows - 1))
        return
      case 'list.first':
        this.selectIndex(0)
        return
      case 'list.last':
        this.selectIndex(this.flatRows().length - 1)
        return
      case 'list.select':
        this.openSelected()
        return
      case 'app.exit':
        // Global quit is not ours to swallow: the parent's normal exit path
        // decides, including its empty-draft/armed-exit semantics.
        this.options.onGlobalAction?.(id)
        return
      default:
        // `app.subagents.details`, model, permission, tools and settings actions
        // are parent surfaces: they stay inert inside this read-only modal.
        return
    }
  }

  private move(delta: number): void {
    const rows = this.flatRows()
    if (rows.length === 0) return
    const current = this.selectedIndex()
    this.selectIndex(current < 0 ? 0 : current + delta)
  }

  private selectIndex(index: number): void {
    const rows = this.flatRows()
    if (rows.length === 0) {
      this.selectedId = undefined
      return
    }
    const clamped = Math.max(0, Math.min(rows.length - 1, index))
    const next = rows[clamped]?.entry.id
    if (next === this.selectedId) return
    this.selectedId = next
    this.requestRender()
  }

  private selectedIndex(): number {
    const rows = this.flatRows()
    const index = rows.findIndex(row => row.entry.id === this.selectedId)
    return index
  }

  private openSelected(): void {
    const entry = this.selectedEntry
    if (entry === undefined || !subagentOpenable(entry)) return
    this.options.onOpen?.(entry)
  }

  /**
   * Reply target: the selected row when it is a local continuable child **and**
   * the parent supplied `onReply`. Without both, reply is inert.
   */
  private replyTarget(): SubagentEntry | undefined {
    if (this.options.onReply === undefined) return undefined
    const entry = this.selectedEntry
    return entry === undefined || !subagentCanReply(entry) ? undefined : entry
  }

  /** Stop target: the selected row when it is local and running/initializing. */
  private stopTarget(): SubagentEntry | undefined {
    if (this.options.onStop === undefined) return undefined
    const entry = this.selectedEntry
    return entry === undefined || !subagentCanStop(entry) ? undefined : entry
  }

  /**
   * Run one native intervention request. Returns whether a request was issued;
   * the component itself never mutates an entry or schedules work, so the
   * parent's own update is the only thing that repaints.
   */
  private replySelected(): boolean {
    const entry = this.replyTarget()
    const callback = this.options.onReply
    if (entry === undefined || callback === undefined) return false
    callback(entry)
    return true
  }

  private stopSelected(): boolean {
    const entry = this.stopTarget()
    const callback = this.options.onStop
    if (entry === undefined || callback === undefined) return false
    callback(entry)
    return true
  }

  private runAction(action: 'reply' | 'stop'): void {
    if (action === 'reply') this.replySelected()
    else this.stopSelected()
  }

  private close(): void {
    if (this.done || this.disposed) return
    this.done = true
    this.cancelChord()
    this.options.onClose()
  }

  // -------------------------------------------------------------------------
  // Rendering

  private flatRows(): readonly SubagentTreeNode[] {
    return flattenSubagentTree(buildSubagentTree(this.projectionValue.entries))
  }

  private limitRows(): number {
    const rows = this.tui.terminal.rows
    const terminalCap = Number.isFinite(rows) && rows > 0 ? Math.max(6, Math.floor(rows) - 2) : 24
    const configured = this.options.maxHeight
    if (configured === undefined || !Number.isFinite(configured) || configured <= 0) return terminalCap
    return Math.max(6, Math.min(terminalCap, Math.floor(configured)))
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const limit = this.limitRows()
    if (limit < CHROME_ROWS + 2) return this.renderCompact(size, limit)

    const rows = this.flatRows()
    const selectedIndex = this.selectedIndex()
    const bodyHeight = Math.max(1, limit - CHROME_ROWS)
    this.viewportRows = bodyHeight
    const total = Math.max(1, rows.length)
    this.scrollView.updateLayout(total, bodyHeight, () => this.requestRender())
    const maxScroll = Math.max(0, total - bodyHeight)
    let top = Math.max(0, Math.min(this.scrollView.scrollTop, maxScroll))
    if (selectedIndex >= 0) {
      if (selectedIndex < top) top = selectedIndex
      else if (selectedIndex >= top + bodyHeight) top = selectedIndex - bodyHeight + 1
    }
    top = Math.max(0, Math.min(top, maxScroll))
    this.scrollView.scrollTo(top)

    const out: string[] = []
    const boxes: MouseHitbox[] = []
    const push = (line: string): number => {
      out.push(line)
      return out.length - 1
    }

    push(cc.inactive('─'.repeat(size)))
    const count = rows.length
    push(fit(
      ` ${bold(cc.permission('Agents'))}${dim(' · ')}${t.text(`${count} ${count === 1 ? 'child' : 'children'}`)}` +
        (this.truncated ? `${dim(' · ')}${t.yellow('incomplete catalog')}` : ''),
      size,
    ))
    push(cc.inactive('─'.repeat(size)))

    if (rows.length === 0) {
      push(fit(` ${dim(t.muted('No native subagents in this session.'))}`, size))
      for (let index = 1; index < bodyHeight; index += 1) push('')
    } else {
      for (let offset = 0; offset < bodyHeight; offset += 1) {
        const index = top + offset
        const node = rows[index]
        if (node === undefined) {
          push('')
          continue
        }
        const row = push(this.renderRow(node, size, index === selectedIndex))
        const entry = node.entry
        boxes.push({
          id: `agent-row:${entry.id}`,
          startRow: row,
          endRow: row,
          claimPress: true,
          onClick: () => {
            this.selectedId = entry.id
            this.openSelected()
            this.requestRender()
          },
        })
      }
    }

    push(cc.inactive('─'.repeat(size)))
    push(fit(` ${this.selectedLine(size)}`, size))
    const footer = this.footer(size)
    if (footer.line !== '') {
      const row = push(fit(` ${footer.line}`, size))
      // Action chips exist only when they were painted on this exact frame: a
      // narrow footer omits them, so no invisible hitbox survives.
      for (const chip of footer.chips) {
        boxes.push({
          id: `agent-action:${chip.action}`,
          startRow: row,
          endRow: row,
          startCol: chip.startCol + 1,
          endCol: chip.endCol + 1,
          claimPress: true,
          onClick: () => this.runAction(chip.action),
        })
      }
    }
    if (this.truncated) push(fit(` ${dim(t.muted('Native catalog is incomplete; rows above are real, missing children are unknown.'))}`, size))
    // Never grow past the viewport when a long notice/hint wrapped the chrome.
    if (out.length > limit) out.length = limit
    // A row that was clipped away cannot be clicked: drop its hitbox so no
    // invisible affordance survives the clamp.
    this.registry.sync(boxes.filter(box => box.endRow < out.length))
    return out.map(line => fit(line, size))
  }

  /** Very short viewport: keep title, selected row and close affordance. */
  private renderCompact(width: number, limit: number): string[] {
    const entry = this.selectedEntry
    const close = this.bindingLabel('list.cancel') ?? this.bindingLabel('app.cancel') ?? 'Esc'
    const title = fit(` ${bold(cc.permission('Agents'))}${dim(' · ')}${dim(`${this.flatRows().length}`)}`, width)
    const row = entry === undefined
      ? fit(` ${dim(t.muted('No native subagents.'))}`, width)
      : fit(` ${this.renderRow({
        entry,
        depth: 0,
        external: entry.mode === 'external' || entry.status === 'external',
        children: [],
      }, width, true)}`, width)
    const closeLine = fit(` ${dim(`${close} close`)}`, width)
    this.viewportRows = 1
    this.registry.sync([])
    if (limit <= 1) return [closeLine]
    if (limit === 2) return [title, closeLine]
    return [title, row, closeLine]
  }

  private renderRow(node: SubagentTreeNode, width: number, selected: boolean): string {
    const entry = node.entry
    const tone = subagentTone(entry)
    const glyph = toneGlyph(tone)
    const status = subagentStatusLabel(entry)
    const mode = subagentModeLabel(entry.mode)
    const indent = '  '.repeat(Math.min(node.depth, 8))
    const pointer = selected ? t.accentBright('❯ ') : '  '
    const separator = dim(' · ')
    const sepWidth = visibleWidth(separator)
    const headWidth = visibleWidth(indent) + visibleWidth(pointer) + visibleWidth(glyph) + 1
    // Reserve the status so a long label never pushes the honest state off-row.
    const statusText = TONE_STYLE[tone](status)
    const reserved = headWidth + sepWidth + visibleWidth(status)
    const label = truncateToWidth(subagentLabel(entry), Math.max(1, width - reserved))
    let line = indent + pointer + glyph + ' ' + (selected ? bold(t.accentBright(label)) : t.text(label))
    // Mode is explicit for every non-external row; external is already a leaf
    // state and repeating "external · external" would be noise.
    if (!node.external) line = this.appendIfFits(line, dim(mode), width)
    line += separator + statusText
    const activity = subagentActivity(entry)
    if (activity !== undefined) line = this.appendIfFits(line, t.muted(activity), width)
    const tokens = subagentTokensLabel(entry.totalTokens)
    if (tokens !== undefined) line = this.appendIfFits(line, dim(tokens), width)
    const timing = subagentTimingLabel(entry.timing, this.now())
    if (timing !== undefined) line = this.appendIfFits(line, dim(timing), width)
    return fit(line, width)
  }

  private appendIfFits(line: string, segment: string, width: number): string {
    const next = `${line}${dim(' · ')}${segment}`
    return visibleWidth(next) <= width ? next : line
  }

  private selectedLine(width: number): string {
    const entry = this.selectedEntry
    if (entry === undefined) return dim(t.muted('No native subagents.'))
    const parts = [bold(t.text(subagentLabel(entry))), dim('id ' + sanitize(entry.id))]
    const route = entry.provider === undefined && entry.model === undefined
      ? ''
      : sanitize([entry.provider, entry.model].filter(value => value !== undefined).join('/'))
    if (route !== '') parts.push(dim(route))
    if (entry.mode === 'external' || entry.status === 'external') {
      parts.push(dim('external task · no local transcript'))
    }
    const line = parts.join(dim(' · '))
    return fit(line, Math.max(1, width - 1))
  }

  /**
   * Footer line plus the clickable action chips it actually painted.
   *
   * Order: intervention actions first (Reply/Stop, from the real keymap), then
   * the shared navigation/open/close hints. A footer that cannot fit the action
   * chips drops them entirely instead of showing a truncated, unclickable
   * affordance.
   */
  private footer(width: number): { line: string; chips: FooterChip[] } {
    const base: string[] = []
    const previous = this.bindingLabel('list.previous')
    const next = this.bindingLabel('list.next')
    const select = this.bindingLabel('list.select')
    const close = this.bindingLabel('list.cancel') ?? this.bindingLabel('app.cancel')
    if (previous !== undefined && next !== undefined) base.push(`${previous}/${next} navigate`)
    if (select !== undefined) base.push(`${select} open`)
    if (close !== undefined) base.push(`${close} close`)

    const actions: Array<{ action: 'reply' | 'stop'; text: string }> = []
    const replyKey = this.actionKey('subagent.reply', 'subagentList')
    if (replyKey !== undefined && this.replyTarget() !== undefined) actions.push({ action: 'reply', text: `[${replyKey}] reply` })
    const stopKey = this.actionKey('subagent.interrupt', 'subagentList')
    if (stopKey !== undefined && this.stopTarget() !== undefined) actions.push({ action: 'stop', text: `[${stopKey}] stop` })
    if (actions.length === 0) return { line: base.join(' · '), chips: [] }

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
   * Effective key for one action **in this surface's context chain**.
   *
   * `getBindings` reports the configured keys wherever the action applies; the
   * chain check keeps a session-only action from being advertised here, so a
   * remapped or disabled shared action can never paint a dead key.
   */
  private actionKey(actionId: string, context: 'subagentList' | 'subagentSession'): string | undefined {
    const action = this.keymap.getAction(actionId)
    if (action === undefined) return undefined
    const chain = this.keymap.getFallbackChain(context)
    if (!action.contexts.some(entry => chain.includes(entry))) return undefined
    const binding = this.keymap.getBindings(actionId)[0]
    return binding === undefined ? undefined : formatBinding(binding.split(' '))
  }

  // -------------------------------------------------------------------------
  // Mouse

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0
      if (delta === 0) return undefined
      this.scrollView.scrollBy(delta)
      this.requestRender()
      return { handled: true, render: true }
    }
    return this.registry.handleMouse(event)
  }
}