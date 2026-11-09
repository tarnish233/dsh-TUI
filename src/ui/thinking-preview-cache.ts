/**
 * Wrap-measurement cache for one {@link ThinkingBlock}: the collapsed tail
 * preview, its exact hidden line count and the lazily requested expanded body.
 *
 * The UX contract (see `thinking-block.ts`) is that the summary counts *real*
 * wrap lines at the width being rendered, exactly like
 * `wrap(sanitize(text).replace(/\s+$/, ''), bodyWidth)`, and that the preview is
 * the tail of that wrap. A reasoning run grows token by token, so doing that
 * whole computation per frame re-wraps an ever longer document - including the
 * frames that only move a hover or a live timer.
 *
 * ## What this module reuses, and why it is exact
 *
 * Pi's `wrapTextWithAnsi` is a greedy left-to-right filler: tokens are appended
 * to the current line until the next one does not fit, then the line is closed
 * (trailing whitespace trimmed) and the whitespace token that caused the break
 * is dropped. Two consequences matter here:
 *
 *  1. Appending text can only change the **last** wrap line. Every earlier line
 *     was closed by a break that a longer suffix cannot reopen.
 *  2. Re-wrapping `lastLine + appendedText` reproduces that last line and its
 *     continuation exactly: the same characters are re-tokenized from the same
 *     line boundary, so grapheme/CJK/long-word breaking sees identical input.
 *     This holds for the sequence of wrap-input characters it is given; what puts
 *     those characters together is `pending`/`sanitize(delta)`, which is only
 *     trusted while the retained source has no escape history.
 *
 * So a state keeps `total` (exact wrap line count), the last `tailLines` lines,
 * the text of the last wrap line, and the whitespace that the `\s+$` trim of the
 * wrap input currently swallows. An append then wraps only
 * `lastLine + trimmedDelta`, and the count is `total - 1 + wrapped.length`. The
 * preview-slice and the hidden count are derived from those numbers, so a
 * timer/hover repaint, or a change of `previewLines` 0..10, costs nothing. A
 * long paragraph without newlines and a single huge unbreakable token need no
 * extra fallback: the last visual line is only one line wide, so the restart
 * region stays small either way.
 *
 * Two seams are handled explicitly instead of being approximated:
 *
 *  - **Paragraph end.** `wrapTextWithAnsi` returns a paragraph that fits in one
 *    line *untrimmed*, while a paragraph that wraps greedily has every line
 *    `trimEnd()`ed. A restarted suffix can take the first path where the full
 *    paragraph took the second. `paraLines` (wrap lines of the final logical
 *    paragraph) records which one applies, so the restart result is trimmed
 *    exactly when the real paragraph is greedy.
 *  - **Empty paragraphs.** Consecutive newlines are real empty paragraphs and
 *    each still contributes a wrap line (`wrap('')` is `['']`), so an empty
 *    middle slice is wrapped rather than skipped.
 *
 * The expanded body is separate and **lazy**: it is only built when the run is
 * open, it is cached per (source, width) and it is also advanced incrementally
 * on appends (`previousLines.slice(0, -1) + appendedLines`). Cached lines are
 * always unstyled; the block applies theme/italic/hover styling at output time,
 * so no stale ANSI or theme colour can be served from here.
 *
 * ## Deliberate conservative fallbacks (correctness over reuse)
 *
 * The incremental path is taken only when *all* of these hold; otherwise the
 * state is rebuilt with one `sanitize` + one full `wrap`, i.e. exactly the old
 * cost, and the output is unchanged:
 *
 *  - same width and the new source extends the previous source (`startsWith`).
 *    A rewrite, a shorter text, a removal or a width change always rebuilds.
 *  - the retained source has no escape history and no trailing `\r`. This is
 *    deliberately blunter than tracking only the *last* escape: `sanitize()` is
 *    sequential, and removing an OSC can expose an earlier unfinished CSI, so
 *    `sanitize(prefix) + sanitize(delta)` is not `sanitize(prefix + delta)` as
 *    soon as any ESC is in play. Any ESC in the retained source therefore
 *    disables the append path (`appendBoundarySettled`); the exactness claim
 *    below is about the wrap arithmetic, not about splicing a sanitizer history.
 *    Those runs rebuild per append for the few frames an escape is retained.
 *  - the previous state still retains its source: a run dropped for exceeding
 *    the memory budget keeps only its accounting behind an explicit
 *    `raw: undefined` sentinel, which can never equal a real source (a genuinely
 *    empty run is `''` and stays a normal cache hit).
 *
 * Trailing whitespace is not a fallback: the trimmed-off suffix is carried in
 * `pending` and prepended to the next delta, so `a b ` + `c` still wraps as
 * `a b c` rather than `a bc`.
 *
 * ## Bounds
 *
 * All state lives in this instance (one per ThinkingBlock), never in a module
 * level map: an item that leaves the transcript drops it with the block. Inside
 * the instance, entries are keyed by run index and bounded by `maxStates`, and
 * retained characters (source + tail lines + cached expanded body) are bounded
 * by `maxChars`. A run whose own state exceeds the whole budget keeps only its
 * accounting and is rebuilt from scratch on the next frame instead of being
 * retained.
 */
import { sanitize, wrap } from './text.ts'

/** Wrapper/sanitizer seams; tests inject counting versions of the real ones. */
export type ThinkingWrapFn = (text: string, width: number) => string[]
export type ThinkingSanitizeFn = (text: string) => string

export interface ThinkingPreviewCacheOptions {
  /** Defaults to the shared `wrap()` from `text.ts` (Pi `wrapTextWithAnsi`). */
  readonly wrap?: ThinkingWrapFn
  /** Defaults to the shared `sanitize()` from `text.ts`. */
  readonly sanitize?: ThinkingSanitizeFn
  /** Retained tail lines; must cover the preview setting (max 10) comfortably. */
  readonly tailLines?: number
  /** Max run states kept per block. */
  readonly maxStates?: number
  /** Max retained characters (source, tail lines, cached expanded body). */
  readonly maxChars?: number
}

export interface ThinkingBodyMeasure {
  /** `sanitize(text).trim() === ''`: the run renders nothing at all. */
  readonly empty: boolean
  /** Exact wrap line count of the whole run at this width. */
  readonly total: number
  /** Rendered lines: the tail `previewLines`, or everything when expanded. */
  readonly lines: readonly string[]
  /** `total - lines.length`. */
  readonly hidden: number
}

export interface ThinkingPreviewCacheStats {
  readonly hits: number
  readonly appends: number
  readonly rebuilds: number
  readonly expandedHits: number
  readonly expandedBuilds: number
  readonly wraps: number
  readonly wrappedChars: number
  readonly sanitizes: number
  readonly sanitizedChars: number
}

/** Wrap input trailing whitespace, matching the block's historical `wrap()` call. */
const TRAILING_WHITESPACE = /\s+$/

const DEFAULT_TAIL_LINES = 24
const DEFAULT_MAX_STATES = 16
const DEFAULT_MAX_CHARS = 256 * 1024

interface ExpandedBody {
  readonly raw: string
  readonly width: number
  readonly lines: string[]
}

interface RunState {
  /**
   * Source text this state describes. `undefined` means "dropped for budget":
   * an explicit sentinel, so it can never collide with a genuinely empty
   * source (`''` is a valid cached run) and be mistaken for a cache hit.
   */
  raw: string | undefined
  width: number
  /** Source ends at a settled boundary, so the next append may be incremental. */
  safe: boolean
  empty: boolean
  /** Exact wrap line count. */
  total: number
  /** Last `tailLines` wrap lines (unstyled). */
  tail: string[]
  /** Text of the last wrap line: the restart point for the next append. */
  last: string
  /**
   * Wrap lines of the final logical paragraph. `> 1` means that paragraph wraps
   * greedily, and `wrapTextWithAnsi` trims every one of its lines - a suffix
   * restarted through `wrap()` can instead take the "fits in one line" fast path
   * and keep trailing whitespace the reference drops. Tracked so that seam stays
   * exact.
   */
  paraLines: number
  /** Whitespace the wrap-input trim currently drops; replayed on the next append. */
  pending: string
  full: ExpandedBody | undefined
  chars: number
}

/** A state that still retains its source, so an append may extend it. */
type RetainedState = RunState & { raw: string }

type UpdateKind = 'hit' | 'rebuild' | 'append'

interface Update {
  readonly state: RunState
  readonly kind: UpdateKind
  readonly previous: RunState | undefined
  /** Append: wrap lines replacing the previous last line. */
  readonly appendedLines: string[] | undefined
  /** Rebuild: the full wrap that was just computed anyway. */
  readonly rebuiltLines: string[] | undefined
}

const EMPTY_MEASURE: ThinkingBodyMeasure = { empty: true, total: 0, lines: [], hidden: 0 }

/**
 * True when an append may extend this source incrementally.
 *
 * Deliberately conservative: `sanitize()` is a sequential multi-pass rewriting
 * (OSC, then CSI, then single escapes, then CR/LF/tab/control stripping), so one
 * pass can *expose* text an earlier pass then consumes. Removing an OSC can make
 * an earlier unfinished CSI complete, e.g.
 * `\u200d文\x1b[` + `\x1b]t\x07abcdef...` sanitizes the whole text to
 * `\u200d文bcdef...` while `sanitize(prefix) + sanitize(delta)` keeps `[a`.
 * Rather than reproduce that pipeline as a second parser, any ESC anywhere in the
 * retained source disables the append path: the next append rebuilds exactly.
 * A delta that introduces the first ESC is still applied incrementally - the
 * *state it produces* is then marked unsettled, so the frame after it rebuilds.
 *
 * Consequences, all acceptable:
 *  - plain text (no ESC in the source) keeps the full append fast path;
 *  - an identical source/width is still a cache hit regardless of this flag
 *    (repeat repaints of the same text never re-sanitize);
 *  - once any escape has been seen, that run rebuilds per append until every
 *    escape scrolls out of the retained text, which for model reasoning means a
 *    few frames at most.
 *
 * A trailing `\r` is also unsettled: `\r\n` collapses to one `\n` only once
 * both bytes have arrived.
 */
function boundOption(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

function appendBoundarySettled(raw: string): boolean {
  if (raw === '') return true
  if (raw.charCodeAt(raw.length - 1) === 0x0d) return false
  return raw.lastIndexOf('\x1b') === -1
}

export class ThinkingPreviewCache {
  private readonly states = new Map<number, RunState>()
  private readonly doWrap: ThinkingWrapFn
  private readonly doSanitize: ThinkingSanitizeFn
  private readonly tailLines: number
  private readonly maxStates: number
  private readonly maxChars: number
  private counters = { hits: 0, appends: 0, rebuilds: 0, expandedHits: 0, expandedBuilds: 0, wraps: 0, wrappedChars: 0, sanitizes: 0, sanitizedChars: 0 }

  constructor(options: ThinkingPreviewCacheOptions = {}) {
    this.doWrap = options.wrap ?? wrap
    this.doSanitize = options.sanitize ?? sanitize
    // Unknown or non-finite options fall back to the finite defaults above;
    // `Math.max(1, NaN)` would otherwise make every bound `NaN` and put the
    // cache silently outside any budget.
    this.tailLines = boundOption(options.tailLines, DEFAULT_TAIL_LINES, 1)
    this.maxStates = boundOption(options.maxStates, DEFAULT_MAX_STATES, 1)
    this.maxChars = boundOption(options.maxChars, DEFAULT_MAX_CHARS, 1_024)
  }

  /**
   * Collapsed measurement: exact `total`, the last `previewLines` wrap lines and
   * the hidden count. An unchanged source/width is a hit with no sanitize, no
   * segmentation and no wrap.
   */
  preview(index: number, raw: string, width: number, previewLines: number): ThinkingBodyMeasure {
    const update = this.update(index, raw, width)
    const state = update.state
    if (state.empty) return EMPTY_MEASURE
    const shown = Math.min(state.total, Math.max(0, Math.floor(previewLines)))
    const hidden = state.total - shown
    if (shown <= 0) return { empty: false, total: state.total, lines: [], hidden }
    if (shown <= state.tail.length) {
      return { empty: false, total: state.total, lines: state.tail.slice(state.tail.length - shown), hidden }
    }
    // Only reachable when `previewLines` exceeds the retained tail window
    // (the configured maximum is far below it); fall back to the full wrap.
    const lines = this.fullLines(update, raw, width)
    return { empty: false, total: state.total, lines: lines.slice(Math.max(0, lines.length - shown)), hidden }
  }

  /** Expanded measurement: every wrap line, built lazily and cached. */
  expanded(index: number, raw: string, width: number): ThinkingBodyMeasure {
    const update = this.update(index, raw, width)
    const state = update.state
    if (state.empty) return EMPTY_MEASURE
    const lines = this.fullLines(update, raw, width)
    return { empty: false, total: state.total, lines, hidden: 0 }
  }

  /** Drop states of runs that no longer exist on this item. */
  prune(runCount: number): void {
    if (this.states.size === 0) return
    for (const index of [...this.states.keys()]) {
      if (index >= runCount) this.states.delete(index)
    }
  }

  /** Drop every cached state (content cache only; stats keep counting). */
  clear(): void {
    this.states.clear()
  }

  stats(): ThinkingPreviewCacheStats {
    return { ...this.counters }
  }

  /** Diagnostics/tests: retained run states. */
  get stateCount(): number {
    return this.states.size
  }

  /** Diagnostics/tests: retained characters for this block. */
  get retainedChars(): number {
    let chars = 0
    for (const state of this.states.values()) chars += state.chars
    return chars
  }

  // -------------------------------------------------------------------------
  // internals

  private wrapText(text: string, width: number): string[] {
    this.counters.wraps += 1
    this.counters.wrappedChars += text.length
    return this.doWrap(text, width)
  }

  private sanitizeText(text: string): string {
    this.counters.sanitizes += 1
    this.counters.sanitizedChars += text.length
    return this.doSanitize(text)
  }

  /**
   * Advance the state for `(index, raw, width)`, choosing between the hit, the
   * incremental append and the full rebuild described in the module comment.
   */
  private update(index: number, raw: string, width: number): Update {
    const previous = this.states.get(index)
    if (previous !== undefined && previous.raw === raw && previous.width === width) {
      this.counters.hits += 1
      this.touch(index, previous)
      return { state: previous, kind: 'hit', previous, appendedLines: undefined, rebuiltLines: undefined }
    }
    if (this.canAppend(previous, raw, width)) {
      const { state, lines } = this.append(index, previous as RetainedState, raw, width)
      return { state, kind: 'append', previous, appendedLines: lines, rebuiltLines: undefined }
    }
    const { state, lines } = this.rebuild(index, raw, width)
    return { state, kind: 'rebuild', previous, appendedLines: undefined, rebuiltLines: lines }
  }

  private canAppend(previous: RunState | undefined, raw: string, width: number): previous is RetainedState {
    return previous !== undefined
      && previous.width === width
      && previous.safe
      && !previous.empty
      && previous.raw !== undefined
      && raw.length > previous.raw.length
      && raw.startsWith(previous.raw)
  }

  private append(index: number, previous: RetainedState, raw: string, width: number): { state: RunState; lines: string[] } {
    const delta = this.sanitizeText(raw.slice(previous.raw.length))
    // The trim of the wrap input may have swallowed whitespace last time; replay
    // it so `a b ` + `c` still wraps as `a b c`.
    const combined = previous.pending + delta
    const kept = combined.replace(TRAILING_WHITESPACE, '')
    const pending = combined.slice(kept.length)
    // Split at the first newline: everything up to it continues the paragraph
    // that `previous.last` started, everything after it is whole paragraphs.
    const headEnd = kept.indexOf('\n')
    const headText = headEnd === -1 ? kept : kept.slice(0, headEnd)
    let headLines = this.wrapText(previous.last + headText, width)
    if (headEnd !== -1 && previous.paraLines > 1) headLines = headLines.map(line => line.trimEnd())
    const tailText = headEnd === -1 ? '' : kept.slice(headEnd + 1)
    let paraLines: number
    let lines: string[]
    if (tailText === '') {
      lines = headLines
      paraLines = previous.paraLines - 1 + headLines.length
    } else {
      const lastNl = tailText.lastIndexOf('\n')
      const finalText = lastNl === -1 ? tailText : tailText.slice(lastNl + 1)
      // Consecutive newlines are real empty paragraphs and each contributes a
      // line, so an empty slice still has to be wrapped.
      const middleLines = lastNl === -1 ? [] : this.wrapText(tailText.slice(0, lastNl), width)
      const finalLines = this.wrapText(finalText, width)
      lines = [...headLines, ...middleLines, ...finalLines]
      paraLines = finalLines.length
    }
    const merged = previous.tail.length === 0 ? lines : [...previous.tail.slice(0, -1), ...lines]
    const state: RunState = {
      raw,
      width,
      safe: appendBoundarySettled(raw),
      empty: false,
      total: previous.total - 1 + lines.length,
      tail: merged.slice(-this.tailLines),
      last: lines[lines.length - 1]!,
      paraLines,
      pending,
      full: undefined,
      chars: 0,
    }
    this.counters.appends += 1
    return { state: this.store(index, state), lines }
  }

  private rebuild(index: number, raw: string, width: number): { state: RunState; lines: string[] | undefined } {
    const cleaned = this.sanitizeText(raw)
    const kept = cleaned.replace(TRAILING_WHITESPACE, '')
    const pending = cleaned.slice(kept.length)
    this.counters.rebuilds += 1
    if (kept === '') {
      return {
        state: this.store(index, { raw, width, safe: appendBoundarySettled(raw), empty: true, total: 0, tail: [], last: '', paraLines: 0, pending, full: undefined, chars: 0 }),
        lines: undefined,
      }
    }
    const lines = this.wrapText(kept, width)
    const lastNl = kept.lastIndexOf('\n')
    const finalText = lastNl === -1 ? kept : kept.slice(lastNl + 1)
    const paraLines = finalText === kept ? lines.length : this.wrapText(finalText, width).length
    return {
      state: this.store(index, {
        raw,
        width,
        safe: appendBoundarySettled(raw),
        empty: false,
        total: lines.length,
        tail: lines.slice(-this.tailLines),
        last: lines[lines.length - 1]!,
        paraLines,
        pending,
        full: undefined,
        chars: 0,
      }),
      lines,
    }
  }

  /** Expanded lines for `state`, built once per (source, width). */
  private fullLines(update: Update, raw: string, width: number): string[] {
    const state = update.state
    const cached = state.full
    if (cached !== undefined && cached.raw === raw && cached.width === width) {
      this.counters.expandedHits += 1
      return cached.lines
    }
    const previous = update.previous
    let lines: string[]
    if (
      update.kind === 'append'
      && update.appendedLines !== undefined
      && previous !== undefined
      && previous.full !== undefined
      && previous.full.width === width
      && previous.full.lines.length === previous.total
    ) {
      // Same restart rule as the collapsed count: only the last line can grow.
      lines = [...previous.full.lines.slice(0, -1), ...update.appendedLines]
    } else if (update.rebuiltLines !== undefined) {
      lines = update.rebuiltLines
    } else {
      // Cold expansion (a hit whose body is not retained, or a state dropped for
      // budget): one sanitize + one full wrap, then cached.
      this.counters.expandedBuilds += 1
      lines = this.wrapText(this.sanitizeText(raw).replace(TRAILING_WHITESPACE, ''), width)
    }
    state.full = { raw, width, lines }
    state.chars = this.measureChars(state)
    this.trimBudget()
    return lines
  }

  private measureChars(state: RunState): number {
    let chars = (state.raw?.length ?? 0) + state.pending.length + state.last.length
    for (const line of state.tail) chars += line.length
    if (state.full !== undefined) {
      for (const line of state.full.lines) chars += line.length
    }
    return chars
  }

  private touch(index: number, state: RunState): void {
    this.states.delete(index)
    this.states.set(index, state)
  }

  private store(index: number, state: RunState): RunState {
    state.chars = this.measureChars(state)
    this.touch(index, state)
    this.trimBudget()
    return state
  }

  /** Enforce the entry and character bounds, keeping the newest entry first. */
  private trimBudget(): void {
    while (this.states.size > this.maxStates) {
      const oldest = this.states.keys().next()
      if (oldest.done === true) break
      this.states.delete(oldest.value)
    }
    let chars = this.retainedChars
    while (chars > this.maxChars && this.states.size > 1) {
      const oldest = this.states.keys().next()
      if (oldest.done === true) break
      const state = this.states.get(oldest.value)
      this.states.delete(oldest.value)
      chars -= state?.chars ?? 0
    }
    // A single state larger than the whole budget keeps only its accounting:
    // dropping the source, the expanded body and the retained lines means the
    // next frame takes the cold exact path instead of retaining an unbounded
    // string here. Correctness is unaffected; only reuse is given up.
    const newest = [...this.states.values()].pop()
    if (newest !== undefined && newest.chars > this.maxChars) {
      newest.full = undefined
      newest.raw = undefined
      newest.safe = false
      newest.pending = ''
      newest.chars = this.measureChars(newest)
    }
    if (newest !== undefined && newest.chars > this.maxChars && newest.tail.length > 1) {
      newest.tail = newest.tail.slice(-1)
      newest.chars = this.measureChars(newest)
    }
    if (newest !== undefined && newest.chars > this.maxChars) {
      newest.tail = []
      newest.last = ''
      newest.chars = this.measureChars(newest)
    }
  }
}
