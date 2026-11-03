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
} from '@earendil-works/pi-tui'
import { CcEditor, type CcKeymap } from '../input/index.ts'
import { cc, editorTheme, t } from './theme.ts'
import { wrap } from './text.ts'

export type InlineKey = 'handled' | 'submit' | 'cancel' | 'up' | 'down' | 'tab'

/** One logical answer row backed by exactly one CcEditor state. */
export class InlineAnswer {
  readonly editor: CcEditor
  readonly keymap: CcKeymap
  onChange: ((text: string) => void) | undefined
  /** The text handed to onSubmit before CcEditor cleared its buffer. */
  lastSubmittedText: string | undefined
  private pending: InlineKey | undefined

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
      if (event.id === 'app.cancel' || event.id === 'app.interrupt') {
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

  /** Render the row without editor borders; `width` is the available columns. */
  render(width: number, focused: boolean, placeholder: string): string[] {
    const raw = this.editor.getText()
    if (focused) {
      if (raw === '') {
        return [`${CURSOR_MARKER}${renderFakeCursor(cc.inactive(placeholder.slice(0, 1) || ' '))}${cc.inactive(placeholder.slice(1))}`]
      }
      const rendered = this.editor.render(Math.max(4, width))
      // This plain Editor has one top and bottom border and no completion provider.
      return rendered.slice(1, -1).map(line => line.replace(/ +$/, ''))
    }
    if (raw.trim() === '') return [cc.inactive(placeholder)]
    return wrap(raw.replace(/\n+$/, ''), Math.max(4, width)).map(line => t.text(line))
  }

  invalidate(): void {
    this.editor.invalidate()
  }
}
