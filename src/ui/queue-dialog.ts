/**
 * Native message-queue modal (operational view, no local queue).
 *
 * DSH owns the inbox. This surface takes `QueueEntry[]` snapshots (or a live
 * `getEntries()` getter) and emits intent for the parent: edit a native entry in
 * the one composer, cancel one native entry, or send one now. It never stores,
 * reorders, merges or schedules messages, and every callback receives the
 * native `QueueEntry` (stable `messageId`) rather than an index.
 *
 * Rows, search, mouse affordances and hints follow the unified modal style:
 * a `ModalFrame` body with the `queueList` input context (list/dialog/global
 * fallback, no editor fallback) and a `modalSearch` field that reuses the CC
 * editor grammar. Hints are read from the real `queue.edit` /
 * `queue.cancel-entry` / `queue.send-now` / `modal.search` / `list.cancel`
 * bindings, so a remapped or disabled action never advertises a dead key.
 */
import {
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type { QueueEntry } from '../backend/types.ts'
import { queueAttachmentLabel, queueContentLabel } from './queue-content.ts'
import { createCcKeymap, type CcContext, type CcKeymap } from '../input/index.ts'
import { isInterruptKey } from './dialogs.ts'
import { InlineAnswer } from './inline-editor.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import {
  ModalFrame,
  modalHeight,
  type ModalAction,
  type ModalFrameOptions,
  type ModalGeometry,
  type ModalSize,
} from './modal.ts'
import { fit, oneLine, sanitize, truncateToWidth, visibleWidth, wrap } from './text.ts'
import { dim, t } from './theme.ts'

export interface QueueDialogOptions {
  /** Initial native queue snapshot (used when `getEntries` is absent). */
  entries?: readonly QueueEntry[]
  /** Live native snapshot; re-sampled on every paint, never cached as truth. */
  getEntries?: () => readonly QueueEntry[]
  /** Shared keymap from the input subsystem. */
  keymap?: CcKeymap
  /** Edit one native entry in the single main composer. */
  onEdit?: (entry: QueueEntry) => void | Promise<void>
  /** Cancel exactly one native inbox entry (App owns the operation). */
  onCancelEntry?: (entry: QueueEntry) => void | Promise<void>
  /** Ask the App to send that native entry now. */
  onSendNow?: (entry: QueueEntry) => void | Promise<void>
  /** Local dismissal (Esc / list.cancel). */
  onClose: () => void
  /** Global turn cancellation (`app.interrupt`); defaults to closing. */
  onInterrupt?: () => void
  /** Optional repaint hook for hosts that own rendering. */
  onRenderRequest?: () => void
  /** Bounded modal height (defaults to the shared standard modal budget). */
  maxHeight?: number
}

interface ResolvedModalAction {
  readonly id: string
  readonly keys: string[]
}

const CLOSE_ACTIONS: ReadonlySet<string> = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])

const errorText = (error: unknown): string => sanitize(error instanceof Error ? error.message : String(error))

const isThenable = (value: unknown): value is Promise<void> =>
  value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function'

const isPrintableByte = (data: string): boolean => data.length === 1 && /[\x20-\x7e]/.test(data)

function targetLabel(entry: QueueEntry): string {
  if (entry.target === 'next-step') return 'steer next step'
  return 'next turn'
}

function imageLabel(entry: QueueEntry): string {
  return queueAttachmentLabel(entry)
}

export class QueueDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: QueueDialogOptions
  private readonly frame = new ModalFrame()
  private readonly rowHitboxes = new HitboxRegistry()
  private readonly search: InlineAnswer
  private snapshot: readonly QueueEntry[]
  private selectedMessageId: string | undefined
  private selectedIndex = 0
  private windowStart = 0
  private searchFocused = false
  private focusedState = false
  private busy = false
  private done = false
  private disposed = false
  private message = ''
  private failed = false
  private geometry: ModalGeometry | undefined
  private frameHeight = 20
  private beforeLines: string[] = []
  private lineRows: Array<number | undefined> = []

  constructor(tui: TUI, options: QueueDialogOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.snapshot = options.entries === undefined ? [] : [...options.entries]
    this.search = new InlineAnswer(tui, this.keymap)
    this.search.onChange = () => { this.reconcile(); this.windowStart = 0; this.repaint() }
    this.selectedMessageId = this.entries()[0]?.messageId
  }

  // -------------------------------------------------------------------------
  // Public surface

  /** Native snapshot: the live getter when supplied, else the last assignment. */
  entries(): readonly QueueEntry[] {
    return this.options.getEntries === undefined ? this.snapshot : this.options.getEntries()
  }

  /** Parent hook for snapshot hosts; never a local queue mutation. */
  setEntries(entries: readonly QueueEntry[]): void {
    this.snapshot = [...entries]
    this.reconcile()
    this.repaint()
  }

  get selectedId(): string | undefined {
    return this.selectedEntry?.messageId
  }

  get selectedEntry(): QueueEntry | undefined {
    this.liveSync()
    const entries = this.visibleEntries()
    return entries[this.currentIndex(entries)]
  }

  /**
   * Reconcile a live native snapshot between paints: a removed id is replaced
   * by the nearest still-available row rather than resurrected.
   */
  private liveSync(): void {
    const entries = this.visibleEntries()
    if (entries.length === 0) {
      this.selectedMessageId = undefined
      this.selectedIndex = 0
      return
    }
    if (this.selectedMessageId !== undefined && entries.some(entry => entry.messageId === this.selectedMessageId)) {
      this.selectedIndex = entries.findIndex(entry => entry.messageId === this.selectedMessageId)
      return
    }
    this.selectedIndex = Math.min(this.selectedIndex, entries.length - 1)
    this.selectedMessageId = entries[this.selectedIndex]?.messageId
  }

  get isDone(): boolean {
    return this.done
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get isBusy(): boolean {
    return this.busy
  }

  /**
   * True while a fragmented bracketed paste is still arriving in the search
   * field; the parent's global interrupt listener can leave it alone.
   */
  get isPasting(): boolean {
    return this.searchFocused && this.search.editor.isPasting()
  }

  get query(): string {
    return this.search.raw.trim()
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.keymap.cancelChord()
    this.focusedState = value
    this.search.focused = value && this.searchFocused
  }

  invalidate(): void {
    this.frame.invalidate()
    this.rowHitboxes.clear()
    this.search.invalidate()
    this.geometry = undefined
    this.lineRows = []
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.focusedState) this.keymap.cancelChord()
    this.search.dispose()
  }

  // -------------------------------------------------------------------------
  // Selection / filtering

  private visibleEntries(): readonly QueueEntry[] {
    const entries = this.entries()
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return entries
    return entries.filter(entry => {
      const haystack = [entry.text, entry.messageId, entry.target].join(' ').toLowerCase()
      return terms.every(term => haystack.includes(term))
    })
  }

  private currentIndex(entries: readonly QueueEntry[]): number {
    if (entries.length === 0) return 0
    if (this.selectedMessageId !== undefined) {
      const found = entries.findIndex(entry => entry.messageId === this.selectedMessageId)
      if (found >= 0) return found
    }
    return Math.min(this.selectedIndex, entries.length - 1)
  }

  private reconcile(): void {
    this.liveSync()
    const entries = this.visibleEntries()
    if (entries.length === 0) {
      this.selectedIndex = 0
      this.selectedMessageId = undefined
      return
    }
    const found = this.selectedMessageId === undefined ? -1 : entries.findIndex(entry => entry.messageId === this.selectedMessageId)
    if (found >= 0) {
      this.selectedIndex = found
      return
    }
    // The native id was removed: select the nearest still-available row instead
    // of resurrecting a stale entry.
    this.selectedIndex = Math.min(this.selectedIndex, entries.length - 1)
    this.selectedMessageId = entries[this.selectedIndex]?.messageId
  }

  private move(delta: number): void {
    const entries = this.visibleEntries()
    if (entries.length === 0) return
    const from = this.currentIndex(entries)
    const next = ((from + delta) % entries.length + entries.length) % entries.length
    this.selectedIndex = next
    this.selectedMessageId = entries[next]?.messageId
    if (next < this.windowStart) this.windowStart = next
    this.clearMessage()
    this.keymap.cancelChord()
    this.repaint()
  }

  private moveTo(index: number): void {
    const entries = this.visibleEntries()
    if (entries.length === 0) return
    this.selectedIndex = Math.max(0, Math.min(index, entries.length - 1))
    this.selectedMessageId = entries[this.selectedIndex]?.messageId
    if (this.selectedIndex < this.windowStart) this.windowStart = this.selectedIndex
    this.repaint()
  }

  private clearMessage(): void {
    this.message = ''
    this.failed = false
  }

  private repaint(): void {
    this.tui.requestRender()
    this.options.onRenderRequest?.()
  }

  // -------------------------------------------------------------------------
  // Parent actions (native ids only)

  private async runAction(run: ((entry: QueueEntry) => void | Promise<void>) | undefined, entry: QueueEntry): Promise<void> {
    if (run === undefined || this.busy) return
    this.busy = true
    this.clearMessage()
    try {
      const result = run(entry)
      if (isThenable(result)) await result
      if (!this.done && !this.disposed) {
        this.message = 'Requested'
        this.failed = false
      }
    } catch (error) {
      if (!this.done && !this.disposed) {
        this.failed = true
        this.message = errorText(error)
      }
    } finally {
      this.busy = false
      if (!this.done && !this.disposed) {
        this.reconcile()
        this.repaint()
      }
    }
  }

  private editSelected(): void {
    const entry = this.selectedEntry
    if (entry !== undefined) void this.runAction(this.options.onEdit, entry)
  }

  private cancelSelected(): void {
    const entry = this.selectedEntry
    if (entry !== undefined) void this.runAction(this.options.onCancelEntry, entry)
  }

  private sendSelected(): void {
    const entry = this.selectedEntry
    if (entry !== undefined) void this.runAction(this.options.onSendNow, entry)
  }

  // -------------------------------------------------------------------------
  // Input

  private resolve(data: string): ResolvedModalAction | undefined {
    // Resolve in the queue-local context so queue.* rows are reachable; still
    // re-dispatch one cancelled chord byte instead of swallowing it.
    let raw = data
    for (let pass = 0; pass < 2; pass += 1) {
      const resolution = this.keymap.resolve(raw, 'queueList')
      if (resolution.kind === 'pending') return undefined
      if (resolution.kind === 'cancelled-chord') { raw = resolution.passthrough; continue }
      if (resolution.kind !== 'action') return undefined
      return { id: resolution.action.id, keys: [...resolution.keys] }
    }
    return undefined
  }

  handleInput(raw: string): void {
    if (this.done || this.disposed) return
    if (isInterruptKey(this.keymap, raw)) {
      this.interrupt()
      return
    }
    if (this.busy) {
      const action = this.resolve(raw)
      if (action !== undefined && CLOSE_ACTIONS.has(action.id)) this.close()
      return
    }
    if (this.searchFocused) {
      this.inputSearch(raw)
      return
    }
    const action = this.resolve(raw)
    if (action === undefined) return
    switch (action.id) {
      case 'modal.search': this.focusSearch(); return
      case 'queue.edit': this.editSelected(); return
      case 'queue.cancel-entry': this.cancelSelected(); return
      case 'queue.send-now': this.sendSelected(); return
      case 'list.previous': this.move(-1); return
      case 'list.next': this.move(1); return
      case 'list.page-up': this.move(-5); return
      case 'list.page-down': this.move(5); return
      case 'list.first': this.moveTo(0); return
      case 'list.last': this.moveTo(this.visibleEntries().length - 1); return
      case 'list.select':
      case 'dialog.confirm': this.editSelected(); return
      default:
        if (CLOSE_ACTIONS.has(action.id)) this.close()
        // Other global/app actions stay inert inside this operational modal.
        return
    }
  }

  private inputSearch(raw: string): void {
    const action = this.resolve(raw)
    if (action !== undefined) {
      switch (action.id) {
        case 'list.select':
        case 'dialog.confirm':
          this.blurSearch()
          this.editSelected()
          return
        case 'list.cancel':
        case 'dialog.cancel':
        case 'app.cancel':
          this.blurSearch()
          return
        case 'list.previous':
          if (!isPrintableByte(raw)) { this.move(-1); return }
          break
        case 'list.next':
          if (!isPrintableByte(raw)) { this.move(1); return }
          break
        case 'list.page-up':
          if (!isPrintableByte(raw)) { this.move(-5); return }
          break
        case 'list.page-down':
          if (!isPrintableByte(raw)) { this.move(5); return }
          break
        default:
          break
      }
    }
    const result = this.search.handleKey(raw)
    if (result === 'submit') {
      this.blurSearch()
      this.editSelected()
    } else if (result === 'cancel') {
      this.blurSearch()
    } else if (result === 'interrupt') {
      this.interrupt()
    }
  }

  private focusSearch(): void {
    this.searchFocused = true
    this.search.focused = this.focusedState
    this.clearMessage()
    this.keymap.cancelChord()
    this.repaint()
  }

  private blurSearch(): void {
    if (!this.searchFocused) return
    this.searchFocused = false
    this.search.focused = false
    this.repaint()
  }

  private close(): void {
    if (this.done) return
    this.done = true
    this.keymap.cancelChord()
    this.options.onClose()
  }

  private interrupt(): void {
    this.keymap.cancelChord()
    if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
    else this.close()
  }

  // -------------------------------------------------------------------------
  // Rendering

  private frameActions(): ModalAction[] {
    const none = this.visibleEntries().length === 0
    // With no native entry there is no capability to keep: show the labels
    // without inventing a key binding (the frame keeps them inert).
    if (none) {
      return [
        { id: 'edit', label: 'edit', disabled: true },
        { id: 'send', label: 'send now', disabled: true },
        { id: 'cancel', label: 'cancel entry', disabled: true },
        { id: 'search', label: 'search', action: 'modal.search', onActivate: () => this.focusSearch() },
        { id: 'close', label: 'close', action: 'list.cancel', onActivate: () => this.close() },
      ]
    }
    return [
      { id: 'edit', label: 'edit', action: 'queue.edit', onActivate: () => this.editSelected() },
      { id: 'send', label: 'send now', action: 'queue.send-now', onActivate: () => this.sendSelected() },
      { id: 'cancel', label: 'cancel entry', action: 'queue.cancel-entry', onActivate: () => this.cancelSelected() },
      { id: 'search', label: 'search', action: 'modal.search', onActivate: () => this.focusSearch() },
      { id: 'close', label: 'close', action: 'list.cancel', onActivate: () => this.close() },
    ]
  }

  private statusLines(width: number): string[] {
    if (this.message !== '') {
      const style = this.failed ? t.redSoft : t.green
      return wrap(style(this.message), Math.max(4, width - 1)).slice(0, 2).map(line => ' ' + line)
    }
    return []
  }

  private headerLine(width: number): string {
    const total = this.entries().length
    const shown = this.visibleEntries().length
    const suffix = this.query === '' ? '' : ` · ${shown}/${total} match`
    return fit(dim(`Native queue · ${total} ${total === 1 ? 'message' : 'messages'}${suffix}`), width)
  }

  private rowLines(entry: QueueEntry, index: number, width: number, focused: boolean): string[] {
    const marker = focused ? t.accentBright('❯') : ' '
    const label = queueContentLabel(entry)
    const meta = [targetLabel(entry), imageLabel(entry)].filter(Boolean).join(' · ')
    const prefix = `${marker} ${dim(`#${index + 1}`)} `
    const lines: string[] = []
    const metaWidth = Math.min(30, visibleWidth(meta))
    const bodyRoom = width - visibleWidth(prefix) - metaWidth - 3
    if (width >= 52 && meta !== '' && bodyRoom >= 12) {
      const body = truncateToWidth(label, bodyRoom, '…')
      const room = Math.max(0, bodyRoom - visibleWidth(body))
      const metaText = truncateToWidth(meta, metaWidth, '…')
      lines.push(prefix + (focused ? t.accentBright(body) : t.text(body)) + ' '.repeat(room) + dim(' │ ') + dim(metaText))
    } else {
      lines.push(prefix + (focused ? t.accentBright(label) : t.text(label)))
      if (meta !== '') lines.push(`   ${dim(meta)}`)
    }
    if (focused) lines.push(`   ${dim(entry.messageId)}`)
    return lines.map(line => fit(line, width))
  }


  /** Bounded height; a test/standalone host without terminal rows stays open. */
  private heightCap(): number {
    const rows = this.tui.terminal?.rows
    if (!Number.isFinite(rows) || rows <= 0) return 200
    return Math.max(1, Math.floor(this.options.maxHeight ?? modalHeight(this.tui, this.modalSize)))
  }
  render(width: number): string[] {
    const size = Math.max(1, Math.floor(width))
    const cap = this.heightCap()
    const ownerKey = `queue:${this.selectedId ?? ''}`
    // Reserve the real status rows in the same measurement and render pass.
    // Body hitboxes must never extend into chrome because a late status line
    // shrank the actual body.
    const after = this.statusLines(size >= 8 ? size - 4 : size)
    const optionsFor = (height: number): ModalFrameOptions => ({
      title: 'Queue',
      ownerKey,
      before: new Array(2).fill(''),
      after,
      actions: this.frameActions(),
      onClose: () => this.close(),
      maxHeight: height,
      keymap: this.keymap,
    })
    const measureWith = (height: number): ModalGeometry => {
      this.frameHeight = height
      return this.frame.measure(size, optionsFor(height))
    }
    const capGeometry = measureWith(cap)
    const tentative = this.buildBody(capGeometry.bodyWidth, capGeometry.bodyHeight)
    const chrome = cap - capGeometry.bodyHeight
    const height = Math.max(Math.min(cap, 8), Math.min(cap, tentative.length + chrome))
    const geometry = height === cap ? capGeometry : measureWith(height)
    this.geometry = geometry
    const before = [
      this.search.render(Math.max(4, geometry.bodyWidth), this.searchFocused, 'Search queued messages…', '')[0] ?? '',
      this.headerLine(geometry.bodyWidth),
    ]
    this.beforeLines = before
    const body = height === cap ? tentative : this.buildBody(geometry.bodyWidth, geometry.bodyHeight)
    const options: ModalFrameOptions = {
      ...optionsFor(height),
      before,
    }
    const lines = this.frame.render(size, body, options)
    this.rowHitboxes.sync(this.bodyHitboxes(geometry))
    return lines
  }

  private buildBody(width: number, height: number): string[] {
    this.lineRows = []
    if (height <= 0) return []
    const entries = this.visibleEntries()
    if (entries.length === 0) {
      const text = this.entries().length === 0
        ? 'No queued messages. The native inbox is empty.'
        : `No queued messages match “${oneLine(this.query, 60)}”.`
      return [fit(` ${t.muted(text)}`, width)]
    }
    const blocks: Array<{ lines: string[]; focused: boolean; rowIndex?: number }> = []
    const selected = this.currentIndex(entries)
    for (const [index, entry] of entries.entries()) {
      blocks.push({ lines: this.rowLines(entry, index, width, index === selected), focused: index === selected, rowIndex: index })
    }
    const total = blocks.reduce((sum, block) => sum + block.lines.length, 0)
    if (total <= height) {
      this.windowStart = 0
      this.lineRows = this.mapBlocks(blocks)
      return blocks.flatMap(block => block.lines)
    }
    const focusIndex = Math.max(0, blocks.findIndex(block => block.focused))
    let start = Math.max(0, Math.min(this.windowStart, focusIndex))
    let end = start
    let used = 0
    while (end < blocks.length && used + blocks[end]!.lines.length <= height) {
      used += blocks[end]!.lines.length
      end += 1
    }
    if (focusIndex >= end) {
      start = focusIndex
      end = start
      used = 0
      while (end < blocks.length && used + blocks[end]!.lines.length <= height) {
        used += blocks[end]!.lines.length
        end += 1
      }
      if (end === start) end = Math.min(blocks.length, start + 1)
    }
    while (start > 0 && used + blocks[start - 1]!.lines.length <= height) {
      start -= 1
      used += blocks[start]!.lines.length
    }
    this.windowStart = start
    const visible = blocks.slice(start, end)
    this.lineRows = this.mapBlocks(visible)
    return visible.flatMap(block => block.lines).slice(0, height)
  }

  private mapBlocks(blocks: ReadonlyArray<{ lines: string[]; rowIndex?: number }>): Array<number | undefined> {
    return blocks.flatMap(block => block.lines.map(() => block.rowIndex))
  }

  private bodyHitboxes(geometry: ModalGeometry): MouseHitbox[] {
    const boxes: MouseHitbox[] = []
    const entries = this.visibleEntries()
    for (const [line, index] of this.lineRows.entries()) {
      if (index === undefined) continue
      boxes.push({
        id: `queue:${entries[index]?.messageId ?? index}:${line}`,
        startRow: line,
        endRow: line,
        startCol: 0,
        endCol: Math.max(0, geometry.bodyWidth - 1),
        onClick: () => {
          const visible = this.visibleEntries()
          const entry = visible[index]
          if (entry === undefined) return
          const wasSelected = this.selectedMessageId === entry.messageId
          this.moveTo(index)
          // A second click on the selected native entry opens it for editing;
          // destructive actions stay on their own chips/key.
          if (wasSelected) this.editSelected()
          this.repaint()
        },
      })
    }
    return boxes
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done || this.disposed) return undefined
    const chrome = this.frame.handleMouse(event)
    if (chrome !== undefined) return chrome
    const beforeIndex = this.beforeLineIndex(event.y)
    if (beforeIndex === 0) {
      if (event.type === 'press' && event.button === 'left') return { handled: true }
      if (event.type === 'click' && event.button === 'left') {
        this.focusSearch()
        return { handled: true, render: true }
      }
    }
    const body = this.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'wheel') {
      this.move((event.wheelDelta ?? 0) < 0 ? -1 : 1)
      return { handled: true, render: true }
    }
    return this.rowHitboxes.handleMouse(body)
  }

  private bodyMouse(event: TuiMouseEvent): TuiMouseEvent | undefined {
    try {
      const translated = this.frame.bodyMouse(event)
      if (translated !== undefined) return translated
    } catch {
      // Fall back to geometry below.
    }
    const geometry = this.geometry
    if (geometry === undefined) return undefined
    if (event.x < geometry.bodyCol || event.x >= geometry.bodyCol + geometry.bodyWidth) return undefined
    if (event.y < geometry.bodyRow || event.y >= geometry.bodyRow + geometry.bodyHeight) return undefined
    return { ...event, x: event.x - geometry.bodyCol, y: event.y - geometry.bodyRow }
  }

  private beforeLineIndex(y: number): number | undefined {
    const geometry = this.geometry
    if (geometry === undefined) return undefined
    const framed = geometry.bodyCol > 0
    const headerRows = framed ? 1 : this.frameHeight >= 2 ? 1 : 0
    const rows = framed
      ? (geometry.bodyRow <= headerRows ? 0 : geometry.bodyRow - headerRows - 1)
      : Math.max(0, geometry.bodyRow - headerRows)
    const index = y - headerRows
    if (index < 0 || index >= rows || index >= this.beforeLines.length) return undefined
    return index
  }
}