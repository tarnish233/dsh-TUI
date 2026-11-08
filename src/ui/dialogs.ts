/**
 * DSH modal surfaces built on the shared popup frame.
 *
 * Three things live here:
 *
 * 1. `SelectDialog` — the generic search-free chooser (`/preset`, `/effort` and
 *    other small native rosters). It is a bounded `ModalFrame` surface sized
 *    `compact`, with clickable rows, a clickable action footer and the same
 *    key/mouse behaviour.
 * 2. `DecisionDialog` — native approvals and ordered questions. It keeps the
 *    opaque native option values, the ordered `{answers: (string|string[])[]}`
 *    result, per-question multi-select/custom/review state and the cancel vs
 *    interrupt split.
 * 3. Small shared modal helpers used by the other chooser/help components:
 *    keymap resolution for the unified `modalList` browse context, block
 *    windowing that also reports painted body row ranges (so mouse hits can
 *    never point at a clipped row), and the body/geometry composition helper.
 *
 * Contract boundaries (do not relax here):
 *
 * - Chrome, sizing, action chips and mouse geometry belong to `ModalFrame`.
 *   These components own only their body lines and their own list state.
 * - `app.interrupt` (Ctrl+C by default) stays global turn cancellation. It is
 *   never converted into a local answer, and never closes a decision by itself.
 * - An approval's local cancel (Esc, `list.cancel`, the frame close affordance)
 *   submits the request's own rejected opaque option, so the native decision
 *   settles as `rejected`. Only when the request has no identifiable rejection
 *   option does it fall back to `onCancel`, whose owner must still settle it.
 * - A question's local cancel goes to `onCancel`. The App is the final owner of
 *   question cancellation/native settlement: it settles the current native
 *   request (or re-queues it) — the component never claims that a dismissed
 *   question stays hidden while pending.
 * - No guessed tool/diff correlation: a decision renders the native message and
 *   options only. Rich approval previews need a native seam this file does not
 *   invent.
 *
 * Layout/keys are adapted from agent_tui (MIT) src/ui/{dialogs,questionnaire,
 * select}.ts, rebuilt on public Pi TUI + this repo's input/theme components.
 */
import {
  Markdown,
  matchesKey,
  type Component,
  type Focusable,
  type KeyId,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type { DecisionOption, DecisionRequest, Question } from '../backend/types.ts'
import { createCcKeymap, type CcKeymap } from '../input/index.ts'
import { InlineAnswer } from './inline-editor.ts'
import { ModalFrame, modalHeight, type ModalAction, type ModalFrameOptions, type ModalSize } from './modal.ts'
import { bold, cc, dim, markdownTheme, t } from './theme.ts'
import { fit, truncateToWidth, visibleWidth, wrap } from './text.ts'

// ---------------------------------------------------------------------------
// Keymap dispatch

/** One resolved registry action: the action id and the physical keys that matched. */
export interface ResolvedModalAction {
  id: string
  keys: string[]
}

const isCancelAction = (id: string): boolean =>
  id === 'list.cancel' || id === 'dialog.cancel' || id === 'app.cancel'
const isInterruptAction = (id: string): boolean => id === 'app.interrupt'
const isSelectAction = (id: string): boolean => id === 'list.select' || id === 'dialog.confirm'

/**
 * Resolve one key for a modal browse surface.
 *
 * `modalList` is the input owner's unified modal context: shared list/dialog/
 * global fallbacks plus the modal-local actions, and no `editor` fallback, so
 * editor movement/kill/undo can never type into a read-only surface. The
 * keymap also applies the interrupt priority there, so a configured Ctrl+C
 * escape hatch is returned as `app.interrupt` even while a chord is pending.
 *
 * Only modal actions are accepted (`list.*`, dialog confirm/cancel, app cancel/
 * interrupt) plus the caller's own `allow` list. Every other app/global action
 * is inert here: it must not fall through to a hidden editor.
 */
export function modalAction(
  keymap: CcKeymap,
  data: string,
  allow: readonly string[] = [],
): ResolvedModalAction | undefined {
  let raw = data
  for (let pass = 0; pass < 2; pass += 1) {
    const resolution = keymap.resolve(raw, 'modalList')
    if (resolution.kind === 'pending') return undefined
    if (resolution.kind === 'cancelled-chord') {
      // A cancelled chord's fresh key is dispatched once, like the editor does,
      // instead of being swallowed.
      raw = resolution.passthrough
      continue
    }
    if (resolution.kind !== 'action') return undefined
    const id = resolution.action.id
    if (isModalActionId(id, allow)) return { id, keys: [...resolution.keys] }
    return undefined
  }
  return undefined
}

/**
 * Legacy shared helper, kept for sibling surfaces (Settings / Keyboard / Queue)
 * that resolve one key as a plain list/dialog action: the same accepted action
 * set as `modalAction` without a surface-specific allow list. A cancelled
 * chord's fresh key is re-dispatched once, like the editor does, so a mismatch
 * is never silently swallowed.
 */
export function listAction(keymap: CcKeymap, data: string): ResolvedModalAction | undefined {
  return modalAction(keymap, data)
}

function isModalActionId(id: string, allow: readonly string[]): boolean {
  return id.startsWith('list.')
    || id === 'dialog.confirm' || id === 'dialog.cancel'
    || id === 'app.cancel' || id === 'app.interrupt'
    || allow.includes(id)
}

/** Keys of a configured, single-key `app.interrupt` binding (chords excluded). */
export function isInterruptKey(keymap: CcKeymap, data: string): boolean {
  if (keymap.isPendingChord()) return false
  return keymap
    .getBindings('app.interrupt')
    .some(binding => !binding.includes(' ') && matchesKey(data, binding as KeyId))
}

const digitOf = (action: ResolvedModalAction): number | undefined => {
  const key = action.keys[0]
  return key !== undefined && /^[1-9]$/.test(key) ? Number(key) : undefined
}

const isTab = (data: string): boolean => matchesKey(data, 'tab')
const isShiftTab = (data: string): boolean => matchesKey(data, 'shift+tab')
const isSpace = (data: string): boolean => matchesKey(data, 'space')

// ---------------------------------------------------------------------------
// Layout helpers

const REJECT_WORDS = /^(reject|rejected|deny|denied|decline|declined|no|cancel|cancelled)$/i

/** True when an approval option's opaque value means "reject" (not "cancel"). */
function isRejectedValue(value: unknown): boolean {
  if (typeof value === 'string') return REJECT_WORDS.test(value.trim())
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.reject === true || record.rejected === true || record.allow === false) return true
  return typeof record.outcome === 'string' && REJECT_WORDS.test(record.outcome.trim())
}

/**
 * The request's own rejected option, by opaque value first and label second.
 * Undefined means this request has no rejection option, which is not the same as
 * a cancelled turn: the caller falls back to the parent's local cancel handler.
 */
export function rejectedOption(items: readonly DecisionOption[]): DecisionOption | undefined {
  return items.find(item => isRejectedValue(item.value))
    ?? items.find(item => REJECT_WORDS.test(item.label.trim()))
}

const hints = (parts: string[]): string => dim(cc.inactive(parts.join(' · ')))
const pointer = (focused: boolean): string => (focused ? cc.suggestion('❯') : ' ')
const numberLabel = (value: number, numberWidth: number): string => dim(`${value}.`.padEnd(numberWidth + 1))

/** One body row: text plus, for selectable rows, the list index it paints. */
export interface BodyRow {
  text: string
  index?: number
}

/**
 * A painted body row range that maps back to a list index (0-based, inclusive).
 * `key` is the row's own identity (native id, option label, page+index), so a
 * press recorded on one row can never activate a different row after a reorder,
 * a roster swap or a page change.
 */
export interface HitRange {
  startRow: number
  endRow: number
  index: number
  key?: string
}

export interface BodyPaint {
  lines: string[]
  hits: HitRange[]
}

export interface RowBlock {
  lines: string[]
  focused: boolean
  /** List index this block paints, when it is a selectable row. */
  index?: number
  /** Stable row identity used for press/click pinning. */
  key?: string
}

/**
 * Which blocks fit the budget: the focused block first, then alternately one
 * block below and one above. The exact rule `windowRows` has always used.
 */
function windowBlockRange(blocks: readonly RowBlock[], budget: number): { start: number; end: number } {
  const total = blocks.reduce((sum, block) => sum + block.lines.length, 0)
  if (total <= budget || blocks.length === 0) return { start: 0, end: blocks.length }
  let focus = blocks.findIndex(block => block.focused)
  if (focus < 0) focus = blocks.length - 1
  let start = focus
  let end = focus + 1
  let used = blocks[focus]!.lines.length
  for (let grew = true; grew;) {
    grew = false
    if (end < blocks.length && used + blocks[end]!.lines.length <= budget) {
      used += blocks[end]!.lines.length
      end += 1
      grew = true
    }
    if (start > 0 && used + blocks[start - 1]!.lines.length <= budget) {
      start -= 1
      used += blocks[start]!.lines.length
      grew = true
    }
  }
  return { start, end }
}

function paintBlocks(blocks: readonly RowBlock[], range: { start: number; end: number }): BodyPaint {
  const lines: string[] = []
  const hits: HitRange[] = []
  for (let index = range.start; index < range.end; index += 1) {
    const block = blocks[index]!
    const painted = [...block.lines]
    // Off-screen direction markers only exist while the list is windowed.
    const windowed = range.start > 0 || range.end < blocks.length
    if (windowed && !block.focused && index === range.start && range.start > 0) {
      painted[0] = dim('↑') + painted[0]!.slice(1)
    } else if (windowed && !block.focused && index === range.end - 1 && range.end < blocks.length) {
      painted[0] = dim('↓') + painted[0]!.slice(1)
    }
    if (block.index !== undefined) {
      hits.push({
        startRow: lines.length,
        endRow: lines.length + painted.length - 1,
        index: block.index,
        ...(block.key === undefined ? {} : { key: block.key }),
      })
    }
    lines.push(...painted)
  }
  return { lines, hits }
}

/** Painted rows for the visible block window (historical helper). */
export function windowRows(blocks: RowBlock[], budget: number): string[] {
  return paintBlocks(blocks, windowBlockRange(blocks, budget)).lines
}

/** Same window plus the body row range of every selectable block. */
export function windowRowsWithHits(blocks: RowBlock[], budget: number): BodyPaint {
  return paintBlocks(blocks, windowBlockRange(blocks, budget))
}

/** Offset painted rows (e.g. below a header) and keep index/hit alignment. */
export function offsetPaint(paint: BodyPaint, offset: number): BodyPaint {
  return {
    lines: [...Array.from({ length: offset }, () => ''), ...paint.lines],
    hits: paint.hits.map(hit => ({ ...hit, startRow: hit.startRow + offset, endRow: hit.endRow + offset })),
  }
}

/** Concatenate body segments, keeping hit rows aligned. */
export function concatPaint(parts: readonly BodyPaint[]): BodyPaint {
  const lines: string[] = []
  const hits: HitRange[] = []
  for (const part of parts) {
    const offset = lines.length
    for (const hit of part.hits) {
      hits.push({
        startRow: hit.startRow + offset,
        endRow: hit.endRow + offset,
        index: hit.index,
        ...(hit.key === undefined ? {} : { key: hit.key }),
      })
    }
    lines.push(...part.lines)
  }
  return { lines, hits }
}

/** A plain, non-selectable body segment. */
export function textPaint(lines: readonly string[]): BodyPaint {
  return { lines: [...lines], hits: [] }
}

/** Default block budget for surfaces that still ask for a raw row count. */
export function rowBudget(tui: TUI): number {
  const rows = tui.terminal.rows
  return Number.isFinite(rows) && rows > 0 ? Math.max(4, rows - 14) : Number.POSITIVE_INFINITY
}

/**
 * Render a component body through the shared frame.
 *
 * Geometry is measured first from the same options used for the render, the
 * body is built to that exact inner size (so windows and mouse hits agree with
 * the painted frame), and every ordinary body line is width-safe.
 */
export function renderModalBody(
  frame: ModalFrame,
  width: number,
  options: ModalFrameOptions,
  build: (bodyWidth: number, bodyHeight: number) => BodyPaint,
): { lines: string[]; paint: BodyPaint } {
  const geometry = frame.measure(width, options)
  const paint = build(geometry.bodyWidth, geometry.bodyHeight)
  const lines = paint.lines.slice(0, geometry.bodyHeight).map(line => fit(line, geometry.bodyWidth))
  const hits = paint.hits.filter(hit => hit.endRow < lines.length)
  return { lines: frame.render(width, lines, options), paint: { lines, hits } }
}

/** Body hit test for a translated `frame.bodyMouse()` event. */
export function bodyHitAt(hits: readonly HitRange[], row: number): HitRange | undefined {
  return hits.find(hit => row >= hit.startRow && row <= hit.endRow)
}

function choiceBlocks(
  items: readonly DecisionOption[],
  focus: number,
  selected: number | undefined,
  width: number,
  numbered: boolean,
  multi: boolean,
  checked: ReadonlySet<number>,
): RowBlock[] {
  const numberWidth = numbered ? String(items.length).length : 0
  const indent = ' '.repeat(numberWidth + (multi ? 8 : 4))
  return items.map((item, index) => {
    const focused = focus === index
    const chosen = selected === index
    const style = chosen ? cc.success : focused ? cc.suggestion : t.text
    const box = multi ? `${checked.has(index) ? cc.success('[✔]') : t.text('[ ]')} ` : ''
    const prefix = `${pointer(focused)} ${numbered ? `${numberLabel(index + 1, numberWidth)} ` : ''}${box}`
    const label = wrap(item.label, Math.max(4, width - visibleWidth(prefix)))
    const lines = [`${prefix}${style(label[0] ?? '')}${chosen ? ` ${cc.success('✔')}` : ''}`]
    for (const line of label.slice(1)) lines.push(indent + style(line))
    if (item.description !== undefined && item.description.trim() !== '') {
      for (const line of wrap(item.description, Math.max(4, width - indent.length))) {
        lines.push(indent + dim(focused || chosen ? style(line) : t.text(line)))
      }
    }
    // Row identity: the rendered label plus its native position. A reorder or a
    // roster swap changes it, so a stale press cannot activate it.
    return { lines, focused, index, key: `${index}:${item.label}` }
  })
}

const noticeLines = (text: string, width: number): string[] =>
  wrap(text, Math.max(4, width)).map(line => ` ${t.muted(fit(line, Math.max(4, width)))}`)

const errorLines = (text: string, width: number): string[] =>
  wrap(text, Math.max(4, width)).map(line => ` ${cc.error(fit(line, Math.max(4, width)))}`)

// ---------------------------------------------------------------------------
// Generic chooser

export interface SelectDialogOptions {
  title: string
  /** Native roster rows. Opaque `value`s are passed back untouched. */
  items: DecisionOption[]
  onSelect: (value: unknown) => void
  onCancel: () => void
  /**
   * Global turn cancellation (`app.interrupt`, Ctrl+C by default). When omitted
   * the interrupt key closes this surface through `onCancel`.
   */
  onInterrupt?: () => void
  /** Shared keymap from the input subsystem. A default CC keymap is used when omitted. */
  keymap?: CcKeymap
  /** Optional one-line context below the title (the frame truncates it). */
  subtitle?: string
  /** Phase-1 state: the native roster has not arrived yet. */
  loading?: boolean
  /** A visible failure from the owning operation. */
  error?: string
}

export class SelectDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'compact'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: SelectDialogOptions
  private readonly frame = new ModalFrame()
  private items: DecisionOption[]
  private loadingState: boolean
  private errorState: string | undefined
  private index = 0
  private hits: HitRange[] = []
  /** Content revision: a press recorded before a roster change cannot fire. */
  private revision = 0
  private press?: { key: string; owner: string }
  private focusedState = false
  private done = false

  constructor(tui: TUI, options: SelectDialogOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.items = [...options.items]
    this.loadingState = options.loading === true
    this.errorState = options.error
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.keymap.cancelChord()
    this.focusedState = value
  }

  /** Parent hook for focus changes; safe to call repeatedly. */
  cancelChord(): void {
    this.keymap.cancelChord()
  }

  invalidate(): void {
    this.frame.invalidate()
  }

  // --- asynchronous roster updates (no auto-select, no auto-submit) ------

  /**
   * Replace the native roster. The current selection survives by index while
   * that index still exists; nothing is selected, submitted or focused as a
   * side effect of late data.
   */
  setItems(items: readonly DecisionOption[]): void {
    this.revision += 1
    this.press = undefined
    this.items = [...items]
    this.loadingState = false
    this.index = this.items.length === 0 ? 0 : Math.min(this.index, this.items.length - 1)
  }

  /** Enter/leave the phase-1 loading state. */
  setLoading(loading: boolean): void {
    if (this.loadingState === loading) return
    this.revision += 1
    this.loadingState = loading
  }

  /** Show or clear a visible failure from the owning operation. */
  setError(message?: string): void {
    this.revision += 1
    this.errorState = message === undefined || message.trim() === '' ? undefined : message
  }

  get selectedIndex(): number {
    return this.index
  }

  /** Content identity shared with the frame so chrome presses expire too. */
  private ownerKey(): string {
    return `select:${this.options.title}:${this.revision}`
  }

  // --- selection ---------------------------------------------------------

  private move(delta: number): void {
    const count = this.items.length
    if (count === 0) return
    this.index = (this.index + delta + count) % count
  }

  private setIndex(index: number): void {
    if (this.items.length === 0) return
    this.index = Math.max(0, Math.min(index, this.items.length - 1))
  }

  private selectIndex(index: number): void {
    const item = this.items[index]
    if (item === undefined) return
    this.finish(item.value)
  }

  private selectFocused(): void {
    this.selectIndex(this.index)
  }

  private finish(value: unknown): void {
    if (this.done) return
    this.done = true
    this.options.onSelect(value)
  }

  private cancel(): void {
    if (this.done) return
    this.done = true
    this.options.onCancel()
  }

  /** Global interrupt: never converted into a local select/cancel answer. */
  private interrupt(): void {
    this.keymap.cancelChord()
    if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
    else this.cancel()
  }

  // --- input -------------------------------------------------------------

  handleInput(raw: string): void {
    if (this.done) return
    const action = modalAction(this.keymap, raw)
    if (action === undefined) return
    if (isInterruptAction(action.id)) {
      this.interrupt()
      return
    }
    if (isCancelAction(action.id)) {
      this.cancel()
      return
    }
    const count = this.items.length
    if (action.id === 'list.previous') this.move(-1)
    else if (action.id === 'list.next') this.move(1)
    else if (action.id === 'list.page-up') this.move(-5)
    else if (action.id === 'list.page-down') this.move(5)
    else if (action.id === 'list.first' && count > 0) this.setIndex(0)
    else if (action.id === 'list.last' && count > 0) this.setIndex(count - 1)
    else if (isSelectAction(action.id) && count > 0) this.selectFocused()
    else if (action.id === 'list.select-digit') {
      const number = digitOf(action)
      if (number !== undefined && number <= count) this.selectIndex(number - 1)
    }
  }

  // --- mouse -------------------------------------------------------------

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const chrome = this.frame.handleMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.frame.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0
      if (delta === 0) return undefined
      this.move(delta < 0 ? -1 : 1)
      return { handled: true, render: true }
    }
    const owner = this.ownerKey()
    const hit = bodyHitAt(this.hits, body.y)
    if (event.type === 'press') {
      this.press = hit === undefined ? undefined : { key: hit.key ?? String(hit.index), owner }
      // Keep the painted window stable between press and release; a click is
      // resolved against the pressed row on release.
      return hit === undefined ? undefined : { handled: true, render: false }
    }
    if (event.type === 'drag') {
      this.press = undefined
      return undefined
    }
    if (event.type !== 'click') return undefined
    const pressed = this.press
    this.press = undefined
    // Only the pressed row may be selected: a late click after a roster swap or
    // a moved window must not answer a different native option.
    if (pressed === undefined || pressed.owner !== owner || hit === undefined) return { handled: true, render: false }
    if ((hit.key ?? String(hit.index)) !== pressed.key) return { handled: true, render: false }
    this.index = hit.index
    this.selectIndex(hit.index)
    return { handled: true, render: true }
  }

  // --- rendering ---------------------------------------------------------

  private actions(): ModalAction[] {
    return [
      {
        id: 'select',
        label: 'Select',
        action: 'list.select',
        onActivate: () => this.selectFocused(),
        disabled: this.items.length === 0,
      },
      { id: 'cancel', label: 'Cancel', action: 'list.cancel', onActivate: () => this.cancel() },
    ]
  }

  private modalOptions(): ModalFrameOptions {
    return {
      title: this.options.title,
      ownerKey: this.ownerKey(),
      ...(this.options.subtitle === undefined ? {} : { subtitle: this.options.subtitle }),
      actions: this.actions(),
      onClose: () => this.cancel(),
      maxHeight: modalHeight(this.tui, this.modalSize),
      keymap: this.keymap,
    }
  }

  private body(bodyWidth: number, bodyHeight: number): BodyPaint {
    const header: BodyPaint = textPaint(this.errorState === undefined ? [] : errorLines(this.errorState, bodyWidth))
    if (this.items.length === 0) {
      const message = this.loadingState ? 'Loading options…' : 'No options are available.'
      return concatPaint([header, textPaint(noticeLines(message, bodyWidth))])
    }
    const budget = Math.max(1, bodyHeight - header.lines.length)
    const blocks = choiceBlocks(this.items, this.index, this.index, bodyWidth, true, false, new Set())
    return concatPaint([header, windowRowsWithHits(blocks, budget)])
  }

  render(width: number): string[] {
    const options = this.modalOptions()
    const painted = renderModalBody(this.frame, width, options, (bodyWidth, bodyHeight) => this.body(bodyWidth, bodyHeight))
    this.hits = painted.paint.hits
    return painted.lines
  }
}

// ---------------------------------------------------------------------------
// Decision dialog (approval or ordered questions)

interface QuestionState {
  focus: number
  selected: number | undefined
  custom: boolean
  /** Custom text survives CcEditor's submit buffer clear. */
  customText: string
  checked: Set<number>
  answer: InlineAnswer
}

export interface DecisionDialogOptions {
  request: DecisionRequest
  onSubmit: (value: unknown) => void
  /**
   * Local dismissal of the surface. For an approval it is only reached when the
   * request has no identifiable rejected option, and then the parent must still
   * settle it. For a question the App is the final owner of settlement: it
   * settles or re-queues the native request; this component never claims the
   * request is still pending behind a hidden surface.
   */
  onCancel: () => void
  /**
   * Global turn cancellation (`app.interrupt`, Ctrl+C by default). The dialog
   * never converts this into `onCancel` or a cancelled answer; the parent runs
   * `backend.cancel()` and the native decision closure closes the surface.
   */
  onInterrupt?: () => void
  /** Shared keymap from the input subsystem. A default CC keymap is used when omitted. */
  keymap?: CcKeymap
}

export class DecisionDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly request: DecisionRequest
  private readonly options: DecisionDialogOptions
  private readonly frame = new ModalFrame()
  private readonly questions: readonly Question[]
  private readonly states: QuestionState[]
  /** One markdown renderer for the current question's `detail` body. */
  private readonly detailMarkdown = new Markdown('', 0, 0, markdownTheme)
  private readonly approvalItems: readonly DecisionOption[]
  private approvalIndex = 0
  private tab = 0
  private reviewFocus = 0
  private hits: HitRange[] = []
  private press?: { key: string; owner: string }
  private focusedState = false
  private done = false
  private dismissedState = false
  private disposedState = false

  constructor(tui: TUI, options: DecisionDialogOptions) {
    this.tui = tui
    this.options = options
    this.request = options.request
    this.keymap = options.keymap ?? createCcKeymap()
    this.questions = this.request.kind === 'question' ? (this.request.questions ?? []) : []
    this.approvalItems = this.request.kind === 'approval' ? (this.request.options ?? []) : []
    this.states = this.questions.map(() => ({
      focus: 0,
      selected: undefined,
      custom: false,
      customText: '',
      checked: new Set<number>(),
      answer: new InlineAnswer(tui, this.keymap),
    }))
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.keymap.cancelChord()
    this.focusedState = value
    if (value) this.dismissedState = false
    this.syncFocus()
  }

  /**
   * True after a question was locally dismissed. The App owns the native
   * settlement (including any re-queue), so this is only a view flag.
   */
  get dismissed(): boolean {
    return this.dismissedState
  }

  /**
   * Fragmented bracketed-paste state of the custom-answer editors. The App's
   * global Ctrl+C listener checks this before cancelling a busy turn, because a
   * Ctrl+C byte inside a paste is answer text, not an interrupt. It reads the
   * existing CcEditor paste state only — no second input state is created.
   */
  get isPasting(): boolean {
    return this.states.some(state => state.answer.editor.isPasting())
  }

  /** True once every inline editor released its shared-keymap listener. */
  get isDisposed(): boolean {
    return this.disposedState
  }

  /**
   * Release the custom-answer editors (and their shared-keymap chord
   * listeners). Call this after a settled decision closure, session reset or
   * shutdown. Idempotent.
   */
  dispose(): void {
    if (this.disposedState) return
    this.disposedState = true
    // The keymap is shared by every surface: only the surface that currently
    // owns input may cancel a pending chord.
    if (this.focusedState) this.keymap.cancelChord()
    for (const state of this.states) state.answer.dispose()
  }

  /** Parent hook for focus changes; safe to call repeatedly. */
  cancelChord(): void {
    this.keymap.cancelChord()
  }

  invalidate(): void {
    // The theme may have changed: the detail body styles markdown too.
    this.frame.invalidate()
    this.detailMarkdown.invalidate()
    for (const state of this.states) state.answer.invalidate()
  }

  // -------------------------------------------------------------------------
  // State

  private get isApproval(): boolean {
    return this.request.kind === 'approval'
  }

  /**
   * Native request identity shared with the frame: a press on an option or on a
   * footer action expires when the App hands this surface a different native
   * request, so a click can never answer the wrong one.
   */
  private ownerKey(): string {
    return `decision:${this.request.id}:${this.request.kind}`
  }

  private get onReview(): boolean {
    return !this.isApproval && this.tab === this.questions.length
  }

  private get hideSubmitTab(): boolean {
    return !this.isApproval && this.questions.length === 1 && this.questions[0]!.multiSelect !== true
  }

  private get lastTab(): number {
    if (this.isApproval) return 0
    return this.hideSubmitTab ? this.questions.length - 1 : this.questions.length
  }

  private get question(): Question {
    return this.questions[this.tab]!
  }

  private get state(): QuestionState {
    return this.states[this.tab]!
  }

  private customRow(): number {
    return this.question.options.length
  }

  private nextRow(): number {
    return this.question.multiSelect === true ? this.question.options.length + 1 : -1
  }

  private lastRow(): number {
    return this.question.multiSelect === true ? this.question.options.length + 1 : this.question.options.length
  }

  private editing(): boolean {
    return !this.isApproval && !this.onReview && this.state.focus === this.customRow()
  }

  /**
   * The custom answer the dialog would return for this question.
   *
   * One rule for single- and multi-select: the live editor text is effective
   * while it exists, and a confirmed text (stored before CcEditor clears its
   * buffer on submit) stays effective afterwards. A draft is therefore never
   * dropped just because the editor was cleared or the tab was left.
   */
  private effectiveText(state: QuestionState): string {
    return state.answer.text !== '' ? state.answer.text : state.customText
  }

  private syncFocus(): void {
    this.states.forEach((state, index) => {
      const question = this.questions[index]
      const customRow = question?.options.length ?? -1
      const focused = this.focusedState && !this.isApproval && !this.onReview && index === this.tab && state.focus === customRow
      // Re-entering a confirmed custom row restores its text into the single
      // editor state, so revisiting a question shows (and can edit) the real
      // answer instead of an empty editor with a check mark.
      if (focused && !state.answer.editor.focused && state.answer.empty && state.customText !== '') {
        state.answer.editor.replaceDraftText(state.customText)
      }
      state.answer.focused = focused
    })
  }

  private setTab(tab: number): void {
    this.keymap.cancelChord()
    this.tab = Math.max(0, Math.min(this.lastTab, tab))
    this.reviewFocus = 0
    this.syncFocus()
  }

  private setFocus(row: number): void {
    this.state.focus = Math.max(0, Math.min(this.lastRow(), row))
    this.syncFocus()
  }

  private advance(): void {
    if (this.hideSubmitTab) {
      this.submit()
      return
    }
    this.setTab(this.tab + 1)
  }

  private submit(): void {
    if (this.done) return
    this.done = true
    this.syncFocus()
    this.options.onSubmit({ answers: this.answers() })
  }

  /** Approval local cancel: settle with this request's own rejected option. */
  private rejectApproval(): void {
    const rejected = rejectedOption(this.approvalItems)
    if (rejected !== undefined) {
      this.finishApproval(rejected.value)
      return
    }
    // No rejection option in this request: the parent's local cancel handler
    // must still settle the request instead of leaving the tool pending.
    this.cancel()
  }

  /** Approval fallback only; a question dismissal never marks the dialog done. */
  private cancel(): void {
    if (this.done) return
    this.done = true
    this.syncFocus()
    this.options.onCancel()
  }

  /**
   * Question local dismissal: the App settles (or re-queues) the native
   * request. Checks, selection, draft and confirmed text survive on the same
   * instance so a reopened question shows the real state.
   */
  private dismissQuestion(): void {
    if (this.done) return
    this.keymap.cancelChord()
    this.dismissedState = true
    this.syncFocus()
    this.options.onCancel()
  }

  /** Global interrupt: never turned into a local decision answer. */
  private interrupt(): void {
    if (this.done) return
    if (this.options.onInterrupt === undefined) return
    this.keymap.cancelChord()
    this.options.onInterrupt()
  }

  private finishApproval(value: unknown): void {
    if (this.done) return
    this.done = true
    this.options.onSubmit(value)
  }

  /** The frame close affordance routes through the same cancel/reject path as Esc. */
  private closeRoute(): void {
    if (this.isApproval) this.rejectApproval()
    else this.dismissQuestion()
  }

  private answers(): (string | string[])[] {
    return this.questions.map((question, index) => {
      const state = this.states[index]!
      const text = this.effectiveText(state)
      if (question.multiSelect === true) {
        const values = [...state.checked].sort((a, b) => a - b).map(option => question.options[option]?.label ?? '').filter(label => label !== '')
        if (text !== '') values.push(text)
        return values
      }
      // An explicitly submitted custom answer replaces the selection.
      if (state.custom && text !== '') return text
      if (state.selected !== undefined) return question.options[state.selected]?.label ?? ''
      // A typed-but-not-submitted draft is still the only input this question
      // has, so it is returned rather than silently dropped. Empty stays empty:
      // DSH permits unanswered questions and this dialog does not require them.
      return text
    })
  }

  private choose(index: number): void {
    this.state.selected = index
    this.state.custom = false
    this.state.customText = ''
    this.advance()
  }

  private chooseCustom(text?: string): void {
    const value = text ?? this.effectiveText(this.state)
    if (value === '') return
    this.state.customText = value
    this.state.custom = true
    this.state.selected = undefined
    this.advance()
  }

  private toggle(index: number): void {
    if (this.state.checked.has(index)) this.state.checked.delete(index)
    else this.state.checked.add(index)
  }

  // -------------------------------------------------------------------------
  // Input

  handleInput(raw: string): void {
    if (this.done || this.disposedState) return
    // A bracketed paste owns its bytes; it is never an interrupt or a decision
    // answer, so it goes straight to the single editor state.
    if (this.editing() && this.state.answer.editor.isPasting()) {
      this.editorKey(raw)
      return
    }
    const action = modalAction(this.keymap, raw)
    if (action !== undefined && isInterruptAction(action.id)) {
      this.interrupt()
      return
    }
    if (this.isApproval) {
      this.approvalKey(raw, action)
      return
    }
    if (this.onReview) {
      this.reviewKey(raw, action)
      return
    }
    if (this.editing()) {
      this.editorKey(raw)
      return
    }
    this.questionKey(raw, action)
  }

  private approvalKey(raw: string, action: ResolvedModalAction | undefined): void {
    if (action === undefined) return
    const count = this.approvalItems.length
    if (isCancelAction(action.id)) {
      // Esc/local cancel on an approval is a rejection, not a turn cancellation.
      this.rejectApproval()
      return
    }
    if (action.id === 'list.previous' && count > 0) this.approvalIndex = (this.approvalIndex - 1 + count) % count
    else if (action.id === 'list.next' && count > 0) this.approvalIndex = (this.approvalIndex + 1) % count
    else if (action.id === 'list.page-up' && count > 0) this.approvalIndex = Math.max(0, this.approvalIndex - 5)
    else if (action.id === 'list.page-down' && count > 0) this.approvalIndex = Math.min(count - 1, this.approvalIndex + 5)
    else if (action.id === 'list.first' && count > 0) this.approvalIndex = 0
    else if (action.id === 'list.last' && count > 0) this.approvalIndex = count - 1
    else if (isSelectAction(action.id) && count > 0) this.finishApproval(this.approvalItems[this.approvalIndex]!.value)
    else if (action.id === 'list.select-digit') {
      const number = digitOf(action)
      if (number !== undefined && number <= count) this.finishApproval(this.approvalItems[number - 1]!.value)
    }
    void raw
  }

  private questionKey(raw: string, action: ResolvedModalAction | undefined): void {
    if (action !== undefined) {
      this.applyQuestionAction(action)
      return
    }
    if (isTab(raw)) {
      this.setTab(this.tab + 1)
      return
    }
    if (isShiftTab(raw)) {
      this.setTab(this.tab - 1)
      return
    }
    if (this.question.multiSelect === true && isSpace(raw)) {
      if (this.state.focus < this.question.options.length) this.toggle(this.state.focus)
      else this.setFocus(this.customRow())
    }
  }

  private applyQuestionAction(action: ResolvedModalAction): void {
    if (isCancelAction(action.id)) {
      this.dismissQuestion()
      return
    }
    const state = this.state
    const count = this.question.options.length
    const last = this.lastRow()
    if (action.id === 'list.previous') {
      this.setFocus(state.focus === 0 ? last : state.focus - 1)
    } else if (action.id === 'list.next') {
      this.setFocus(state.focus === last ? 0 : state.focus + 1)
    } else if (action.id === 'list.page-up') {
      this.setFocus(Math.max(0, state.focus - 5))
    } else if (action.id === 'list.page-down') {
      this.setFocus(Math.min(last, state.focus + 5))
    } else if (action.id === 'list.first') {
      this.setFocus(0)
    } else if (action.id === 'list.last') {
      this.setFocus(last)
    } else if (isSelectAction(action.id)) {
      this.selectFocused()
    } else if (action.id === 'list.select-digit') {
      const number = digitOf(action)
      if (number === undefined) return
      if (number <= count) {
        if (this.question.multiSelect === true) this.toggle(number - 1)
        else this.choose(number - 1)
      } else if (number === count + 1) {
        this.setFocus(count)
      }
    }
  }

  private selectFocused(): void {
    const state = this.state
    const count = this.question.options.length
    if (this.question.multiSelect === true) {
      const next = this.nextRow()
      if (state.focus === next) this.advance()
      else if (state.focus < count) this.toggle(state.focus)
      else this.setFocus(count)
      return
    }
    if (state.focus < count) this.choose(state.focus)
    else this.chooseCustom()
  }

  private editorKey(raw: string): void {
    const state = this.state
    const result = state.answer.handleKey(raw)
    switch (result) {
      case 'interrupt':
        this.interrupt()
        return
      case 'cancel':
        this.dismissQuestion()
        return
      case 'submit': {
        const submitted = state.answer.lastSubmittedText ?? state.answer.text
        const text = submitted !== '' ? submitted : this.effectiveText(state)
        if (text === '') {
          if (this.question.multiSelect === true) this.setFocus(this.nextRow())
          return
        }
        state.customText = text
        if (this.question.multiSelect === true) this.advance()
        else this.chooseCustom(text)
        return
      }
      case 'tab':
        if (this.question.multiSelect === true) this.setFocus(this.nextRow())
        else this.advance()
        return
      case 'up':
        this.setFocus(state.focus - 1)
        return
      case 'down':
        this.setFocus(this.question.multiSelect === true ? this.nextRow() : 0)
        return
      case 'handled':
        return
    }
  }

  private reviewKey(raw: string, action: ResolvedModalAction | undefined): void {
    if (action !== undefined) {
      if (isCancelAction(action.id)) {
        this.dismissQuestion()
        return
      }
      if (action.id === 'list.previous' || action.id === 'list.next') {
        this.reviewFocus = 1 - this.reviewFocus
        return
      }
      if (action.id === 'list.first') {
        this.reviewFocus = 0
        return
      }
      if (action.id === 'list.last') {
        this.reviewFocus = 1
        return
      }
      if (isSelectAction(action.id)) {
        if (this.reviewFocus === 0) this.submit()
        else this.dismissQuestion()
        return
      }
      if (action.id === 'list.select-digit') {
        const number = digitOf(action)
        if (number === 1) this.submit()
        else if (number === 2) this.dismissQuestion()
      }
      return
    }
    if (isTab(raw)) {
      this.setTab(0)
      return
    }
    if (isShiftTab(raw)) {
      this.setTab(this.questions.length - 1)
    }
  }

  // -------------------------------------------------------------------------
  // Mouse

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const chrome = this.frame.handleMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.frame.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0
      if (delta === 0) return undefined
      if (this.isApproval) this.approvalIndex = Math.max(0, Math.min(this.approvalItems.length - 1, this.approvalIndex + (delta < 0 ? -1 : 1)))
      else if (this.onReview) this.reviewFocus = delta < 0 ? 0 : 1
      else this.setFocus(this.state.focus + (delta < 0 ? -1 : 1))
      return { handled: true, render: true }
    }
    const owner = this.ownerKey()
    const hit = bodyHitAt(this.hits, body.y)
    const key = hit === undefined ? undefined : hit.key ?? String(hit.index)
    if (event.type === 'press') {
      this.press = key === undefined ? undefined : { key, owner }
      // Do not move the window on press: the release must resolve the same
      // painted row even when a click starts a scroll/window adjustment.
      return hit === undefined ? undefined : { handled: true, render: false }
    }
    if (event.type === 'drag') {
      this.press = undefined
      return undefined
    }
    if (event.type !== 'click') return undefined
    const pressed = this.press
    this.press = undefined
    // A pending native request is only ever settled by an explicit press+release
    // on the same option of the same request. A stale click (page change, native
    // request swap, re-order, drag) is swallowed rather than answered.
    if (pressed === undefined || pressed.owner !== owner || key === undefined || pressed.key !== key) {
      return { handled: true, render: false }
    }
    this.focusHit(hit!.index)
    if (this.isApproval) {
      const option = this.approvalItems[this.approvalIndex]
      if (option !== undefined) this.finishApproval(option.value)
    } else if (this.onReview) {
      if (this.reviewFocus === 0) this.submit()
      else this.dismissQuestion()
    } else {
      this.selectFocused()
    }
    return { handled: true, render: true }
  }

  /** Move the highlight to a clicked row without answering it. */
  private focusHit(index: number): void {
    if (this.isApproval) this.approvalIndex = Math.min(Math.max(0, index), Math.max(0, this.approvalItems.length - 1))
    else if (this.onReview) this.reviewFocus = index === 1 ? 1 : 0
    else this.setFocus(index)
  }

  // -------------------------------------------------------------------------
  // Rendering

  /**
   * One question that carries its own body is the whole dialog (DSH's native
   * plan review: header / question / plan / options). It only gets that
   * treatment when there is no tab navigation to lose — a multi-select question
   * keeps its tabs and review step.
   */
  private presentsOwnBody(): boolean {
    const question = this.questions[0]
    return this.hideSubmitTab && question !== undefined && questionDetail(question) !== undefined
  }

  /**
   * Dialog title. The self-presenting question contributes its own header;
   * every other shape keeps the request title the backend adapter supplied.
   */
  private dialogTitle(): string {
    if (this.isApproval || !this.presentsOwnBody()) return this.request.title
    const header = this.questions[0]?.header?.trim() ?? ''
    return header === '' ? this.request.title : header
  }

  private actions(): ModalAction[] {
    if (this.isApproval) {
      const count = this.approvalItems.length
      return [
        {
          id: 'choose',
          label: 'Choose',
          action: 'list.select',
          onActivate: () => {
            const option = this.approvalItems[this.approvalIndex]
            if (option !== undefined) this.finishApproval(option.value)
          },
          disabled: count === 0,
        },
        { id: 'reject', label: 'Reject', action: 'list.cancel', onActivate: () => this.rejectApproval() },
      ]
    }
    if (this.onReview) {
      return [
        { id: 'submit', label: 'Submit', action: 'dialog.confirm', onActivate: () => this.submit() },
        { id: 'cancel', label: 'Cancel', action: 'dialog.cancel', onActivate: () => this.dismissQuestion() },
      ]
    }
    return [
      {
        id: 'choose',
        label: this.question.multiSelect === true ? 'Toggle' : 'Choose',
        action: 'list.select',
        onActivate: () => this.selectFocused(),
      },
      { id: 'cancel', label: 'Cancel', action: 'list.cancel', onActivate: () => this.dismissQuestion() },
    ]
  }

  private modalOptions(): ModalFrameOptions {
    return {
      title: this.dialogTitle(),
      ownerKey: this.ownerKey(),
      actions: this.actions(),
      onClose: () => this.closeRoute(),
      maxHeight: modalHeight(this.tui, this.modalSize),
      keymap: this.keymap,
    }
  }

  /**
   * The native request message, wrapped in the body (the frame subtitle is a
   * single truncated line, which would silently drop native text).
   */
  private messagePaint(width: number): BodyPaint {
    const message = this.request.message?.trim() ?? ''
    if (message === '') return textPaint([])
    return textPaint([...wrap(message, Math.max(4, width - 2)).map(line => ` ${dim(t.text(line))}`), ''])
  }

  private renderApproval(bodyWidth: number, bodyHeight: number): BodyPaint {
    const message = this.messagePaint(bodyWidth)
    if (this.approvalItems.length === 0) {
      return concatPaint([
        message,
        textPaint(noticeLines('No approval options are available.', bodyWidth)),
        textPaint([' ' + this.hintLine()]),
      ])
    }
    const blocks = choiceBlocks(this.approvalItems, this.approvalIndex, this.approvalIndex, bodyWidth, true, false, new Set())
    const hint = this.hintLine()
    const budget = Math.max(1, bodyHeight - message.lines.length - (hint === '' ? 0 : 2))
    return concatPaint([
      message,
      windowRowsWithHits(blocks, budget),
      ...(hint === '' ? [] : [textPaint(['']), textPaint([' ' + hint])]),
    ])
  }

  /** Narrow hint line: real registry actions come from the frame footer. */
  private hintLine(): string {
    if (this.isApproval) return hints(['Enter to allow the focused option', 'Esc to reject'])
    if (this.onReview) return hints(['Enter to submit', 'Esc to cancel'])
    const parts: string[] = []
    if (this.questions.length > 1) parts.push('Tab switches questions')
    if (this.question.multiSelect === true) parts.push('Space toggles')
    if (this.editing()) parts.push('Enter submits the answer')
    parts.push('Esc cancels')
    return hints(parts)
  }

  private renderQuestions(bodyWidth: number, bodyHeight: number): BodyPaint {
    const message = this.messagePaint(bodyWidth)
    const hint = this.hintLine()
    if (this.onReview) {
      const hintRows = hint === '' ? 0 : 2
      const budget = Math.max(1, bodyHeight - message.lines.length - hintRows)
      const review = this.reviewBlocks(bodyWidth)
      const painted = windowRowsWithHits(review.blocks, budget)
      return concatPaint([message, painted, ...(hint === '' ? [] : [textPaint(['']), textPaint([' ' + hint])])])
    }
    const question = this.question
    const hasDetail = questionDetail(question) !== undefined
    // Degradation order on a short body: the native answer rows first, then the
    // honest detail marker, then the question header, then the optional
    // hint/preview chrome. Nothing that is dropped disappears without a marker.
    const blocks = question.multiSelect === true ? this.multiRows(bodyWidth) : this.singleRows(bodyWidth)
    // Two answer rows when the native question has them: the horizontal choice
    // must stay visible next to an honest plan marker, not only one option.
    const optionLines = blocks.reduce((sum, block) => sum + block.lines.length, 0)
    const optionMinimum = Math.min(2, Math.max(1, optionLines))
    const markerRows = hasDetail ? 1 : 0
    const headerRoom = Math.max(0, bodyHeight - optionMinimum - markerRows)
    const titleLines = wrap(question.question, Math.max(4, bodyWidth)).map(line => bold(t.text(line)))
    // A self-presenting question already carries its header as the frame title.
    const tabs = this.presentsOwnBody() ? undefined : this.renderTabs(bodyWidth)
    const header: string[] = []
    if (tabs !== undefined && header.length < headerRoom) header.push(tabs)
    for (const line of titleLines) {
      if (header.length >= headerRoom) break
      header.push(line)
    }
    // Body: the native long-form detail (the plan review's plan markdown). At
    // least one honest marker row is kept whenever the native detail exists, so
    // a clipped plan is never silently invisible.
    const detailRoom = hasDetail ? Math.max(1, bodyHeight - header.length - optionMinimum) : 0
    const detail = this.detailLines(question, bodyWidth, detailRoom)
    const separator = detail.length > 0 && bodyHeight - header.length - detail.length - optionMinimum >= 1 ? 1 : 0
    const detailRows = detail.length === 0 ? 0 : detail.length + separator
    const preview = this.previewLines(bodyWidth)
    let previewRows = preview.length === 0 ? 0 : preview.length + 1
    let hintCost = hint === '' ? 0 : 2
    const fixed = message.lines.length + header.length + detailRows
    if (bodyHeight - fixed < optionMinimum + hintCost + previewRows) previewRows = 0
    if (bodyHeight - fixed < optionMinimum + hintCost) hintCost = 0
    const budget = Math.max(1, bodyHeight - fixed - hintCost - previewRows)
    const painted: BodyPaint[] = [message]
    if (header.length > 0) painted.push(textPaint(header))
    if (detail.length > 0) {
      painted.push(textPaint(detail))
      if (separator > 0) painted.push(textPaint(['']))
    }
    painted.push(windowRowsWithHits(blocks, budget))
    if (preview.length > 0 && previewRows > 0) painted.push(textPaint(['']), textPaint(preview))
    if (hint !== '' && hintCost > 0) painted.push(textPaint(['']), textPaint([' ' + hint]))
    return concatPaint(painted)
  }

  /**
   * The question's long-form `detail` as a readable body above the options:
   * markdown through the repo's transcript theme (no new dependency). `room` is
   * the exact number of body rows the caller can spare, including the honest
   * `… +N lines` marker; nothing is drawn when there is no usable room.
   */
  private detailLines(question: Question, width: number, room: number): string[] {
    if (room < 1) return []
    const detail = questionDetail(question)
    if (detail === undefined) return []
    this.detailMarkdown.setText(detail)
    const body = this.detailMarkdown.render(Math.max(1, width - 1))
    while (body.length > 0 && (body[0] ?? '').trim() === '') body.shift()
    while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop()
    if (body.length === 0) return []
    const cap = Math.min(14, room)
    const marker = (hidden: number): string => ` ${dim(t.muted(`… +${hidden} line${hidden === 1 ? '' : 's'} hidden`))}`
    // Markdown pads its lines to the rendered width; the dialog has no reason
    // to emit trailing blanks.
    const shown = body.slice(0, cap).map(line => (line.trim() === '' ? '' : ` ${line.trimEnd()}`))
    if (body.length <= cap) return shown
    // Clipped: keep an honest marker even when only one row is affordable, so a
    // short terminal never hides a native plan without saying so.
    if (cap < 2) return [marker(body.length)]
    return [...shown.slice(0, cap - 1), marker(body.length - (cap - 1))]
  }

  private renderTabs(width: number): string {
    const arrows = !(this.questions.length === 1 && this.hideSubmitTab)
    const submit = this.hideSubmitTab ? '' : '✔ Submit'
    const headers = this.questions.map((question, index) => {
      const label = question.header !== undefined && question.header !== '' ? question.header : `Q${index + 1}`
      const answered = this.isAnswered(index)
      return `${answered ? '☒' : '☐'} ${label}`
    })
    const reserve = (arrows ? 4 : 0) + (submit === '' ? 0 : visibleWidth(submit) + 4)
    const budget = Math.max(8, width - reserve)
    let shown = headers
    const total = headers.reduce((sum, header) => sum + visibleWidth(header) + 4, 0)
    if (total > budget && headers.length > 0) {
      const each = Math.max(4, Math.floor(budget / headers.length) - 4)
      shown = headers.map(header => truncateToWidth(header, each, '…'))
    }
    const chip = (text: string, active: boolean): string => (active ? cc.chip(` ${text} `) : t.text(` ${text} `))
    let line = arrows ? `${this.tab === 0 ? cc.inactive('←') : t.text('←')} ` : ''
    shown.forEach((header, index) => {
      line += chip(header, index === this.tab)
    })
    if (submit !== '') line += chip(submit, this.onReview)
    if (arrows) line += ` ${this.tab === this.lastTab ? cc.inactive('→') : t.text('→')}`
    return line
  }

  private isAnswered(index: number): boolean {
    const question = this.questions[index]
    const state = this.states[index]
    if (question === undefined || state === undefined) return false
    if (this.effectiveText(state) !== '') return true
    if (question.multiSelect === true) return state.checked.size > 0
    return state.selected !== undefined
  }

  private singleRows(width: number): RowBlock[] {
    const question = this.question
    const state = this.state
    const count = question.options.length
    const numberWidth = String(count + 1).length
    const options: DecisionOption[] = question.options.map(option => ({ label: option.label, description: option.description, value: option.label }))
    const blocks = choiceBlocks(options, state.focus, state.custom ? undefined : state.selected, width, true, false, new Set())
      .map((block, index) => ({ ...block, key: `${this.tab}:${index}:${options[index]?.label ?? ''}` }))
    const indent = ' '.repeat(numberWidth + 4)
    const focused = this.editing()
    const body = state.answer.render(Math.max(4, width - indent.length), focused, 'Type something.', state.customText)
    const chosen = state.custom && this.effectiveText(state) !== ''
    const lines = [`${pointer(focused)} ${numberLabel(count + 1, numberWidth)} ${body[0] ?? ''}${chosen ? ` ${cc.success('✔')}` : ''}`]
    for (const line of body.slice(1)) lines.push(indent + line)
    blocks.push({ lines, focused, index: count, key: `${this.tab}:custom` })
    return blocks
  }

  private multiRows(width: number): RowBlock[] {
    const question = this.question
    const state = this.state
    const count = question.options.length
    const numberWidth = String(count + 1).length
    const indent = ' '.repeat(numberWidth + 8)
    const box = (checked: boolean): string => (checked ? cc.success('[✔]') : t.text('[ ]'))
    const blocks: RowBlock[] = question.options.map((option, index) => {
      const focused = state.focus === index
      const style = focused ? cc.suggestion : t.text
      const label = wrap(option.label, Math.max(4, width - indent.length))
      const lines = [`${pointer(focused)} ${numberLabel(index + 1, numberWidth)} ${box(state.checked.has(index))} ${style(label[0] ?? '')}`]
      for (const line of label.slice(1)) lines.push(indent + style(line))
      if (option.description !== undefined && option.description.trim() !== '') {
        for (const line of wrap(option.description, Math.max(4, width - indent.length))) lines.push(indent + cc.inactive(line))
      }
      return { lines, focused, index, key: `${this.tab}:${index}:${option.label}` }
    })
    const editing = this.editing()
    const customChecked = this.effectiveText(state) !== ''
    const body = state.answer.render(Math.max(4, width - indent.length), editing, 'Type something (optional)', state.customText)
    const custom = [`${pointer(editing)} ${numberLabel(count + 1, numberWidth)} ${box(customChecked)} ${body[0] ?? ''}`]
    for (const line of body.slice(1)) custom.push(indent + line)
    blocks.push({ lines: custom, focused: editing, index: count, key: `${this.tab}:custom` })
    const next = this.nextRow()
    const onNext = state.focus === next
    const nextLabel = this.tab === this.questions.length - 1 ? 'Submit' : 'Next'
    blocks.push({ lines: [`${pointer(onNext)}    ${bold((onNext ? cc.suggestion : t.text)(nextLabel))}`], focused: onNext, index: next, key: `${this.tab}:next` })
    return blocks
  }

  private previewLines(width: number): string[] {
    if (this.question.multiSelect === true) return []
    const option = this.question.options[this.state.focus]
    const preview = option?.preview
    if (preview === undefined || preview.trim() === '') return []
    const inner = Math.max(10, Math.min(width, 72))
    const lines = wrap(preview.replace(/\n+$/, ''), inner - 4).slice(0, 8)
    return [dim(`┌${'─'.repeat(inner - 2)}┐`), ...lines.map(line => `${dim('│')} ${t.muted(line)}`), dim(`└${'─'.repeat(inner - 2)}┘`)]
  }

  private reviewBlocks(width: number): { blocks: RowBlock[] } {
    const blocks: RowBlock[] = []
    blocks.push({ lines: [bold(t.text('Review your answers'))], focused: false })
    blocks.push({ lines: [''], focused: false })
    const answers = this.answers()
    if (answers.some(answer => (Array.isArray(answer) ? answer.length === 0 : answer === ''))) {
      blocks.push({ lines: [cc.warning('⚠ You have not answered all questions')], focused: false })
      blocks.push({ lines: [''], focused: false })
    }
    this.questions.forEach((question, index) => {
      const answer = answers[index]
      const text = Array.isArray(answer) ? answer.join(', ') : answer
      const lines = wrap(question.question, Math.max(4, width - 3))
      blocks.push({ lines: [` ● ${t.text(lines[0] ?? '')}`, ...lines.slice(1).map(line => `   ${t.text(line)}`)], focused: false })
      if (text !== '') blocks.push({ lines: wrap(`→ ${text}`, Math.max(4, width - 3)).map(line => `   ${cc.success(line)}`), focused: false })
    })
    blocks.push({ lines: [''], focused: false })
    blocks.push({ lines: [cc.inactive('Ready to submit your answers?')], focused: false })
    blocks.push({ lines: [''], focused: false })
    ;['Submit answers', 'Cancel'].forEach((label, index) => {
      const focused = index === this.reviewFocus
      blocks.push({
        lines: [`${pointer(focused)} ${dim(`${index + 1}.`)} ${(focused ? cc.suggestion : t.text)(label)}`],
        focused,
        index,
        key: `review:${index}:${label}`,
      })
    })
    return { blocks }
  }

  render(width: number): string[] {
    const options = this.modalOptions()
    const painted = renderModalBody(this.frame, width, options, (bodyWidth, bodyHeight) =>
      this.isApproval ? this.renderApproval(bodyWidth, bodyHeight) : this.renderQuestions(bodyWidth, bodyHeight))
    this.hits = painted.paint.hits
    return painted.lines
  }
}

/**
 * Long-form question body (`detail`): the native plan review carries the whole
 * plan markdown here. Presentation only — the text is DSH's, the TUI renders it.
 */
function questionDetail(question: Question): string | undefined {
  const detail = question.detail
  return typeof detail === 'string' && detail.trim() !== '' ? detail : undefined
}