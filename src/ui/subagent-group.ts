/**
 * Subagent record grouping — a pure display projection plus its group component.
 *
 * DSH owns the child catalog, the durable settlement/trigger messages and the
 * order of the parent log; the store keeps every native `subagent` row and every
 * `subagent-message` fact exactly where DSH put it. This module only derives a
 * *view* over that ordered list, in which runs of consecutive subagent records
 * collapse into one block, following the tool-group convention:
 *
 *   ● Subagents: 3 records · 1 running · 1 completed · 1 message · ctrl+o to expand
 *    ├ ⏺ Explore 仓库 · running · reading src/app.ts
 *    ├ ⏺ Subtask status updated · Review changes
 *    └ ⏺ Task message received · Explore 仓库
 *
 * Rules — all derived from the declared items, never from arrival time:
 *   - two records are the minimum for a group;
 *   - only `subagent` catalog rows and `subagent-message` (settlement/trigger)
 *     facts may join. A user/assistant/tool/attempt/notice/todo item, a tool
 *     group and any other record always breaks the run: nothing is merged
 *     across a real transcript boundary and nothing is reordered;
 *   - the native attribution, `seq`, sender id and exact message text stay in
 *     the store; the group paints a summary row when collapsed and the real
 *     member paint (never a rewrite) when expanded;
 *   - the grouped presentation is part of the existing `groupTools`
 *     preference: disabling grouping restores one row per record. No new
 *     shortcut, setting or backend field exists.
 *
 * Navigation stays name-only. A collapsed member row paints its child **name**
 * (the native catalog label, or the durable sender id when the catalog does not
 * know that child) as the bold brand-blue underlined internal link; the branch
 * guide, status glyph, status/attribution text and gaps keep native selection
 * and copy. An expanded member is the real child block, which owns the same
 * name-only geometry. The header is a disclosure control only — it can toggle
 * the group and can never open a child.
 *
 * The disclosure state is the shared ephemeral map (`tool-expansion.ts`) under
 * `group:<anchor item id>`, so Ctrl+O and single-expand treat a group exactly
 * like a tool group. Nothing is persisted, no timer is armed and no child
 * catalog/session is fetched here.
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { SubagentEntry } from '../backend/types.ts'
import type { TranscriptItem } from '../state/transcript.ts'
import type { SubagentMessageTranscriptItem, SubagentTranscriptItem } from '../state/subagents.ts'
import type { ItemBlock, TranscriptViewOptions } from './blocks.ts'
import { dispatchToChild, type MouseHitbox } from './mouse.ts'
import { SubagentLinkHitboxes } from './subagent-link.ts'
import type { TranscriptNode } from './tool-group.ts'
import { isToolExpanded, requestToolExpansion, toolGroupExpansionKey } from './tool-expansion.ts'
import {
  subagentActivity,
  subagentGlyph,
  subagentLabel,
  subagentLinkStyle,
  subagentOpenable,
  subagentPaintedLink,
  subagentSenderDisplay,
  subagentStatusLabel,
  subagentStatusStyle,
  subagentTone,
  type SubagentLinkSpan,
} from './subagent-format.ts'
import { fit, oneLine, truncateToWidth, visibleWidth } from './text.ts'
import { bold, dim, t } from './theme.ts'

/** Durable record kinds that may be folded into one group. */
export type SubagentRecordItem = SubagentTranscriptItem | SubagentMessageTranscriptItem

/** One grouped run in the frame projection. */
export interface SubagentGroupFrameNode {
  readonly kind: 'subagent-group'
  /** First member: the group's stable identity and disclosure anchor. */
  readonly anchor: SubagentRecordItem
  readonly members: readonly SubagentRecordItem[]
}

/** Frame nodes of the transcript view (tool nodes plus subagent groups). */
export type SubagentFrameNode = TranscriptNode | SubagentGroupFrameNode

export interface SubagentGroupPlanOptions {
  /**
   * `Settings.groupTools`. Consecutive-record grouping shares the existing
   * grouping preference, so `false` restores one row per record and no new
   * setting/hierarchy is introduced.
   */
  readonly groupRecords: boolean
}

/** Is this transcript item a durable subagent record? */
export function isSubagentRecord(item: TranscriptItem): item is SubagentRecordItem {
  return item.kind === 'subagent' || item.kind === 'subagent-message'
}

/**
 * Fold consecutive subagent records into group nodes.
 *
 * Pure: the same nodes always produce the same frame projection, and nothing is
 * sorted, merged across a non-record node or dropped. Members keep their own
 * item identity, so their cached block (and its native facts) is reused while
 * grouped and after the group dissolves.
 */
export function planSubagentGroupNodes(
  nodes: readonly TranscriptNode[],
  options: SubagentGroupPlanOptions,
): readonly SubagentFrameNode[] {
  if (!options.groupRecords) return nodes
  const out: SubagentFrameNode[] = []
  let run: SubagentRecordItem[] = []
  const flush = (): void => {
    if (run.length > 1) out.push({ kind: 'subagent-group', anchor: run[0]!, members: run })
    else for (const item of run) out.push({ kind: 'item', item })
    run = []
  }
  for (const node of nodes) {
    if (node.kind === 'item' && isSubagentRecord(node.item)) {
      run.push(node.item)
      continue
    }
    flush()
    out.push(node)
  }
  flush()
  return out
}

/** A group member: the durable item plus the cached component that paints it. */
export interface SubagentGroupMember {
  readonly item: SubagentRecordItem
  readonly block: ItemBlock
}

/** Row span of one expanded member inside the group's own frame. */
export interface SubagentGroupRowSpan {
  readonly block: ItemBlock
  readonly item: SubagentRecordItem
  readonly startRow: number
  readonly endRow: number
  /** Columns the member's own coordinate space is shifted right by. */
  readonly xOffset: number
}

const DOT = '⏺'
/**
 * Two-column tree guides, exactly like the tool group: the first row of a member
 * carries `├ `/`└ `, every following row of the same member carries `│ `/`  `.
 * `PREFIX_WIDTH`, `childWidth()` and the dispatched `xOffset` all derive from
 * these strings, so the member's own paint is never silently over-clipped or
 * mis-addressed by a prefix/coordinate mismatch.
 */
const BRANCH = { more: '├ ', last: '└ ', moreBody: '│ ', lastBody: '  ' } as const
const PREFIX_WIDTH = Math.max(
  visibleWidth(BRANCH.more),
  visibleWidth(BRANCH.last),
  visibleWidth(BRANCH.moreBody),
  visibleWidth(BRANCH.lastBody),
)

/** One collapsed member row plus the name-link geometry that survived the clip. */
interface CollapsedRow {
  readonly sessionId: string
  readonly link?: SubagentLinkSpan
}

/** Session id a record navigates to (catalog row id / durable sender id). */
function recordSessionId(item: SubagentRecordItem): string {
  return item.kind === 'subagent' ? item.entry.id : item.senderSessionId
}

/** Display name + local openability of one record, from already-known facts only. */
function recordIdentity(
  item: SubagentRecordItem,
  entries: readonly SubagentEntry[] | undefined,
): { label: string; openable: boolean } {
  if (item.kind === 'subagent') {
    return {
      label: oneLine(subagentLabel(item.entry), Number.MAX_SAFE_INTEGER),
      openable: subagentOpenable(item.entry),
    }
  }
  return subagentSenderDisplay(item.senderSessionId, entries)
}

function recordTitle(item: SubagentRecordItem): string {
  if (item.kind === 'subagent') return ''
  return item.sourceKind === 'agent-message' ? 'Task message received' : 'Subtask status updated'
}

/** Append one low-priority segment only while the row still fits the width. */
function appendIfFits(line: string, segment: string, width: number): string {
  const next = `${line}${dim(' · ')}${segment}`
  return visibleWidth(next) <= width ? next : line
}

/**
 * One collapsed/expanded group of consecutive durable subagent records.
 *
 * Identity is the *first* member's item id, so the component (and its cache)
 * survives members joining, updating or leaving. The header only toggles the
 * disclosure; child navigation is exclusively the name text of a member row.
 */
export class SubagentGroupBlock implements Component {
  /** Anchor item id — the row span identity this block reports to the view. */
  readonly itemId: string
  readonly kind: 'subagent' = 'subagent'
  /** Shared disclosure key (`group:<anchor item id>`). */
  readonly key: string
  private readonly flags: TranscriptViewOptions
  private readonly links = new SubagentLinkHitboxes()
  private members: readonly SubagentGroupMember[] = []
  private rows: SubagentGroupRowSpan[] = []
  private collapsedRows: CollapsedRow[] = []
  private frameBoxes: MouseHitbox[] = []
  private disposed = false
  private cache: { key: string; lines: string[]; paints: readonly (readonly string[])[] } | undefined

  constructor(anchor: SubagentRecordItem, flags: TranscriptViewOptions) {
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

  get memberItems(): readonly SubagentRecordItem[] {
    return this.members.map(member => member.item)
  }

  /** Member row spans of the last rendered frame (diagnostics/tests). */
  get rowSpans(): readonly SubagentGroupRowSpan[] {
    return this.rows
  }

  /** Hitboxes declared by the last render (diagnostics/tests). */
  get hitboxes(): readonly MouseHitbox[] {
    return this.frameBoxes
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Diagnostics/tests: cache key of the last composed frame. */
  get frameCacheKey(): string | undefined {
    return this.cache?.key
  }

  /**
   * Replace the member list for this frame. An unchanged list keeps the
   * composed frame (and its hitboxes); a changed one repaints.
   */
  setMembers(members: readonly SubagentGroupMember[]): void {
    const unchanged = members.length === this.members.length && members.every((member, index) => {
      const previous = this.members[index]
      return previous !== undefined
        && previous.block === member.block
        && previous.item.id === member.item.id
        && previous.item.kind === member.item.kind
        && previous.item.version === member.item.version
    })
    this.members = [...members]
    if (!unchanged) this.cache = undefined
  }

  /** Flip the whole group through the shared disclosure helper (viewport anchor first). */
  toggle(): void {
    requestToolExpansion(this.flags, this.key, !this.expanded)
  }

  invalidate(): void {
    this.cache = undefined
    // Deliberately does not touch the link gestures: an ordinary repaint must
    // keep a claimed header press pinned. Eviction/session replacement goes
    // through `clearMouse()`, and a vanished region voids itself on `sync`.
  }

  /**
   * Drop frame-local state: hitboxes, hover and the pinned press target. Called
   * when the group leaves the view or the session changes — never on an ordinary
   * repaint (that would lose a pressed row).
   */
  clearMouse(): void {
    this.links.clear()
    this.frameBoxes = []
    this.rows = []
    this.collapsedRows = []
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

  private frameKey(width: number, expanded: boolean): string {
    const members = this.members.map(member => {
      const identity = recordIdentity(member.item, this.flags.subagentEntries)
      const status = member.item.kind === 'subagent' ? member.item.entry.status : 'message'
      return `${member.item.kind}:${member.item.id}@${member.item.version}:${status}:${identity.label}:${identity.openable ? 'local' : 'leaf'}`
    }).join(',')
    return [
      width,
      expanded ? 'open' : 'closed',
      members,
      this.flags.screen ?? 'inline',
      this.flags.hints?.expand ?? '',
      typeof this.flags.onSubagentDetails === 'function' ? 'links' : 'inert',
      this.links.hoveredId ?? '',
    ].join('|')
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const safeWidth = Math.max(1, Math.floor(width))
    const expanded = this.expanded
    // Members are always rendered first in expanded mode: their own caches make
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
      const painted = this.collapsedRow(member.item, index === last, width)
      lines.push(painted.line)
      collapsed.push({ sessionId: recordSessionId(member.item), ...(painted.link === undefined ? {} : { link: painted.link }) })
    })
    this.collapsedRows = collapsed
    return lines
  }

  /**
   * Expanded frame: every member's real paint, prefixed with the tree glyph and
   * never filtered. The member block keeps its own rows (and its own name-only
   * hitbox) — the group only re-bases the column by the prefix.
   */
  private buildExpanded(width: number, paints: readonly (readonly string[])[]): string[] {
    this.collapsedRows = []
    this.rows = []
    const lines = [this.headerLine(width, true)]
    const last = this.members.length - 1
    this.members.forEach((member, index) => {
      const isLast = index === last
      const painted = paints[index] ?? []
      const startRow = lines.length
      painted.forEach((line, row) => {
        const prefix = row === 0 ? (isLast ? BRANCH.last : BRANCH.more) : (isLast ? BRANCH.lastBody : BRANCH.moreBody)
        lines.push(t.muted(prefix) + line)
      })
      if (painted.length > 0) {
        this.rows.push({ block: member.block, item: member.item, startRow, endRow: lines.length - 1, xOffset: PREFIX_WIDTH })
      }
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

  /** Overall marker: a real failure is red, live work is accent, retained history is dim. */
  private overallDot(): string {
    let active = false
    let failed = false
    let success = false
    for (const member of this.members) {
      if (member.item.kind !== 'subagent') continue
      const tone = subagentTone(member.item.entry)
      if (tone === 'running') active = true
      else if (tone === 'failed') failed = true
      else if (tone === 'done') success = true
    }
    if (failed) return t.red(DOT)
    if (active) return t.accent('◌')
    return success ? t.green(DOT) : t.muted('◌')
  }

  /** Raw native status counts of catalog members plus a count of durable messages. */
  private countSegments(): string[] {
    const counts = new Map<string, number>()
    let messages = 0
    for (const member of this.members) {
      if (member.item.kind === 'subagent-message') { messages += 1; continue }
      const entry = member.item.entry
      const label = subagentStatusLabel(entry)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    const segments: string[] = []
    for (const [label, count] of counts) segments.push(`${count} ${label}`)
    if (messages > 0) segments.push(`${messages} ${messages === 1 ? 'message' : 'messages'}`)
    return segments
  }

  private headerLine(width: number, expanded: boolean): string {
    const total = this.members.length
    const head = `${this.overallDot()} ${t.text('Subagents:')}`
    const hintText = this.hintText(expanded)
    const hoveredHeader = this.links.hoveredId === this.headerBoxIdValue()
    const hint = hintText === '' ? '' : (hoveredHeader ? t.accent : t.muted)(` · ${hintText}`)
    const room = Math.max(0, width - visibleWidth(head) - visibleWidth(hint))
    // Counts are dropped whole rather than cut in half: a stub tells less.
    let middle = ''
    const append = (segment: string): void => {
      const next = middle === '' ? ` ${segment}` : `${middle} ${t.subtle('·')} ${segment}`
      if (visibleWidth(next) <= room) middle = next
    }
    append(dim(`${total} ${total === 1 ? 'record' : 'records'}`))
    for (const segment of this.countSegments()) {
      const failed = segment.includes('failed') || segment.includes('max tokens') || segment.includes('refused')
      const live = segment.includes('running') || segment.includes('initializing')
      append((failed ? t.redSoft : live ? t.accent : t.muted)(segment))
    }
    return fit(head + middle + hint, width)
  }

  // --- collapsed member rows -------------------------------------------------

  /**
   * One collapsed member row:
   *
   *   `├ ⏺ Explore 仓库 · running · reading src/app.ts`
   *   `├ ⏺ Subtask status updated · Review changes`
   *
   * The branch, glyph, status/attribution and gaps stay plain text. Only the
   * child name is a link, and only while it is genuinely openable and the
   * callback exists; geometry comes from the final clipped paint.
   */
  private collapsedRow(item: SubagentRecordItem, last: boolean, width: number): { line: string; link?: SubagentLinkSpan } {
    const branch = last ? BRANCH.last : BRANCH.more
    const head = branch + DOT + ' '
    const separator = dim(' · ')
    const identity = recordIdentity(item, this.flags.subagentEntries)
    const linkable = this.flags.onSubagentDetails !== undefined && identity.openable
    const hovered = linkable && this.links.hoveredId === this.memberBoxIdValue(item.id)
    const styled = linkable ? subagentLinkStyle(hovered)(identity.label) : bold(t.text(identity.label))
    if (item.kind === 'subagent-message') {
      const title = recordTitle(item)
      const prefix = head + bold(t.text(title)) + separator
      const raw = `${prefix}${styled}`
      return subagentPaintedLink(raw, width, visibleWidth(prefix), visibleWidth(identity.label), linkable)
    }
    const tone = subagentTone(item.entry)
    const status = subagentStatusLabel(item.entry)
    const statusText = subagentStatusStyle(tone, status)
    // The full native status is reserved, so a long label can never push it off.
    const labelRoom = Math.max(1, width - visibleWidth(head) - visibleWidth(separator) - visibleWidth(status))
    const label = truncateToWidth(identity.label, labelRoom)
    const labelStyled = linkable ? subagentLinkStyle(hovered)(label) : bold(t.text(label))
    let raw = `${head}${labelStyled}${separator}${statusText}`
    if (item.entry.status === 'running') {
      const activity = subagentActivity(item.entry)
      if (activity !== undefined && width >= 60) raw = appendIfFits(raw, t.muted(oneLine(activity, 100)), width)
    }
    return subagentPaintedLink(raw, width, visibleWidth(head), visibleWidth(label), linkable)
  }

  // --- mouse -----------------------------------------------------------------

  private headerBoxIdValue(): string {
    return `${this.key}#header`
  }

  private memberBoxIdValue(id: string): string {
    return `${this.itemId}:m:${id}`
  }

  /**
   * Re-declare this frame's links.
   *
   * Only two kinds exist: the header disclosure control (it can never open a
   * child) and a collapsed member's child **name**. An expanded member's name
   * link belongs to the member block itself, which keeps its own gesture state.
   * There is deliberately no body hitbox: an expanded body is plain, selectable
   * text, so a press there can never be re-derived as a child navigation or as a
   * collapsed row after a repaint.
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
      if (!expanded) {
        // Only a visible child name is a navigation link; every other cell of a
        // collapsed row is plain text with native selection/copy.
        const handler = this.flags.onSubagentDetails
        if (handler !== undefined) {
          for (const [index, row] of this.collapsedRows.entries()) {
            if (row.link === undefined) continue
            const member = this.members[index]
            if (member === undefined) continue
            boxes.push({
              id: this.memberBoxIdValue(member.item.id),
              startRow: index + 1,
              endRow: index + 1,
              startCol: row.link.startCol,
              endCol: row.link.endCol,
              claimPress: true,
              onClick: () => handler(row.sessionId),
              onHover: () => { this.flags.onRenderRequest?.() },
            })
          }
        }
      }
    }
    this.links.sync(boxes)
    this.frameBoxes = boxes
  }

  /**
   * Route a pointer event.
   *
   * An expanded member row resolves to the real member block first (its own
   * name-only links and their own gesture rules), with the row and column
   * re-based into the member's coordinate space; the returned target keeps that
   * member for the rest of the gesture. Everything else belongs to this group's
   * own links (header, collapsed member names) and never to a fallback by
   * coordinates. Motion is never claimed.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const span = this.rows.find(entry => event.y >= entry.startRow && event.y <= entry.endRow)
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