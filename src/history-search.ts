import {
  CURSOR_MARKER,
  matchesKey,
  type Focusable,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from '#pi-tui'
import { CcEditor, type CcActionEvent, type CcKeymap } from './input/index.ts'
import type { ComposerInteraction, InteractionLayout, InteractionPlacement } from './ui/interaction.ts'
import { editorTheme, t } from './ui/theme.ts'

/** Header row (`History search · n/m`). */
const HEADER_ROWS = 1
/** Mode hint row. */
const FOOTER_ROWS = 1
/** Preview is a reading aid, never a scrolled transcript. */
const PREVIEW_MAX_ROWS = 5

/** Parent-supplied cap normalized to a usable row count, or undefined (terminal-derived). */
function normalizedCap(maxHeight: number): number | undefined {
  return Number.isFinite(maxHeight) && maxHeight > 0 ? Math.max(1, Math.floor(maxHeight)) : undefined
}

/**
 * Prompt-history search (Ctrl+R) as a composer-adjacent interaction.
 *
 * One query editor (`CcEditor`/Pi `Editor`) is the only editable state here:
 * the App keeps the main draft, undo, kill ring, pastes and the parent prompt
 * untouched. Search is presentation-only over the already-recorded prompt
 * history; a selection is handed back to the parent callback, which decides
 * insert-vs-send (`execute`). Cancel always returns `undefined` so the parent
 * can restore its captured draft.
 *
 * Inline vs fullscreen keep their CC meaning:
 * - inline: Enter sends the match (`execute`), Tab/Esc insert it for editing;
 * - fullscreen: Enter/Tab insert it, Esc cancels and restores.
 * The actual keys come from the shared keymap (the App composes the per-screen
 * historySearch bindings), so a remap/disable is honored instead of a raw byte.
 *
 * Pi-style Ctrl+C: the local `historySearch.cancel` binding (and the editor's
 * ordinary Esc/app.cancel path) cancels. The global `app.clear` action is
 * deliberately not aliased here, so a disabled/remapped local cancel key is
 * inert instead of being resurrected by the new Ctrl+C default; search
 * cancellation must not leak a hidden root clear or abort a busy root turn
 * (the App owns that policy, see docs/COMPOSER-INTERACTION-CONTRACT.md).
 *
 * ComposerInteraction:
 * - `setInteractionLayout` is idempotent and presentation-only: no reads,
 *   focus changes, editor replacement or repaint requests. This surface owns
 *   no mouse targets, so a layout change cannot leave a stale pin behind.
 * - `measureRows` is pure (memoized editor geometry + cached preview wrap) and
 *   never calls `render`. `render(width).length === measureRows(width)` for
 *   every width/cap, and the result never exceeds the parent's hard height.
 * - The height cap covers the header, the one query editor, up to five preview
 *   rows and the footer, with no padding for a short/small result set.
 *
 * Lifecycle: the parent callback is delivered at most once; `dispose()` is
 * idempotent, retires the query `onChange`/`onAction` hooks and disposes the
 * one query editor. A disposed/completed search consumes late input without
 * re-completing or touching the parent's editor.
 */
export class HistorySearch implements ComposerInteraction, Focusable {
  readonly editor: CcEditor
  readonly capturesViewportInput = true
  private _focused = false
  private readonly history: string[]
  private readonly mode: 'inline' | 'fullscreen'
  private readonly complete: (text: string | undefined, execute: boolean) => void
  private readonly tui: TUI
  private results: string[] = []
  private selected = 0
  private placement: InteractionPlacement = 'composer'
  private capRows: number | undefined
  private completed = false
  private disposed = false
  private previewCache: { key: string; lines: string[] } | undefined

  constructor(tui: TUI, history: string[], keymap: CcKeymap, mode: 'inline' | 'fullscreen', complete: (text: string | undefined, execute: boolean) => void) {
    this.tui = tui
    this.history = [...history].reverse()
    this.mode = mode
    this.complete = complete
    this.editor = new CcEditor(tui, editorTheme, { paddingX: 1, keymap, context: 'historySearch' })
    this.editor.onChange = () => {
      if (this.completed || this.disposed) return
      this.filter()
      this.tui.requestRender()
    }
    this.editor.onAction = event => this.action(event)
    this.filter()
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value; this.editor.focused = value }

  /** Fragmented bracketed-paste state of the one query editor (parent guard). */
  get isPasting(): boolean {
    return this.editor.isPasting()
  }

  /** True once the parent callback was delivered; later input is inert. */
  get isCompleted(): boolean {
    return this.completed
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Apply the parent's hard bounds. Idempotent and presentation-only: no
   * fetch, answer, focus change, editor replacement or repaint request.
   */
  setInteractionLayout(layout: InteractionLayout): void {
    const placement: InteractionPlacement = layout.placement === 'workspace' ? 'workspace' : 'composer'
    const cap = normalizedCap(layout.maxHeight)
    if (placement === this.placement && cap === this.capRows) return
    this.placement = placement
    this.capRows = cap
    // Presentation changed only; the parent repaints on its own schedule.
  }

  /**
   * Rows this search paints at `width`: exactly `render(width).length`, using
   * the editor's own memoized row geometry and the cached preview wrap. Never
   * paints or mutates visible state.
   */
  measureRows(width: number): number {
    if (this.disposed) return 0
    const size = Math.max(1, Math.floor(width))
    const cap = this.maxRows()
    const queryRows = this.editor.measureRows(size)
    const previewRows = this.previewPlan(size).length
    return this.composedRows(cap, queryRows, previewRows)
  }

  private filter(): void {
    const query = this.editor.getExpandedText().toLocaleLowerCase()
    this.results = this.history.filter(text => text.toLocaleLowerCase().includes(query))
    this.selected = 0
    this.previewCache = undefined
  }

  private action(event: CcActionEvent): boolean {
    if (this.completed || this.disposed) return true
    if (event.id === 'historySearch.next') {
      if (this.results.length) this.selected = (this.selected + 1) % this.results.length
    } else if (event.id === 'historySearch.previous') {
      if (this.results.length) this.selected = (this.selected - 1 + this.results.length) % this.results.length
    } else if (event.id === 'historySearch.accept') {
      // Inline Enter sends; fullscreen Enter/Tab only insert. Esc in inline mode
      // is bound to accept by the App and inserts too. A bare LF is Ctrl+J:
      // even a custom accept binding must not turn it into an inline submit.
      this.finish(this.results[this.selected], this.mode === 'inline' && event.key !== '\n' && matchesKey(event.key, 'enter'))
    } else if (
      event.id === 'historySearch.cancel' ||
      event.id === 'app.interrupt' ||
      event.id === 'app.cancel'
    ) {
      // Local-first Pi-style cancellation: restore the parent draft even while
      // the root is busy. No backend/agent cancellation is requested here.
      this.finish(undefined, false)
    } else return false
    if (!this.completed && !this.disposed) this.tui.requestRender()
    return true
  }

  /** Deliver the parent callback exactly once. */
  private finish(text: string | undefined, execute: boolean): void {
    if (this.completed || this.disposed) return
    this.completed = true
    this.complete(text, execute)
  }

  handleInput(data: string): void {
    if (this.completed || this.disposed) return
    this.editor.handleInput(data)
    if (!this.completed && !this.disposed) this.tui.requestRender()
  }

  invalidate(): void {
    this.previewCache = undefined
    this.editor.invalidate()
  }

  /**
   * Idempotent teardown: retire the query listener/action sink and dispose the
   * one query editor. Never calls the completion callback and never touches the
   * parent's main editor state.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.previewCache = undefined
    this.editor.onChange = undefined
    this.editor.onAction = undefined
    const editor = this.editor as CcEditor & { dispose?: () => void }
    editor.dispose?.()
  }

  // -------------------------------------------------------------------------
  // Geometry

  /** Parent cap, or the terminal rows for a standalone/unspecified host. */
  private maxRows(): number {
    if (this.capRows !== undefined) return this.capRows
    const rows = this.tui.terminal.rows
    return Number.isFinite(rows) && rows > 0 ? Math.max(1, Math.floor(rows)) : 24
  }

  /** Row count of the header/editor/preview/footer composition under `cap`. */
  private composedRows(cap: number, queryRows: number, previewRows: number): number {
    if (cap <= 0) return 0
    if (cap === 1) return HEADER_ROWS
    if (cap === 2) return 2
    const available = cap - HEADER_ROWS - FOOTER_ROWS
    const queryBudget = Math.min(queryRows, available)
    const previewBudget = Math.min(previewRows, Math.max(0, available - queryBudget))
    return HEADER_ROWS + queryBudget + previewBudget + FOOTER_ROWS
  }

  /**
   * Preview lines for the current selection, cached per width/query/result. The
   * same cache answers both `measureRows` and `render`, so a count can never
   * drift from the painted preview.
   */
  private previewPlan(width: number): string[] {
    const result = this.results[this.selected]
    const query = this.editor.getExpandedText()
    const key = `${width}|${this.selected}|${query}|${result ?? ''}`
    if (this.previewCache?.key === key) return this.previewCache.lines
    let lines: string[]
    if (result === undefined) {
      lines = [truncateToWidth('  No matching prompts', width)]
    } else {
      const position = result.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
      const preview = query !== '' && position >= 0
        ? result.slice(0, position) + t.accent(result.slice(position, position + query.length)) + result.slice(position + query.length)
        : result
      lines = wrapTextWithAnsi(t.accent('❯') + ' ' + preview, Math.max(1, width)).slice(0, PREVIEW_MAX_ROWS)
    }
    this.previewCache = { key, lines }
    return lines
  }

  /**
   * Keep the cursor's visual row inside a clipped query window. The editor
   * already scrolls its own visible cap; this only applies when the parent cap
   * is smaller than the editor's rendering.
   */
  private visibleQuery(lines: readonly string[], budget: number): string[] {
    if (budget <= 0) return []
    if (lines.length <= budget) return [...lines]
    const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER))
    if (cursor < 0) return lines.slice(0, budget)
    const start = Math.max(0, Math.min(cursor - budget + 1, lines.length - budget))
    return lines.slice(start, start + budget)
  }

  private footerLine(): string {
    return this.mode === 'inline'
      ? 'Ctrl+R next · Tab/Esc edit · Enter send · Ctrl+C cancel'
      : 'Ctrl+P/N choose · Tab/Enter edit · Esc cancel'
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const cap = this.maxRows()
    const count = this.results.length ? this.selected + 1 : 0
    const header = truncateToWidth(
      t.accent('History search') + t.muted(' · ' + count + '/' + this.results.length),
      size,
    )
    const query = this.editor.render(size)
    const preview = this.previewPlan(size)
    const footer = truncateToWidth(this.footerLine(), size)

    if (cap === 1) return [header]
    if (cap === 2) return [query[0] ?? header, footer]
    const available = cap - HEADER_ROWS - FOOTER_ROWS
    const queryBudget = Math.min(query.length, available)
    const previewBudget = Math.min(preview.length, Math.max(0, available - queryBudget))
    return [
      header,
      ...this.visibleQuery(query, queryBudget),
      ...preview.slice(0, previewBudget),
      footer,
    ]
  }
}