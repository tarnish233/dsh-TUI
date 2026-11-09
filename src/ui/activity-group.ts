/**
 * Mixed activity grouping — a pure planner plus the group component that hosts
 * real tools *and* DSH's own settlement notices in one disclosure.
 *
 * DSH owns what happened and in which order: the store keeps every `tool/call`,
 * `tool/result` and attributed `user/message` exactly where the durable log put
 * it. This module only derives a *view* over that ordered projection, in which a
 * run of consecutive groupable tool calls and pure runtime settlement notices
 * collapses into one block:
 *
 *   ● Activities: 1 tool · 1 update · ctrl+o to expand
 *    ├ ✓ List agents children
 *    └ ⏺ Subtask status updated · Tui acceptance agent 3
 *
 * The real case behind this: one tool call whose card returned a few rows,
 * immediately followed by the runtime's own account that a background child
 * settled (`user/message` with `source.kind: 'subagent-settled'`,
 * `source.form: 'notice'`). That second row is not a tool result and never
 * becomes one — it stays the native attributed message — but a plain tool run
 * followed by a plain notice is one narrative, so they share one disclosure.
 *
 * Rules — all derived from the declared items, never from arrival time:
 *   - **both** grouping preferences must be on. A mixed group is a conjunction of
 *     the existing `groupTools` and `groupSubagentMessages` settings, so either
 *     one switched off restores exactly the previous rows; there is no new
 *     setting, shortcut or persisted state;
 *   - at least two members, at least one real groupable tool call and at least
 *     one **pure** settlement notice. `form` must be the native `notice`; a
 *     legacy/unknown form is *not* eligible (fail-closed), so a message shape
 *     this build does not recognise keeps its own row;
 *   - only `subagent-settled` notices join. A native `agent-message`
 *     (`Task message received`), a `subagent` catalog row, a plain notice, todo,
 *     permission/decision/error notice and every ungroupable tool (diff card,
 *     edit/write/apply_patch) always breaks the run — nothing is merged across a
 *     real transcript boundary and nothing is reordered;
 *   - the boundary rules of the existing projections still decide adjacency: an
 *     assistant/attempt item that paints nothing is crossed exactly as it is
 *     inside a tool run, and a known turn change between two tool calls inside
 *     one run still breaks it;
 *   - runs that hold only tools are handed back to the existing
 *     {@link ToolGroupBlock}; runs that hold only subagent records are handed
 *     back to the existing `SubagentGroupBlock`. Nothing about their behaviour
 *     changes;
 *   - no tool call, result, id or tool-use is invented, and no elided notice
 *     text is re-created. `store.items` is untouched: native ids, seq, sender,
 *     summary, exact text and order stay exactly as DSH declared them.
 *
 * The header counts the two populations **separately** (`1 tool · 1 update`) and
 * keeps real tool state visible (`1 running`, `1 failed`, `1 unknown`). A notice
 * never contributes a success reading: its durable row carries no structured
 * outcome, so an all-tools-succeeded group that also carries a notice paints a
 * neutral marker instead of a green one.
 *
 * The group is a *host*: expanded member rows are the real `ToolBlock` /
 * `SubagentMessageBlock` paints, prefixed — never filtered or rewritten — with
 * the tree guide, and re-based so each child keeps its own hitboxes
 * (`dispatchToChild`). Collapsed rows use the shared tool summary wording and
 * the durable sender identity; only a genuinely openable child **name** is a
 * link. The header is a disclosure control only: it can never open a child.
 *
 * Disclosure is the shared ephemeral map (`tool-expansion.ts`) under
 * `group:<anchor item id>`, so Ctrl+O and single-expand treat a mixed group
 * exactly like a tool group. Nothing is persisted, no timer is armed and no
 * child catalog/session is fetched here.
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { SubagentEntry } from '../backend/types.ts'
import type { ToolTranscriptItem, TranscriptItem } from '../state/transcript.ts'
import type { SubagentMessageTranscriptItem } from '../state/subagents.ts'
import type { ItemBlock, TranscriptViewOptions } from './blocks.ts'
import { dispatchToChild, HoverOwnership, hoverRowSlot, isHoverExit, type MouseHitbox } from './mouse.ts'
import { SubagentLinkHitboxes } from './subagent-link.ts'
import {
  subagentLinkStyle,
  subagentPaintedLink,
  subagentSenderDisplay,
  type SubagentLinkSpan,
} from './subagent-format.ts'
import { fit, truncateToWidth, visibleWidth } from './text.ts'
import { bold, dim, t } from './theme.ts'
import {
  claimToolGroupContext,
  collapsedToolRow,
  isGroupableToolItem,
  releaseToolGroupContext,
  toolGroupCounts,
  type TranscriptNode,
} from './tool-group.ts'
import { isToolExpanded, requestToolExpansion, toolGroupExpansionKey } from './tool-expansion.ts'
import { isTerminalTool } from './tool-io.ts'
import type { ToolGroupContext } from './tool-view.ts'

// ---------------------------------------------------------------------------
// Projection (pure; no store, terminal or timer involvement)

/** A member of a mixed group: a real tool call or a pure settlement notice. */
export type ActivityMemberItem = ToolTranscriptItem | SubagentMessageTranscriptItem

/** One mixed run in the frame projection. */
export interface ActivityGroupFrameNode {
  readonly kind: 'activity-group'
  /** First member: the group's stable identity and disclosure anchor. */
  readonly anchor: ActivityMemberItem
  readonly members: readonly ActivityMemberItem[]
}

/** Frame nodes of the transcript view (tool, mixed activity and subagent nodes). */
export type ActivityFrameNode = TranscriptNode | ActivityGroupFrameNode

export interface ActivityGroupPlanOptions {
  /**
   * `Settings.groupTools && Settings.groupSubagentMessages`. The caller owns the
   * conjunction so both preferences keep their independent meaning: either one
   * off restores the previous rows instead of introducing a third setting.
   */
  readonly groupActivities: boolean
}

/**
 * Is this durable row a *pure* runtime settlement notice?
 *
 * Fail-closed on purpose: the native `subagent-settled` source always carries
 * `form: 'notice'`, so anything else (an older/unknown form, an `agent-message`
 * relay, a catalog row) is not a status update this group may summarise. The
 * decision reads the native source projection only — never the title or the
 * message text.
 */
export function isPureStatusNotice(item: TranscriptItem): item is SubagentMessageTranscriptItem {
  return item.kind === 'subagent-message' && item.sourceKind === 'subagent-settled' && item.form === 'notice'
}

/** Is this item a *real* tool call the mixed group may host directly? */
function isActivityToolItem(item: TranscriptItem): item is ToolTranscriptItem {
  return item.kind === 'tool' && isGroupableToolItem(item)
}

/**
 * Members a node would contribute to a mixed run.
 *
 * A tool-group node is flattened into its real calls (the mixed group renders the
 * cards itself), an item node contributes at most one member.
 */
function activityMembersOf(node: TranscriptNode): readonly ActivityMemberItem[] {
  if (node.kind === 'group') return node.members
  const item = node.item
  if (item.kind === 'tool') return isActivityToolItem(item) ? [item] : []
  if (isPureStatusNotice(item)) return [item]
  return []
}

/** Known turn of a node, if the projection recorded one. */
function activityTurnOf(node: TranscriptNode): number | undefined {
  if (node.kind === 'group') return node.anchor.turn
  return node.item.kind === 'tool' ? node.item.turn : undefined
}

/**
 * Fold consecutive `tool` / `tool-group` / pure-notice nodes into mixed groups.
 *
 * Pure: the same nodes always produce the same projection, and nothing is
 * sorted, merged across a non-member node or dropped. A run that lacks either
 * population is emitted **unchanged**, so the existing tool and subagent groups
 * keep handling it. Members keep their own item identity, so their cached block
 * (and every native fact behind it) is reused while grouped and after the group
 * dissolves.
 */
export function planActivityGroupNodes(
  nodes: readonly TranscriptNode[],
  options: ActivityGroupPlanOptions,
): readonly ActivityFrameNode[] {
  if (!options.groupActivities) return nodes
  const out: ActivityFrameNode[] = []
  let run: TranscriptNode[] = []
  let runTurn: number | undefined
  const flush = (): void => {
    if (run.length === 0) return
    const members = run.flatMap(node => activityMembersOf(node))
    const tools = members.filter(member => member.kind === 'tool').length
    const notices = members.length - tools
    if (members.length > 1 && tools > 0 && notices > 0) {
      out.push({ kind: 'activity-group', anchor: members[0]!, members })
    } else {
      // Not mixed: hand the original nodes back untouched (tool groups included).
      out.push(...run)
    }
    run = []
    runTurn = undefined
  }
  for (const node of nodes) {
    if (activityMembersOf(node).length === 0) {
      flush()
      out.push(node)
      continue
    }
    const turn = activityTurnOf(node)
    // Only a *known* turn change is a break, exactly like the tool projection.
    if (turn !== undefined && runTurn !== undefined && turn !== runTurn) flush()
    run.push(node)
    if (turn !== undefined) runTurn = turn
  }
  flush()
  return out
}

// ---------------------------------------------------------------------------
// Header wording

export interface ActivityGroupCounts {
  /** Real tool calls (never notices, never fabricated). */
  readonly tools: number
  /** Pure native settlement notices. */
  readonly updates: number
  readonly proposed: number
  readonly running: number
  readonly done: number
  readonly failed: number
  /** Tool calls without a settlement: unresolved, never drawn as success. */
  readonly unknown: number
}

/** Count the two populations separately and keep every tool status bucket. */
export function activityGroupCounts(members: readonly ActivityMemberItem[]): ActivityGroupCounts {
  const tools = members.filter((member): member is ToolTranscriptItem => member.kind === 'tool')
  const { proposed, running, done, error, unknown } = toolGroupCounts(tools)
  return {
    tools: tools.length,
    updates: members.length - tools.length,
    proposed,
    running,
    done,
    failed: error,
    unknown,
  }
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

// ---------------------------------------------------------------------------
// Group component

/** A group member: the native item plus the cached component that paints it. */
export interface ActivityGroupMember {
  readonly item: ActivityMemberItem
  readonly block: ItemBlock
}

/** Row span of one expanded member inside the group's own frame. */
export interface ActivityGroupRowSpan {
  readonly block: ItemBlock
  readonly item: ActivityMemberItem
  readonly startRow: number
  readonly endRow: number
  /** Columns the member's own coordinate space is shifted right by. */
  readonly xOffset: number
}

/** Placement token of this group's own header control (row 0). */
const HEADER_SLOT = 'header'
const DOT = '●'
const HOLLOW = '◌'
const NOTICE_DOT = '⏺'
const NOTICE_TITLE = 'Subtask status updated'
const BRANCH = { more: '├ ', last: '└ ', moreBody: '│ ', lastBody: '  ' } as const
const PREFIX_WIDTH = Math.max(
  visibleWidth(BRANCH.more),
  visibleWidth(BRANCH.last),
  visibleWidth(BRANCH.moreBody),
  visibleWidth(BRANCH.lastBody),
)

/** One collapsed notice row plus the name-link geometry that survived the clip. */
interface CollapsedRow {
  /** Member index this row paints (its frame row is `memberIndex + 1`). */
  readonly memberIndex: number
  readonly senderSessionId: string
  readonly link?: SubagentLinkSpan
}

/** Displayed identity of a durable settlement sender, from already-known facts. */
interface SenderIdentity {
  readonly label: string
  readonly openable: boolean
}

function senderIdentity(
  item: SubagentMessageTranscriptItem,
  entries: readonly SubagentEntry[] | undefined,
): SenderIdentity {
  return subagentSenderDisplay(item.senderSessionId, entries)
}

/**
 * One mixed tool/status activity group.
 *
 * Identity is the *first* member's item id, so the component (and its cache)
 * survives members joining, updating or leaving. The header only toggles the
 * disclosure; child navigation is exclusively the name of a collapsed notice
 * member (or the real member block, when expanded).
 */
export class ActivityGroupBlock implements Component {
  /** Anchor item id — the row span identity this block reports to the view. */
  readonly itemId: string
  readonly kind: 'activity' = 'activity'
  /** Shared disclosure key (`group:<anchor item id>`). */
  readonly key: string
  private readonly flags: TranscriptViewOptions
  private readonly links = new SubagentLinkHitboxes()
  /**
   * The one hover target inside this group: the header/collapsed name links
   * (this block) or the expanded member block the pointer's row belongs to.
   * Motion only reaches one target per event, so the previously hovered one is
   * released here instead of keeping a blue hint nobody points at.
   */
  private readonly hover = new HoverOwnership()
  private members: readonly ActivityGroupMember[] = []
  private rows: ActivityGroupRowSpan[] = []
  private collapsedRows: CollapsedRow[] = []
  private frameBoxes: MouseHitbox[] = []
  private disposed = false
  private cwd = ''
  private context: ToolGroupContext | undefined
  private cache: { key: string; lines: string[]; paints: readonly (readonly string[])[] } | undefined

  constructor(anchor: ActivityMemberItem, flags: TranscriptViewOptions) {
    this.itemId = anchor.id
    this.key = toolGroupExpansionKey(anchor.id)
    this.flags = flags
  }

  /** Disclosure state, shared with the whole transcript (Ctrl+O and single-expand). */
  get expanded(): boolean {
    return isToolExpanded(this.key, this.flags.expandTools)
  }

  get memberCount(): number {
    return this.members.length
  }

  get memberItems(): readonly ActivityMemberItem[] {
    return this.members.map(member => member.item)
  }

  /** Child row spans of the last rendered frame (diagnostics/tests). */
  get rowSpans(): readonly ActivityGroupRowSpan[] {
    return this.rows
  }

  /** Hitboxes declared by the last render (diagnostics/tests). */
  get hitboxes(): readonly MouseHitbox[] {
    return this.frameBoxes
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Diagnostics/tests: cache key of the last composed frame (undefined = next render rebuilds). */
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
   * An unchanged member list keeps the composed frame; a changed one repaints.
   * A tool card that leaves the group gets its delegated context removed
   * immediately (ownership-aware, so a group that already claimed it keeps it),
   * because from then on it owns its own disclosure again.
   */
  setMembers(members: readonly ActivityGroupMember[]): void {
    const unchanged = members.length === this.members.length && members.every((member, index) => {
      const previous = this.members[index]
      return previous !== undefined
        && previous.block === member.block
        && previous.item.kind === member.item.kind
        && previous.item.id === member.item.id
        && previous.item.version === member.item.version
    })
    const previous = this.members
    this.members = [...members]
    if (!unchanged) this.cache = undefined
    for (const member of previous) {
      if (this.members.some(entry => entry.block === member.block)) continue
      releaseToolGroupContext(member.block, this)
    }
    for (const member of this.members) {
      if (member.item.kind !== 'tool') continue
      claimToolGroupContext(member.block, this, this.groupContext())
    }
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
    requestToolExpansion(this.flags, this.key, !this.expanded)
  }

  invalidate(): void {
    this.cache = undefined
    // Deliberately does not touch the links: an ordinary repaint must keep the
    // press pin so a click whose rows moved between frames still lands.
  }

  /**
   * Drop frame-local state: hitboxes, hover, the pinned press target and the
   * tool members' delegated contexts. Called when the group leaves the view or
   * the session changes — never on an ordinary repaint.
   */
  clearMouse(): void {
    this.hover.release()
    this.links.clear()
    this.frameBoxes = []
    this.rows = []
    this.collapsedRows = []
    for (const member of this.members) {
      if (member.item.kind !== 'tool') continue
      releaseToolGroupContext(member.block, this)
    }
  }

  /** Teardown for the view's `dispose()`. Idempotent and inert afterwards. */
  dispose(): void {
    if (this.disposed) return
    this.clearMouse()
    this.disposed = true
    this.cache = undefined
    this.members = []
  }

  // --- frame -----------------------------------------------------------------

  private memberStamp(member: ActivityGroupMember): string {
    if (member.item.kind === 'tool') {
      return `tool:${member.item.id}@${member.item.version}:${member.item.status}`
    }
    const sender = senderIdentity(member.item, this.flags.subagentEntries)
    return `notice:${member.item.id}@${member.item.version}:${sender.label}:${sender.openable ? 'local' : 'leaf'}`
  }

  /**
   * Cache key of the composed frame.
   *
   * It carries everything *this* component paints itself: the member identities,
   * the width, the disclosure state, the cwd and label-clip preferences the
   * collapsed tool rows read, the hint wording, the link callback presence and
   * the hover. Expanded frames additionally compare the children's painted lines
   * by reference, which is what makes a child repaint (its own cache decides)
   * show up here.
   */
  private frameKey(width: number, expanded: boolean): string {
    return [
      width,
      expanded ? 'open' : 'closed',
      this.members.map(member => this.memberStamp(member)).join(','),
      this.liveStamp(),
      this.cwd,
      this.flags.toolLabelClip ?? 0,
      this.flags.hints?.expand ?? '',
      this.flags.screen ?? 'inline',
      typeof this.flags.onSubagentDetails === 'function' ? 'links' : 'inert',
      this.links.hoveredId ?? '',
    ].join('|')
  }

  /**
   * Clock stamp while some member card is still measuring a running command.
   *
   * The stamp only changes when the parent repaints (a display timer it already
   * owns), so no timer is created here.
   */
  private liveStamp(): string {
    const live = this.members.some(member =>
      member.item.kind === 'tool'
      && isTerminalTool(member.item)
      && (member.item.status === 'running' || member.item.status === 'proposed')
      && member.item.startedAt !== undefined)
    return live ? String((this.flags.now ?? Date.now)()) : ''
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const safeWidth = Math.max(1, Math.floor(width))
    const expanded = this.expanded
    // Members are always rendered first in expanded mode: their own cache makes
    // it cheap, and the returned line arrays are the identity that tells this
    // group whether anything it composed has actually changed.
    const paints = expanded ? this.members.map(member => member.block.render(this.childWidth(safeWidth))) : []
    const key = this.frameKey(safeWidth, expanded)
    if (this.cache !== undefined && this.cache.key === key && sameLines(this.cache.paints, paints)) {
      this.syncMouse(expanded)
      return this.cache.lines
    }
    const lines = expanded ? this.buildExpanded(safeWidth, paints) : this.buildCollapsed(safeWidth)
    const fitted = lines.map(line => fit(line, safeWidth))
    this.cache = { key, lines: fitted, paints }
    this.syncMouse(expanded)
    return fitted
  }

  private childWidth(width: number): number {
    return Math.max(1, width - PREFIX_WIDTH)
  }

  private buildCollapsed(width: number): string[] {
    this.rows = []
    const collapsed: CollapsedRow[] = []
    const lines = [this.headerLine(width, false)]
    const last = this.members.length - 1
    this.members.forEach((member, index) => {
      if (member.item.kind === 'tool') {
        lines.push(collapsedToolRow(member.item, index === last, width, this.cwd, this.flags.toolLabelClip ?? 0))
        return
      }
      const painted = this.collapsedNoticeRow(member.item, index === last, width)
      lines.push(painted.line)
      collapsed.push({
        memberIndex: index,
        senderSessionId: member.item.senderSessionId,
        ...(painted.link === undefined ? {} : { link: painted.link }),
      })
    })
    this.collapsedRows = collapsed
    return lines
  }

  /**
   * Expanded frame: every member's real paint, prefixed with the tree guide and
   * never filtered or rewritten. A child that paints nothing keeps one summary
   * row so the tree stays complete and the member stays reachable.
   */
  private buildExpanded(width: number, paints: readonly (readonly string[])[]): string[] {
    this.collapsedRows = []
    this.rows = []
    const lines = [this.headerLine(width, true)]
    const childWidth = this.childWidth(width)
    const last = this.members.length - 1
    this.members.forEach((member, index) => {
      const isLast = index === last
      const painted = paints[index] ?? []
      const childLines = painted.length > 0 ? painted : [this.fallbackLine(member, childWidth)]
      const startRow = lines.length
      childLines.forEach((line, row) => {
        const prefix = row === 0 ? (isLast ? BRANCH.last : BRANCH.more) : (isLast ? BRANCH.lastBody : BRANCH.moreBody)
        lines.push(t.muted(prefix) + line)
      })
      this.rows.push({ block: member.block, item: member.item, startRow, endRow: lines.length - 1, xOffset: PREFIX_WIDTH })
    })
    return lines
  }

  // --- header ----------------------------------------------------------------

  private hintText(expanded: boolean): string {
    const screen = this.flags.screen ?? 'inline'
    const key = this.flags.hints?.expand?.trim() ?? ''
    if (screen === 'fullscreen') return expanded ? 'click to collapse' : 'click to show more'
    if (key === '') return ''
    return expanded ? `${key} to collapse` : `${key} to expand`
  }

  /**
   * Overall marker.
   *
   * Red only for a real tool failure, accent while a tool is running/proposed,
   * muted for an unresolved tool and **never green while a notice is present**:
   * a settlement notice carries no structured outcome this build may read, so
   * painting it as success would invent one.
   */
  private overallDot(counts: ActivityGroupCounts): string {
    if (counts.failed > 0) return t.red(DOT)
    if (counts.proposed > 0 || counts.running > 0) return t.accent(HOLLOW)
    if (counts.unknown > 0) return t.muted(HOLLOW)
    if (counts.updates > 0) return t.muted(DOT)
    return t.green(DOT)
  }

  /**
   * Header segments: the two populations are counted separately and every real
   * tool state that is *not* an ordinary completion is kept visible
   * (`1 proposed`, `1 running`, `1 failed`, `1 unknown`).
   *
   * The settled-and-succeeded calls are not repeated as `1 done`: they are the
   * remainder of the tool total, so `1 tool · 1 update` stays the compact
   * reading of the ordinary case while a failure, an unresolved call or live
   * work can never be hidden. The update count is neutral; there is no invented
   * "succeeded" reading for a notice.
   */
  private countSegments(counts: ActivityGroupCounts): string[] {
    const segments: Array<{ text: string; style: (value: string) => string }> = [
      { text: plural(counts.tools, 'tool', 'tools'), style: t.muted },
    ]
    if (counts.proposed > 0) segments.push({ text: `${counts.proposed} proposed`, style: t.accent })
    if (counts.running > 0) segments.push({ text: `${counts.running} running`, style: t.accent })
    if (counts.failed > 0) segments.push({ text: `${counts.failed} failed`, style: t.redSoft })
    if (counts.unknown > 0) segments.push({ text: `${counts.unknown} unknown`, style: t.subtle })
    if (counts.updates > 0) segments.push({ text: plural(counts.updates, 'update', 'updates'), style: t.muted })
    return segments.map(segment => segment.style(segment.text))
  }

  private headerLine(width: number, expanded: boolean): string {
    const counts = activityGroupCounts(this.members.map(member => member.item))
    const head = `${this.overallDot(counts)} ${t.text('Activities:')}`
    const hintText = this.hintText(expanded)
    const hoveredHeader = this.links.hoveredId === this.headerBoxIdValue()
    const hint = hintText === '' ? '' : (hoveredHeader ? t.accent : t.muted)(` · ${hintText}`)
    // The affordance is reserved first: truncating it away would leave the only
    // cue for the click/key invisible on a narrow terminal.
    const room = Math.max(0, width - visibleWidth(head) - visibleWidth(hint))
    // Counts are dropped whole rather than cut in half: a `·…` stub tells less.
    let middle = ''
    for (const segment of this.countSegments(counts)) {
      const next = middle === '' ? ` ${segment}` : `${middle} ${t.subtle('·')} ${segment}`
      if (visibleWidth(next) > room) break
      middle = next
    }
    return fit(head + middle + hint, width)
  }

  // --- collapsed member rows -------------------------------------------------

  /**
   * One collapsed notice row:
   *
   *   `├ ⏺ Subtask status updated · Tui acceptance agent 3`
   *
   * Branch, title, gap and any clipped text stay plain text. Only the child
   * **name** is a link, and only while the native catalog already knows that
   * child as openable and the callback exists; an unknown or external sender is
   * painted as plain text so no dead affordance is advertised. The native notice
   * body is never reprinted or rewritten here — it is the expanded member.
   */
  private collapsedNoticeRow(
    item: SubagentMessageTranscriptItem,
    last: boolean,
    width: number,
  ): { line: string; link?: SubagentLinkSpan } {
    return this.noticeRow(item, (last ? BRANCH.last : BRANCH.more) + NOTICE_DOT + ' ', width)
  }

  /**
   * One notice row with an explicit leading guide, so the collapsed row (tree
   * branch) and the expanded fallback (no branch, the group adds it) share one
   * painter and one link geometry rule.
   */
  private noticeRow(
    item: SubagentMessageTranscriptItem,
    head: string,
    width: number,
  ): { line: string; link?: SubagentLinkSpan } {
    const separator = dim(' · ')
    const identity = senderIdentity(item, this.flags.subagentEntries)
    const linkable = this.flags.onSubagentDetails !== undefined && identity.openable
    const hovered = linkable && this.links.hoveredId === this.memberBoxIdValue(item.id)
    const prefix = head + bold(t.text(NOTICE_TITLE)) + separator
    const label = truncateToWidth(identity.label, Math.max(1, width - visibleWidth(prefix)))
    const styled = linkable ? subagentLinkStyle(hovered)(label) : bold(t.text(label))
    return subagentPaintedLink(`${prefix}${styled}`, width, visibleWidth(prefix), visibleWidth(label), linkable)
  }

  // --- expanded fallback -----------------------------------------------------

  /**
   * One-line fallback for a member whose expanded paint is empty.
   *
   * Reached only if a member block paints nothing at all: the tree stays
   * complete and the member stays reachable instead of silently vanishing.
   */
  private fallbackLine(member: ActivityGroupMember, width: number): string {
    if (member.item.kind === 'tool') {
      // The shared collapsed tool row already carries its own branch guide.
      return collapsedToolRow(member.item, true, width, this.cwd, this.flags.toolLabelClip ?? 0)
    }
    return this.noticeRow(member.item, NOTICE_DOT + ' ', width).line
  }

  // --- mouse -----------------------------------------------------------------

  private headerBoxIdValue(): string {
    return `${this.key}#header`
  }

  private memberBoxIdValue(id: string): string {
    return `${this.itemId}:m:${id}`
  }

  /**
   * Re-declare this frame's hitboxes.
   *
   * Only two kinds exist: the header disclosure control (it can never open a
   * child) and a collapsed notice's sender **name**. A collapsed tool row keeps
   * the established no-detail-hitbox policy — it is plain text. An expanded body
   * is plain, selectable text owned by the member blocks themselves, so no group
   * body hitbox exists and a press there can never be re-derived as a toggle.
   */
  private syncMouse(expanded: boolean): void {
    const height = this.cache?.lines.length ?? 0
    const boxes: MouseHitbox[] = []
    if (height > 0) {
      boxes.push({
        id: this.headerBoxIdValue(),
        startRow: 0,
        endRow: 0,
        claimPress: true,
        onClick: () => { this.toggle() },
        onHover: () => { this.flags.onRenderRequest?.() },
      })
      const handler = this.flags.onSubagentDetails
      if (!expanded && handler !== undefined) {
        // Only a visible child name is a navigation link; every other cell of a
        // collapsed row is plain text with native selection/copy.
        for (const row of this.collapsedRows) {
          if (row.link === undefined) continue
          const member = this.members[row.memberIndex]
          if (member === undefined) continue
          boxes.push({
            id: this.memberBoxIdValue(member.item.id),
            startRow: row.memberIndex + 1,
            endRow: row.memberIndex + 1,
            startCol: row.link.startCol,
            endCol: row.link.endCol,
            claimPress: true,
            onClick: () => handler(row.senderSessionId),
            onHover: () => { this.flags.onRenderRequest?.() },
          })
        }
      }
    }
    this.links.sync(boxes)
    // A frame that no longer paints the hovered target at the row it was
    // entered in released its hitbox: the hint goes back to neutral.
    this.hover.retain([
      { component: this, slot: HEADER_SLOT },
      ...this.rows.map(row => ({ component: row.block, slot: hoverRowSlot(row.startRow) })),
    ])
    this.frameBoxes = boxes
  }

  /**
   * Route a pointer event.
   *
   * An expanded member row resolves to the real member block first (its own
   * hitboxes and their own gesture rules), with the row and column re-based into
   * the member's coordinate space; the returned target keeps that member for the
   * rest of the gesture. Everything else belongs to this group's own links
   * (header, collapsed notice names) and never to a fallback by coordinates.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const span = this.rows.find(entry => event.y >= entry.startRow && event.y <= entry.endRow)
    if (event.type === 'move' || event.type === 'drag') {
      // One hover target per pointer position: a member row, this group's own
      // header/name link, or nothing (a synthetic leave must not re-adopt it).
      const next = span !== undefined
        ? { component: span.block, slot: hoverRowSlot(span.startRow) }
        : isHoverExit(event) ? undefined : { component: this, slot: HEADER_SLOT }
      this.hover.moveTo(next, span === undefined ? event : { ...event, y: event.y - span.startRow })
    }
    if (span !== undefined) {
      const childEvent = { ...event, x: Math.max(0, event.x - span.xOffset), y: event.y - span.startRow }
      const result = dispatchToChild(span.block, childEvent)
      if (result !== undefined) return result
    }
    return this.links.handleMouse(event)
  }
}

/** Reference equality of the members' painted frames (their own caches reuse arrays). */
function sameLines(
  previous: readonly (readonly string[])[],
  next: readonly (readonly string[])[],
): boolean {
  if (previous.length !== next.length) return false
  return previous.every((lines, index) => lines === next[index])
}