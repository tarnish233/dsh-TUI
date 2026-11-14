/**
 * DSH modal surfaces built on the shared popup frame.
 *
 * Three things live here:
 *
 * 1. `SelectDialog` — the generic search-free chooser (`/preset`, `/effort` and
 *    other small native rosters). It is a bounded `ModalFrame` surface, with
 *    clickable rows, a clickable action footer and the same key/mouse
 *    behaviour.
 * 2. `DecisionDialog` — native approvals and ordered questions. It keeps the
 *    opaque native option values, the ordered `{answers: (string|string[])[]}`
 *    result, per-question multi-select/custom/review state, the local
 *    cancel/reject path and the optional full native detail overlay request.
 * 3. Small shared modal helpers used by the other chooser/help components:
 *    keymap resolution for the unified `modalList` browse context, block
 *    windowing that also reports painted body row ranges (so mouse hits can
 *    never point at a clipped row), the body/geometry composition helper and
 *    the shared proposal validation/rows also used by `decision-details.ts`.
 *
 * Contract boundaries (do not relax here):
 *
 * - Chrome, sizing, action chips and mouse geometry belong to `ModalFrame`.
 *   These components own only their body lines and their own list state.
 * - Placement is presentation only (`ComposerInteraction`, docs/
 *   COMPOSER-INTERACTION-CONTRACT.md): the default stays the historical bounded
 *   workspace overlay, a `composer` mount sits input-adjacent, uses the natural
 *   content height capped by the parent's budget, and stops claiming viewport
 *   keys so transcript paging keeps working. Selection keys stay local.
 * - Default `Ctrl+C` is the local cancel/reject path of the focused surface
 *   (`list.cancel`/`dialog.cancel`), never a hidden root clear and never a
 *   native abort. An explicitly configured `app.interrupt` key is explicit
 *   intent and keeps its priority through `onInterrupt`; it is never converted
 *   into a local answer, and never closes a decision by itself.
 * - The root `app.clear` binding is never re-aliased into a dismissal and never
 *   reaches the hidden root draft from inside a decision. A custom-answer field
 *   only maps the *actual configured* local cancel bindings onto the same local
 *   dismiss path, and only when the editor layer does not claim that key; a
 *   disabled/remapped cancel key therefore stays inert instead of gaining an
 *   invented fallback.
 * - An approval's local cancel (Esc, `list.cancel`, the frame close affordance)
 *   submits the request's own rejected opaque option, so the native decision
 *   settles as `rejected`. Only when the request has no identifiable rejection
 *   option does it fall back to `onCancel`, whose owner must still settle it.
 * - A question's local cancel goes to `onCancel`. The App is the final owner of
 *   question cancellation/native settlement: it settles the current native
 *   request (or re-queues it) — the component never claims that a dismissed
 *   question stays hidden while pending.
 * - No guessed tool/diff correlation: a decision renders the native message and
 *   options only, except for an approval that arrives with DSH's own
 *   `toolPresentation.presentCall` diff intent. That preview is validated with
 *   the shared tool-presentation reader, is rendered by the shared
 *   `renderDiffBlock`, is always worded as a proposal that has not run, and is
 *   dropped (with no error and no marker) when the record is missing or
 *   malformed. `callId` alone is never evidence of a diff.
 * - The full native detail (`question.detail` markdown or the validated pure
 *   proposal) is never invented here: `onDetails` is only offered when the
 *   native request already carries it, and the parent mounts the read-only
 *   `DecisionDetailsDialog` over this retained decision instance.
 *
 * Layout/keys are adapted from agent_tui (MIT) src/ui/{dialogs,questionnaire,
 * select}.ts, rebuilt on public Pi TUI + this repo's input/theme components.
 */
import {
  Markdown,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type { DecisionOption, DecisionRequest, JsonRecord, Question } from '../backend/types.ts'
import { createCcKeymap, matchesConfiguredKey, type CcKeymap } from '../input/index.ts'
import type { DecisionDetailContent } from './decision-details.ts'
import { subscribeHighlightRuntime } from './highlight.ts'
import { InlineAnswer } from './inline-editor.ts'
import type { ComposerInteraction, InteractionLayout } from './interaction.ts'
import { CLOSE_ACTIONS, isCloseAction, ModalFrame, modalHeight, type ModalAction, type ModalFrameOptions, type ModalSize } from './modal.ts'
import { bold, cc, dim, markdownTheme, t } from './theme.ts'
import { fit, sanitize, truncateToWidth, visibleWidth, wrap } from './text.ts'
import { renderDiffBlock, diffStats } from './tool-diff.ts'
import { readToolPresentation, type MetaDiff } from './tool-io.ts'

// ---------------------------------------------------------------------------
// Keymap dispatch

/** One resolved registry action: the action id and the physical keys that matched. */
export interface ResolvedModalAction {
  id: string
  keys: string[]
}

/** Every action that means "settle this surface locally, without answering". */
const CANCEL_ACTIONS: readonly string[] = [...CLOSE_ACTIONS]
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
    .some(binding => !binding.includes(' ') && matchesConfiguredKey(data, binding))
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
 * block below and one above.
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

/** Same window plus the body row range of every selectable block. */
export function windowRowsWithHits(blocks: RowBlock[], budget: number): BodyPaint {
  return paintBlocks(blocks, windowBlockRange(blocks, budget))
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

// ---------------------------------------------------------------------------
// Composer / workspace presentation

/** Historical bounded workspace overlay height; the default presentation. */
function workspaceHeight(tui: Pick<TUI, 'terminal'>, size: ModalSize): number {
  return modalHeight(tui, size)
}

/**
 * Smallest natural composer plate: title, one body row, one footer row and the
 * closed border. Never padded beyond the content, and clamped again by the
 * parent's budget.
 */
const MIN_COMPOSER_ROWS = 6

/** One frame plan shared by `measureRows` and `render` (never a second paint). */
interface PlannedFrame {
  readonly height: number
  /** Body rows the frame actually gives the dialog at this height. */
  readonly bodyHeight: number
  readonly options: ModalFrameOptions
  readonly lines: string[]
  readonly hits: HitRange[]
}

/**
 * Plan one frame at `width` from the same options the paint uses.
 *
 * `fixedHeight` keeps the historical workspace surface (it fills its bounded
 * overlay exactly). Without it the height is the natural content height capped
 * by `cap` — the parent's budget is a cap, never an excuse to pad a two-row
 * picker into a tall panel. Chrome rows are allocated first by `ModalFrame`, so
 * the action footer (including cancel/reject) survives at every height.
 *
 * Planning only measures and composes body rows: it paints nothing, syncs no
 * hitboxes and changes no selection, focus or editor state. The body is built
 * against the exact geometry the frame will use, so `measureRows` and `render`
 * can never disagree about the row count.
 */
function planFrame(
  frame: ModalFrame,
  width: number,
  options: (height: number) => ModalFrameOptions,
  body: (bodyWidth: number, bodyHeight: number) => BodyPaint,
  fixedHeight: number | undefined,
  cap: number,
  minimum = 1,
): PlannedFrame {
  const safeWidth = Math.max(1, Math.floor(width))
  const budget = Math.max(1, Math.floor(cap))
  // A framed plate stays readable for a tiny roster, but the floor is itself
  // bounded by the parent's budget: a small viewport still wins.
  const floor = Math.max(1, Math.min(budget, Math.floor(minimum)))
  const at = (height: number): PlannedFrame => {
    const built = options(height)
    const geometry = frame.measure(safeWidth, built)
    const paint = body(geometry.bodyWidth, geometry.bodyHeight)
    const lines = paint.lines.slice(0, geometry.bodyHeight).map(line => fit(line, geometry.bodyWidth))
    const hits = paint.hits.filter(hit => hit.endRow < lines.length)
    return { height, bodyHeight: geometry.bodyHeight, options: built, lines, hits }
  }
  if (fixedHeight !== undefined) return at(Math.max(1, Math.floor(fixedHeight)))
  // Chrome only shrinks as the height shrinks, so the fixed point is reached in
  // one or two passes. The loop stays bounded so no degradation rule can spin.
  let height = budget
  for (let pass = 0; pass < 3; pass += 1) {
    const plan = at(height)
    const natural = Math.max(1, plan.height - plan.bodyHeight + plan.lines.length)
    const next = Math.max(floor, Math.min(budget, natural))
    if (next === height) return plan
    height = next
  }
  return at(height)
}

/**
 * True when `raw` is one of the enabled single-key bindings of `actionId`.
 *
 * Read-only test: it never opens, advances or cancels a pending chord, so a
 * dialog can ask about one app action before forwarding the key to the single
 * editor state. Chords are deliberately excluded (they belong to the editor or
 * to the dialog's own resolution, not to this lookahead).
 */
export function boundToKey(keymap: CcKeymap, actionId: string, raw: string): boolean {
  return keymap
    .getBindings(actionId)
    .some(binding => !binding.includes(' ') && matchesConfiguredKey(raw, binding))
}

/**
 * True when the editor layer claims `raw` itself (a nearer binding wins), which
 * keeps the single editor state authoritative inside an inline answer field.
 * A pending chord always belongs to the editor until it completes or cancels.
 */
function editorClaimsKey(keymap: CcKeymap, raw: string): boolean {
  if (keymap.isPendingChord()) return true
  for (const action of keymap.getActions('editor')) {
    for (const binding of keymap.getBindings(action.id)) {
      const first = binding.split(' ')[0]
      if (first !== undefined && matchesConfiguredKey(raw, first)) return true
    }
  }
  return false
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
    const label = wrap(sanitize(item.label), Math.max(4, width - visibleWidth(prefix)))
    const lines = [`${prefix}${style(label[0] ?? '')}${chosen ? ` ${cc.success('✔')}` : ''}`]
    for (const line of label.slice(1)) lines.push(indent + style(line))
    if (item.description !== undefined && item.description.trim() !== '') {
      for (const line of wrap(sanitize(item.description), Math.max(4, width - indent.length))) {
        lines.push(indent + dim(focused || chosen ? style(line) : t.text(line)))
      }
    }
    // Row identity: the rendered label plus its native position. A reorder or a
    // roster swap changes it, so a stale press cannot activate it.
    return { lines, focused, index, key: `${index}:${item.label}` }
  })
}

const noticeLines = (text: string, width: number): string[] =>
  wrap(sanitize(text), Math.max(4, width)).map(line => ` ${t.muted(fit(line, Math.max(4, width)))}`)

const errorLines = (text: string, width: number): string[] =>
  wrap(sanitize(text), Math.max(4, width)).map(line => ` ${cc.error(fit(line, Math.max(4, width)))}`)

// ---------------------------------------------------------------------------
// Approval proposal preview

/** Diff rows a bounded proposal preview may paint; never a full patch dump. */
const PROPOSAL_PREVIEW_ROWS = 12
/** Same column threshold the transcript's diff cards use by default. */
const PROPOSAL_SPLIT_MIN_WIDTH = 120

/**
 * Validate the request's native proposed diff call view.
 *
 * DSH hands an approval the pure `presentCall` intent *before* the tool runs, so
 * only the call half is read and only its diff card counts. A missing record, a
 * different card, malformed `diffs`, or a record that carries only a `result`
 * half is not a proposal: it yields `undefined`, and the dialog keeps its plain
 * message + options with no error and no placeholder. `callId` is deliberately
 * not consulted — an identity string is never evidence of a diff.
 *
 * Exported for the full detail overlay, which re-renders exactly this validated
 * record (one validation rule, no second diff guess).
 */
export function decisionProposalRecord(raw: unknown): JsonRecord | undefined {
  const record = asRecordLike(raw)
  if (record === undefined) return undefined
  // An approval is decided *before* execution, so a record that carries a
  // result half is not the pure call intent this preview understands. Refuse it
  // rather than risk presenting an executed result as a pending proposal.
  if ('result' in record) return undefined
  const call = readToolPresentation(record, false).call
  if (call === undefined || call.card !== 'diff' || call.diffs.length === 0) return undefined
  return record
}

/** Diffs of an already-validated pure proposal record (shared reader, no copy). */
export function decisionProposalDiffs(record: JsonRecord): MetaDiff[] {
  const call = readToolPresentation(record, false).call
  return call === undefined ? [] : [...call.diffs]
}

/** Plain-object check for the untrusted presentation record. */
function asRecordLike(raw: unknown): JsonRecord | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as JsonRecord : undefined
}

/** One untrusted native path as a single printable row fragment. */
function proposalPath(path: string): string {
  return sanitize(path).replace(/\s+/g, ' ').trim()
}

/**
 * Label + summary row of the proposal preview.
 *
 * The honesty wording comes first so a narrow body truncates the file list, not
 * the fact that this is a proposal DSH has not run. No row of this preview may
 * claim an applied change or an executed result.
 */
export function decisionProposalLabel(diffs: readonly MetaDiff[], width: number): string {
  const paths = [...new Set(diffs.map(diff => proposalPath(diff.path)))].filter(path => path !== '')
  const scope = paths.length === 0
    ? 'file change'
    : paths.length === 1
      ? paths[0]!
      : `${paths.length} files (${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` +${paths.length - 3} more` : ''})`
  const stats = diffStats(diffs)
  const counts = stats.oversized ? 'hunk too large to count precisely' : `+${stats.added} -${stats.removed} lines`
  const label = 'Proposal'
  return fit(` ${bold(t.accent(label))}${t.muted(` · not run yet · ${scope} · ${counts}`)}`, width)
}

/**
 * Complete proposal rows: heading, diff rows and honest overflow markers.
 *
 * Diff math and width/wrap behaviour are `renderDiffBlock`'s; this function only
 * adds the indent, the label and the truncation notice. `expanded` renders the
 * whole patch (the full read-only detail overlay); otherwise the bounded
 * `PROPOSAL_PREVIEW_ROWS` budget applies and the hidden count is reported.
 *
 * `indicatorMode: 'classic'` is deliberate: an approval has no card chrome and
 * may be read on a terminal without diff colors, so `- old` / `+ new` must carry
 * the change on its own instead of relying on the bands alone.
 */
export function decisionProposalRows(
  diffs: readonly MetaDiff[],
  width: number,
  options: { readonly expanded: boolean },
): { readonly lines: string[]; readonly hidden: number; readonly oversized: boolean } {
  const indent = ' '
  const contentWidth = Math.max(1, width - indent.length)
  const rendered = renderDiffBlock(diffs, contentWidth, {
    viewMode: 'auto',
    indicatorMode: 'classic',
    splitMinWidth: PROPOSAL_SPLIT_MIN_WIDTH,
    wordWrap: true,
    expanded: options.expanded,
    collapsedLines: PROPOSAL_PREVIEW_ROWS,
    layoutWidth: width,
  })
  const lines: string[] = [decisionProposalLabel(diffs, width)]
  for (const row of rendered.lines) lines.push(fit(`${indent}${row}`, width))
  if (rendered.oversized) lines.push(fit(`${indent}${dim(t.muted('(diff too large to display)'))}`, width))
  if (rendered.hidden > 0) {
    lines.push(fit(`${indent}${dim(t.muted(`… ${rendered.hidden} more ${rendered.hidden === 1 ? 'line' : 'lines'}`))}`, width))
  }
  return { lines, hidden: rendered.hidden, oversized: rendered.oversized }
}

/** Bounded preview composition: optional separator, label and preview rows. */
function proposalLines(diffs: readonly MetaDiff[], width: number, gap: boolean): string[] {
  const rows = decisionProposalRows(diffs, width, { expanded: false }).lines
  return gap ? ['', ...rows] : rows
}

// ---------------------------------------------------------------------------
// Generic chooser

export interface SelectDialogOptions {
  title: string
  /** Native roster rows. Opaque `value`s are passed back untouched. */
  items: DecisionOption[]
  onSelect: (value: unknown) => void
  onCancel: () => void
  /**
   * Explicitly configured global turn cancellation (`app.interrupt`, no shipped
   * default). When omitted an explicit interrupt key closes this surface through
   * `onCancel`; the default `Ctrl+C` is the local cancel path either way.
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

/** Opt-in selection survival policy for a native roster refresh. */
export interface SelectItemsOptions {
  /**
   * Keep the row whose opaque `value` is identical (`Object.is`) to the row
   * under the cursor instead of preserving the raw index. A native catalog
   * refresh can insert or reorder rows, and an index-based survival would move
   * the highlight onto a different native option.
   *
   * Only exact value identity counts: a row that is merely deep-equal is a
   * different native option, so nothing is inferred from object structure. If
   * several rows share the value, the first native row wins; if the value is
   * gone the index is clamped as in the default policy. Neither branch selects,
   * submits or focuses anything.
   */
  preserveValue?: boolean
}

export class SelectDialog implements ComposerInteraction, Focusable {
  readonly modalSize: ModalSize = 'compact'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: SelectDialogOptions
  private readonly frame = new ModalFrame()
  /** Presentation only: unset keeps the historical bounded workspace overlay. */
  private layout: InteractionLayout | undefined
  private items: DecisionOption[]
  private loadingState: boolean
  private errorState: string | undefined
  private messageState: string | undefined
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

  /**
   * A workspace surface owns the viewport (its list is the reading surface). A
   * composer mount stops claiming it, so transcript paging stays available;
   * the dialog's own selection keys are still resolved locally.
   */
  get capturesViewportInput(): boolean {
    return this.layout?.placement !== 'composer'
  }

  /** Parent hook for focus changes; safe to call repeatedly. */
  cancelChord(): void {
    this.keymap.cancelChord()
  }

  invalidate(): void {
    this.frame.invalidate()
  }

  /**
   * Presentation-only placement (docs/COMPOSER-INTERACTION-CONTRACT.md).
   *
   * Idempotent: an unchanged layout touches nothing. It never reads data,
   * answers, focuses, replaces an editor or requests a frame. Old mouse targets
   * and presses belong to the previous geometry, so they are retired here — a
   * press recorded before the reflow can never resolve against the new rows.
   */
  setInteractionLayout(layout: InteractionLayout): void {
    const maxHeight = Number.isFinite(layout.maxHeight) ? Math.max(1, Math.floor(layout.maxHeight)) : 1
    if (this.layout !== undefined && this.layout.placement === layout.placement && this.layout.maxHeight === maxHeight) return
    this.layout = { placement: layout.placement, maxHeight }
    this.press = undefined
    this.hits = []
    this.frame.invalidate()
  }

  /** Rows this dialog paints at `width`; equals `render(width).length`. */
  measureRows(width: number): number {
    return this.plan(width).height
  }

  // --- asynchronous roster updates (no auto-select, no auto-submit) ------

  /**
   * Replace the native roster. By default the current selection survives by
   * index while that index still exists; with `{ preserveValue: true }` it
   * survives by the exact opaque `value` under the cursor, so a native
   * insert/reorder keeps the same row selected. Nothing is selected, submitted
   * or focused as a side effect of late data, and a press recorded against the
   * previous roster cannot fire against the new one.
   */
  setItems(items: readonly DecisionOption[], options: SelectItemsOptions = {}): void {
    const previous = this.items[this.index]
    this.revision += 1
    this.press = undefined
    this.items = [...items]
    this.loadingState = false
    const count = this.items.length
    if (count === 0) {
      this.index = 0
      return
    }
    if (options.preserveValue === true && previous !== undefined) {
      const exact = this.items.findIndex(item => Object.is(item.value, previous.value))
      if (exact >= 0) {
        this.index = exact
        return
      }
    }
    this.index = Math.min(this.index, count - 1)
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

  /** Replace native metadata feedback without changing selection, focus or editor state. */
  setMessage(message?: string, error = false): void {
    this.revision += 1
    const text = message === undefined || message.trim() === '' ? undefined : message
    this.messageState = error ? undefined : text
    this.errorState = error ? text : undefined
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
    // The single confirmation path for Enter, a digit and a mouse release. A
    // held native refresh may still paint the previous roster (so identity can
    // be preserved), but that roster is not a confirmed choice yet: while
    // loading, nothing is submitted and `isDone` stays false. Errors are not
    // part of this guard, because a visible failure can be informational.
    if (this.loadingState) return
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
    if (isCloseAction(action.id)) {
      this.cancel()
      return
    }
    // A composer mount leaves transcript paging to the parent; the chooser's
    // own selection keys stay local.
    if (this.layout?.placement === 'composer' && (action.id === 'list.page-up' || action.id === 'list.page-down')) return
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
        // A held native refresh keeps painting the previous roster so identity
        // can survive it, but those rows are not a confirmed choice yet: the
        // footer says so instead of offering a chip that silently does nothing.
        // A visible *error* stays informational and keep the chooser answerable.
        disabled: this.items.length === 0 || this.loadingState,
      },
      { id: 'cancel', label: 'Cancel', action: 'list.cancel', onActivate: () => this.cancel() },
    ]
  }

  private modalOptions(height: number): ModalFrameOptions {
    return {
      title: this.options.title,
      ownerKey: this.ownerKey(),
      ...((this.messageState ?? this.options.subtitle) === undefined ? {} : { subtitle: this.messageState ?? this.options.subtitle }),
      actions: this.actions(),
      onClose: () => this.cancel(),
      maxHeight: height,
      keymap: this.keymap,
    }
  }

  private body(bodyWidth: number, bodyHeight: number): BodyPaint {
    const header: BodyPaint = textPaint(this.errorState === undefined ? [] : errorLines(this.errorState, bodyWidth))
    if (this.items.length === 0) {
      const message = this.loadingState ? 'Loading options…' : 'No options are available.'
      return concatPaint([header, textPaint(noticeLines(message, bodyWidth))])
    }
    // Loading with a previous roster on screen is its own state: the rows stay
    // readable (identity survives the refresh) but they cannot be confirmed, so
    // the body names the pending refresh instead of hiding it behind a dead
    // footer chip.
    const status: BodyPaint = this.loadingState ? textPaint(noticeLines('Refreshing…', bodyWidth)) : textPaint([])
    const budget = Math.max(1, bodyHeight - header.lines.length - status.lines.length)
    const blocks = choiceBlocks(this.items, this.index, this.index, bodyWidth, true, false, new Set())
    return concatPaint([header, status, windowRowsWithHits(blocks, budget)])
  }

  /** Same plan `measureRows` reports: one geometry, no render-to-measure recursion. */
  private plan(width: number): PlannedFrame {
    const cap = this.layout?.maxHeight ?? workspaceHeight(this.tui, this.modalSize)
    return planFrame(
      this.frame,
      width,
      height => this.modalOptions(height),
      (bodyWidth, bodyHeight) => this.body(bodyWidth, bodyHeight),
      this.layout === undefined ? workspaceHeight(this.tui, this.modalSize) : undefined,
      cap,
      MIN_COMPOSER_ROWS,
    )
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const plan = this.plan(safeWidth)
    this.hits = plan.hits
    return this.frame.render(safeWidth, plan.lines, plan.options)
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
   * Explicitly configured global turn cancellation (`app.interrupt`, no shipped
   * default). The dialog never converts this into `onCancel` or a cancelled
   * answer; the parent runs `backend.cancel()` and the native decision closure
   * closes the surface. The default `Ctrl+C` is the local reject/cancel path.
   */
  onInterrupt?: () => void
  /** Shared keymap from the input subsystem. A default CC keymap is used when omitted. */
  keymap?: CcKeymap
  /**
   * Parent-owned full native detail request (`dialog.details`, Ctrl+O by
   * default). It is only offered when this native request already carries
   * `question.detail` or a usable pure `toolPresentation` proposal; the parent
   * mounts the read-only `DecisionDetailsDialog` over this retained decision
   * and keeps its selections, drafts and native option values.
   */
  onDetails?: (content: DecisionDetailContent) => void
}

export class DecisionDialog implements ComposerInteraction, Focusable {
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly request: DecisionRequest
  private readonly options: DecisionDialogOptions
  private readonly frame = new ModalFrame()
  /** Presentation only: unset keeps the historical bounded workspace overlay. */
  private layout: InteractionLayout | undefined
  private readonly questions: readonly Question[]
  private readonly states: QuestionState[]
  /** One markdown renderer for the current question's `detail` body. */
  private readonly detailMarkdown = new Markdown('', 0, 0, markdownTheme)
  private readonly approvalItems: readonly DecisionOption[]
  /**
   * Validated native proposed diff call view, read once from the immutable
   * request. `undefined` means "no preview": the approval body stays exactly
   * as it was before this seam existed. The original record is kept for the
   * full read-only detail overlay — the same validated presentation, never a
   * second projection of it.
   */
  private readonly proposalRecord: JsonRecord | undefined
  private readonly proposedDiffs: readonly MetaDiff[] | undefined
  /** Painted proposal rows keyed by width; dropped by `invalidate()`. */
  private proposalCache: { readonly width: number; readonly lines: readonly string[] } | undefined
  /** True when the native message already paints its own separator row. */
  private readonly hasMessage: boolean
  private approvalIndex = 0
  private tab = 0
  private reviewFocus = 0
  private hits: HitRange[] = []
  private press?: { key: string; owner: string }
  private focusedState = false
  private done = false
  private dismissedState = false
  private disposedState = false
  /** Disposes the lazy grammar repaint edge (see the constructor). */
  private unsubscribeHighlight: (() => void) | undefined

  constructor(tui: TUI, options: DecisionDialogOptions) {
    this.tui = tui
    this.options = options
    this.request = options.request
    this.keymap = options.keymap ?? createCcKeymap()
    this.questions = this.request.kind === 'question' ? (this.request.questions ?? []) : []
    this.approvalItems = this.request.kind === 'approval' ? (this.request.options ?? []) : []
    this.proposalRecord = this.request.kind === 'approval' ? decisionProposalRecord(this.request.toolPresentation) : undefined
    this.proposedDiffs = this.proposalRecord === undefined ? undefined : decisionProposalDiffs(this.proposalRecord)
    this.hasMessage = (this.request.message?.trim() ?? '') !== ''
    this.states = this.questions.map(() => ({
      focus: 0,
      selected: undefined,
      custom: false,
      customText: '',
      checked: new Set<number>(),
      answer: new InlineAnswer(tui, this.keymap),
    }))
    // `detailMarkdown` caches its own `(text, width)` lines, independently of the
    // transcript's block cache, and this dialog is not a Transcript child: the
    // view's ready edge cannot reach it. So the dialog subscribes itself, drops
    // only that renderer's lines and asks for one repaint. A failed load changes
    // nothing (the plain rows stay correct), and a disposed dialog neither
    // invalidates nor paints.
    this.unsubscribeHighlight = subscribeHighlightRuntime(event => {
      if (event.state !== 'ready' || this.disposedState) return
      this.detailMarkdown.invalidate()
      this.tui.requestRender()
    })
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
    this.unsubscribeHighlight?.()
    this.unsubscribeHighlight = undefined
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
    // The theme may have changed: the detail body styles markdown too, and the
    // proposal rows carry themed diff bands.
    this.frame.invalidate()
    this.detailMarkdown.invalidate()
    this.proposalCache = undefined
    for (const state of this.states) state.answer.invalidate()
  }

  /**
   * A workspace surface owns the viewport (its options are the reading
   * surface). A composer mount stops claiming it, so transcript paging stays
   * available; the dialog's own selection keys are still resolved locally.
   */
  get capturesViewportInput(): boolean {
    return this.layout?.placement !== 'composer'
  }

  /**
   * Presentation-only placement (docs/COMPOSER-INTERACTION-CONTRACT.md).
   *
   * Idempotent: an unchanged layout touches nothing. It never reads native
   * data, answers, focuses, replaces an editor or requests a frame. Old mouse
   * targets and presses belong to the previous geometry, so they are retired
   * here — a press recorded before the reflow can never answer a different row.
   */
  setInteractionLayout(layout: InteractionLayout): void {
    const maxHeight = Number.isFinite(layout.maxHeight) ? Math.max(1, Math.floor(layout.maxHeight)) : 1
    if (this.layout !== undefined && this.layout.placement === layout.placement && this.layout.maxHeight === maxHeight) return
    this.layout = { placement: layout.placement, maxHeight }
    this.press = undefined
    this.hits = []
    this.frame.invalidate()
  }

  /** Rows this dialog paints at `width`; equals `render(width).length`. */
  measureRows(width: number): number {
    return this.plan(width).height
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
  // Full native detail (read-only, parent-mounted)

  /**
   * The native detail this request already carries, if any.
   *
   * - approval: the validated pure `presentCall` diff record (never a result,
   *   never a guessed call);
   * - question: that question's own `detail` markdown (the plan review body).
   *
   * `undefined` means there is nothing honest to open, so no detail action is
   * offered and `onDetails` is never called.
   */
  private detailContent(): DecisionDetailContent | undefined {
    if (this.isApproval) {
      const record = this.proposalRecord
      return record === undefined ? undefined : { kind: 'proposal', title: 'Proposed change', presentation: record }
    }
    if (this.onReview) return undefined
    const question = this.questions[this.tab]
    if (question === undefined) return undefined
    const detail = questionDetail(question)
    if (detail === undefined) return undefined
    const header = question.header?.trim() ?? ''
    return { kind: 'markdown', title: header === '' ? this.dialogTitle() : header, text: detail }
  }

  private detailsAvailable(): boolean {
    return this.options.onDetails !== undefined && this.detailContent() !== undefined
  }

  /**
   * Ask the parent to mount the full read-only detail over this retained
   * decision. No answer, focus, selection, draft or native value changes here.
   */
  private openDetails(): void {
    if (this.done || this.disposedState) return
    const onDetails = this.options.onDetails
    const content = this.detailContent()
    if (onDetails === undefined || content === undefined) return
    onDetails(content)
  }

  // -------------------------------------------------------------------------
  // Input

  /** Modal action plus this dialog's own `dialog.details` (input-owned key). */
  private resolveAction(raw: string): ResolvedModalAction | undefined {
    return modalAction(this.keymap, raw, ['dialog.details'])
  }

  /** A composer mount leaves transcript paging to the parent. */
  private pagingKey(actionId: string): boolean {
    return this.layout?.placement === 'composer' && (actionId === 'list.page-up' || actionId === 'list.page-down')
  }

  /**
   * A configured local cancel key inside the custom-answer field.
   *
   * The editor layer carries no Ctrl+C cancel binding any more, and the root
   * `app.clear` binding is deliberately not re-aliased here: a dialog must never
   * clear the hidden root draft from inside a decision, and a phantom dismissal
   * for a key the user actually moved is worse than an inert key. So the dialog
   * maps the *actual configured* local cancel bindings (`list.cancel`,
   * `dialog.cancel`, `app.cancel`) onto the same dismiss path the rest of the
   * surface uses, and only when the editor layer does not claim that key itself
   * (a remapped cancel that collides with an edit key keeps the edit) and no
   * explicit `app.interrupt` intent owns it.
   */
  private answerCancelKey(raw: string): boolean {
    if (this.keymap.isPendingChord()) return false
    if (boundToKey(this.keymap, 'app.interrupt', raw)) return false
    if (!CANCEL_ACTIONS.some(id => boundToKey(this.keymap, id, raw))) return false
    return !editorClaimsKey(this.keymap, raw)
  }

  /** True when the key is the configured `dialog.details` binding (read-only lookahead). */
  private detailsKey(raw: string): boolean {
    return this.detailsAvailable() && boundToKey(this.keymap, 'dialog.details', raw)
  }

  handleInput(raw: string): void {
    if (this.done || this.disposedState) return
    // A bracketed paste owns its bytes; it is never an interrupt or a decision
    // answer, so it goes straight to the single editor state.
    if (this.editing() && this.state.answer.editor.isPasting()) {
      this.editorKey(raw)
      return
    }
    // While the answer field owns input the dialog only looks ahead for the two
    // app-level keys it must keep local; every editing key stays with the one
    // CcEditor state (dialog actions are never double-resolved).
    if (this.editing() && this.answerCancelKey(raw)) {
      this.dismissQuestion()
      return
    }
    if (this.editing() && this.detailsKey(raw)) {
      this.openDetails()
      return
    }
    const action = this.resolveAction(raw)
    if (action !== undefined && isInterruptAction(action.id)) {
      this.interrupt()
      return
    }
    if (action !== undefined && action.id === 'dialog.details') {
      this.openDetails()
      return
    }
    if (action !== undefined && this.pagingKey(action.id)) return
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
    if (isCloseAction(action.id)) {
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
    if (isCloseAction(action.id)) {
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
      if (isCloseAction(action.id)) {
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

  /**
   * The native-detail chip is only painted when this request actually carries
   * readable native content, and it only asks the parent to mount the read-only
   * overlay: it never answers, executes or fabricates an applied change.
   */
  private detailsAction(): ModalAction | undefined {
    if (!this.detailsAvailable()) return undefined
    return { id: 'details', label: 'Details', action: 'dialog.details', onActivate: () => this.openDetails() }
  }

  private actions(): ModalAction[] {
    const details = this.detailsAction()
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
        ...(details === undefined ? [] : [details]),
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
      ...(details === undefined ? [] : [details]),
    ]
  }

  private modalOptions(height: number): ModalFrameOptions {
    return {
      title: this.dialogTitle(),
      ownerKey: this.ownerKey(),
      actions: this.actions(),
      onClose: () => this.closeRoute(),
      maxHeight: height,
      keymap: this.keymap,
    }
  }

  /**
   * The native request message, wrapped in the body (the frame subtitle is a
   * single truncated line, which would silently drop native text).
   */
  private messagePaint(width: number): BodyPaint {
    const message = sanitize(this.request.message?.trim() ?? '')
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
    const hintRows = hint === '' ? 0 : 2
    const optionRows = blocks.reduce((sum, block) => sum + block.lines.length, 0)
    const optionMinimum = Math.min(2, Math.max(1, optionRows))
    // Degradation order (docs/APPROVAL-PROPOSAL.md): the native message, then
    // the options' floor, then the hint group, and only the remainder becomes the
    // bounded proposal preview. The hint is therefore dropped *before* the
    // options lose their two-row floor: a permission decision may never become
    // less visible because a prose hint or a proposal preview wanted the rows.
    // A missing or malformed native presentation paints nothing here (no error,
    // no marker).
    const afterMessage = bodyHeight - message.lines.length
    const proposalRoom = afterMessage - optionMinimum - hintRows
    const proposal = this.proposalPaint(bodyWidth, proposalRoom)
    const hintCost = afterMessage - optionMinimum - proposal.lines.length >= hintRows ? hintRows : 0
    const budget = Math.max(1, afterMessage - proposal.lines.length - hintCost)
    return concatPaint([
      message,
      proposal,
      windowRowsWithHits(blocks, budget),
      ...(hintCost === 0 ? [] : [textPaint(['']), textPaint([' ' + hint])]),
    ])
  }

  /**
   * Bounded native proposal preview. `room` is the exact number of body rows the
   * approval can spare; nothing is painted when the preview does not exist or
   * there is no row left for it. A clipped preview keeps the label first and
   * ends with an honest `… N more` marker instead of a silent cut.
   */
  private proposalPaint(width: number, room: number): BodyPaint {
    if (this.proposedDiffs === undefined || room <= 0) return textPaint([])
    const full = this.proposalLines(width)
    if (full.length === 0) return textPaint([])
    // The message paint already ends with its own separator row, so this preview
    // only contributes one when the request has no message at all. The heading
    // sits after that optional gap and is the first row that must survive.
    const head = this.hasMessage ? 0 : 1
    if (room <= head) return textPaint([])
    if (room === head + 1) return textPaint([full[head]!])
    if (full.length <= room) return textPaint(full)
    const kept = room - 1
    const hidden = full.length - kept
    return textPaint([
      ...full.slice(0, kept),
      fit(` ${dim(t.muted(`… ${hidden} more proposal ${hidden === 1 ? 'line' : 'lines'}`))}`, Math.max(1, width)),
    ])
  }

  /** Cached rendered-with-theme proposal rows (rebuild happens on invalidate). */
  private proposalLines(width: number): readonly string[] {
    const diffs = this.proposedDiffs
    if (diffs === undefined) return []
    const safeWidth = Math.max(1, Math.floor(width))
    if (this.proposalCache?.width !== safeWidth) {
      this.proposalCache = { width: safeWidth, lines: proposalLines(diffs, safeWidth, !this.hasMessage) }
    }
    return this.proposalCache.lines
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
    const titleLines = wrap(sanitize(question.question), Math.max(4, bodyWidth)).map(line => bold(t.text(line)))
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
    const detail = sanitize(questionDetail(question) ?? '')
    if (detail === '') return []
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
      const label = sanitize(question.header !== undefined && question.header !== '' ? question.header : `Q${index + 1}`)
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
      const labelText = sanitize(option.label)
      const label = wrap(labelText, Math.max(4, width - indent.length))
      const lines = [`${pointer(focused)} ${numberLabel(index + 1, numberWidth)} ${box(state.checked.has(index))} ${style(label[0] ?? '')}`]
      for (const line of label.slice(1)) lines.push(indent + style(line))
      const description = option.description === undefined ? '' : sanitize(option.description)
      if (description.trim() !== '') {
        for (const line of wrap(description, Math.max(4, width - indent.length))) lines.push(indent + cc.inactive(line))
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
    const rawPreview = option?.preview
    if (rawPreview === undefined || rawPreview.trim() === '') return []
    const preview = sanitize(rawPreview)
    if (preview.trim() === '') return []
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
      const text = sanitize(Array.isArray(answer) ? answer.join(', ') : answer)
      const lines = wrap(sanitize(question.question), Math.max(4, width - 3))
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

  /** Same plan `measureRows` reports: one geometry, no render-to-measure recursion. */
  private plan(width: number): PlannedFrame {
    const cap = this.layout?.maxHeight ?? workspaceHeight(this.tui, this.modalSize)
    return planFrame(
      this.frame,
      width,
      height => this.modalOptions(height),
      (bodyWidth, bodyHeight) =>
        this.isApproval ? this.renderApproval(bodyWidth, bodyHeight) : this.renderQuestions(bodyWidth, bodyHeight),
      this.layout === undefined ? workspaceHeight(this.tui, this.modalSize) : undefined,
      cap,
      MIN_COMPOSER_ROWS,
    )
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const plan = this.plan(safeWidth)
    this.hits = plan.hits
    return this.frame.render(safeWidth, plan.lines, plan.options)
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