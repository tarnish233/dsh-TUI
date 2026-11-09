/**
 * Inline answer row for dialogs.
 *
 * CcEditor is imported from the input owner's public surface
 * (src/input/index.ts) and shares the dialog's CcKeymap. There is deliberately
 * no fallback to a bare Pi Editor: if the vendored Pi seam is missing,
 * CcEditor reports an actionable error instead of silently changing key
 * behavior.
 *
 * Key routing rules:
 * - dialog/list actions are resolved once by the dialog, never here;
 * - editor-context keys are forwarded once to CcEditor, so chords, word kill,
 *   yank and custom overrides keep one editing state;
 * - only the boundary case of Up/Down at the first/last logical line is
 *   inspected before forwarding, using the keymap's effective bindings without
 *   mutating chord state.
 *
 * Rendering follows agent_tui's InlineText approach (MIT): strip the editor's
 * border rows and draw a fake cursor/placeholder while empty and focused.
 */
import {
  CURSOR_MARKER,
  matchesKey,
  renderFakeCursor,
  type TUI,
} from '#pi-tui'
import { CcEditor, type CcKeymap } from '../input/index.ts'
import { cc, editorTheme, t } from './theme.ts'
import { wrap } from './text.ts'

export type InlineKey = 'handled' | 'submit' | 'cancel' | 'interrupt' | 'up' | 'down' | 'tab'

/** One logical answer row backed by exactly one CcEditor state. */
export class InlineAnswer {
  readonly editor: CcEditor
  readonly keymap: CcKeymap
  onChange: ((text: string) => void) | undefined
  /** The text handed to onSubmit before CcEditor cleared its buffer. */
  lastSubmittedText: string | undefined
  private pending: InlineKey | undefined
  private disposed = false

  constructor(tui: TUI, keymap: CcKeymap) {
    this.keymap = keymap
    this.editor = new CcEditor(tui, editorTheme, { paddingX: 0, keymap, context: 'editor' })
    // Enter reaches InlineAnswer as onSubmit so the dialog owns submission.
    this.editor.disableSubmit = false
    this.editor.onSubmit = text => {
      this.pending = 'submit'
      this.lastSubmittedText = text
    }
    this.editor.onChange = text => this.onChange?.(text)
    this.editor.onAction = event => {
      // Global turn cancellation and local dismissal are different answers for
      // the dialog; keep them distinct instead of folding both into cancel.
      if (event.id === 'app.interrupt') {
        this.pending = 'interrupt'
        return true
      }
      if (event.id === 'app.cancel') {
        this.pending = 'cancel'
        return true
      }
      if (event.id === 'editor.complete') {
        this.pending = 'tab'
        return true
      }
      return false
    }
  }

  get text(): string {
    return this.editor.getExpandedText().trim()
  }

  get raw(): string {
    return this.editor.getExpandedText()
  }

  get empty(): boolean {
    return this.editor.getText() === ''
  }

  /** True once the shared-keymap listeners of this editor were released. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Release the single editor state and any shared-keymap chord listener it
   * owns. Idempotent: the parent calls it on settled closure, session reset or
   * shutdown, never while a question is merely hidden and expected back.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.onChange = undefined
    // CcEditor.dispose is ownership-aware for the shared keymap: it removes
    // only this editor's listener and only cancels a chord this editor opened.
    this.editor.dispose()
  }

  set focused(value: boolean) {
    this.editor.focused = value
  }

  private boundTo(actionId: string, data: string): boolean {
    return this.keymap
      .getBindings(actionId)
      .some(binding => binding.split(' ').length === 1 && matchesKey(data, binding as Parameters<typeof matchesKey>[1]))
  }

  /** Forward one raw terminal input to the single editor state. */
  handleKey(data: string): InlineKey {
    if (this.disposed) return 'handled'
    this.pending = undefined
    this.lastSubmittedText = undefined
    const canNavigate = !this.editor.isPasting() && !this.keymap.isPendingChord() && !this.editor.capturesViewportInput
    if (canNavigate && this.boundTo('editor.move.line-up', data) && this.editor.ccIsOnFirstVisualLine()) return 'up'
    if (canNavigate && this.boundTo('editor.move.line-down', data) && this.editor.ccIsOnLastVisualLine()) return 'down'
    this.editor.handleInput(data)
    const result = this.pending ?? 'handled'
    this.pending = undefined
    return result
  }

  /**
   * Render the row without editor borders; `width` is the available columns.
   *
   * `confirmed` is the answer the dialog already accepted (CcEditor clears its
   * buffer on submit), so an unfocused row keeps showing the real value instead
   * of an empty placeholder plus a check mark.
   */
  render(width: number, focused: boolean, placeholder: string, confirmed = ''): string[] {
    const raw = this.editor.getText()
    if (focused) {
      if (raw === '') {
        return [`${CURSOR_MARKER}${renderFakeCursor(cc.inactive(placeholder.slice(0, 1) || ' '))}${cc.inactive(placeholder.slice(1))}`]
      }
      const rendered = this.editor.render(Math.max(4, width))
      // This plain Editor has one top and bottom border and no completion provider.
      return rendered.slice(1, -1).map(line => line.replace(/ +$/, ''))
    }
    const shown = raw.trim() === '' ? confirmed : raw
    if (shown.trim() === '') return [cc.inactive(placeholder)]
    return wrap(shown.replace(/\n+$/, ''), Math.max(4, width)).map(line => t.text(line))
  }

  invalidate(): void {
    this.editor.invalidate()
  }
}

/**
 * The bottom-dock prompt editor: the one `CcEditor` state plus a height
 * measurement the parent can ask for before it lays the fixed dock out.
 *
 * `App.statusDockPool()` needs the editor's row count to compute the transcript
 * budget, and `docs/FRONTEND-CONTRACT.md` forbids re-rendering a dock member
 * just to count its rows. The vendored `Editor.render` keeps no cached lines (it
 * re-lays out the text, clamps the scroll offset and re-emits the cursor cell),
 * so the only answer that can never disagree with the paint is the paint's own
 * length: `measureRows(width) === render(width).length` holds by construction
 * and is pinned by test. Rendering is deterministic and side-effect-free for the
 * visible rows, so measuring twice — or measuring and then painting — is
 * idempotent and never moves the frame it describes.
 *
 * The App's `PromptEditor` (working-status border, brand-blue prompt arrow)
 * extends this class and inherits the measurement; the decorations change cell
 * content only, never the row count.
 */
export class DockPromptEditor extends CcEditor {
  /** Rows this editor paints at `width`; equal to `render(width).length`. */
  measureRows(width: number): number {
    return this.render(Math.max(1, Math.floor(width))).length
  }
}
