/**
 * Streaming-safe Markdown body: reuse a **sealed prefix** instead of re-lexing
 * the whole message on every frame.
 *
 * The problem
 * -----------
 * `Markdown.setText()` drops the rendered lines, so a streaming assistant body
 * re-lexes and re-styles the entire message on every frame. Measured on a
 * 300-block (~2 700-line) message that is ~4.5 ms per frame, dominated by the
 * lexer's block regexes; the vendored per-block reuse cannot help because it
 * keeps its block map in a `WeakRef` that GC may collect at any time.
 *
 * The solution
 * ------------
 * Split the source at a **sealed** boundary: everything before it is rendered
 * once by one `Markdown` instance and the resulting rows are held *strongly*;
 * only the tail after the boundary is re-rendered while tokens arrive. Per-frame
 * lexer work is then bounded by the tail (one paragraph), not by the message.
 *
 * Correctness first
 * -----------------
 * A seal is only placed at a blank-line boundary whose region (since the
 * previous seal) is **paragraph/heading only**: blank lines, ATX headings,
 * setext underlines/thematic breaks, plain paragraph text, and *closed*
 * fenced-code / `$$` / `\[` math blocks.
 *
 * **Any barrier — a list, blockquote, GFM table, 4-space indented code, HTML
 * block, or a link reference definition — makes the whole document render as one
 * text from the frame it appears onward.** It clears the seal that was already
 * adopted and stops all future sealing, so "any doubt means whole text" is one
 * rule with no second scan mode. This matters because some of those constructs
 * are *retroactive*: a link reference definition is document-global (a `[ref]`
 * usage in an early paragraph becomes a link once a later definition arrives),
 * and it can hide behind an ordinary barrier — `Use [ref].\n\n- list\n\n
 * [ref]: /url\n\n` — which a scan that stopped at the list would never see.
 * Sealing only ever happens *before* such a barrier, so every prefix streamed
 * earlier was already exact; the barrier only ends the reuse.
 *
 * The boundary is consequently *not* monotone: a barrier resets it to 0.
 * {@link ScanState.documentFallback} is the explicit sticky flag; only a
 * non-append reset (a new/edited message) starts a fresh scan.
 *
 * A naive blank-line split is *not* sound: a fragment fuzz of 1 336 blank-line
 * boundaries changed the output on 135 of them (loose-list spacing, `math→*`
 * blocks, indented continuations). Those are exactly the cases these rules
 * exclude.
 *
 * Every streaming prefix is byte-identical to a fresh whole-text render; the
 * differential fuzz in `test/ui-markdown-stream.test.ts` asserts that for every
 * prefix of every generated stream, not just for the finished text.
 *
 * Non-append input (an edit, a shrink, a replacement) resets the seal: the next
 * render is one whole render and sealing then resumes from scratch. A width
 * change keeps the seal (a character index) but re-renders *both* sides at the
 * new width, so no cached row can be reused at the wrong geometry.
 *
 * This module owns no policy about *what* is rendered: it reuses the very same
 * vendored lexer/renderer and theme as the whole-text path, and adds no second
 * parser, no sanitizer and no styling of its own.
 */
import { Markdown, type MarkdownTheme } from '#pi-tui'

/** Deterministic work counters (tests/diagnostics; never a renderer input). */
export interface StreamingMarkdownStats {
  /** Times the sealed boundary moved forward. */
  readonly sealAdvances: number
  /** Renders of the sealed prefix (one per advance/width change at most). */
  readonly prefixRenders: number
  /** Renders of the streaming tail (one per changed tail text/width). */
  readonly tailRenders: number
  /** Characters handed to the prefix renderer (lexer work for sealed text). */
  readonly prefixChars: number
  /** Characters handed to the tail renderer (per-frame lexer work). */
  readonly tailChars: number
  /** Saves answered by a whole-text render (no seal yet, or a barrier). */
  readonly fallbacks: number
  /** Characters examined by the seal scanner (bounded fallback scanning). */
  readonly scanChars: number
  /** Transitions into whole-document rendering because a barrier appeared. */
  readonly documentFallbacks: number
  /**
   * Candidate boundaries refused because their prefix would not carry the
   * block separator (a `$$`/fence/rule last block renders no trailing blank
   * row, so composing it would drop or duplicate the separator).
   */
  readonly rejectedSeals: number
  /** Non-append resets (edit/shrink/replacement). */
  readonly resets: number
  /** Row references copied when a sealed prefix is concatenated with the tail. */
  readonly concatRows: number
}

/** One top-level line classification of the seal scanner. */
type LineKind =
  /** Blank line: a candidate boundary when the region so far is sealable. */
  | 'blank'
  /** Plain paragraph text: allowed. */
  | 'text'
  /** ATX heading (`#`…): allowed. */
  | 'heading'
  /** Setext underline or thematic break: a single line, allowed. */
  | 'rule'
  /** Fence / math delimiter: allowed while paired (tracked by the scanner). */
  | 'fence'
  /**
   * Construct whose closure/scope a line scan cannot prove (list, quote, table,
   * indented code, HTML block, link reference definition): the whole document
   * renders as one text from this frame on.
   */
  | 'barrier'

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const MATH_DOLLAR_LINE = /^ {0,3}\$\$\s*$/
const MATH_BRACKET_OPEN = /^ {0,3}\\\[\s*$/
const MATH_BRACKET_CLOSE = /^ {0,3}\\\]\s*$/
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
const BLOCKQUOTE = /^ {0,3}>/
const TABLE_ROW = /^ {0,3}\|/
const INDENTED = /^(?: {4}|\t)/
const HTML_BLOCK = /^ {0,3}</
/**
 * A link reference definition, in any container an indented/quote line can put
 * it in.
 *
 * CommonMark definitions are document-global regardless of the container, so
 * this is deliberately looser than the 0–3 space top-level form: any leading
 * indentation or blockquote prefix counts. A false positive only costs the
 * prefix reuse of one message (the safe direction); a false negative would paint
 * a stale, link-less prefix forever. Fenced/math content never reaches this test.
 */
const REFERENCE_DEFINITION = /^[ \t]*(?:>[ \t]?)*\[[^\]\n]+\]:/
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/
const RULE = /^ {0,3}(?:=+\s*|(?:-\s*){2,}|(?:\*\s*){3,}|(?:_\s*){3,})$/

/** Classify one top-level line (without its newline). */
function classifyLine(line: string): LineKind {
  if (line.trim() === '') return 'blank'
  // An unprovable construct first: these also *contain* markers that would
  // otherwise look like a fence or a rule.
  if (REFERENCE_DEFINITION.test(line)) return 'barrier'
  if (LIST_MARKER.test(line)) return 'barrier'
  if (BLOCKQUOTE.test(line)) return 'barrier'
  if (TABLE_ROW.test(line)) return 'barrier'
  if (INDENTED.test(line)) return 'barrier'
  if (HTML_BLOCK.test(line)) return 'barrier'
  if (FENCE_LINE.test(line)) return 'fence'
  if (MATH_DOLLAR_LINE.test(line) || MATH_BRACKET_OPEN.test(line) || MATH_BRACKET_CLOSE.test(line)) return 'fence'
  if (ATX_HEADING.test(line)) return 'heading'
  if (RULE.test(line)) return 'rule'
  return 'text'
}

/** Incremental, append-only seal scanner (the boundary is not monotone). */
interface ScanState {
  /** Character index already scanned (always a line boundary). */
  readonly scanned: number
  /**
   * Current scanner candidate (0 = none). It only moves forward while scanning;
   * a global barrier resets it to 0 and sticks.
   */
  readonly boundary: number
  /** False once an unprovable construct appeared (no further seal). */
  readonly sealable: boolean
  /**
   * Sticky document fallback: a barrier (list/quote/table/indented code/HTML
   * block/link reference definition) appeared outside a fence/math block, so no
   * prefix may be reused for this text at all.
   */
  readonly documentFallback: boolean

  /** Open fence run, or `undefined`. */
  readonly fence: { readonly char: string; readonly length: number } | undefined
  /** Open `$$` / `\[` math block, or `undefined`. */
  readonly math: 'dollar' | 'bracket' | undefined
}

function freshScan(): ScanState {
  return { scanned: 0, boundary: 0, sealable: true, documentFallback: false, fence: undefined, math: undefined }
}

/**
 * Advance one scan state over `text`, classifying only complete lines.
 *
 * A partial trailing line is left for the next call, which is what keeps the
 * boundary on a line start. Once the state is unsealable the scan stops: the
 * fallback path must stay O(1) per frame.
 */
function advanceScan(state: ScanState, text: string): ScanState {
  // A barrier is terminal: no further scanning, so the fallback path is O(1)
  // per frame (the examined-character counter stays flat).
  if (state.documentFallback) return state
  let { scanned, boundary, fence, math } = state
  while (true) {
    const newline = text.indexOf('\n', scanned)
    if (newline < 0) break
    const line = text.slice(scanned, newline)
    scanned = newline + 1

    if (fence !== undefined) {
      const match = FENCE_LINE.exec(line)
      if (match !== null && match[1]![0] === fence.char && match[1]!.length >= fence.length && match[2]!.trim() === '') {
        fence = undefined
      }
      continue
    }
    if (math !== undefined) {
      if (math === 'dollar' ? MATH_DOLLAR_LINE.test(line) : MATH_BRACKET_CLOSE.test(line)) math = undefined
      continue
    }

    const kind = classifyLine(line)
    if (kind === 'barrier') {
      // One conservative rule: the whole document renders as one text from this
      // frame on, and an adopted seal is cleared by the caller. Scanning stops
      // here, so nothing behind the barrier (including a document-global link
      // reference definition) can be missed or need a second scan.
      return { scanned, boundary: 0, sealable: false, documentFallback: true, fence, math }
    }
    if (kind === 'fence') {
      const match = FENCE_LINE.exec(line)
      if (match !== null) fence = { char: match[1]![0]!, length: match[1]!.length }
      else if (MATH_BRACKET_OPEN.test(line)) math = 'bracket'
      else if (MATH_DOLLAR_LINE.test(line)) math = 'dollar'
      // A closing delimiter without an opener is plain text: no state change.
      continue
    }
    if (kind === 'blank' && scanned > 1) {
      // A blank line after a paragraph/heading region is a complete top-level
      // block boundary: the prefix is self-contained.
      boundary = scanned
    }
  }
  // A definition that is still arriving must disable reuse *now*: the lexer
  // already resolves `[ref]: https://…` before its newline arrives, so the
  // current frame would otherwise paint a stale link-less prefix.
  if (fence === undefined && math === undefined && REFERENCE_DEFINITION.test(text.slice(scanned))) {
    return { scanned, boundary: 0, sealable: false, documentFallback: true, fence, math }
  }
  return { scanned, boundary, sealable: true, documentFallback: false, fence, math }
}

/**
 * Conservative stable-prefix boundary of one whole Markdown text.
 *
 * The returned index is where the source can be cut so that
 * `render(text[0..n)) + render(text[n..])` equals the whole render (`0` = no
 * reuse). It is `0` for any text that carries a list, blockquote, GFM table,
 * 4-space indented code, HTML block or link reference definition outside a
 * fence/math block: those are the constructs a line scan cannot prove, so the
 * whole text renders as one document. Pure and non-incremental;
 * {@link StreamingMarkdown} uses the same rules incrementally.
 */
export function stableMarkdownBoundary(text: string): number {
  return Math.min(advanceScan(freshScan(), text).boundary, text.length)
}

/**
 * Can this prefix be concatenated with a tail render?
 *
 * The whole document separates blocks with the blank row a `space` token paints.
 * A prefix that ends with such a row carries that separator; a prefix whose last
 * block is a `$$`/fence/rule paints none, so composing it would silently drop the
 * separator (or duplicate it, if the tail also starts with one).
 */
function isComposablePrefix(prefixLines: readonly string[]): boolean {
  if (prefixLines.length === 0) return false
  return prefixLines[prefixLines.length - 1]!.trim() === ''
}

/** The sealed-prefix state of one text-run slot of a streamed Markdown body. */
export class StreamingMarkdown {
  private readonly theme: MarkdownTheme
  /** Renderer of the sealed prefix (created on the first seal). */
  private prefix: Markdown | undefined
  /** Renderer of the streaming tail. */
  private readonly tail: Markdown
  /**
   * Renderer for the one transient state that cannot be composed: a partial
   * construct in the tail (`>`, ``` ``` ```, `- `) renders as blank/empty rows,
   * which the whole document merges with the prefix's separator row. Such a
   * frame is rendered as one document instead (a few frames per message).
   */
  private whole: Markdown | undefined
  private scan = freshScan()
  private lastText: string | undefined
  private lastWidth = 0

  /**
   * The adopted seal: the scanner may hand out later candidates that are not
   * composable (see {@link isComposablePrefix}), and this one stays usable.
   */
  private seal = 0
  /** Highest candidate already refused, so a frame does not retry it. */
  private rejectedCandidate = 0

  /**
   * Source currently set on `prefix`/`tail` and the width they were rendered at.
   *
   * `undefined` is the reset sentinel: it can never equal a real source or
   * width, so a reset always re-`setText`s instead of keeping the previous
   * document by accident (the exact hazard that made a replaced message keep its
   * old tail rows).
   */
  private prefixText: string | undefined
  private prefixLines: string[] = []
  private prefixWidth: number | undefined
  private tailText: string | undefined
  private tailLines: string[] = []
  private tailWidth: number | undefined
  /** Composed frame of the last render, reused as the same array when nothing moved. */
  private composed: string[] | undefined

  private counters: StreamingMarkdownStats = {
    sealAdvances: 0,
    prefixRenders: 0,
    tailRenders: 0,
    prefixChars: 0,
    tailChars: 0,
    fallbacks: 0,
    scanChars: 0,
    documentFallbacks: 0,
    rejectedSeals: 0,
    resets: 0,
    concatRows: 0,
  }

  constructor(theme: MarkdownTheme) {
    this.theme = theme
    this.tail = new Markdown('', 0, 0, theme)
  }

  /** Deterministic work counters (tests/diagnostics). */
  get stats(): StreamingMarkdownStats {
    return this.counters
  }

  /** Current sealed boundary (0 = whole-text mode). */
  get sealedAt(): number {
    return this.seal
  }

  /** Rows of the last render (identity-reused while nothing changed). */
  get lastLines(): readonly string[] | undefined {
    return this.composed ?? (this.scan.boundary === 0 ? this.tailLines : undefined)
  }

  /**
   * Drop every derived row: the tail renderer's lines *and* the sealed prefix
   * rows plus its renderer.
   *
   * Used for theme/grammar invalidation (the lazy highlight runtime arriving)
   * and for teardown: a strongly held prefix row could otherwise keep plain
   * (pre-grammar) colors forever. The next render is one whole render, and the
   * prefix re-seals as the text continues.
   */
  invalidate(): void {
    this.tail.invalidate()
    this.prefix?.invalidate()
    this.whole?.invalidate()
    this.prefix = undefined
    this.prefixText = undefined
    this.prefixLines = []
    this.prefixWidth = undefined
    this.tailText = undefined
    this.tailLines = []
    this.tailWidth = undefined
    this.composed = undefined
    this.scan = freshScan()
    this.seal = 0
    this.rejectedCandidate = 0
    // `lastText` is dropped so an unchanged text re-renders once instead of
    // returning the rows that were just invalidated.
    this.lastText = undefined
  }

  /**
   * Rows for `text` at `width`.
   *
   * Byte-identical to a fresh whole-text render for every input: the split is
   * only made where block semantics cannot cross it, and anything unprovable is
   * rendered as one document.
   */
  render(text: string, width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    if (this.lastText === text && this.lastWidth === safeWidth) {
      const stable = this.composed ?? (this.scan.boundary === 0 ? this.tailLines : undefined)
      if (stable !== undefined) return stable
    }

    const previous = this.lastText
    if (previous !== undefined && !(text.length >= previous.length && text.startsWith(previous))) {
      // Non-append: an edit/shrink/replacement makes the seal meaningless.
      this.counters = { ...this.counters, resets: this.counters.resets + 1 }
      this.scan = freshScan()
      this.seal = 0
      this.rejectedCandidate = 0
      this.prefix = undefined
      this.prefixText = undefined
      this.prefixLines = []
      this.prefixWidth = undefined
      this.tailText = undefined
      this.tailLines = []
      this.tailWidth = undefined
      this.composed = undefined
    }
    this.lastText = text
    this.lastWidth = safeWidth

    const previousScan = this.scan
    this.scan = advanceScan(this.scan, text)
    if (this.scan.scanned > previousScan.scanned) {
      this.counters = {
        ...this.counters,
        scanChars: this.counters.scanChars + (this.scan.scanned - previousScan.scanned),
      }
    }
    if (this.scan.documentFallback) {
      // A barrier makes the whole document render as one text from this frame
      // on, and some barriers are retroactive (a link reference definition
      // restyles `[ref]` usages in already sealed paragraphs), so the adopted
      // seal and every row derived from it are invalid now.
      if (this.seal !== 0 || this.prefix !== undefined || this.prefixLines.length > 0) {
        this.seal = 0
        this.rejectedCandidate = 0
        this.prefix = undefined
        this.prefixText = undefined
        this.prefixLines = []
        this.prefixWidth = undefined
        this.composed = undefined
        this.counters = { ...this.counters, documentFallbacks: this.counters.documentFallbacks + 1 }
      }
    }
    const candidate = Math.min(this.scan.boundary, text.length)
    if (candidate > this.seal && candidate !== this.rejectedCandidate) {
      // Render the candidate prefix once and only adopt it when it carries the
      // block separator itself; otherwise the earlier seal (or whole-text mode)
      // stays in force and the next paragraph boundary is tried.
      if (this.prefix === undefined) this.prefix = new Markdown('', 0, 0, this.theme)
      const candidateText = text.slice(0, candidate)
      this.prefix.setText(candidateText)
      this.prefixText = candidateText
      this.prefixWidth = safeWidth
      this.counters = {
        ...this.counters,
        prefixRenders: this.counters.prefixRenders + 1,
        prefixChars: this.counters.prefixChars + candidateText.length,
      }
      const candidateLines = this.prefix.render(safeWidth)
      if (isComposablePrefix(candidateLines)) {
        this.seal = candidate
        this.prefixLines = candidateLines
        this.composed = undefined
        this.counters = { ...this.counters, sealAdvances: this.counters.sealAdvances + 1 }
      } else {
        // `$$`/fence/rule last block: it paints no trailing separator row, so a
        // composition here would drop or duplicate the blank row the whole
        // document has. Keep the previous seal and never retry this candidate.
        this.rejectedCandidate = candidate
        this.counters = { ...this.counters, rejectedSeals: this.counters.rejectedSeals + 1 }
        this.prefixText = undefined
        this.composed = undefined
      }
    }

    const seal = Math.min(this.seal, text.length)
    if (seal === 0) {
      // Whole-text mode (no composable boundary yet, or a barrier): one renderer.
      this.counters = { ...this.counters, fallbacks: this.counters.fallbacks + 1 }
      this.composed = undefined
      this.prefixLines = []
      this.prefixText = undefined
      this.prefixWidth = undefined
      return this.renderTail(text, safeWidth)
    }

    if (this.prefixText !== text.slice(0, seal) || this.prefixWidth !== safeWidth) {
      // The adopted seal re-renders after a width switch or an invalidation.
      if (this.prefix === undefined) this.prefix = new Markdown('', 0, 0, this.theme)
      const prefixText = text.slice(0, seal)
      this.prefix.setText(prefixText)
      this.prefixText = prefixText
      this.prefixWidth = safeWidth
      this.counters = {
        ...this.counters,
        prefixRenders: this.counters.prefixRenders + 1,
        prefixChars: this.counters.prefixChars + prefixText.length,
      }
      this.prefixLines = this.prefix.render(safeWidth)
      this.composed = undefined
    }

    const tailText = text.slice(seal)
    const tailLines = this.renderTail(tailText, safeWidth)
    if (tailText.trim() !== '' && !tailLines.some(row => row.trim() !== '')) {
      // The tail is a partial construct that paints nothing but empty rows. In
      // the whole document those rows merge with the blank row the sealed
      // prefix ends with, so composing would duplicate the separator: render the
      // text as one document for this frame (the transient state ends as soon as
      // the construct gets content). It is *not* cached as a composed frame.
      this.counters = { ...this.counters, fallbacks: this.counters.fallbacks + 1 }
      return this.renderWhole(text, safeWidth)
    }
    if (this.composed === undefined) {
      this.counters = { ...this.counters, concatRows: this.counters.concatRows + this.prefixLines.length }
      this.composed = this.prefixLines.concat(tailLines)
    }
    return this.composed
  }

  /** Whole-document render for the transient uncomposable states. */
  private renderWhole(text: string, width: number): string[] {
    if (this.whole === undefined) this.whole = new Markdown('', 0, 0, this.theme)
    this.whole.setText(text)
    this.counters = {
      ...this.counters,
      prefixRenders: this.counters.prefixRenders,
      tailChars: this.counters.tailChars + text.length,
    }
    return this.whole.render(width)
  }

  /** Render the tail (the only per-frame lexer work). */
  private renderTail(tailText: string, width: number): string[] {
    if (this.tailText === tailText && this.tailWidth === width) return this.tailLines
    if (this.tailText !== tailText) {
      this.tail.setText(tailText)
      this.tailText = tailText
    }
    this.tailWidth = width
    this.counters = {
      ...this.counters,
      tailRenders: this.counters.tailRenders + 1,
      tailChars: this.counters.tailChars + tailText.length,
    }
    this.tailLines = this.tail.render(width)
    this.composed = undefined
    return this.tailLines
  }
}