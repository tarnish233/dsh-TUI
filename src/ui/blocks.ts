/**
 * Transcript item components in a compact Claude-Code visual language.
 *
 * Rendering rules:
 *   - every component measures with Pi TUI's width helpers and never emits a
 *     line wider than the width passed to render();
 *   - caches are keyed by item identity + version + width + option flags, so a
 *     streaming token only re-renders the one live item;
 *   - tool cards prefer DSH's native `presentCall`/`presentResult` render
 *     intents and fall back to a generic name+argument summary, never to a
 *     guess about what the tool did;
 *   - diffs come from the tool's own before/after hunk (native card or opaque
 *     `tool/result` meta). A hunk has no file coordinates, so no absolute line
 *     numbers are invented for it;
 *   - proposed/running/result states stay distinct, and an unresolved card is
 *     reported as unknown rather than an eternal "Running…";
 *   - active responses render directly; incomplete/unconfirmed responses are marked explicitly.
 *
 * Layout/algorithm attribution: agent_tui (MIT) src/ui/blocks.ts.
 */
import {
  type Component,
  Markdown,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type { SubagentEntry, TodoItem } from '../backend/types.ts'
import type {
  AssistantTranscriptItem,
  AttemptTranscriptItem,
  NoticeTranscriptItem,
  ToolTranscriptItem,
  TodosTranscriptItem,
  TranscriptItem,
  TranscriptThinkingRun,
  UserTranscriptItem,
} from '../state/transcript.ts'
import type { SubagentMessageTranscriptItem, SubagentTranscriptItem } from '../state/subagents.ts'
import { WorkspaceChangesBlock, type WorkspaceChangesDetailsRequest } from './workspace-changes.ts'
import { ImageContentBody, type ContentRenderOptions } from './image-content.ts'
import { imageMarkerLine } from './image-marker.ts'
import { toolImageOccurrences } from './image-data.ts'
import type { ImageDetailsRequest } from './image-view.ts'
import { HitboxRegistry, hoverExitEvent, type MouseHitbox } from './mouse.ts'
import { SubagentLinkHitboxes } from './subagent-link.ts'
import { countCacheKeyBuild } from './render-counters.ts'
import { toolExpansionRevision } from './tool-expansion.ts'
import { bold, cc, dim, italic, markdownTheme, t } from './theme.ts'
import { fit, oneLine, plural, sanitize, truncateToWidth, visibleWidth, wrap } from './text.ts'
import {
  adoptThinkingExpansion,
  isThinkingRunLive,
  ThinkingBlock,
  thinkingExpansionRevision,
  type ThinkingRun,
  type ThinkingScreen,
} from './thinking-block.ts'
import type { ToolGroupContext, ToolViewOptions } from './tool-view.ts'
import { ToolBlock } from './tool-block.ts'
import {
  subagentActivity,
  subagentGlyph,
  subagentLabel,
  subagentLinkStyle,
  subagentModeLabel,
  subagentOpenable,
  subagentPaintedLink,
  subagentSenderDisplay,
  subagentStatusLabel,
  subagentStatusStyle,
  subagentTone,
  type SubagentLinkSpan,
} from './subagent-format.ts'

export { toolDisplayName } from './tool-io.ts'

export interface TranscriptViewHints {
  /**
   * Display label of the effective `app.tools.expand` binding (e.g. `ctrl+o`),
   * taken from the real keymap by the parent. Omitted means "do not advertise
   * a key", so a remapped or disabled action never prints a stale shortcut.
   */
  expand?: string
  /** Effective keyboard entry for the tool I/O inspector. */
  toolsDetails?: string
  /** Display label of the effective `app.thinking.toggle` binding. Unbound by default. */
  thinking?: string
}

export interface TranscriptViewOptions extends ToolViewOptions {
  showThinking: boolean
  expandTools: boolean
  hints?: TranscriptViewHints
  /** Collapsed reasoning preview line count (`Settings.thinkingPreviewLines`). */
  thinkingPreviewLines?: number
  /** Where the collapsed summary advertises its affordance. */
  screen?: ThinkingScreen
  /** Clock for live reasoning elapsed time; injectable for deterministic tests. */
  now?: () => number
  /** Repaint hook for hover/click and the live timer. Never writes stdout. */
  onRenderRequest?: () => void
  /**
   * Click-driven viewport anchor for thinking expansion (freeze/restore
   * follow-end so the clicked summary row stays under the pointer).
   */
  onViewportAnchor?: (expanding: boolean) => void
  /** Open the parent-owned image details overlay for one occurrence. */
  onImageDetails?: (request: ImageDetailsRequest) => void
  /** Real `app.images.details` key label for the inline marker hint. */
  imageDetailsHint?: string
  /**
   * Open the read-only details surface for one identified child Session. Used
   * by the inline subagent row and by the sender of a durable trigger message.
   * Without it those rows stay inert (no fake affordance).
   */
  onSubagentDetails?: (sessionId: string) => void
  /** Optional `app.subagents.details` key label advertised on wide rows. */
  subagentDetailsHint?: string
  /**
   * Native child catalog used to resolve a durable trigger sender's real label
   * and openability. `TranscriptView` syncs this from `store.subagentEntries`
   * before every paint, so parents never assign it and nothing is fetched: the
   * catalog is already in memory, and no child Session is read for painting.
   */
  subagentEntries?: readonly SubagentEntry[]
  /**
   * Open the parent-owned per-file native diff surface for one live
   * workspace-changes card. Without it the card still paints every native fact
   * but owns no hitbox and advertises no dead click. The parent answers with the
   * `workspace-change-diff` result; this UI never reads a file or runs git.
   */
  onWorkspaceChangesDetails?: (request: WorkspaceChangesDetailsRequest) => void
  /** Optional display hint for a wide changed-files card (a real binding only). */
  workspaceChangesDetailsHint?: string
  /**
   * Read-only disclosure projection (the historical detail surface).
   *
   * When true every block bypasses the module-level reasoning/tool/group
   * expansion maps: nothing is read, written, cleared or transferred, every
   * disclosure paints collapsed and every toggle/hint is inert. The live
   * transcript's shared state is never affected by this view.
   */
  readonlyDisclosure?: boolean
}

/** Cache key for the display-only hint labels. */
const hintsKey = (hints: TranscriptViewHints | undefined): string => `${hints?.expand ?? ''}|${hints?.thinking ?? ''}`

/** Cache-key fragment for the image affordance state. */
function imageKey(flags: TranscriptViewOptions, hovered: string | undefined): string {
  return `${flags.imageDetailsHint ?? ''}|${flags.screen ?? 'inline'}|${typeof flags.onImageDetails === 'function' ? 'live' : 'inert'}|${hovered ?? ''}`
}

/** Render options for the ordered text/image body. */
function contentOptions(flags: TranscriptViewOptions, hovered: string | undefined): ContentRenderOptions {
  return {
    interactive: typeof flags.onImageDetails === 'function',
    ...(hovered === undefined ? {} : { hoveredKey: hovered }),
    ...(flags.imageDetailsHint === undefined ? {} : { hint: flags.imageDetailsHint }),
    fullscreen: flags.screen === 'fullscreen',
  }
}

/** Clickable marker hitboxes; inert when the parent supplied no handler. */
function imageHitboxes(
  itemId: string,
  markers: ReadonlyArray<{ readonly row: number; readonly key: string }>,
  flags: TranscriptViewOptions,
  onHover: (key: string, entering: boolean) => void,
): MouseHitbox[] {
  const handler = flags.onImageDetails
  if (handler === undefined) return []
  return markers.map(marker => ({
    id: `${itemId}:image:${marker.key}`,
    startRow: marker.row,
    endRow: marker.row,
    claimPress: true,
    onClick: () => handler({ key: marker.key }),
    onHover: entering => onHover(marker.key, entering),
  }))
}

/** ` (ctrl+o to expand)` only when that action really has a binding. */
function expandHint(hints: TranscriptViewHints | undefined): string {
  const key = hints?.expand?.trim() ?? ''
  return key === '' ? '' : ` (${key} to expand)`
}

/** Honest overflow marker: folded may expand, an already-expanded cap is truncated. */
function hiddenMarker(hidden: number, word: string, expanded: boolean, hints: TranscriptViewHints | undefined): string {
  const count = `… +${plural(hidden, word)}`
  return expanded ? `${count} (truncated)` : count + expandHint(hints)
}

const DOT = '⏺'
const HOLLOW = '◌'
const ELBOW = '  ⎿  '
const INDENT = '     '
const MARKER = '⏺ '
const ERROR_MARKER = '● '

/**
 * The bridge reports agent failures with a wire-level `agent error:` prefix.
 * Presentation follows CC's transcript layout: `● API Error: <headline>` with
 * the message detail indented under the marker. Other error notices keep their
 * own text under the same marker. Info notices are unchanged.
 */
function errorHeadline(firstLine: string): string {
  const match = /^agent error\b[:\s]*(.*)$/i.exec(firstLine)
  if (match === null) return firstLine
  const rest = (match[1] ?? '').trim()
  return rest === '' ? 'API Error' : `API Error: ${rest}`
}

export interface ItemBlock extends Component {
  readonly itemId: string
  readonly kind: TranscriptItem['kind']
  readonly version: number
  /**
   * Monotone generation of this block's painted frame.
   *
   * A group reuses its composed frame while its members' generations are
   * unchanged, so a child hover/expansion/update cannot be masked by the
   * group's own fast path.
   */
  readonly paintRevision?: number
  update(item: TranscriptItem): void
  /** Cancel frame-local pointer state when this item leaves the view. */
  clearMouse?(): void
  /** A grouped card delegates expansion/collapse to its containing disclosure. */
  setToolGroupContext?(context: ToolGroupContext | undefined): void
}

export function createItemBlock(item: TranscriptItem, options: TranscriptViewOptions): ItemBlock {
  switch (item.kind) {
    case 'user': return new UserBlock(item, options)
    case 'assistant': return new AssistantBlock(item, options)
    case 'tool': return new ToolBlock(item, options)
    case 'attempt': return new AttemptBlock(item, options)
    case 'notice': return new NoticeBlock(item, options)
    case 'todos': return new TodosBlock(item, options)
    case 'subagent': return new SubagentBlock(item, options)
    case 'subagent-message': return new SubagentMessageBlock(item, options)
    case 'workspace-changes': return new WorkspaceChangesBlock(item, options)
  }
}

/** Live and settled text use the same layout; lifecycle bookkeeping stays in the store. */
interface AssistantContentResult {
  readonly lines: string[]
  readonly markers: ReadonlyArray<{ readonly row: number; readonly key: string }>
}

/**
 * Thinking section plus ordered text/image body.
 *
 * The body renderer owns Markdown instances and image marker rows, so text and
 * images keep their durable content order. Marker rows are reported in this
 * block's coordinate space for the mouse layer; image bytes stay unread.
 */
function assistantContent(
  width: number,
  thinking: string,
  runs: readonly TranscriptThinkingRun[],
  body: ImageContentBody,
  block: ThinkingBlock,
  flags: TranscriptViewOptions,
  hovered: string | undefined,
  rowOffset = 0,
): AssistantContentResult {
  const out: string[] = []
  out.push(...thinkingSectionLines(block, runs, thinking, width, flags, rowOffset))
  const prefixWidth = visibleWidth(MARKER)
  const rendered = body.render(Math.max(1, width - prefixWidth), contentOptions(flags, hovered))
  const bodyLines = [...rendered.lines]
  let trimStart = 0
  while (bodyLines.length > 0 && bodyLines[0]!.trim() === '') { bodyLines.shift(); trimStart += 1 }
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === '') bodyLines.pop()
  const markers: Array<{ row: number; key: string }> = []
  if (bodyLines.length > 0) {
    // Keep the standard one-blank-row separation between the thinking section
    // and the body, matching the gap between transcript items.
    if (out.length > 0) out.push('')
    const start = out.length
    for (let index = 0; index < bodyLines.length; index += 1) {
      out.push((index === 0 ? t.text(MARKER) : ' '.repeat(prefixWidth)) + bodyLines[index]!)
    }
    for (const marker of rendered.markers) {
      const row = start + marker.row - trimStart
      if (row >= start && row < out.length) markers.push({ row, key: marker.key })
    }
  }
  return { lines: out, markers }
}

/**
 * Reasoning runs of one item: the store's per-run projection when it has one,
 * and otherwise the joined `thinking` string as a single run (a codec-less or
 * legacy projection has no boundaries to report and none are invented).
 */
export function thinkingRunsOf(item: { thinking: string; thinkingRuns?: readonly TranscriptThinkingRun[] }): readonly TranscriptThinkingRun[] {
  const projected = (item.thinkingRuns ?? []).filter(run => run.text.trim() !== '')
  if (projected.length > 0) return projected
  return item.thinking.trim() === '' ? [] : [{ text: item.thinking }]
}

/**
 * Thinking section of one item.
 *
 * `showThinking=false` keeps the historical single-line marker and leaks no
 * reasoning text; `true` hands every run to the collapsed CC-style block.
 *
 * Both non-clickable branches drop the block's hitboxes first: a frame that
 * renders no clickable summary must not keep the previous frame's regions alive
 * (that phantom hitbox would swallow a click and fire a viewport anchor for an
 * expansion nobody can see).
 */
function thinkingSectionLines(
  block: ThinkingBlock,
  runs: readonly TranscriptThinkingRun[],
  thinking: string,
  width: number,
  flags: TranscriptViewOptions,
  rowOffset: number,
): string[] {
  const visible = runs.filter(run => run.text.trim() !== '')
  if (visible.length === 0 && thinking.trim() === '') {
    block.clear()
    return []
  }
  if (!flags.showThinking) {
    block.clear()
    const key = flags.hints?.thinking?.trim() ?? ''
    return [t.muted('✻') + ' ' + italic(t.muted('Thought')) + t.subtle(key === '' ? ' (hidden)' : ` (${key} to show)`)]
  }
  return block.render({
    runs: visible.length > 0 ? visible : [{ text: thinking }],
    width,
    previewLines: flags.thinkingPreviewLines ?? 3,
    screen: flags.screen ?? 'inline',
    toggleKey: flags.hints?.thinking ?? '',
    rowOffset,
  })
}

/** Options handed to a per-item {@link ThinkingBlock}. */
function thinkingBlockOptions(
  item: TranscriptItem,
  flags: TranscriptViewOptions,
  /** Owner hook: reasoning hover/expansion changes the owner's cache key too. */
  onLocalRepaint: () => void = () => {},
): ConstructorParameters<typeof ThinkingBlock>[0] {
  return {
    itemId: item.id,
    // The reasoning block asks for a repaint on hover and on disclosure; both
    // change the owner's cache key without a new item version, so the owner's
    // cached lines must be dropped before the parent's frame is requested.
    onRenderRequest: () => {
      onLocalRepaint()
      flags.onRenderRequest?.()
    },
    ...(flags.now === undefined ? {} : { now: flags.now }),
    ...(flags.onViewportAnchor === undefined ? {} : { onViewportAnchor: flags.onViewportAnchor }),
    // Read-only detail projections never read or mutate the shared map.
    ...(flags.readonlyDisclosure === true ? { readonly: true } : {}),
  }
}

/** Cache-key fragment for the collapsed/expanded reasoning frame. */
function thinkingKey(block: ThinkingBlock, runs: readonly TranscriptThinkingRun[], flags: TranscriptViewOptions): string {
  return block.viewKey({
    runs,
    previewLines: flags.thinkingPreviewLines ?? 3,
    screen: flags.screen ?? 'inline',
    toggleKey: flags.hints?.thinking ?? '',
  })
}

abstract class CachedBlock implements ItemBlock {
  readonly itemId: string
  readonly kind: TranscriptItem['kind']
  version = 0
  /** See {@link ItemBlock.paintRevision}; bumped by every invalidation. */
  paintRevision = 0
  protected readonly flags: TranscriptViewOptions
  private cache: {
    width: number
    key: string
    lines: string[]
    /** Disclosure generations this frame was composed from. */
    expansions: { readonly tools: number; readonly thinking: number }
  } | undefined

  constructor(id: string, kind: TranscriptItem['kind'], version: number, flags: TranscriptViewOptions) {
    this.itemId = id
    this.kind = kind
    this.version = version
    this.flags = flags
  }

  update(item: TranscriptItem): void {
    if (item.version === this.version) return
    this.assign(item)
    this.version = item.version
    this.invalidate()
  }

  protected abstract assign(item: TranscriptItem): void
  protected abstract build(width: number): string[]
  protected viewKey(): string {
    return ''
  }

  /**
   * Can a key input change between two paints without an `invalidate()`?
   *
   * Only a clock does that: a live duration or an in-progress reasoning run is
   * rendered text, and the parent's paid render is what advances it. Everything
   * else — content, preferences, cwd, hover, disclosure — reaches the cache
   * through {@link update}, {@link invalidate} or a new width. Blocks that answer
   * `true` always compose a key; every other block reuses its exact cached lines
   * array when the width matches (see {@link render}).
   */
  protected clocked(): boolean {
    return false
  }

  /** Re-declare this frame's mouse hitboxes after `render`. */
  protected syncMouse(): void {}

  /**
   * Drop the composed lines of this block and of every renderer it owns.
   *
   * A `Markdown` instance memoizes its own `(text, width)` lines, so a block
   * whose output depends on a theme-level renderer (the lazy highlight grammar)
   * must forward the invalidation instead of only forgetting its own array.
   */
  invalidate(): void {
    this.paintRevision += 1
    this.cache = undefined
    this.invalidateOwned()
  }

  /** Registered renderers of this block (Markdown bodies) drop their caches. */
  protected invalidateOwned(): void {}

  /**
   * Can this block answer "nothing changed" from its own cache?
   *
   * `width` and the two module-level disclosure generations are the only key
   * inputs that can move without a content version or an `invalidate()`: hover,
   * cwd, preferences, the child catalog and item content all invalidate, and a
   * clocked block never takes this path at all.
   */
  private reusable(safeWidth: number, tools: number, thinking: number): boolean {
    const cache = this.cache
    return this.clocked() === false
      && cache !== undefined
      && cache.width === safeWidth
      && cache.expansions.tools === tools
      && cache.expansions.thinking === thinking
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const expansions = { tools: toolExpansionRevision(), thinking: thinkingExpansionRevision() }
    // Fast path: no key input can have changed since this paint, so the exact
    // lines array (and therefore every hitbox row and row span) is still valid.
    if (this.reusable(safeWidth, expansions.tools, expansions.thinking)) return this.cache!.lines
    countCacheKeyBuild()
    const key = `${this.version}|${this.viewKey()}`
    if (this.cache !== undefined && this.cache.width === safeWidth && this.cache.key === key) {
      return this.cache.lines
    }
    const lines = this.build(safeWidth).map(line => fit(line, safeWidth))
    this.cache = { width: safeWidth, key, lines, expansions }
    this.syncMouse()
    return lines
  }
}

// ---------------------------------------------------------------------------

class UserBlock extends CachedBlock {
  private text = ''
  private imageCount = 0
  private hovered: string | undefined
  private pendingBoxes: MouseHitbox[] = []
  private readonly body = new ImageContentBody('plain')
  private readonly registry = new HitboxRegistry()

  constructor(item: UserTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'user') return
    this.text = item.text
    this.imageCount = item.imageCount
    this.body.setItem(item)
  }

  protected viewKey(): string {
    return imageKey(this.flags, this.hovered)
  }

  protected syncMouse(): void {
    if (this.pendingBoxes.length === 0) this.registry.clear()
    else this.registry.sync(this.pendingBoxes)
  }

  protected invalidateOwned(): void {
    this.body.invalidate()
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.registry.handleMouse(event)
  }

  clearMouse(): void {
    this.pendingBoxes = []
    this.hovered = undefined
    this.registry.clear()
  }

  private hoverEvent(key: string, entering: boolean): void {
    const next = entering ? key : this.hovered === key ? undefined : this.hovered
    if (next === this.hovered) return
    this.hovered = next
    // Hover is a cache-key input but not a content version: the fast path must be
    // dropped explicitly or the hint would keep painting from the previous paint.
    this.invalidate()
    this.flags.onRenderRequest?.()
  }

  protected build(width: number): string[] {
    // The ordered body keeps text/image/file positions; a legacy count-only
    // message renders inert placeholders instead of pretending to be clickable,
    // and a native file keeps its own read-only metadata row.
    const rendered = this.body.render(Math.max(1, width - 2), contentOptions(this.flags, this.hovered))
    const rows = rendered.lines.length === 0 ? [''] : rendered.lines
    const markerRows = new Set(rendered.markerRows)
    const lines = rows.map((line, index) => {
      const content = `${index === 0 ? t.muted('> ') : '  '}${markerRows.has(index) ? line : t.text(line)}`
      // A full-width mist-blue band makes human turns easy to distinguish from
      // assistant output. It is the DSH dark theme's selection color.
      return t.userBg(content + ' '.repeat(Math.max(0, width - visibleWidth(content))))
    })
    this.pendingBoxes = imageHitboxes(this.itemId, rendered.markers, this.flags, (key, entering) => { this.hoverEvent(key, entering) })
    return lines
  }
}

// ---------------------------------------------------------------------------

class AssistantBlock extends CachedBlock {
  private text = ''
  private thinkingText = ''
  private runs: readonly TranscriptThinkingRun[] = []
  private interrupted = false
  private interruptCause: AssistantTranscriptItem['interruptCause']
  private hovered: string | undefined
  private pendingBoxes: MouseHitbox[] = []
  private readonly body = new ImageContentBody('markdown')
  private readonly thinkingBlock: ThinkingBlock
  private readonly registry = new HitboxRegistry()

  constructor(item: AssistantTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.thinkingBlock = new ThinkingBlock(thinkingBlockOptions(item, flags, () => { this.invalidate() }))
    // The durable item keeps its native id; only disclosure/render identity is
    // inherited from the live attempt it replaced. A read-only projection never
    // transfers (that is a mutation of the live view's shared state).
    if (flags.readonlyDisclosure !== true) adoptThinkingExpansion(item.thinkingKey, item.id)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'assistant') return
    this.text = item.text
    this.thinkingText = item.thinking
    this.runs = thinkingRunsOf(item)
    this.interrupted = item.interrupted
    this.interruptCause = item.interruptCause
    this.body.setItem(item)
  }

  protected viewKey(): string {
    return `${this.flags.showThinking ? 'think' : 'plain'}|${hintsKey(this.flags.hints)}|${this.flags.thinkingPreviewLines ?? 3}|${this.flags.screen ?? 'inline'}|${thinkingKey(this.thinkingBlock, this.runs, this.flags)}|${imageKey(this.flags, this.hovered)}`
  }

  /**
   * A live reasoning run prints its own elapsed time, which no version bump
   * announces: those paints keep composing a key so the clock keeps advancing.
   */
  protected clocked(): boolean {
    return this.runs.some(isThinkingRunLive)
  }

  protected invalidateOwned(): void {
    this.body.invalidate()
  }

  protected syncMouse(): void {
    this.thinkingBlock.sync()
    if (this.pendingBoxes.length === 0) this.registry.clear()
    else this.registry.sync(this.pendingBoxes)
  }

  /**
   * One hover owner inside the block.
   *
   * The reasoning section and the image-marker registry are two independent
   * hitbox sets; forwarding motion only to the first one that claims it leaves
   * the other's hover painted on an old row. A real `move` therefore sends the
   * synthetic outside-rect exit to the target that just lost the pointer.
   * Press pins, drags and click synthesis are untouched: this only runs for
   * plain motion, and the real event still routes to the winning child.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const thinking = this.thinkingBlock.handleMouse(event)
    if (thinking !== undefined) {
      if (event.type === 'move') this.registry.handleMouse(hoverExitEvent(event))
      return thinking
    }
    if (event.type === 'move') this.thinkingBlock.handleMouse(hoverExitEvent(event))
    return this.registry.handleMouse(event)
  }

  clearMouse(): void {
    this.thinkingBlock.clear()
    this.pendingBoxes = []
    this.hovered = undefined
    this.registry.clear()
  }

  private hoverEvent(key: string, entering: boolean): void {
    const next = entering ? key : this.hovered === key ? undefined : this.hovered
    if (next === this.hovered) return
    this.hovered = next
    // Hover is a cache-key input but not a content version: the fast path must be
    // dropped explicitly or the marker hint would keep painting the old state.
    this.invalidate()
    this.flags.onRenderRequest?.()
  }

  protected build(width: number): string[] {
    const content = assistantContent(width, this.thinkingText, this.runs, this.body, this.thinkingBlock, this.flags, this.hovered)
    this.pendingBoxes = imageHitboxes(this.itemId, content.markers, this.flags, (key, entering) => { this.hoverEvent(key, entering) })
    const out = [...content.lines]
    if (this.interrupted) out.push(`${ELBOW}${t.redSoft(interruptedLabel(this.interruptCause))}`)
    return out
  }
}

// ---------------------------------------------------------------------------

/**
 * Interruption wording from the native cancellation cause only.
 *
 * A durable interrupted reply records the truncation marker but not its cause;
 * until a recorded `turn/end{aborted}` supplies one, the line must stay neutral.
 * External causes (parent agent, hook, disposal, imported legacy records) are
 * never turned into a user action.
 */
function interruptedLabel(cause: AssistantTranscriptItem['interruptCause']): string {
  return cause === 'user' ? 'Interrupted by user' : 'Interrupted'
}

class AttemptBlock extends CachedBlock {
  private text = ''
  private thinkingText = ''
  private runs: readonly TranscriptThinkingRun[] = []
  private toolNames: readonly string[] = []
  private status: AttemptTranscriptItem['status'] = 'streaming'
  private tentative = true
  private hovered: string | undefined
  private pendingBoxes: MouseHitbox[] = []
  private readonly body = new ImageContentBody('markdown')
  private readonly plainBody = new ImageContentBody('plain')
  private readonly thinkingBlock: ThinkingBlock
  private readonly registry = new HitboxRegistry()

  constructor(item: AttemptTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.thinkingBlock = new ThinkingBlock(thinkingBlockOptions(item, flags, () => { this.invalidate() }))
    if (flags.readonlyDisclosure !== true) adoptThinkingExpansion(item.thinkingKey, item.id)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'attempt') return
    this.text = item.text
    this.thinkingText = item.thinking
    this.runs = thinkingRunsOf(item)
    this.toolNames = item.toolNames
    this.status = item.status
    this.tentative = item.tentative
    this.body.setItem(item)
    this.plainBody.setItem(item)
  }

  protected viewKey(): string {
    return `${this.flags.expandTools ? 'expand' : 'fold'}|${this.flags.showThinking ? 'think' : 'plain'}|${hintsKey(this.flags.hints)}|${this.flags.thinkingPreviewLines ?? 3}|${this.flags.screen ?? 'inline'}|${thinkingKey(this.thinkingBlock, this.runs, this.flags)}|${imageKey(this.flags, this.hovered)}`
  }

  /** A live reasoning run keeps printing its own elapsed text (see AssistantBlock). */
  protected clocked(): boolean {
    return this.runs.some(isThinkingRunLive)
  }

  protected invalidateOwned(): void {
    this.body.invalidate()
    this.plainBody.invalidate()
  }

  protected syncMouse(): void {
    this.thinkingBlock.sync()
    if (this.pendingBoxes.length === 0) this.registry.clear()
    else this.registry.sync(this.pendingBoxes)
  }

  /**
   * One hover owner inside the block.
   *
   * The reasoning section and the image-marker registry are two independent
   * hitbox sets; forwarding motion only to the first one that claims it leaves
   * the other's hover painted on an old row. A real `move` therefore sends the
   * synthetic outside-rect exit to the target that just lost the pointer.
   * Press pins, drags and click synthesis are untouched: this only runs for
   * plain motion, and the real event still routes to the winning child.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const thinking = this.thinkingBlock.handleMouse(event)
    if (thinking !== undefined) {
      if (event.type === 'move') this.registry.handleMouse(hoverExitEvent(event))
      return thinking
    }
    if (event.type === 'move') this.thinkingBlock.handleMouse(hoverExitEvent(event))
    return this.registry.handleMouse(event)
  }

  clearMouse(): void {
    this.thinkingBlock.clear()
    this.pendingBoxes = []
    this.hovered = undefined
    this.registry.clear()
  }

  private hoverEvent(key: string, entering: boolean): void {
    const next = entering ? key : this.hovered === key ? undefined : this.hovered
    if (next === this.hovered) return
    this.hovered = next
    this.invalidate()
    this.flags.onRenderRequest?.()
  }

  private label(): string {
    if (this.status === 'unknown') return 'Response result unknown (connection or turn ended)'
    return 'Incomplete response'
  }

  protected build(width: number): string[] {
    if (this.status === 'streaming' || this.status === 'committing') {
      const content = assistantContent(width, this.thinkingText, this.runs, this.body, this.thinkingBlock, this.flags, this.hovered)
      this.pendingBoxes = imageHitboxes(this.itemId, content.markers, this.flags, (key, entering) => { this.hoverEvent(key, entering) })
      const out = [...content.lines]
      if (this.toolNames.length > 0) out.push(ELBOW + t.subtle('requested: ' + this.toolNames.join(', ')))
      return out
    }
    const out = [`${t.muted(HOLLOW)} ${italic(t.muted(this.label()))}`]
    // A settled attempt keeps the label row first, so the thinking section (and
    // its hitbox rows) starts one row lower.
    out.push(...thinkingSectionLines(this.thinkingBlock, this.runs, this.thinkingText, width, this.flags, out.length))
    const body = this.tentative ? this.body : this.plainBody
    const rendered = body.render(Math.max(1, width - 2), contentOptions(this.flags, this.hovered))
    const lines = [...rendered.lines]
    let trimStart = 0
    while (lines.length > 0 && lines[0]!.trim() === '') { lines.shift(); trimStart += 1 }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
    const limit = this.tentative ? Number.POSITIVE_INFINITY : (this.flags.expandTools ? 200 : 10)
    const visible = lines.slice(0, limit)
    const markerRows = new Set(rendered.markerRows.map(row => row - trimStart))
    const start = out.length
    for (let index = 0; index < visible.length; index += 1) {
      const line = visible[index]!
      // Tentative previews keep Markdown styling; capped settled previews use
      // the muted body style, while marker rows keep their own chrome.
      const styled = markerRows.has(index + trimStart) ? line : this.tentative ? line : t.muted(line)
      out.push(`  ${styled}`)
    }
    this.pendingBoxes = imageHitboxes(
      this.itemId,
      rendered.markers
        .map(marker => ({ row: start + marker.row - trimStart, key: marker.key }))
        .filter(marker => marker.row >= start && marker.row < out.length),
      this.flags,
      (key, entering) => { this.hoverEvent(key, entering) },
    )
    if (lines.length > visible.length) {
      out.push(`  ${t.subtle(hiddenMarker(lines.length - visible.length, 'line', this.flags.expandTools, this.flags.hints))}`)
    }
    if (this.toolNames.length > 0) out.push(`${ELBOW}${t.subtle(`requested: ${this.toolNames.join(', ')}`)}`)
    return out
  }
}

// ---------------------------------------------------------------------------

class NoticeBlock extends CachedBlock {
  private level: NoticeTranscriptItem['level'] = 'info'
  private text = ''

  constructor(item: NoticeTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'notice') return
    this.level = item.level
    this.text = item.text
  }

  protected build(width: number): string[] {
    if (this.level !== 'error') {
      const prefix = `${t.muted('·')} `
      return wrap(sanitize(this.text), Math.max(1, width - visibleWidth(prefix)))
        .map((line, index) => `${index === 0 ? prefix : ' '.repeat(visibleWidth(prefix))}${t.muted(line)}`)
    }
    // CC-style error notice: one red marker row with the headline, then the
    // message detail indented to the marker width, all in the error red.
    const [first, ...rest] = sanitize(this.text).split('\n')
    const message = [errorHeadline(first), ...rest].join('\n')
    const prefixWidth = visibleWidth(ERROR_MARKER)
    return wrap(message, Math.max(1, width - prefixWidth))
      .map((line, index) => `${index === 0 ? t.redSoft(ERROR_MARKER) : ' '.repeat(prefixWidth)}${t.redSoft(line)}`)
  }
}

// ---------------------------------------------------------------------------

/** Pending / running / done glyphs stay in the transcript's box-and-circle family. */
function todoGlyph(status: TodoItem['status']): string {
  switch (status) {
    case 'completed': return cc.success('☑')
    case 'in_progress': return t.accent('◐')
    case 'pending':
    default: return t.muted('☐')
  }
}

/** Completed items recede; the running one is the only emphasised row. */
function todoContent(status: TodoItem['status'], text: string): string {
  if (status === 'completed') return dim(t.muted(text))
  if (status === 'in_progress') return bold(t.text(text))
  return t.text(text)
}

/**
 * DSH's native `todos` projection as CC's live checklist: ONE block for the
 * whole list (the store replaces it in place, so it never appends a copy per
 * update). The header carries the item count; each row carries the status glyph
 * and the wrapped step text. The projection is the truth — no step is marked
 * done here that DSH did not report as completed.
 */
class TodosBlock extends CachedBlock {
  private todos: readonly TodoItem[] = []

  constructor(item: TodosTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'todos') return
    this.todos = item.todos
  }

  protected build(width: number): string[] {
    const items = this.todos.filter(todo => todo.content.trim() !== '')
    // An empty checklist paints nothing: the block would only be chrome.
    if (items.length === 0) return []
    const lines = [`${t.muted(DOT)} ${t.muted('Todos')} ${t.subtle(`· ${items.length}`)}`]
    const glyphWidth = 2
    items.forEach((todo, index) => {
      // The first row carries the elbow, every later row aligns under it.
      const lead = index === 0 ? ELBOW : INDENT
      const room = Math.max(1, width - visibleWidth(lead) - glyphWidth)
      const content = wrap(sanitize(todo.content).trim(), room)
      content.forEach((line, lineIndex) => {
        const head = lineIndex === 0
          ? `${lead}${todoGlyph(todo.status)} `
          : `${' '.repeat(visibleWidth(lead) + glyphWidth)}`
        lines.push(head + todoContent(todo.status, line))
      })
    })
    return lines
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Native subagent rows

/** Append one low-priority segment only when the finished row still fits. */
function appendIfFits(line: string, segment: string, width: number): string {
  const next = `${line}${dim(' · ')}${segment}`
  return visibleWidth(next) <= width ? next : line
}

/**
 * ONE single-line row per direct child.
 *
 * There is no accordion and no per-run metric: the row carries the native
 * label, mode, status and (only while running) the one current activity. Mode
 * and activity disappear before the name/status when the width shrinks; the
 * final `fit` guarantees no line ever exceeds the terminal width.
 *
 * Only the visible **name** is a child-navigation link: the alignment glyph,
 * the mode/status/metrics/hint and every gap stay plain text with native
 * selection. A non-openable (external/remote) child, a missing callback or a
 * name clipped away by the final paint owns no hitbox at all, and the link
 * geometry is measured in display columns of the painted line, so CJK, emoji
 * and hostile ANSI can never widen or misplace the clickable span.
 */
class SubagentBlock extends CachedBlock {
  private entry: SubagentEntry
  private link: SubagentLinkSpan | undefined
  private readonly links = new SubagentLinkHitboxes()

  constructor(item: SubagentTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.entry = item.entry
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'subagent') return
    this.entry = item.entry
  }

  private get boxId(): string {
    return `${this.itemId}:name`
  }

  protected viewKey(): string {
    const hover = this.links.hoveredId === this.boxId ? 'hover' : 'rest'
    return `${typeof this.flags.onSubagentDetails === 'function' ? 'open' : 'inert'}|${this.flags.subagentDetailsHint ?? ''}|${hover}`
  }

  protected syncMouse(): void {
    const handler = this.flags.onSubagentDetails
    const link = this.link
    // External tasks have no local child Session: the name must not advertise
    // a details surface the parent cannot open, and a clipped-away name owns no
    // hitbox either.
    if (handler === undefined || link === undefined || !subagentOpenable(this.entry)) {
      this.links.sync([])
      return
    }
    const sessionId = this.entry.id
    this.links.sync([{
      id: this.boxId,
      startRow: 0,
      endRow: 0,
      startCol: link.startCol,
      endCol: link.endCol,
      claimPress: true,
      onClick: () => handler(sessionId),
      // The link name changes color on hover: a cache-key input, so the fast
      // path must be dropped before the parent repaints.
      onHover: () => { this.invalidate(); this.flags.onRenderRequest?.() },
    }])
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.links.handleMouse(event)
  }

  /**
   * Eviction/session-replacement teardown. An ordinary repaint (`invalidate`)
   * deliberately keeps a claimed press pinned: a row that updates in place
   * between press and release still opens the pressed child.
   */
  clearMouse(): void {
    this.link = undefined
    this.links.clear()
  }

  protected build(width: number): string[] {
    const entry = this.entry
    const tone = subagentTone(entry)
    const glyph = subagentGlyph(tone)
    const status = subagentStatusLabel(entry)
    const mode = subagentModeLabel(entry.mode)
    const separator = dim(' · ')
    const glyphWidth = visibleWidth(glyph) + 1
    const separatorWidth = visibleWidth(separator)
    const statusWidth = visibleWidth(status)
    // Mode is a secondary detail: keep it only when the row can also keep a
    // readable name plus the full status. Narrow rows degrade to name · status.
    // External is already the leaf status, so repeating "external · external"
    // would just noise the row.
    const external = entry.mode === 'external' || entry.status === 'external'
    const keepMode = !external &&
      width >= glyphWidth + separatorWidth + statusWidth + separatorWidth + visibleWidth(mode) + 8
    const reserved = glyphWidth + separatorWidth + statusWidth +
      (keepMode ? separatorWidth + visibleWidth(mode) : 0)
    // A native label may legally carry LF/CR/TAB; flatten it to one row before
    // any width math so the stored fact can never add a row to this single-line
    // row. Only the display copy is folded — the store keeps the exact label.
    const name = truncateToWidth(oneLine(subagentLabel(entry), Number.MAX_SAFE_INTEGER), Math.max(1, width - reserved))
    const head = `${glyph} `
    const linkable = this.flags.onSubagentDetails !== undefined && subagentOpenable(entry)
    const hovered = this.links.hoveredId === this.boxId
    const styledName = linkable
      ? subagentLinkStyle(hovered)(name)
      : bold(t.text(name))
    let line = head + styledName
    if (keepMode) line += separator + dim(mode)
    line += separator + subagentStatusStyle(tone, status)
    const activity = subagentActivity(entry)
    if (activity !== undefined && width >= 48) line = appendIfFits(line, t.muted(activity), width)
    const hint = this.flags.onSubagentDetails === undefined ? '' : this.flags.subagentDetailsHint?.trim() ?? ''
    if (hint !== '' && width >= 72) line = appendIfFits(line, t.subtle(hint), width)
    const painted = subagentPaintedLink(line, width, visibleWidth(head), visibleWidth(name), linkable)
    this.link = painted.link
    return [painted.line]
  }
}

/**
 * Durable settlement/trigger row (native `user/message` with an attributed
 * source). It is not a human prompt (`> ` band) and not an ephemeral notice:
 * the header states the native attribution, the body is the exact message text.
 *
 * Only the sender identity in the header is a child link, and only when the
 * native catalog already knows that child (its real label is shown) and reports
 * it openable. Without a catalog row the durable sender id is painted as plain
 * text: the header says "Subtask status updated" but never offers a click the
 * parent could not honour. The body paragraphs, the attribution title and the
 * indent stay non-navigation text.
 */
class SubagentMessageBlock extends CachedBlock {
  private item: SubagentMessageTranscriptItem | undefined
  private link: SubagentLinkSpan | undefined
  private readonly links = new SubagentLinkHitboxes()

  constructor(item: SubagentMessageTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'subagent-message') return
    this.item = item
  }

  private get boxId(): string {
    return `${this.itemId}:sender`
  }

  private sender(): { label: string; openable: boolean } {
    const item = this.item
    if (item === undefined) return { label: '', openable: false }
    return subagentSenderDisplay(item.senderSessionId, this.flags.subagentEntries)
  }

  protected viewKey(): string {
    const sender = this.sender()
    const hover = this.links.hoveredId === this.boxId ? 'hover' : 'rest'
    return `${typeof this.flags.onSubagentDetails === 'function' ? 'open' : 'inert'}|${sender.label}|${sender.openable ? 'local' : 'leaf'}|${hover}`
  }

  protected syncMouse(): void {
    const handler = this.flags.onSubagentDetails
    const item = this.item
    const link = this.link
    if (handler === undefined || item === undefined || link === undefined || !this.sender().openable) {
      this.links.sync([])
      return
    }
    const sessionId = item.senderSessionId
    this.links.sync([{
      id: this.boxId,
      startRow: 0,
      endRow: 0,
      startCol: link.startCol,
      endCol: link.endCol,
      claimPress: true,
      onClick: () => handler(sessionId),
      // The link name changes color on hover: a cache-key input, so the fast
      // path must be dropped before the parent repaints.
      onHover: () => { this.invalidate(); this.flags.onRenderRequest?.() },
    }])
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.links.handleMouse(event)
  }

  /** Eviction/session-replacement teardown; an in-place repaint keeps the pin. */
  clearMouse(): void {
    this.link = undefined
    this.links.clear()
  }

  private title(): string {
    return this.item?.sourceKind === 'agent-message' ? 'Task message received' : 'Subtask status updated'
  }

  /**
   * Body paragraphs without repeating the header. The stored `text` stays
   * exact; only an exact native prefix that the header already states is
   * removed from the paint (never a guessed summary or a relabeled message).
   */
  private paragraphs(): string[] {
    const item = this.item
    if (item === undefined) return []
    const summary = item.summary ?? ''
    let body = item.text
    if (item.sourceKind === 'agent-message') {
      const prefix = `Agent ${item.senderSessionId} sent a message: `
      if (body.startsWith(prefix)) body = body.slice(prefix.length)
    } else if (summary !== '' && body.startsWith(summary)) {
      body = body.slice(summary.length)
    }
    body = body.replace(/^\n+/, '')
    return [summary, body].map(part => sanitize(part).trim()).filter(part => part !== '')
  }

  protected build(width: number): string[] {
    const item = this.item
    if (item === undefined) return []
    const sender = this.sender()
    const title = this.title()
    const head = `${t.muted(DOT)} ${bold(t.text(title))}`
    const gap = dim(' · ')
    const linkable = this.flags.onSubagentDetails !== undefined && sender.openable
    const hovered = this.links.hoveredId === this.boxId
    // The sender is the clickable identity. It is always appended and then
    // clipped by `fit`, so a narrow terminal still shows a readable prefix of the
    // native label instead of dropping the identity entirely; the link geometry
    // covers only the columns of that name that actually survived the clip.
    const styled = linkable ? subagentLinkStyle(hovered)(sender.label) : t.text(sender.label)
    const raw = `${head}${gap}${styled}`
    const painted = subagentPaintedLink(raw, width, visibleWidth(head + gap), visibleWidth(sender.label), linkable)
    this.link = painted.link
    const out: string[] = [painted.line]
    const paragraphs = this.paragraphs()
    const room = Math.max(1, width - visibleWidth(ELBOW))
    paragraphs.forEach((paragraph, paragraphIndex) => {
      if (paragraphIndex > 0) out.push('')
      const lines = wrap(paragraph, room)
      lines.forEach((line, index) => {
        out.push(index === 0 ? ELBOW + t.text(line) : INDENT + t.text(line))
      })
    })
    return out.map(line => fit(line, width))
  }
}
