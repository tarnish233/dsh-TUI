/**
 * One reusable CC-grammar search field for read-only inspectors.
 *
 * The field is a *field*, not a second composer: it owns exactly one
 * `InlineAnswer`/`CcEditor` state with the shared `CcKeymap`, so typing, word
 * vs whitespace deletion, kill/yank, undo, bracketed paste and chord handling
 * all come from the input subsystem instead of a bespoke readline. The main
 * prompt keeps its own editor state; nothing here is mounted as a prompt slot
 * and the field only exists while the owning inspector is open.
 *
 * Contract for hosts (ToolDetails today):
 * - `handleKey` returns `confirm` for the effective `list.select` binding
 *   *before* forwarding: a search field must keep its query visible after
 *   Enter, so Enter never submits/clears the CcEditor buffer.
 * - every other key is forwarded once; `up`/`down` are reported only at the
 *   visual first/last line (InlineAnswer semantics) so a host may move list
 *   selection instead.
 * - `render` is width-safe and keeps `CURSOR_MARKER` for the renderer.
 * - `dispose` releases only this field's editor listener and pending chord.
 */
import type { TUI } from '#pi-tui'
import { matchesConfiguredKey, type CcKeymap } from '../input/index.ts'
import { InlineAnswer, type InlineKey } from './inline-editor.ts'

/** Key outcome: InlineAnswer's field keys plus an explicit confirm. */
export type SearchFieldKey = InlineKey | 'confirm'

export interface SearchFieldOptions {
  readonly tui: TUI
  readonly keymap: CcKeymap
  /** Shown while the field is focused and empty. */
  readonly placeholder?: string
  readonly onChange?: (text: string) => void
}

export class SearchField {
  readonly keymap: CcKeymap
  private readonly answer: InlineAnswer
  private readonly placeholder: string
  private disposed = false

  constructor(options: SearchFieldOptions) {
    this.keymap = options.keymap
    this.placeholder = options.placeholder ?? 'Search…'
    this.answer = new InlineAnswer(options.tui, options.keymap)
    this.answer.onChange = text => options.onChange?.(text)
  }

  /** Exact field text (untrimmed). */
  get raw(): string {
    return this.answer.raw
  }

  /** Trimmed query used for filtering. */
  get query(): string {
    return this.answer.text
  }

  get empty(): boolean {
    return this.answer.empty
  }

  get focused(): boolean {
    return this.answer.editor.focused
  }

  set focused(value: boolean) {
    this.answer.focused = value
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Fragmented bracketed-paste state of this field's single editor. */
  get isPasting(): boolean {
    return this.answer.editor.isPasting()
  }

  /**
   * True when `raw` is a configured single-key binding of `actionId`. Used for
   * field-level decisions (confirm/cancel) without mutating chord state; the
   * forwarded key is still resolved by the editor once.
   */
  isBound(raw: string, actionId: string): boolean {
    return this.keymap
      .getBindings(actionId)
      .some(binding => !binding.includes(' ') && matchesConfiguredKey(raw, binding))
  }

  /** Replace the query (one editor state; never a second buffer). */
  setText(text: string): void {
    if (this.disposed) return
    if (this.answer.editor.getExpandedText() === text) return
    this.answer.editor.setText(text)
  }

  clear(): void {
    this.setText('')
  }

  /**
   * Forward one raw input to the single field editor. Confirm is decided from
   * the effective keymap first so the query survives; a stray submit path
   * restores the submitted text instead of leaving a cleared field.
   */
  handleKey(raw: string): SearchFieldKey {
    if (this.disposed) return 'handled'
    if (this.isBound(raw, 'list.select')) return 'confirm'
    const result = this.answer.handleKey(raw)
    if (result !== 'submit') return result
    const submitted = this.answer.lastSubmittedText ?? ''
    if (this.answer.empty && submitted !== '') this.answer.editor.setText(submitted)
    return 'confirm'
  }

  /**
   * Render the row. `confirmed` keeps a persisted query visible while the field
   * is unfocused (InlineAnswer clears its own buffer on submit).
   */
  render(width: number, placeholder: string = this.placeholder, confirmed = ''): string[] {
    return this.answer.render(Math.max(1, width), this.focused, placeholder, confirmed)
  }

  invalidate(): void {
    this.answer.invalidate()
  }

  /** Release only this field's editor listener and pending chord (idempotent). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.answer.onChange = undefined
    this.answer.dispose()
  }
}