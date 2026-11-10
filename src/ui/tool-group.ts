/**
 * Tool grouping — a pure display projection plus the group component.
 *
 * DSH owns which calls happened and in what order (the store keeps every
 * `tool/call` and `tool/result` where the durable log put it). This module only
 * derives a *view* over that ordered list, in which consecutive tool calls are
 * collapsed into one block:
 *
 *   ● Bash: 2 running · 1 done · ctrl+o to expand
 *    ├ ◐ Bash npm test
 *    ├ ✓ Bash npm run build · 1.4s
 *    └ ○ Bash git status
 *
 * Rules — all derived from the declared items, never from arrival time:
 *   - two tool calls are the minimum for a group;
 *   - diff cards and file-mutating tools (edit/write/apply_patch) never join:
 *     their content has to stay visible as its own card;
 *   - an assistant/attempt item that paints nothing (no visible text, no visible
 *     reasoning, no requested tool names) can be crossed; anything that paints a
 *     row — including the `✻ Thought (hidden)` placeholder — breaks the group, so
 *     a hidden reasoning placeholder is never swallowed by a group;
 *   - user turns, notices, todos and every other non-tool item break it;
 *   - a *known* different turn number breaks it; a step change inside one turn
 *     does not, because DSH may settle several steps of one turn;
 *   - declaration order is kept: nothing is reordered by completion time, and a
 *     group never claims its calls ran in parallel;
 *   - `groupTools=false` restores one card per call (no group ever forms).
 *
 * The group is a *host*: it never re-implements a tool card. Collapsed rows use
 * the shared `getToolSummary` (same wording as a single card row) plus the call's
 * real status glyph, and an expanded group renders the real child blocks,
 * prefixing — never filtering — every child row so `handleMouse` can map a frame
 * row back onto the child that painted it (`dispatchToChild`). Child hitboxes
 * therefore keep working through the group.
 *
 * Pointer policy:
 *   - the header is a small control: it claims the press, so a repaint between
 *     press and release cannot move the click onto another row;
 *   - while the group is OPEN, its body is a click-only collapse area
 *     (`claimPress: false`), so text selection and drag stay native;
 *   - while it is COLLAPSED, member rows are plain text and own no hitbox: they
 *     advertise no detail view and never toggle anything.
 *
 * Expansion state is the shared, module-level disclosure map
 * (`tool-expansion.ts`): the group uses `group:<firstCallId>` and hands its
 * members a {@link ToolGroupContext} instead of writing per-card overrides, so a
 * grouped card is never counted as an independent disclosure. Contexts are
 * released ownership-aware ({@link releaseToolGroupContext}), so a group that
 * loses a member cannot clear a context another group already installed.
 * Nothing here is persisted and no timer is armed: a collapsed row prints the
 * duration DSH measured for a settled call and never fabricates elapsed time
 * while running.
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { ToolTranscriptItem, TranscriptItem } from '../state/transcript.ts'
import { type ItemBlock, thinkingRunsOf, type TranscriptViewOptions } from './blocks.ts'
import { dispatchToChild, HitboxRegistry, HoverOwnership, hoverControlAt, hoverRowSlot, type MouseHitbox } from './mouse.ts'
import { countCacheKeyBuild } from './render-counters.ts'
import { fit, visibleWidth } from './text.ts'
import { t } from './theme.ts'
import { requestToolExpansion, toolDisclosureExpanded, toolExpansionRevision, toolGroupExpansionKey } from './tool-expansion.ts'
import { formatToolDuration, getToolSummary, isTerminalTool, toolDisplayName } from './tool-io.ts'
import type { ToolGroupContext } from './tool-view.ts'

// ---------------------------------------------------------------------------
// Projection (pure; no store, terminal or timer involvement)

/** Tools whose card is a file mutation: never hidden behind a group summary. */
export const NON_GROUPABLE_TOOL_NAMES: ReadonlySet<string> = new Set(['edit', 'write', 'apply_patch'])

const DOT = '●'
const HOLLOW = '◌'
/** Placement token of this group's own header control (row 0). */
const HEADER_SLOT = 'header'
/** The header is the group's first painted row; no other row is a host control. */
const HEADER_ROW = 0
const BRANCH = { more: '├ ', last: '└ ', moreBody: '│ ', lastBody: '  ' } as const
const GLYPH_WIDTH = 2

/**
 * Per-call status glyph of a collapsed row.
 *
 * `✓` means DSH published a `tool/result` without a failure marker — never that
 * the command exited 0 (the exit code lives in the card's own output). A call
 * without a result stays visibly unresolved (`○` proposed, `◐` running,
 * `◌` unknown) and is never drawn as a success.
 */
export function toolStatusGlyph(item: ToolTranscriptItem): string {
  switch (item.status) {
    case 'done': return t.green('✓')
    case 'error': return t.redSoft('✗')
    case 'running': return t.accent('◐')
    case 'proposed': return t.muted('○')
    case 'unknown':
    default: return t.muted('◌')
  }
}

/** One frame-level node of the projection, in declaration order. */
export type TranscriptNode =
  | { readonly kind: 'item'; readonly item: TranscriptItem }
  | {
      readonly kind: 'group'
      /** First member: the group's stable identity and expansion anchor. */
      readonly anchor: ToolTranscriptItem
      readonly members: readonly ToolTranscriptItem[]
    }

export interface ToolGroupPlanOptions {
  /** `Settings.groupTools`; `false` restores one card per call. */
  readonly groupTools: boolean
  /** `Settings.showThinking` (only the hidden placeholder decision depends on it). */
  readonly showThinking: boolean
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * Does this call carry a native file diff?
 *
 * Presentation-only: the forwarded `presentation` (native `presentCall` /
 * `presentResult`) is read for a `diff` card, and the opaque `tool/result` meta
 * for `diffs`. Nothing here decides what the tool did; a diff simply must not be
 * folded away inside a group.
 */
export function toolItemCarriesDiff(item: ToolTranscriptItem): boolean {
  const presentation = asRecord(item.presentation)
  for (const half of [asRecord(presentation?.call), asRecord(presentation?.result)]) {
    const card = half?.card
    if (card === 'diff') return true
    if (Array.isArray(half?.diffs) && half.diffs.length > 0) return true
  }
  const meta = asRecord(item.meta)
  return Array.isArray(meta?.diffs) && meta.diffs.length > 0
}

/** Can this tool call become a group member? */
export function isGroupableToolItem(item: ToolTranscriptItem): boolean {
  if (NON_GROUPABLE_TOOL_NAMES.has(item.name.toLowerCase())) return false
  return !toolItemCarriesDiff(item)
}

/**
 * Does this non-tool item paint nothing at all, so a group may span it?
 *
 * This mirrors what the item blocks actually print. `showThinking` deliberately
 * does not matter: with reasoning hidden the block still prints the
 * `✻ Thought (hidden)` placeholder row, which is visible chrome the group must
 * not swallow.
 */
export function isTransparentItem(item: TranscriptItem): boolean {
  const visibleThinking = (entry: { thinking: string; thinkingRuns?: readonly { text: string }[] }): boolean =>
    thinkingRunsOf(entry).length > 0 || entry.thinking.trim() !== ''
  switch (item.kind) {
    case 'assistant':
      return item.text.trim() === '' && !item.interrupted && !visibleThinking(item)
    case 'attempt':
      // A settled attempt always prints its label row.
      if (item.status !== 'streaming' && item.status !== 'committing') return false
      return item.text.trim() === '' && item.toolNames.length === 0 && !visibleThinking(item)
    default:
      return false
  }
}

/**
 * Derive the frame's nodes from the store's declared item order.
 *
 * Pure: same items + same options always give the same nodes, and nothing is
 * sorted, merged across a boundary or dropped except items that paint nothing.
 */
export function planTranscriptNodes(
  items: readonly TranscriptItem[],
  options: ToolGroupPlanOptions,
): readonly TranscriptNode[] {
  if (!options.groupTools) return items.map(item => ({ kind: 'item', item }) as const)
  const nodes: TranscriptNode[] = []
  let run: ToolTranscriptItem[] = []
  let runTurn: number | undefined
  const flush = (): void => {
    if (run.length > 1) nodes.push({ kind: 'group', anchor: run[0]!, members: run })
    else for (const item of run) nodes.push({ kind: 'item', item })
    run = []
    runTurn = undefined
  }
  for (const item of items) {
    if (item.kind === 'tool') {
      if (!isGroupableToolItem(item)) {
        flush()
        nodes.push({ kind: 'item', item })
        continue
      }
      // Only a *known* turn change is a break; an item without a turn number has
      // no boundary to report and must not invent one.
      if (run.length > 0 && item.turn !== undefined && runTurn !== undefined && item.turn !== runTurn) flush()
      run.push(item)
      runTurn = item.turn ?? runTurn
      continue
    }
    if (isTransparentItem(item)) continue
    flush()
    nodes.push({ kind: 'item', item })
  }
  flush()
  return nodes
}

// ---------------------------------------------------------------------------
// Group header wording

export interface ToolGroupCounts {
  readonly proposed: number
  readonly running: number
  readonly done: number
  readonly error: number
  readonly unknown: number
}

/** Per-status counts. `unknown` stays its own bucket: a card without a result is not "running". */
export function toolGroupCounts(items: readonly ToolTranscriptItem[]): ToolGroupCounts {
  let proposed = 0
  let running = 0
  let done = 0
  let error = 0
  let unknown = 0
  for (const item of items) {
    switch (item.status) {
      case 'proposed': proposed += 1; break
      case 'running': running += 1; break
      case 'done': done += 1; break
      case 'error': error += 1; break
      case 'unknown': unknown += 1; break
    }
  }
  return { proposed, running, done, error, unknown }
}

/** Display label of a group: the shared tool name, or `Multiple Tools`. */
export function toolGroupLabel(items: readonly ToolTranscriptItem[]): string {
  const names = new Set(items.map(item => toolDisplayName(item.name)))
  return names.size === 1 ? [...names][0] ?? 'Multiple Tools' : 'Multiple Tools'
}

/** `Bash×2, Read×1` in declaration order (no completion-time sorting). */
export function toolGroupNameList(items: readonly ToolTranscriptItem[]): string {
  const counts = new Map<string, number>()
  for (const item of items) {
    const label = toolDisplayName(item.name)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts].map(([label, count]) => `${label}×${count}`).join(', ')
}

/**
 * Trailing ` · 1.4s` of a collapsed member row.
 *
 * `ToolSummaryInfo.durationMs` is the shared, name/inline-card-derived shell
 * duration (the same value the single card prints) and only exists once DSH
 * measured a settled call — this never fabricates elapsed time for a running
 * one, so no per-card or display timer is needed.
 *
 * A recorded `0ms` IS a reading: DSH derives `toolMs` as
 * `max(0, settledAt - startedAt)` and its durable clocks may legally share one
 * instant (`eventClock` keeps a real `0`), so a same-instant call/result pair
 * measures zero. The single card, the details status line and this tail must
 * therefore agree and print `0ms` instead of silently dropping the measurement.
 * Only a missing (no measurement) or impossible (non-finite/negative) value
 * prints nothing.
 */
export function durationTail(durationMs: number | undefined): string {
  if (durationMs === undefined) return ''
  // Not a measurement: no finite reading, or a clock that ran backwards. A real
  // `0` stays visible — hiding it would disagree with the card and the status
  // line, which both render `0ms` for the same item.
  if (!Number.isFinite(durationMs) || durationMs < 0) return ''
  const duration = formatToolDuration(durationMs)
  return duration === '' ? '' : ` · ${duration}`
}

// ---------------------------------------------------------------------------
// Group component

/** A group member: the DSH-backed item plus the cached card component for it. */
export interface ToolGroupMember {
  readonly item: ToolTranscriptItem
  readonly block: ItemBlock
}

/** Row span of one expanded child inside the group's own frame. */
export interface ToolGroupRowSpan {
  readonly block: ItemBlock
  readonly startRow: number
  readonly endRow: number
  /** Columns the child's own coordinate space is shifted right by. */
  readonly xOffset: number
}

const PREFIX_WIDTH = 2

/**
 * Which group currently owns a card's disclosure context.
 *
 * Exactly one group may own a card, and only the owner may release it. Without
 * this, a group that loses a member (or its anchor) would clear a context a
 * neighbouring group already installed in the same frame — the classic ordering
 * bug when a merged group re-claims children released by the group beside it.
 *
 * Every tool-group-shaped host claims through this one map ({@link ToolGroupBlock}
 * and the mixed {@link ActivityGroupBlock}), so two hosts can never both believe
 * they own the same card.
 */
const groupOwner = new WeakMap<ItemBlock, object>()

/** Release a card's group context when `owner` owns it (any owner when omitted). */
function releaseGroupContext(block: ItemBlock, owner?: object): void {
  const current = groupOwner.get(block)
  if (current === undefined) return
  if (owner !== undefined && current !== owner) return
  groupOwner.delete(block)
  block.setToolGroupContext?.(undefined)
}

/**
 * Install `context` on a card as `owner`'s grouped child.
 *
 * Claiming is what makes a grouped card delegate its expansion to the host
 * instead of counting as an independent disclosure; `owner` is the only one
 * allowed to release it again.
 */
export function claimToolGroupContext(block: ItemBlock, owner: object, context: ToolGroupContext): void {
  groupOwner.set(block, owner)
  block.setToolGroupContext?.(context)
}

/**
 * Release a card's group context from the outside (the view ungroups a card into
 * a standalone row). Ownership-aware: a card still claimed by a group this frame
 * keeps that group's context.
 */
export function releaseToolGroupContext(block: ItemBlock, owner?: object): void {
  releaseGroupContext(block, owner)
}

/**
 * One collapsed/expanded tool group.
 *
 * Identity is the *first* member's call id, so the component (and its cache)
 * survives members joining, updating or leaving; counter-based ids are never
 * used as identity.
 */
export class ToolGroupBlock implements Component {
  /** Anchor item id — the row span identity this block reports to the view. */
  readonly itemId: string
  readonly kind: 'tool' = 'tool'
  /** Shared disclosure key (`group:<firstCallId>`). */
  readonly key: string
  private readonly flags: TranscriptViewOptions
  private readonly registry = new HitboxRegistry()
  /**
   * The one hover target inside this group: the header (this block) or the
   * expanded child card whose row the pointer is on. Motion only reaches one of
   * them per event, so the previously hovered target must be released here or a
   * child card keeps a blue hint after the pointer moved to its sibling/header.
   */
  private readonly hover = new HoverOwnership()
  private members: readonly ToolGroupMember[] = []
  private rows: ToolGroupRowSpan[] = []
  private context: ToolGroupContext | undefined
  private hoveredHeader = false
  private cwd = ''
  private disposed = false
  private cache: {
    width: number
    key: string
    lines: string[]
    paints: readonly (readonly string[])[]
    /** Disclosure generation this frame was composed from. */
    expansions: number
    /** Child paint generations this frame was composed from (expanded only). */
    readonly memberPaints: readonly number[]
  } | undefined
  private frameBoxes: MouseHitbox[] = []

  constructor(anchor: ToolTranscriptItem, flags: TranscriptViewOptions) {
    this.itemId = anchor.id
    this.key = toolGroupExpansionKey(anchor.callId)
    this.flags = flags
  }

  /** Read-only projection: no module-level disclosure is read or written. */
  private get readonly(): boolean {
    return this.flags.readonlyDisclosure === true
  }

  /** Group expansion state, shared with the whole transcript (live views only). */
  get expanded(): boolean {
    return toolDisclosureExpanded(this.flags, this.key)
  }

  get memberCount(): number {
    return this.members.length
  }

  get memberItems(): readonly ToolTranscriptItem[] {
    return this.members.map(member => member.item)
  }

  /** Child row spans of the last rendered frame (diagnostics/tests). */
  get rowSpans(): readonly ToolGroupRowSpan[] {
    return this.rows
  }

  /** Hitboxes declared by the last render (diagnostics/tests). */
  get hitboxes(): readonly MouseHitbox[] {
    return this.frameBoxes
  }

  /**
   * Placement this group claimed for itself by the last motion (diagnostics).
   *
   * `header` only while the pointer is really on the header row; member rows of
   * a collapsed group adopt nothing.
   */
  get hoverSlot(): string | undefined {
    return this.hover.current === this ? this.hover.placement : undefined
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Diagnostics/tests: cache key of the last composed frame (undefined = rebuilt next time). */
  get frameCacheKey(): string | undefined {
    return this.cache?.key
  }

  setCwd(cwd: string): void {
    if (cwd === this.cwd) return
    this.cwd = cwd
    this.cache = undefined
  }

  /**
   * Replace the member list for this frame.
   *
   * An unchanged member list keeps the composed frame: the group must not clear
   * its cache on every render, or a missing preference in the frame key would go
   * unnoticed instead of invalidating the frame. A card that leaves the group
   * gets its group context removed immediately, because from then on it owns its
   * own disclosure.
   */
  setMembers(members: readonly ToolGroupMember[]): void {
    const unchanged = members.length === this.members.length && members.every((member, index) => {
      const previous = this.members[index]
      return previous !== undefined
        && previous.block === member.block
        && previous.item.id === member.item.id
        && previous.item.version === member.item.version
        && previous.item.status === member.item.status
    })
    const previous = this.members
    this.members = [...members]
    if (!unchanged) this.cache = undefined
    for (const member of previous) {
      if (this.members.some(entry => entry.block === member.block)) continue
      // Only this group may release it; another group may already own it.
      releaseGroupContext(member.block, this)
    }
    for (const member of this.members) claimToolGroupContext(member.block, this, this.groupContext())
  }

  private groupContext(): ToolGroupContext {
    this.context ??= {
      key: this.key,
      isExpanded: () => this.expanded,
      collapse: () => { this.toggle() },
    }
    return this.context
  }

  /** Flip the whole group through the shared disclosure helper (viewport anchor first). */
  toggle(): void {
    if (this.readonly) return
    requestToolExpansion(this.flags, this.key, !this.expanded)
  }

  invalidate(): void {
    this.cache = undefined
    // Deliberately does not touch the registry: an ordinary repaint must keep
    // the press pin so a click whose rows moved between frames still lands.
  }

  /**
   * Drop frame-local state: hitboxes, the pinned press target and the children's
   * group contexts. Called when this group leaves the view or the session
   * changes — never on an ordinary repaint (that would lose a pressed row).
   */
  clearMouse(): void {
    this.hover.release()
    this.registry.clear()
    this.frameBoxes = []
    this.rows = []
    for (const member of this.members) releaseGroupContext(member.block, this)
  }

  /**
   * Teardown for the view's `dispose()`: release every child context and forget
   * the frame. Idempotent and inert afterwards — no render, no repaint request,
   * no touch of any other component's focus or press state.
   */
  dispose(): void {
    if (this.disposed) return
    this.clearMouse()
    this.disposed = true
    this.cache = undefined
    this.members = []
  }

  private setHeaderHover(entering: boolean): void {
    if (this.disposed || this.hoveredHeader === entering) return
    this.hoveredHeader = entering
    this.cache = undefined
    this.flags.onRenderRequest?.()
  }

  // --- frame -----------------------------------------------------------------

  /**
   * Cache key of the composed frame.
   *
   * It carries every Tools display preference the child cards read (their own
   * caches are keyed by the same list), the hint labels, the screen mode, the
   * cwd, the hover and the live duration, so changing e.g. the expanded-output
   * preview or a diff preference changes this key and the group repaints
   * immediately. Expanded frames additionally compare the children's painted
   * lines by reference (see `render`), which is what makes hover inside an
   * expanded child show up.
   */
  private frameKey(width: number, expanded: boolean): string {
    const members = this.members.map(member => `${member.item.id}@${member.item.version}:${member.item.status}`).join(',')
    return [
      width,
      expanded ? 'open' : 'closed',
      members,
      this.liveStamp(),
      this.cwd,
      this.flags.groupTools === false ? 'single' : 'group',
      this.flags.expandTools ? 'expand' : 'fold',
      this.flags.expandedInputMaxLines ?? 5,
      this.flags.expandedOutputMaxLines ?? 10,
      this.flags.toolLabelClip ?? 0,
      this.flags.diffViewMode ?? 'auto',
      this.flags.diffIndicatorMode ?? 'bars',
      this.flags.diffSplitMinWidth ?? 120,
      this.flags.editDiffCollapsedLines ?? 24,
      this.flags.writeDiffCollapsedLines ?? 0,
      this.flags.diffWordWrap === false ? 'nowrap' : 'wrap',
      this.flags.hints?.expand ?? '',
      this.flags.hints?.toolsDetails ?? '',
      typeof this.flags.onToolDetails === 'function' ? 'details' : '',
      this.flags.screen ?? 'inline',
      this.hoveredHeader ? 'hover' : 'rest',
    ].join('|')
  }

  /**
   * Clock stamp of the frame while some child card is still measuring a running
   * command.
   *
   * A grouped card owns its own `· 1.2s` row; without the stamp the group's
   * composed frame would be returned from cache and freeze that number. The
   * stamp only changes when the parent repaints (a display timer it already
   * owns), so no timer is created here.
   */
  private liveStamp(): string {
    const live = this.members.some(member =>
      isTerminalTool(member.item)
      && (member.item.status === 'running' || member.item.status === 'proposed')
      && member.item.startedAt !== undefined)
    return live ? String((this.flags.now ?? Date.now)()) : ''
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const safeWidth = Math.max(1, Math.floor(width))
    // Fast path: a group with no running member has no key input that can change
    // between paints without `invalidate()`/`setMembers` — hover, preferences,
    // cwd, member versions and width all reach this cache, a disclosure flip
    // moves the shared generation, and an expanded frame also requires every
    // child's own paint generation to be unchanged (a hovered child repaints
    // itself but not this group's cache).
    if (this.liveStamp() === '' && this.cache !== undefined && this.cache.width === safeWidth
      && this.cache.expansions === toolExpansionRevision() && this.membersUnchanged()) {
      return this.cache.lines
    }
    const expanded = this.expanded
    // Children are always rendered first in expanded mode: their own cache makes
    // it cheap, and the returned line arrays are the identity that tells this
    // group whether anything it composed has actually changed.
    const paints = expanded ? this.members.map(member => member.block.render(this.childWidth(safeWidth))) : []
    countCacheKeyBuild()
    const key = this.frameKey(safeWidth, expanded)
    if (this.cache !== undefined && this.cache.key === key && sameLines(this.cache.paints, paints)) {
      this.syncMouse(expanded)
      return this.cache.lines
    }
    const lines = expanded ? this.buildExpanded(safeWidth, paints) : this.buildCollapsed(safeWidth)
    const fitted = lines.map(line => fit(line, safeWidth))
    this.cache = { width: safeWidth, key, lines: fitted, paints, expansions: toolExpansionRevision(), memberPaints: this.memberPaints(expanded) }
    this.syncMouse(expanded)
    return fitted
  }

  private childWidth(width: number): number {
    return Math.max(1, width - PREFIX_WIDTH)
  }

  /** Paint generation of every member block (empty while collapsed). */
  private memberPaints(expanded: boolean): readonly number[] {
    return expanded ? this.members.map(member => member.block.paintRevision ?? 0) : []
  }

  /** Do the members still paint the frame this cache was composed from? */
  private membersUnchanged(): boolean {
    const cached = this.cache
    if (cached === undefined) return false
    const current = this.members
    if (cached.memberPaints.length !== (this.expanded ? current.length : 0)) return false
    for (let index = 0; index < cached.memberPaints.length; index += 1) {
      if ((current[index]?.block.paintRevision ?? 0) !== cached.memberPaints[index]) return false
    }
    return true
  }

  private syncMouse(expanded: boolean): void {
    const height = this.cache?.lines.length ?? 0
    const boxes: MouseHitbox[] = []
    if (height > 0 && !this.readonly) {
      // Small control: the header claims the press so a repaint between press
      // and release cannot move the click onto another row.
      boxes.push({
        id: `${this.key}#header`,
        startRow: 0,
        endRow: 0,
        onClick: () => { this.toggle() },
        onHover: (entering: boolean) => { this.setHeaderHover(entering) },
      })
      // Only an OPEN group has a click-only collapse area. A collapsed member row
      // is plain text: it advertises no detail view and a click on it must stay
      // native (selection/drag), exactly like any other transcript text.
      if (expanded && height > 1) {
        boxes.push({
          id: `${this.key}#body`,
          startRow: 1,
          endRow: height - 1,
          claimPress: false,
          onClick: () => { this.toggle() },
        })
      }
    }
    this.registry.sync(boxes)
    this.frameBoxes = boxes
    // A frame that no longer paints the hovered child at the row it was entered
    // in released its hitbox: the hint goes back to neutral.
    this.hover.retain([
      { component: this, slot: HEADER_SLOT },
      ...this.rows.map(row => ({ component: row.block, slot: hoverRowSlot(row.startRow) })),
    ])
  }

  private buildCollapsed(width: number): string[] {
    this.rows = []
    const lines = [this.headerLine(width, false)]
    const last = this.members.length - 1
    this.members.forEach((member, index) => {
      lines.push(this.summaryRow(member.item, index === last, width))
    })
    return lines
  }

  /**
   * Expanded frame: every child's real paint, prefixed with the tree glyph and
   * never filtered. The child's first row already carries its own status marker,
   * so the group does not add a second one (no duplicated and no lost status).
   */
  private buildExpanded(width: number, paints: readonly (readonly string[])[]): string[] {
    this.rows = []
    const lines = [this.headerLine(width, true)]
    const childWidth = this.childWidth(width)
    const last = this.members.length - 1
    this.members.forEach((member, index) => {
      const isLast = index === last
      const painted = paints[index] ?? []
      // A child that paints nothing still keeps one summary row, so the tree
      // stays complete and the member stays reachable.
      const childLines = painted.length > 0 ? painted : [this.summaryText(member.item, childWidth)]
      const startRow = lines.length
      childLines.forEach((line, row) => {
        const prefix = row === 0 ? (isLast ? BRANCH.last : BRANCH.more) : (isLast ? BRANCH.lastBody : BRANCH.moreBody)
        lines.push(t.muted(prefix) + line)
      })
      this.rows.push({ block: member.block, startRow, endRow: lines.length - 1, xOffset: PREFIX_WIDTH })
    })
    return lines
  }

  // --- header ----------------------------------------------------------------

  private hintText(expanded: boolean): string {
    if (this.readonly) return ''
    const screen = this.flags.screen ?? 'inline'
    const key = this.flags.hints?.expand?.trim() ?? ''
    if (screen === 'fullscreen') return expanded ? 'click to collapse' : 'click to show more'
    if (key === '') return ''
    return expanded ? `${key} to collapse` : `${key} to expand`
  }

  private countText(items: readonly ToolTranscriptItem[]): string {
    const counts = toolGroupCounts(items)
    const sep = ` ${t.subtle('·')} `
    const parts: string[] = []
    if (counts.proposed > 0) parts.push(t.accent(`${counts.proposed} proposed`))
    if (counts.running > 0) parts.push(t.accent(`${counts.running} running`))
    if (counts.done > 0) parts.push(t.muted(`${counts.done} done`))
    if (counts.error > 0) parts.push(t.redSoft(`${counts.error} failed`))
    if (counts.unknown > 0) parts.push(t.subtle(`${counts.unknown} unknown`))
    return parts.join(sep)
  }

  private overallDot(items: readonly ToolTranscriptItem[]): string {
    const counts = toolGroupCounts(items)
    if (counts.error > 0) return t.red(DOT)
    if (counts.proposed > 0 || counts.running > 0) return t.accent(HOLLOW)
    if (counts.unknown > 0) return t.muted(HOLLOW)
    return t.green(DOT)
  }

  private headerLine(width: number, expanded: boolean): string {
    const items = this.memberItems
    const label = toolGroupLabel(items)
    // `● Bash: 2 done` — the colon binds the counts to the name, so a mixed group
    // reads `● Multiple Tools: 2 done · Bash×1, Read×1`.
    const head = `${this.overallDot(items)} ${t.text(label)}:`
    const counts = this.countText(items)
    const names = new Set(items.map(item => toolDisplayName(item.name))).size > 1
      ? toolGroupNameList(items)
      : ''
    const hintText = this.hintText(expanded)
    const hint = hintText === '' ? '' : (this.hoveredHeader ? t.accent : t.muted)(` · ${hintText}`)
    // The affordance is reserved first: truncating it away would leave the only
    // cue for the click/key invisible on a narrow terminal.
    const room = Math.max(0, width - visibleWidth(head) - visibleWidth(hint))
    // Counts and names are dropped whole rather than cut in half: a `·…` stub
    // tells the reader less than nothing.
    let middle = ''
    if (counts !== '') {
      const withCounts = ` ${counts}`
      if (visibleWidth(withCounts) <= room) middle = withCounts
    }
    if (middle !== '' && names !== '') {
      const withNames = middle + ` ${t.subtle('·')} ${t.subtle(names)}`
      if (visibleWidth(withNames) <= room) middle = withNames
    }
    return fit(head + middle + hint, width)
  }

  // --- member rows -----------------------------------------------------------

  private summaryText(item: ToolTranscriptItem, width: number): string {
    const summary = getToolSummary(item, this.cwd, this.flags.toolLabelClip ?? 0)
    // The duration is reserved before the summary is fitted, so a long command
    // never truncates away the one honest measurement on the row.
    const tail = durationTail(summary.durationMs)
    const room = Math.max(1, width - visibleWidth(tail))
    return `${t.text(fit(summary.text, room))}${tail === '' ? '' : t.subtle(tail)}`
  }

  /** `├ ✓ Bash npm test · 2.1s` — branch, real status, real summary, real duration. */
  private summaryRow(item: ToolTranscriptItem, last: boolean, width: number): string {
    return collapsedToolRow(item, last, width, this.cwd, this.flags.toolLabelClip ?? 0)
  }

  // --- mouse -----------------------------------------------------------------

  /**
   * Route a pointer event.
   *
   * Expanded child rows resolve to the real child block first (its own hitboxes,
   * its own click semantics), with the row and column re-based into the child's
   * coordinate space; the returned target keeps that child for the rest of the
   * gesture. Everything else belongs to the group: the header control claims the
   * press, and any other row is a click-only collapse/expand target.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const span = this.rows.find(entry => event.y >= entry.startRow && event.y <= entry.endRow)
    if (event.type === 'move' || event.type === 'drag') {
      // One hover target per pointer position: a child row, this group's header
      // row, or nothing at all. The header row is the only row this host claims
      // for itself; a collapsed member row and a gap adopt nothing, and a
      // synthetic leave never re-adopts the header. The previous target hears
      // its exit before the new one enters.
      const next = span !== undefined
        ? { component: span.block, slot: hoverRowSlot(span.startRow) }
        : hoverControlAt(event, this, HEADER_ROW, HEADER_SLOT)
      this.hover.moveTo(next, span === undefined ? event : { ...event, y: event.y - span.startRow })
    }
    if (span !== undefined) {
      const childEvent = { ...event, x: Math.max(0, event.x - span.xOffset), y: event.y - span.startRow }
      const result = dispatchToChild(span.block, childEvent)
      if (result !== undefined) return result
    }
    return this.registry.handleMouse(event)
  }
}

/**
 * One collapsed tool row: `├ ✓ Bash npm test · 2.1s`.
 *
 * Branch, the call's real status glyph, the shared `getToolSummary` wording and
 * the measured duration only. Shared with the mixed activity group so a grouped
 * call reads identically in both hosts; the arguments are explicit so neither
 * host has to own a second summary implementation.
 */
export function collapsedToolRow(
  item: ToolTranscriptItem,
  last: boolean,
  width: number,
  cwd: string,
  labelClip: number,
): string {
  const branch = t.muted(last ? BRANCH.last : BRANCH.more)
  const glyph = toolStatusGlyph(item) + ' '.repeat(GLYPH_WIDTH - 1)
  const summary = getToolSummary(item, cwd, labelClip)
  // The duration is reserved before the summary is fitted, so a long command
  // never truncates away the one honest measurement on the row.
  const tail = durationTail(summary.durationMs)
  const room = Math.max(1, width - PREFIX_WIDTH - GLYPH_WIDTH - visibleWidth(tail))
  return branch + glyph + `${t.text(fit(summary.text, room))}${tail === '' ? '' : t.subtle(tail)}`
}

/** Reference equality of the children's painted frames (their own caches reuse arrays). */
function sameLines(
  previous: readonly (readonly string[])[],
  next: readonly (readonly string[])[],
): boolean {
  if (previous.length !== next.length) return false
  return previous.every((lines, index) => lines === next[index])
}
