/**
 * Component adapter for the transcript store.
 *
 * The view owns one block component per stable transcript item id. Stable
 * items keep their rendered lines; only an item whose `version` changed (the
 * live attempt while tokens arrive) re-renders. The parent still owns the TUI
 * frame scheduler: this component never writes stdout.
 *
 * Mouse: the view is the transport for fullscreen pointer events. It remembers
 * the row span of every item block from the last frame and hands a re-based
 * event (block-local `y`) to the block that covers the row. Blocks declare
 * their own hitboxes through `HitboxRegistry`; the view never parses input.
 * Delegation goes through {@link dispatchToChild} so the renderer's press target
 * is the *block*: `release` and the synthesized `click` then keep the press-time
 * local row even when a repaint (streaming, live timer, hover) moved the block
 * between press and release.
 *
 * Live reasoning durations: when `thinkingLiveTimerMs > 0` this view keeps one
 * lightweight interval that asks the parent for a repaint while some reasoning
 * run is still accruing time. It only calls `onRenderRequest`; no timer ever
 * writes to the terminal, and it is unref'd so it cannot keep the process
 * alive. With `0` the display advances purely on chunk-driven renders.
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { CcKeymap } from '../input/index.ts'
import type { TranscriptStore } from '../state/transcript.ts'
import type { ToolTranscriptItem, TranscriptItem } from '../state/transcript.ts'
import {
  type ItemBlock,
  createItemBlock,
  thinkingRunsOf,
  type TranscriptViewHints,
  type TranscriptViewOptions,
} from './blocks.ts'
import { dispatchToChild, HoverOwnership, hoverRowSlot } from './mouse.ts'
import {
  planTranscriptNodes,
  releaseToolGroupContext,
  ToolGroupBlock,
  type ToolGroupMember,
} from './tool-group.ts'
import {
  ActivityGroupBlock,
  planActivityGroupNodes,
  type ActivityGroupMember,
  type ActivityMemberItem,
} from './activity-group.ts'
import {
  planSubagentGroupNodes,
  SubagentGroupBlock,
  type SubagentFrameNode,
  type SubagentGroupMember,
  type SubagentRecordItem,
} from './subagent-group.ts'
import {
  clearToolExpansion,
  isToolExpanded,
  retainToolExpansion,
  setToolExpanded,
  toolExpansionKey,
  toolGroupExpansionKey,
} from './tool-expansion.ts'
import { toolPreferences, type ToolViewOptions } from './tool-view.ts'
import type { ImageDetailsRequest } from './image-view.ts'
import {
  clearThinkingExpansion,
  isThinkingExpanded,
  setThinkingExpanded,
  thinkingExpansionKey,
  type ThinkingScreen,
} from './thinking-block.ts'

export type { TranscriptViewHints }

/**
 * Expanded reasoning state is module level (see `thinking-block.ts`). The parent
 * calls this on session switch/resume so stale keys from another conversation
 * cannot leak into the new one. The view also clears it when the store session
 * id changes, so this is the explicit, parent-owned call.
 */
export { clearThinkingExpansion } from './thinking-block.ts'

export interface TranscriptViewOptionsShape extends ToolViewOptions {
  showThinking: boolean
  expandTools: boolean
  /**
   * Display labels for the expandable/thinking affordances, derived from the
   * real keymap (see `transcriptHints`). Absent labels print no key name.
   */
  hints?: TranscriptViewHints
  /** Collapsed reasoning preview line count; defaults to 3 (Settings value). */
  thinkingPreviewLines?: number
  /**
   * Screen mode for the collapsed summary wording: fullscreen advertises a
   * click, inline advertises the `app.thinking.toggle` key. Defaults to inline.
   */
  screen?: ThinkingScreen
  /**
   * Live reasoning refresh interval in ms; `0` (or absent) leaves the display
   * chunk-driven. Settings value `thinkingLiveTimerMs`.
   */
  thinkingLiveTimerMs?: number
  /**
   * The parent has a modal overlay open: transcript hitboxes must not react to
   * pointer events behind it. Only normalized events are inspected here; the
   * view never parses raw terminal bytes.
   */
  mouseBlocked?: boolean
  /** Clock for live elapsed time; injectable for deterministic tests. */
  now?: () => number
  /**
   * Open the parent-owned image details overlay for one occurrence. Markers
   * stay inert when absent (legacy-only images, unsupported hosts).
   */
  onImageDetails?: (request: ImageDetailsRequest) => void
  /** Real `app.images.details` key label for inline marker hints. */
  imageDetailsHint?: string
  /**
   * Repaint request for hover/click and the live timer. The parent wires this
   * to its own `requestRender`; it must never write to stdout.
   */
  onRenderRequest?: () => void
  /**
   * Open the read-only details surface for one identified child Session. The
   * inline subagent row and a durable trigger row's sender both use it; without
   * it those rows stay inert instead of advertising a dead click.
   */
  onSubagentDetails?: (sessionId: string) => void
  /** Real `app.subagents.details` key label for wide row hints. */
  subagentDetailsHint?: string
  /**
   * Fold consecutive durable subagent records into one display group.
   *
   * Independent of `groupTools`: the native facts, declared order, item ids,
   * Ctrl+O disclosure and every real dialogue boundary are unchanged, only the
   * record projection is. Standalone rendering defaults to `true`; the parent
   * passes the migrated `Settings.groupSubagentMessages` value.
   */
  groupSubagentMessages?: boolean
  /**
   * Omit DSH's live todos checklist from this transcript.
   *
   * The native projection stays in the store (and in every durable event, tool
   * card and notice); only the `TodosTranscriptItem` display node is skipped.
   * The parent enables this while it hosts the same snapshot in the
   * above-editor todo dock, so the checklist is not painted twice. Default
   * `false` keeps the historical standalone transcript rendering byte-for-byte.
   */
  suppressLiveTodos?: boolean
  /**
   * Click-driven viewport anchor for thinking expansion: the parent freezes
   * follow-end before an expanding click so the clicked row stays visible,
   * and restores follow on the collapsing click.
   */
  onViewportAnchor?: (expanding: boolean) => void
}

interface CachedItemEntry {
  readonly tag: 'item'
  block: ItemBlock
  version: number
}

interface CachedGroupEntry {
  readonly tag: 'group'
  block: ToolGroupBlock
}

interface CachedSubagentGroupEntry {
  readonly tag: 'subagent-group'
  block: SubagentGroupBlock
}

interface CachedActivityGroupEntry {
  readonly tag: 'activity-group'
  block: ActivityGroupBlock
}

type CacheEntry = CachedItemEntry | CachedGroupEntry | CachedSubagentGroupEntry | CachedActivityGroupEntry

/**
 * View flags plus projection-only extras: subagent record grouping is
 * independent from the tool grouping preference (`groupTools`), and the parent
 * may suppress only the live todos display node while it hosts the dock. Both
 * are view-local display state and are not smuggled through
 * `ToolViewOptions`/`TranscriptViewOptions` (owned by the shared block
 * contract).
 */
type TranscriptFlags = TranscriptViewOptions & {
  groupSubagentMessages?: boolean
  suppressLiveTodos?: boolean
}

/** What the frame loop needs from either kind of cached block. */
interface FrameBlock {
  readonly itemId: string
  render(width: number): string[]
  invalidate(): void
  clearMouse?(): void
}

/** One rendered item block's row span in the last frame (mouse routing). */
export interface TranscriptRowSpan {
  readonly itemId: string
  readonly startRow: number
  readonly endRow: number
}

/**
 * Key labels for transcript affordances, taken from the effective keymap.
 *
 * `app.tools.expand` keeps the CC Ctrl+O meaning only while that binding
 * exists; `app.thinking.toggle` is unbound by default (Ctrl+T is the todo
 * panel), so no key is advertised unless the user actually binds it.
 * Remapped or disabled actions therefore never produce a stale hint.
 */
export function transcriptHints(keymap: CcKeymap): TranscriptViewHints {
  const first = (actionId: string): string | undefined => {
    const binding = keymap.getBindings(actionId)[0]
    return binding === undefined || binding === '' ? undefined : binding
  }
  const expand = first('app.tools.expand')
  const toolsDetails = first('app.tools.details')
  const thinking = first('app.thinking.toggle')
  return {
    ...(expand === undefined ? {} : { expand }),
    ...(toolsDetails === undefined ? {} : { toolsDetails }),
    ...(thinking === undefined ? {} : { thinking }),
  }
}

export class TranscriptView implements Component {
  readonly store: TranscriptStore
  /** Mutable by the parent; assignment of a new object is also supported. */
  options: TranscriptViewOptionsShape
  private readonly flags: TranscriptFlags
  private readonly cache = new Map<string, CacheEntry>()
  /** Item cache keys that were group members in the previous frame. */
  private groupedKeys: ReadonlySet<string> = new Set()
  /** Item blocks of the last rendered frame plus their rows, used for mouse routing. */
  private spans: Array<{ block: FrameBlock; startRow: number; endRow: number }> = []
  /**
   * The one item block / group the pointer is inside right now.
   *
   * Pointer motion is only ever forwarded to the block under the row, so a block
   * the pointer left would otherwise keep its `hovered` hitbox and paint a blue
   * "click to expand" hint on a historical card. This helper releases that
   * owner (and lets a group cascade the release to its own child) whenever
   * motion moves to another row, a gap, a wheel scroll, or a frame that no
   * longer shows the block at the same row.
   */
  private readonly hover = new HoverOwnership()
  private sessionId: string | undefined
  /** Width of the last painted frame (`0` before the first render). */
  private lastWidth = 0
  private liveTimer: ReturnType<typeof setInterval> | undefined
  private liveTimerMs = 0
  /** Set by {@link dispose}: the view is inert and never renders again. */
  private disposed = false

  constructor(store: TranscriptStore, options: TranscriptViewOptionsShape) {
    this.store = store
    this.options = options
    this.flags = { showThinking: options.showThinking, expandTools: options.expandTools, hints: options.hints }
    this.syncFlags()
  }

  private syncFlags(): void {
    this.flags.showThinking = this.options.showThinking
    this.flags.expandTools = this.options.expandTools
    this.flags.hints = this.options.hints
    this.flags.thinkingPreviewLines = this.options.thinkingPreviewLines
    this.flags.screen = this.options.screen
    this.flags.now = this.options.now
    this.flags.onRenderRequest = this.options.onRenderRequest
    this.flags.onViewportAnchor = this.options.onViewportAnchor
    this.flags.onImageDetails = this.options.onImageDetails
    this.flags.imageDetailsHint = this.options.imageDetailsHint
    this.flags.onSubagentDetails = this.options.onSubagentDetails
    this.flags.subagentDetailsHint = this.options.subagentDetailsHint
    // Presentation only: a durable settlement/trigger row shows the real child
    // label (and only then a name link) from the catalog the store already
    // holds. Nothing is fetched and no child Session is read or resumed.
    this.flags.subagentEntries = this.store.subagentEntries
    Object.assign(this.flags, toolPreferences(this.options))
    // Independent from `groupTools`: absent means the standalone default `true`,
    // and an explicit `false` (the migrated setting) restores one row per
    // durable record without changing any native fact or shared disclosure.
    this.flags.groupSubagentMessages = this.options.groupSubagentMessages
    // Parent-hosted dock only: this removes the live todos display node, never a
    // durable tool/event/notice item and never the native store projection.
    this.flags.suppressLiveTodos = this.options.suppressLiveTodos
    this.flags.onToolDetails = this.options.onToolDetails
    this.flags.onImageDetails = this.options.onImageDetails
    this.flags.imageDetailsHint = this.options.imageDetailsHint
    // The view owns the disclosure request: it is the only place that can
    // freeze the viewport *before* the state flips and ask for the repaint
    // afterwards. Key-driven and click-driven tool expansion share this path.
    this.flags.onToolExpansionRequest = (key: string, expanded: boolean) => { this.applyToolExpansionRequest(key, expanded) }
  }

  /**
   * One tool/group disclosure request.
   *
   * Deliberately limited to tool and group keys: a tool card or a group never
   * touches reasoning state, so a click cannot silently close a thought.
   *
   * Mouse single-expand (the source project's policy): opening one disclosure
   * first closes every other *root* tool card or group — never a group's child
   * cards (they are not root rows) and never a reasoning run. The candidate set
   * is the current projection, so ids that no longer exist are simply absent
   * instead of being "handled". The viewport anchor runs before any flip so the
   * clicked row stays under the pointer while the frame changes.
   */
  private applyToolExpansionRequest(key: string, expanded: boolean): void {
    if (!key.startsWith('tool:') && !key.startsWith('group:')) return
    this.options.onViewportAnchor?.(expanded)
    if (expanded) {
      for (const other of this.rootToolDisclosureKeys()) {
        if (other === key) continue
        // A card that is only open because of the global default has no override
        // yet; single-expand closes it with an explicit one.
        if (!isToolExpanded(other, this.flags.expandTools)) continue
        setToolExpanded(other, false)
      }
    }
    setToolExpanded(key, expanded)
    this.options.onToolExpansionRequest?.(key, expanded)
    this.options.onRenderRequest?.()
  }

  /**
   * Frame projection, in three display-only folds of the same declared order:
   *
   *   1. consecutive tool calls (`ToolGroupBlock`);
   *   2. consecutive tools + pure runtime settlement notices
   *      (`ActivityGroupBlock`) — only while BOTH grouping preferences are on,
   *      so either one switched off restores the previous rows exactly;
   *   3. consecutive durable subagent records (`SubagentGroupBlock`).
   *
   * Every fold is a view: the store still holds every native item, seq, sender,
   * summary and exact message text in declaration order.
   */
  private frameNodes(): readonly SubagentFrameNode[] {
    const options = this.planOptions()
    const toolNodes = planTranscriptNodes(this.store.items, options)
    // A mixed activity group is the conjunction of the two existing preferences:
    // there is no third setting and no separate behaviour to explain.
    const activityNodes = planActivityGroupNodes(toolNodes, {
      groupActivities: options.groupTools && options.groupSubagentMessages,
    })
    const nodes = planSubagentGroupNodes(activityNodes, {
      groupRecords: options.groupSubagentMessages,
    })
    if (options.suppressLiveTodos !== true) return nodes
    // Grouping runs first so hiding the checklist does not change any tool,
    // activity or subagent run boundary: the live todos item still separates
    // runs exactly as it did before, only its own display node is dropped.
    return nodes.filter(node => !(node.kind === 'item' && node.item.kind === 'todos'))
  }

  /** Root disclosure keys of the current projection (groups and ungrouped cards). */
  private rootToolDisclosureKeys(): string[] {
    const keys: string[] = []
    for (const node of this.frameNodes()) {
      if (node.kind === 'group') keys.push(toolGroupExpansionKey(node.anchor.callId))
      else if (node.kind === 'activity-group') keys.push(toolGroupExpansionKey(node.anchor.id))
      else if (node.kind === 'subagent-group') keys.push(toolGroupExpansionKey(node.anchor.id))
      else if (node.item.kind === 'tool') keys.push(toolExpansionKey(node.item.callId))
    }
    return keys
  }

  /**
   * Ctrl+O semantics: flip the global default and drop every local override.
   *
   * Local overrides are module-level and shared by cards and groups, so
   * forgetting them here is what makes the key a real master switch instead of
   * a toggle that leaves half the transcript in its old state.
   */
  toggleToolsExpanded(): void {
    this.options.expandTools = !this.options.expandTools
    clearToolExpansion()
    this.syncFlags()
    this.invalidate()
    this.options.onRenderRequest?.()
  }

  /**
   * Expanded disclosures that are visible right now: reasoning runs (only while
   * reasoning is displayed) plus root-level tool cards and groups.
   *
   * Group members are counted through their group exactly once, and nothing that
   * is hidden, removed or absorbed into a group is counted. The parent uses this
   * as its viewport-anchor counter.
   */
  get expandedDisclosureCount(): number {
    this.syncFlags()
    let count = 0
    for (const node of this.frameNodes()) {
      if (node.kind === 'group') {
        if (isToolExpanded(toolGroupExpansionKey(node.anchor.callId), this.flags.expandTools)) count += 1
        continue
      }
      if (node.kind === 'activity-group' || node.kind === 'subagent-group') {
        if (isToolExpanded(toolGroupExpansionKey(node.anchor.id), this.flags.expandTools)) count += 1
        continue
      }
      const item = node.item
      if (item.kind === 'tool') {
        if (isToolExpanded(toolExpansionKey(item.callId), this.flags.expandTools)) count += 1
        continue
      }
      if (this.flags.showThinking && (item.kind === 'assistant' || item.kind === 'attempt')) {
        const runs = thinkingRunsOf(item)
        for (let index = 0; index < runs.length; index += 1) {
          // The new durable block adopts its live disclosure key on first
          // paint. Count that pending handoff too, so viewport anchoring cannot
          // observe a spurious collapse between the event and the render.
          const current = thinkingExpansionKey(item.id, index)
          const pending = item.thinkingKey === undefined ? undefined : thinkingExpansionKey(item.thinkingKey, index)
          if (isThinkingExpanded(current) || (pending !== undefined && isThinkingExpanded(pending))) count += 1
        }
      }
    }
    return count
  }

  private planOptions(): {
    groupTools: boolean
    groupSubagentMessages: boolean
    showThinking: boolean
    suppressLiveTodos: boolean
  } {
    return {
      groupTools: this.flags.groupTools ?? true,
      // Independent display preference: default on for standalone rendering,
      // parent passes the migrated durable value.
      groupSubagentMessages: this.flags.groupSubagentMessages ?? true,
      showThinking: this.flags.showThinking,
      // Opt-in parent-hosted dock only; default false preserves standalone use.
      suppressLiveTodos: this.flags.suppressLiveTodos === true,
    }
  }

  /** Diagnostics/tests: number of item components currently retained. */
  get cachedItemCount(): number {
    return this.cache.size
  }

  /** Diagnostics/tests: row span of every item block in the last frame. */
  get rowSpans(): readonly TranscriptRowSpan[] {
    return this.spans.map(span => ({ itemId: span.block.itemId, startRow: span.startRow, endRow: span.endRow }))
  }

  /** Diagnostics/tests: the item block that currently owns the pointer hover. */
  get hoverOwnerItemId(): string | undefined {
    return (this.hover.current as FrameBlock | undefined)?.itemId
  }

  /** Diagnostics/tests: placement (`row 12`) of the current hover owner. */
  get hoverOwnerPlacement(): string | undefined {
    return this.hover.placement
  }

  /**
   * Drop the ephemeral hover of the current pointer target (parent seam).
   *
   * The view only ever sees motion that lands inside its own box, so the parent
   * calls this when the pointer leaves the transcript (editor, status dock,
   * overlay), when *it* scrolls the viewport for a key press, and before a
   * teardown it drives itself. Only hover paint is cleared: no press pin, no
   * drag, no selection, no disclosure and no focus state is touched.
   */
  releaseHover(): void {
    this.hover.release()
  }

  /** Diagnostics/tests: whether the live reasoning timer is armed. */
  get liveTimerRunning(): boolean {
    return this.liveTimer !== undefined
  }

  /** Diagnostics/tests: the view was torn down and renders nothing. */
  get isDisposed(): boolean {
    return this.disposed
  }

  invalidate(): void {
    // Every cached component — item cards *and* groups — drops its composed
    // lines, so a Settings/theme change cannot leave a group showing children
    // painted with the old preferences. An ordinary repaint only drops cached
    // lines: the registries keep their press pins so a click whose rows moved
    // between frames still lands.
    for (const entry of this.cache.values()) entry.block.invalidate()
  }

  /**
   * Shutdown path (the parent owns the App lifecycle and calls this once).
   *
   * Stops the single display timer, releases every child's group context, drops
   * the hitboxes/press pins and the cache, and goes inert: no render, no
   * repaint request, no timer re-armed. It never touches focus, the store or any
   * other component, and calling it twice is a no-op.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopLiveTimer()
    // Release the pointer hover before the blocks forget their hitboxes: a card
    // that vanished while still blue would otherwise never repaint neutral.
    this.hover.release()
    for (const entry of this.cache.values()) {
      if (entry.tag === 'group' || entry.tag === 'subagent-group' || entry.tag === 'activity-group') entry.block.dispose()
      else entry.block.clearMouse?.()
    }
    this.cache.clear()
    this.groupedKeys = new Set()
    this.spans = []
  }

  render(width: number): string[] {
    if (this.disposed) return []
    this.syncFlags()
    // A different durable session is a different conversation: expanded runs
    // keyed by the previous session's item ids would never be reachable again.
    // The parent still calls `clearThinkingExpansion()` explicitly on switch;
    // this is the safety net for a reset it did not observe. The tool/group
    // disclosures are ephemeral view state for the same reason and are cleared
    // with it.
    if (this.store.sessionId !== this.sessionId) {
      this.sessionId = this.store.sessionId
      this.hover.release()
      for (const entry of this.cache.values()) entry.block.clearMouse?.()
      this.cache.clear()
      this.groupedKeys = new Set()
      this.spans = []
      clearThinkingExpansion()
      clearToolExpansion()
    }
    const safeWidth = Math.max(1, Math.floor(width))
    // A modal owns the pointer: the transcript behind it must not keep a hint
    // painted as if the pointer were still heading for it.
    if (this.options.mouseBlocked === true) this.hover.release()
    // A terminal resize re-flows every row: no hitbox the pointer was inside
    // still occupies the same cells, so the hint reverts before the new paint.
    if (safeWidth !== this.lastWidth) {
      if (this.lastWidth !== 0) this.hover.release()
      this.lastWidth = safeWidth
    }
    const cwd = this.store.info?.cwd ?? ''
    // The projection is display-only: `store.items` keeps the declared order and
    // every tool card keeps its own item identity/cache. A group is one extra
    // cached host block anchored on its first member's call id.
    const nodes = this.frameNodes()
    // Evict what left the frame BEFORE any block is (re)assembled. A group that
    // lost its anchor must release its children while no new group owns them yet;
    // otherwise its cleanup would reset the context the frame just installed on
    // the blocks the new group took over.
    this.evictUnplanned(plannedKeys(nodes))
    const seen = new Set<string>()
    const grouped = new Set<string>()
    const disclosureKeys: string[] = []
    const spans: Array<{ block: FrameBlock; startRow: number; endRow: number }> = []
    const out: string[] = []
    for (const node of nodes) {
      let block: FrameBlock
      if (node.kind === 'item') {
        if (node.item.kind === 'tool') disclosureKeys.push(toolExpansionKey(node.item.callId))
        block = this.itemBlock(node.item, seen, cwd)
        const key = `${node.item.kind}|${node.item.id}`
        if (this.groupedKeys.has(key) && !grouped.has(key)) ungroupItem(block as ItemBlock)
      } else if (node.kind === 'activity-group') {
        const members: ActivityGroupMember[] = []
        for (const item of node.members) {
          // Tool members keep their own disclosure key (restored verbatim once
          // the group dissolves) and are marked grouped so `ungroupItem` releases
          // the delegated context when the mixed run breaks up.
          if (item.kind === 'tool') {
            disclosureKeys.push(toolExpansionKey(item.callId))
            grouped.add(`tool|${item.id}`)
          }
          members.push({ item, block: this.itemBlock(item, seen, cwd) })
        }
        block = this.activityGroupBlock(node.anchor, members, seen, cwd)
        disclosureKeys.push(toolGroupExpansionKey(node.anchor.id))
      } else if (node.kind === 'subagent-group') {
        const members: SubagentGroupMember[] = []
        for (const item of node.members) members.push({ item, block: this.itemBlock(item, seen, cwd) })
        block = this.subagentGroupBlock(node.anchor, members, seen)
        disclosureKeys.push(toolGroupExpansionKey(node.anchor.id))
      } else {
        const members: ToolGroupMember[] = []
        for (const item of node.members) {
          disclosureKeys.push(toolExpansionKey(item.callId))
          grouped.add(`tool|${item.id}`)
          members.push({ item, block: this.itemBlock(item, seen, cwd) })
        }
        block = this.groupBlock(node.anchor, members, seen, cwd)
        disclosureKeys.push(toolGroupExpansionKey(node.anchor.callId))
      }
      // Every block fits its own lines, so the view never fits them again.
      const lines = block.render(safeWidth)
      if (lines.length === 0) continue
      if (out.length > 0) out.push('')
      spans.push({ block, startRow: out.length, endRow: out.length + lines.length - 1 })
      for (const line of lines) out.push(line)
    }
    this.groupedKeys = grouped
    // A removed call must not leave a stale disclosure behind; keys of items
    // that still exist (grouped or not) are kept so ungrouping restores them,
    // while a group key is only retained for as long as a group row exists.
    retainToolExpansion(new Set(disclosureKeys))
    this.spans = spans
    // A repaint that re-based (or dropped) the hovered block moved its hitbox
    // away from a pointer that did not move: the hint must go back to neutral.
    this.hover.retain(spans.map(span => ({ component: span.block, slot: hoverRowSlot(span.startRow) })))
    this.syncLiveTimer()
    return out
  }

  /** One cached component per item key; versions update in place. */
  private itemBlock(item: TranscriptItem, seen: Set<string>, cwd: string): ItemBlock {
    const key = `${item.kind}|${item.id}`
    seen.add(key)
    const entry = this.cache.get(key)
    if (entry === undefined || entry.tag !== 'item') {
      const block = createItemBlock(item, this.flags)
      this.cache.set(key, { tag: 'item', block, version: item.version })
      applyCwd(block, cwd)
      return block
    }
    if (entry.version !== item.version) {
      entry.block.update(item)
      entry.version = item.version
    }
    applyCwd(entry.block, cwd)
    return entry.block
  }

  /** One cached group per first-member call id, holding the reused child blocks. */
  private groupBlock(
    anchor: ToolTranscriptItem,
    members: readonly ToolGroupMember[],
    seen: Set<string>,
    cwd: string,
  ): ToolGroupBlock {
    const key = `group|${anchor.id}`
    seen.add(key)
    const entry = this.cache.get(key)
    if (entry !== undefined && entry.tag === 'group') {
      entry.block.setCwd(cwd)
      entry.block.setMembers(members)
      return entry.block
    }
    const block = new ToolGroupBlock(anchor, this.flags)
    block.setCwd(cwd)
    block.setMembers(members)
    this.cache.set(key, { tag: 'group', block })
    return block
  }

  /**
   * One cached group per anchor item id, holding the reused member blocks.
   *
   * The anchor is the first member, so the component (and its disclosure state)
   * survives members joining, updating or leaving the run.
   */
  private subagentGroupBlock(
    anchor: SubagentRecordItem,
    members: readonly SubagentGroupMember[],
    seen: Set<string>,
  ): SubagentGroupBlock {
    const key = `subagent-group|${anchor.id}`
    seen.add(key)
    const entry = this.cache.get(key)
    if (entry !== undefined && entry.tag === 'subagent-group') {
      entry.block.setMembers(members)
      return entry.block
    }
    const block = new SubagentGroupBlock(anchor, this.flags)
    block.setMembers(members)
    this.cache.set(key, { tag: 'subagent-group', block })
    return block
  }

  /**
   * One cached mixed activity group per anchor item id, holding the reused member
   * blocks (real tool cards and real settlement-notice blocks).
   *
   * The anchor is the first member, so the component, its disclosure state and
   * its cache survive members joining, updating or leaving the run.
   */
  private activityGroupBlock(
    anchor: ActivityMemberItem,
    members: readonly ActivityGroupMember[],
    seen: Set<string>,
    cwd: string,
  ): ActivityGroupBlock {
    const key = `activity-group|${anchor.id}`
    seen.add(key)
    const entry = this.cache.get(key)
    if (entry !== undefined && entry.tag === 'activity-group') {
      entry.block.setCwd(cwd)
      entry.block.setMembers(members)
      return entry.block
    }
    const block = new ActivityGroupBlock(anchor, this.flags)
    block.setCwd(cwd)
    block.setMembers(members)
    this.cache.set(key, { tag: 'activity-group', block })
    return block
  }

  /**
   * Drop cached components that the frame no longer shows.
   *
   * A group releases its children's group contexts here, before the frame's own
   * groups claim them; a child that is still part of the frame keeps its block
   * (and its own cache) either way.
   */
  private evictUnplanned(planned: ReadonlySet<string>): void {
    for (const [key, entry] of [...this.cache]) {
      if (planned.has(key)) continue
      if (entry.tag === 'group' || entry.tag === 'subagent-group' || entry.tag === 'activity-group') entry.block.clearMouse()
      else entry.block.clearMouse?.()
      this.cache.delete(key)
    }
  }

  /**
   * Route one pointer event to the item block that covers the row.
   *
   * Blocks own their hitboxes; this only translates the frame row into
   * block-local coordinates. A row that belongs to no rendered block (item gap)
   * or a block with nothing clickable stays unhandled, so TuiAltScreen keeps
   * text selection and wheel routing untouched.
   *
   * The child result is forwarded with its own target (see
   * {@link dispatchToChild}), so the renderer addresses the block for the rest of
   * the gesture and a row that shifted after the press cannot steal the click.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // A disposed view (or one behind a modal overlay) owns no pointer target:
    // the transcript behind it stays inert instead of expanding a card or
    // collapsing a group nobody can see.
    if (this.disposed || this.options.mouseBlocked === true) {
      this.hover.release()
      return undefined
    }
    const span = this.spans.find(entry => event.y >= entry.startRow && event.y <= entry.endRow)
    // A wheel scroll moves every hitbox under a stationary pointer; the hint has
    // to revert instead of pointing at whatever row is there after the scroll.
    if (event.type === 'wheel') {
      this.hover.release(event)
      return undefined
    }
    const moving = event.type === 'move' || event.type === 'drag'
    if (moving) {
      // Exactly one visible target owns the hover: a new block (or the gap
      // between blocks) releases the previous one before the event routes on.
      this.hover.moveTo(
        span === undefined ? undefined : { component: span.block, slot: hoverRowSlot(span.startRow) },
        span === undefined ? event : { ...event, y: event.y - span.startRow },
      )
    }
    if (span === undefined) return undefined
    return dispatchToChild(span.block, { ...event, y: event.y - span.startRow })
  }

  /**
   * Flip the collapsed/expanded state of the LAST reasoning run.
   *
   * This is the `app.thinking.toggle` action's new semantic (expand/collapse the
   * latest thought instead of switching global visibility). It also fires the
   * viewport anchor callback, exactly like a summary click. Parent wiring:
   *
   *   case 'app.thinking.toggle': {
   *     if (!this.viewOptions.showThinking) this.viewOptions.showThinking = true
   *     else this.transcript.toggleLatestThinking()
   *     this.transcript.invalidate()
   *   }
   *
   * The first press only reveals collapsed previews; only /settings persists
   * the master switch. No new setting or backend operation belongs here.
   *
   * Returns false when the transcript holds no reasoning run at all, so the
   * parent decides what to say/do instead of the view inventing a fallback.
   */
  toggleLatestThinking(): boolean {
    for (let index = this.store.items.length - 1; index >= 0; index -= 1) {
      const item = this.store.items[index]
      if (item === undefined) continue
      if (item.kind !== 'assistant' && item.kind !== 'attempt') continue
      const runs = thinkingRunsOf(item)
      if (runs.length === 0) continue
      const key = thinkingExpansionKey(item.id, runs.length - 1)
      // Same contract as a summary click: the parent hears about the viewport
      // before the frame grows or shrinks, so a key-driven toggle cannot scroll
      // the summary out from under the pointer that is about to click it.
      const expanded = isThinkingExpanded(key)
      this.options.onViewportAnchor?.(!expanded)
      setThinkingExpanded(key, !expanded)
      this.cache.get(`${item.kind}|${item.id}`)?.block.invalidate()
      this.options.onRenderRequest?.()
      return true
    }
    return false
  }

  /**
   * True when the transcript holds reasoning but is not displaying it
   * (`showThinking === false`). Expanding a hidden section changes nothing on
   * screen, so the parent can use this to reveal it first — see
   * {@link toggleLatestThinking} for the recommended wiring.
   */
  get hasHiddenThinking(): boolean {
    if (this.options.showThinking) return false
    return this.store.items.some(item => (item.kind === 'assistant' || item.kind === 'attempt') && thinkingRunsOf(item).length > 0)
  }

  /**
   * Arm/disarm the single live-duration timer.
   *
   * It exists only while some reasoning run is still accruing time and the
   * parent supplied a repaint hook; the tick itself only asks for a frame. The
   * cache key of a live run includes its rendered elapsed text, so the repaint
   * actually advances the visible `· 2s` instead of returning stale lines.
   */
  private syncLiveTimer(): void {
    if (this.disposed) {
      this.stopLiveTimer()
      return
    }
    const interval = Math.max(0, Math.floor(this.options.thinkingLiveTimerMs ?? 0))
    const needed = interval > 0 && this.options.onRenderRequest !== undefined && this.hasLiveThinking()
    if (!needed) {
      this.stopLiveTimer()
      return
    }
    if (this.liveTimer !== undefined && this.liveTimerMs === interval) return
    this.stopLiveTimer()
    const timer = setInterval(() => { this.options.onRenderRequest?.() }, interval)
    // A UI refresh timer must never keep the event loop (or the process) alive.
    timer.unref?.()
    this.liveTimer = timer
    this.liveTimerMs = interval
  }

  private stopLiveTimer(): void {
    if (this.liveTimer === undefined) return
    clearInterval(this.liveTimer)
    this.liveTimer = undefined
    this.liveTimerMs = 0
  }

  private hasLiveThinking(): boolean {
    return this.store.items.some(item => {
      if (item.kind !== 'attempt' && item.kind !== 'assistant') return false
      return thinkingRunsOf(item).some(run => run.durationMs === undefined && run.startedAt !== undefined)
    })
  }
}
/**
 * Detach a card from a group it was rendered in.
 *
 * A card that stops being a group member owns its own disclosure again, so the
 * delegated context must go away *before* its next frame — otherwise the card
 * would keep expanding/collapsing a group that no longer contains it.
 */
function ungroupItem(block: ItemBlock): void {
  if (typeof block.setToolGroupContext !== 'function') return
  // Ownership-aware release: a card claimed by a group this frame keeps it.
  releaseToolGroupContext(block)
  block.invalidate()
}

/** Cards that display paths accept the session cwd for compact display. */
function applyCwd(block: ItemBlock, cwd: string): void {
  const withCwd = block as ItemBlock & { setCwd?: (cwd: string) => void }
  if (typeof withCwd.setCwd === 'function') withCwd.setCwd(cwd)
}

/**
 * Cache keys the projection will show this frame: one per item, one per tool
 * group and one per subagent group. Group members keep their own item key
 * because their block is reused by the group (and by the frame once the group
 * dissolves).
 */
function plannedKeys(nodes: readonly SubagentFrameNode[]): ReadonlySet<string> {
  const planned = new Set<string>()
  for (const node of nodes) {
    if (node.kind === 'item') {
      planned.add(`${node.item.kind}|${node.item.id}`)
      continue
    }
    if (node.kind === 'activity-group') {
      planned.add(`activity-group|${node.anchor.id}`)
      for (const item of node.members) planned.add(`${item.kind}|${item.id}`)
      continue
    }
    if (node.kind === 'subagent-group') {
      planned.add(`subagent-group|${node.anchor.id}`)
      for (const item of node.members) planned.add(`${item.kind}|${item.id}`)
      continue
    }
    planned.add(`group|${node.anchor.id}`)
    for (const item of node.members) planned.add(`tool|${item.id}`)
  }
  return planned
}
