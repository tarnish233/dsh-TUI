import { matchesKey, type Component, type Focusable, type TUI, truncateToWidth, wrapTextWithAnsi } from '#pi-tui'
import { CcEditor, type CcActionEvent, type CcKeymap } from './input/index.ts'
import { editorTheme, t } from './ui/theme.ts'

/** Search input is an editor, with contextual search actions above normal editing. */
export class HistorySearch implements Component, Focusable {
  readonly editor: CcEditor
  readonly capturesViewportInput = true
  private _focused = false
  private readonly history: string[]
  private readonly mode: 'inline' | 'fullscreen'
  private readonly complete: (text: string | undefined, execute: boolean) => void
  private readonly tui: TUI
  private results: string[] = []
  private selected = 0

  constructor(tui: TUI, history: string[], keymap: CcKeymap, mode: 'inline' | 'fullscreen', complete: (text: string | undefined, execute: boolean) => void) {
    this.tui = tui
    this.history = [...history].reverse()
    this.mode = mode
    this.complete = complete
    this.editor = new CcEditor(tui, editorTheme, { paddingX: 1, keymap, context: 'historySearch' })
    this.editor.onChange = () => { this.filter(); tui.requestRender() }
    this.editor.onAction = event => this.action(event)
    this.filter()
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value; this.editor.focused = value }

  private filter(): void {
    const query = this.editor.getExpandedText().toLocaleLowerCase()
    this.results = this.history.filter(text => text.toLocaleLowerCase().includes(query))
    this.selected = 0
  }

  private action(event: CcActionEvent): boolean {
    if (event.id === 'historySearch.next') {
      if (this.results.length) this.selected = (this.selected + 1) % this.results.length
    } else if (event.id === 'historySearch.previous') {
      if (this.results.length) this.selected = (this.selected - 1 + this.results.length) % this.results.length
    } else if (event.id === 'historySearch.accept') {
      this.complete(this.results[this.selected], this.mode === 'inline' && matchesKey(event.key, 'enter'))
    } else if (event.id === 'historySearch.cancel' || event.id === 'app.interrupt' || event.id === 'app.cancel') {
      this.complete(undefined, false)
    } else return false
    this.tui.requestRender()
    return true
  }

  handleInput(data: string): void { this.editor.handleInput(data); this.tui.requestRender() }
  invalidate(): void { this.editor.invalidate() }

  /** Release the search editor's shared-keymap hooks when the dialog closes. */
  dispose(): void {
    const editor = this.editor as CcEditor & { dispose?: () => void }
    editor.dispose?.()
  }

  render(width: number): string[] {
    const query = this.editor.getExpandedText()
    const result = this.results[this.selected]
    const count = this.results.length ? this.selected + 1 : 0
    const lines = [truncateToWidth(t.accent('History search') + t.muted(' · ' + count + '/' + this.results.length), width), ...this.editor.render(width)]
    if (result === undefined) lines.push(truncateToWidth('  No matching prompts', width))
    else {
      const position = result.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
      const preview = query && position >= 0
        ? result.slice(0, position) + t.accent(result.slice(position, position + query.length)) + result.slice(position + query.length)
        : result
      lines.push(...wrapTextWithAnsi(t.accent('❯') + ' ' + preview, Math.max(1, width)).slice(0, 5))
    }
    lines.push(truncateToWidth(this.mode === 'inline' ? 'Ctrl+R next · Tab/Esc edit · Enter send · Ctrl+C cancel' : 'Ctrl+P/N choose · Tab/Enter edit · Esc cancel', width))
    return lines
  }
}
