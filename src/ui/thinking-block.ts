/**
 * Collapsed reasoning ("thinking") blocks in the Claude-Code style.
 *
 * One reasoning run renders as a single one-line summary plus a tail preview,
 * never as a raw dump:
 *
 *   collapsed  ✻ Thought for 5s · 7 more lines · click to show more
 *   streaming  ✻ Thinking… · 2s · 4 more lines · click to show more
 *   expanded   ✻ Thought for 5s · click to collapse
 *                …the full reasoning text, wrapped, no line cap
 *
 * Honesty rules:
 *   - a duration is only printed when the caller measured one; a run with no
 *     timing data renders as `✻ Thought` and the streaming form only shows the
 *     elapsed time it can actually compute;
 *   - `n more lines` counts real wrap lines at the width being rendered
 *     (`wrapTextWithAnsi` semantics), including a long paragraph that emits no
 *     newline at all;
 *   - the preview is the *tail* of the run, so the newest reasoning stays
 *     visible while streaming;
 *   - the affordance never over-claims: `show more` only appears when wrap
 *     lines are actually hidden, and `collapse` only while the body is open.
 *
 * Performance: the wrap measurement (exact line count + tail lines, and the
 * expanded body on demand) is delegated to {@link ThinkingPreviewCache}. It
 * never re-wraps the stable prefix of a growing run, returns cached numbers for
 * a timer/hover-only repaint, and caches unstyled lines only - styling is
 * applied here at output time. Hover, expansion and `clear()` therefore keep the
 * content cache; a width change, a rewritten/shortened source or an unsettled
 * escape boundary inside the cache falls back to one full exact pass.
 *
 * Mouse: one full-width hitbox per summary row (expand/collapse) and, while a
 * run is expanded, one click-only hitbox over that run's own body rows
 * (`claimPress: false`, so text selection and drag keep working and only an
 * undragged native click collapses — the same entry point as the reference
 * implementation's "click anywhere in the body" behavior). Body bounds stop at
 * the next run's summary and never cover the following message. Hitboxes are
 * declared in the owning item block's coordinate space (the caller passes its
 * `rowOffset`), synced through `HitboxRegistry` every frame, and dispatch is
 * delegated to that registry — this module never parses terminal input itself.
 * Hover styling is driven by the registry's `onHover` callback; this module
 * only remembers which summary row is hovered and asks for a repaint.
 */
import type { TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { TranscriptThinkingRun } from '../state/transcript.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import { fit, visibleWidth } from './text.ts'
import { ThinkingPreviewCache } from './thinking-preview-cache.ts'
import { italic, t } from './theme.ts'

/** A reasoning run as the transcript store projects it. */
export type ThinkingRun = TranscriptThinkingRun

/** Where the collapsed summary advertises its affordance. */
export type ThinkingScreen = 'inline' | 'fullscreen'

const MARKER = '✻'
const INDENT = '  '

/**
 * Expansion state is module level on purpose: an item block is rebuilt whenever
 * the view cache drops it (session switch, width change, kind change), and the
 * user's expanded reasoning must survive that recreation.
 *
 * Key = `{itemId}:{runIndex}`. Cleared by the parent on session switch through
 * {@link clearThinkingExpansion}.
 */
const expansion = new Map<string, boolean>()

/**
 * Monotone generation of the reasoning disclosure map (see
 * `toolExpansionRevision`): a block that cached its lines also cached this
 * generation, so a flip repaints it even without a new item version.
 */
let expansionRevision = 0

/** Generation of the reasoning disclosure map. */
export function thinkingExpansionRevision(): number {
  return expansionRevision
}

/** Stable expansion key for one reasoning run of one transcript item. */
export function thinkingExpansionKey(itemId: string, runIndex: number): string {
  return `${itemId}:${runIndex}`
}

export function isThinkingExpanded(key: string): boolean {
  return expansion.get(key) === true
}

export function setThinkingExpanded(key: string, expanded: boolean): void {
  const before = expansion.has(key)
  if (expanded) expansion.set(key, true)
  else expansion.delete(key)
  if (before !== expanded) expansionRevision += 1
}

/** Drop every expanded run (session switch / resume). */
export function clearThinkingExpansion(): void {
  if (expansion.size === 0) return
  expansion.clear()
  expansionRevision += 1
}

/**
 * Carry expanded runs from one item identity to another.
 *
 * The live attempt is a tentative display item; when the native settlement
 * replaces it, the durable item has its own native id (`assistant:<seq>`).
 * Without this transfer an expanded long thought would silently collapse on
 * that frame - the exact "tool appears wrong/unstable after long Thinking"
 * handoff. Only the module-level disclosure entries move; no durable id, seq,
 * run text or timing is touched.
 */
export function adoptThinkingExpansion(fromItemId: string | undefined, toItemId: string): void {
  if (fromItemId === undefined || fromItemId === '' || fromItemId === toItemId) return
  const prefix = `${fromItemId}:`
  let moved = false
  for (const [key, expanded] of [...expansion]) {
    if (!key.startsWith(prefix)) continue
    const run = key.slice(prefix.length)
    if (!/^\d+$/.test(run)) continue
    expansion.delete(key)
    if (expanded) expansion.set(`${toItemId}:${run}`, true)
    moved = true
  }
  if (moved) expansionRevision += 1
}

/** Diagnostics/tests: how many runs are currently expanded. */
export function thinkingExpandedCount(): number {
  return expansion.size
}

/**
 * `Thought for …` duration text.
 *
 *   <1s   -> `999ms`
 *   <60s  -> `5s`
 *   >=60s -> `1m 20s` (`1m` when the seconds round away)
 *
 * `undefined` (or a non-finite value) yields `''` so callers never print a
 * placeholder like `0ms` or `--` for a run whose timing nobody measured.
 */
export function formatThinkingDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const rounded = Math.max(0, Math.round(ms))
  if (rounded < 1000) return `${rounded}ms`
  const totalSeconds = Math.round(rounded / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

/** A run is still producing text when it started but has no fixed duration. */
export function isThinkingRunLive(run: ThinkingRun): boolean {
  return run.durationMs === undefined && run.startedAt !== undefined
}

export interface ThinkingRenderInput {
  readonly runs: readonly ThinkingRun[]
  /** Full width available to the item block. */
  readonly width: number
  /** Collapsed preview line count (`Settings.thinkingPreviewLines`); 0 = summary only. */
  readonly previewLines: number
  /** Wording source for the affordance hint. */
  readonly screen: ThinkingScreen
  /** Display label of `app.thinking.toggle`; empty means the action is unbound. */
  readonly toggleKey: string
  /** Row of this section inside the owning item block (hitbox coordinates). */
  readonly rowOffset: number
}

export interface ThinkingKeyInput {
  readonly runs: readonly ThinkingRun[]
  readonly previewLines: number
  readonly screen: ThinkingScreen
  readonly toggleKey: string
}

export interface ThinkingBlockOptions {
  /** Owning transcript item id; part of every expansion key. */
  readonly itemId: string
  /** Repaint request for hover/click/timer. Never writes stdout. */
  readonly onRenderRequest?: () => void
  /** Clock for an in-progress run; injectable for deterministic tests. */
  readonly now?: () => number
  /**
   * Wrap-measurement cache; injectable so tests can hand in instrumented
   * `wrap`/`sanitize` seams. Defaults to a private per-block instance.
   */
  readonly previewCache?: ThinkingPreviewCache
  /**
   * Click-driven viewport anchor. Called BEFORE the expansion state flips so
   * the app can freeze follow-end scrolling: without it, content growth drags
   * the viewport to the bottom and the clicked summary row jumps away from
   * under the pointer, which makes the collapse click miss the hitbox.
   * `expanding` is true when the click is about to EXPAND the run.
   */
  readonly onViewportAnchor?: (expanding: boolean) => void
  /**
   * Read-only projection (historical detail): never read the module-level
   * expanded-run map and never write it. Runs stay collapsed and a click is
   * inert, so a second view cannot collapse or inherit live reasoning state.
   */
  readonly readonly?: boolean
}

interface RunPlan {
  readonly key: string
  readonly hitboxId: string
  readonly summary: string
  readonly body: readonly string[]
  readonly summaryRow: number
  /** Rows of this run's body rendered under the summary in this frame. */
  readonly bodyRows: number
  /** Whether the body is the full run (`true`) or the collapsed preview. */
  readonly expanded: boolean
}

/**
 * The thinking section of one transcript item.
 *
 * The owning item block calls {@link render} while building its frame, then
 * {@link sync} so the registry reflects that frame, and forwards mouse events
 * with {@link handleMouse}. Layout and expansion are shared across runs and
 * kept in the module-level map above.
 */
export class ThinkingBlock {
  readonly itemId: string
  private readonly options: ThinkingBlockOptions
  private readonly registry = new HitboxRegistry()
  private readonly cache: ThinkingPreviewCache
  private hovered: string | undefined
  private boxes: MouseHitbox[] = []
  private plans: RunPlan[] = []

  constructor(options: ThinkingBlockOptions) {
    this.options = options
    this.itemId = options.itemId
    this.cache = options.previewCache ?? new ThinkingPreviewCache()
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /**
   * Effective expansion of one run for this block.
   *
   * Read-only projections are always collapsed: they neither inherit a
   * same-key live override nor mutate the shared map.
   */
  private expandedOf(key: string): boolean {
    return this.options.readonly === true ? false : isThinkingExpanded(key)
  }

  private requestRender(): void {
    this.options.onRenderRequest?.()
  }

  /**
   * Rendered elapsed text of an in-progress run. A clock that has not moved yet
   * yields `''` rather than `0ms`: there is no duration to claim.
   */
  private elapsed(run: ThinkingRun): string {
    if (!isThinkingRunLive(run)) return ''
    return formatThinkingDuration(Math.max(0, this.now() - (run.startedAt ?? this.now())) || undefined)
  }

  /**
   * Cache-key fragment for everything that changes the collapsed/expanded
   * frame without a new item version: preview policy, the advertised key, the
   * expanded runs, hover and the live elapsed text.
   */
  viewKey(input: ThinkingKeyInput): string {
    const parts = [
      String(input.previewLines),
      input.screen,
      input.toggleKey,
      this.hovered ?? '',
    ]
    input.runs.forEach((run, index) => {
      const key = thinkingExpansionKey(this.itemId, index)
      parts.push(`${this.expandedOf(key) ? 'open' : 'closed'}:${this.elapsed(run)}:${formatThinkingDuration(run.durationMs)}`)
    })
    return parts.join('|')
  }

  /**
   * Affordance text for the summary row, or `''` when there is nothing to do.
   *
   * Honesty rules: `show more` is only advertised while wrap lines are actually
   * hidden, and `collapse` only while the body is open — an affordance that
   * cannot change anything teaches the user that clicks do not work.
   */
  private hint(input: ThinkingRenderInput, expanded: boolean, hidden: number): string {
    if (expanded) {
      if (input.screen === 'fullscreen') return 'click to collapse'
      const key = input.toggleKey.trim()
      return key === '' ? '' : `${key} to collapse`
    }
    if (hidden <= 0) return ''
    if (input.screen === 'fullscreen') return 'click to show more'
    const key = input.toggleKey.trim()
    return key === '' ? '' : `${key} to expand`
  }

  private plan(run: ThinkingRun, index: number, input: ThinkingRenderInput, row: number): RunPlan | undefined {
    const key = thinkingExpansionKey(this.itemId, index)
    const expanded = this.expandedOf(key)
    const bodyWidth = Math.max(4, input.width - INDENT.length)
    // Reasoning text is model output: the cache sanitizes it (ANSI/control bytes
    // stripped, tabs expanded) before wrapping, so the counted lines are exactly
    // the lines rendered - and the collapsed tail is the tail of that same wrap.
    const measure = expanded
      ? this.cache.expanded(index, run.text, bodyWidth)
      : this.cache.preview(index, run.text, bodyWidth, Math.max(0, Math.floor(input.previewLines)))
    if (measure.empty) return undefined
    const hidden = measure.hidden
    const live = isThinkingRunLive(run)
    // A duration is only printed when somebody measured one: `0` means the clock
    // did not move, which is not a duration claim.
    const duration = formatThinkingDuration(run.durationMs !== undefined && run.durationMs > 0 ? run.durationMs : undefined)
    const elapsed = this.elapsed(run)
    const heading = live
      ? `Thinking…${elapsed === '' ? '' : ` · ${elapsed}`}`
      : `Thought${duration === '' ? '' : ` for ${duration}`}`
    const hiddenText = hidden > 0 && !expanded ? t.subtle(` · ${hidden} more ${hidden === 1 ? 'line' : 'lines'}`) : ''
    const hintText = this.hint(input, expanded, hidden)
    const hitboxId = `${key}#summary`
    const hint = hintText === '' ? '' : (this.hovered === hitboxId ? t.accent : t.muted)(` · ${hintText}`)
    const head = `${t.subtle(MARKER)} ${t.muted(heading)}${hiddenText}`
    let summary = `${head}${hint}`
    if (hint !== '' && visibleWidth(summary) > input.width) {
      // Over-wide summary: keep the affordance readable and truncate the
      // heading instead of dropping the only cue for the click/key.
      const room = input.width - visibleWidth(hint) - 1
      summary = room >= 4 ? `${fit(head, room)}${hint}` : fit(summary, input.width)
    }
    summary = fit(summary, input.width)
    const body = measure.lines.map((line: string) => `${INDENT}${italic(t.subtle(line))}`)
    return { key, hitboxId, summary, body, summaryRow: row, bodyRows: body.length, expanded }
  }

  /**
   * Flip one run. The viewport anchor fires BEFORE the state change so the app
   * can freeze follow-end ahead of content growth (both directions, and for the
   * keyboard path through {@link TranscriptView.toggleLatestThinking}).
   */
  private toggle(key: string): void {
    if (this.options.readonly === true) return
    const expanded = isThinkingExpanded(key)
    this.options.onViewportAnchor?.(!expanded)
    setThinkingExpanded(key, !expanded)
    this.requestRender()
  }

  /**
   * Render every non-empty run. `input.rowOffset` is the row of this section
   * inside the owning block, so hitboxes can be declared in that coordinate
   * space directly.
   */
  render(input: ThinkingRenderInput): string[] {
    // Runs that disappeared from this item must not keep their measurement state.
    this.cache.prune(input.runs.length)
    const lines: string[] = []
    const plans: RunPlan[] = []
    input.runs.forEach((run, index) => {
      const plan = this.plan(run, index, input, input.rowOffset + lines.length)
      if (plan === undefined) return
      plans.push(plan)
      lines.push(plan.summary)
      for (const line of plan.body) lines.push(line)
    })
    this.plans = plans
    this.boxes = plans.flatMap(plan => {
      const summary: MouseHitbox = {
        id: plan.hitboxId,
        startRow: plan.summaryRow,
        endRow: plan.summaryRow,
        onClick: () => { this.toggle(plan.key) },
        onHover: (entering: boolean) => {
          const next = entering ? plan.hitboxId : this.hovered === plan.hitboxId ? undefined : this.hovered
          if (next === this.hovered) return
          this.hovered = next
          this.requestRender()
        },
      }
      // An expanded run collapses from anywhere in its own body, so a long
      // thought the user just scrolled through still has a close entry point.
      // `claimPress: false` keeps press/move/drag native, so selecting the text
      // still works and only an undragged click collapses.
      const body: MouseHitbox[] = plan.expanded && plan.bodyRows > 0
        ? [{
            id: `${plan.key}#body`,
            startRow: plan.summaryRow + 1,
            endRow: plan.summaryRow + plan.bodyRows,
            claimPress: false,
            onClick: () => { this.toggle(plan.key) },
          }]
        : []
      return [summary, ...body]
    })
    return lines
  }

  /** Re-declare this frame's hitboxes. Safe to call every frame. */
  sync(): void {
    this.registry.sync(this.boxes)
  }

  /**
   * Drop every hitbox and the hover/press state behind it.
   *
   * A frame that renders nothing clickable (reasoning hidden behind the master
   * `showThinking` switch, or no runs at all) must not keep the previous
   * frame's summaries alive: a phantom hitbox would swallow a click meant for
   * text selection and flip an expansion the user cannot see.
   *
   * Only the interaction state is dropped. Hover exits, width changes and this
   * reset are harmless repaints: the sanitized/wrapped measurement stays cached
   * per (source, width), so they never pay for a re-wrap.
   */
  clear(): void {
    this.plans = []
    this.boxes = []
    this.hovered = undefined
    this.registry.clear()
  }

  /**
   * Dispatch a mouse event in the owning block's coordinate space.
   *
   * Press/click dispatch, hover transitions and click-to-expand all belong to
   * the shared {@link HitboxRegistry}; this module owns no input parsing and no
   * hit testing of its own. Rows outside every region return `undefined`, which
   * leaves text selection and wheel routing to TuiAltScreen.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.registry.handleMouse(event)
  }

  /** Hitboxes declared by the last render (diagnostics/tests). */
  hitboxes(): readonly MouseHitbox[] {
    return this.boxes
  }

  /** Plans of the last render (diagnostics/tests). */
  get runCount(): number {
    return this.plans.length
  }
}