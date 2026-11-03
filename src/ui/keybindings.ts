/** A single Settings-owned shortcut list and inline editor; no profiles or command UI. */
import { matchesKey, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui'
import { formatBinding, parseBindingSpec, type CcActionDefinition, type CcKeymap } from '../input/index.ts'
import { listAction, rowBudget, windowRows } from './dialogs.ts'
import { InlineAnswer } from './inline-editor.ts'
import { bold, cc, dim, t } from './theme.ts'
import { fit, sanitize, tildePath, visibleWidth, wrap } from './text.ts'

interface ShortcutRow {
  action: CcActionDefinition
  group: string
  label: string
}

const GROUPS = ['Navigation', 'Editing', 'Application', 'Completion', 'Lists & dialogs', 'History search'] as const

function groupOf(action: CcActionDefinition): string {
  if (action.id.startsWith('historySearch.')) return 'History search'
  if (action.id.startsWith('app.') || action.id === 'editor.cancel') return 'Application'
  if (action.family === 'list' || action.family === 'dialog') return 'Lists & dialogs'
  if (action.family === 'completion') return 'Completion'
  if (action.family === 'movement' || action.family === 'history') return 'Navigation'
  return 'Editing'
}

const LABELS: Record<string, string> = {
  'editor.move.line-start': 'Start of line',
  'editor.move.line-end': 'End of line',
  'editor.move.char-left': 'Move cursor left',
  'editor.move.char-right': 'Move cursor right',
  'editor.move.line-up': 'Move up / browse history / recall queued text',
  'editor.move.line-down': 'Move down / browse history',
  'editor.submit': 'Send message / queue follow-up',
  'editor.newline': 'New line',
  'editor.cancel': 'Close completion / interrupt response',
  'editor.kill.whitespace-backward': 'Delete back to whitespace (whole path/flag)',
  'editor.kill.word-backward': 'Delete previous word (punctuation boundaries)',
  'editor.kill.word-forward': 'Delete next word (punctuation boundaries)',
  'editor.yank': 'Paste most recently deleted text',
  'editor.yank-pop': 'Cycle deleted text after pasting',
  'app.interrupt': 'Interrupt / clear draft / confirm exit',
  'app.todo': 'Todo panel (not implemented)',
  'app.thinking.toggle': 'Show / hide reasoning text (display only)',
  'app.clipboard.pasteImage': 'Paste clipboard text (images not implemented)',
  'app.help': 'Show commands and help',
}

function labelOf(action: CcActionDefinition): string {
  return sanitize(LABELS[action.id] ?? action.description)
}

/** Newlines separate alternatives; spaces retain native multi-key chord syntax. */
export function parseShortcutText(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!lines.length) return null
  const bindings = lines.map(line => {
    const keys = parseBindingSpec(line.replace(/\boption\+/gi, 'alt+'))
    if (!keys) throw new Error('Invalid key: ' + sanitize(line) + '. Example: ctrl+p or ctrl+x ctrl+e.')
    return keys.join(' ')
  })
  return [...new Set(bindings)]
}

export interface KeybindingsDialogOptions {
  keymap: CcKeymap
  path: string
  /** undefined removes just this override; null disables just this action. */
  onChange: (actionId: string, bindings: string[] | null | undefined) => Promise<void>
  onBack: () => void
}

export class KeybindingsDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  private readonly rows: ShortcutRow[]
  private readonly answer: InlineAnswer
  private index = 0
  private focusedState = false
  private editing = false
  private saving = false
  private done = false
  private message = ''
  private failed = false

  constructor(tui: TUI, options: KeybindingsDialogOptions) {
    this.tui = tui
    this.options = options
    const actions = options.keymap.getActions()
    this.rows = GROUPS.flatMap(group => actions.filter(action => groupOf(action) === group).map(action => ({ action, group, label: labelOf(action) })))
    this.answer = new InlineAnswer(tui, options.keymap)
  }

  private readonly tui: TUI
  private readonly options: KeybindingsDialogOptions

  get selectedActionId(): string | undefined { return this.rows[this.index]?.action.id }
  get isEditing(): boolean { return this.editing }
  get isSaving(): boolean { return this.saving }
  get bindingText(): string { return this.answer.raw }
  get focused(): boolean { return this.focusedState }
  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.options.keymap.cancelChord()
    this.focusedState = value
    this.answer.focused = value && this.editing
  }

  invalidate(): void { this.answer.invalidate() }

  private keys(row: ShortcutRow): string[] { return this.options.keymap.getBindings(row.action.id) }
  private keyLabel(row: ShortcutRow): string {
    const keys = this.keys(row)
    if (keys.length) return keys.map(key => formatBinding(key.split(' ')).replace(/\bAlt\+/g, process.platform === 'darwin' ? 'Option+' : 'Alt+')).join(' / ')
    const override = this.options.keymap.getUserConfig()[row.action.id]
    return override === null || (Array.isArray(override) && !override.length) ? 'Disabled' : 'Not bound'
  }

  private move(delta: number): void {
    this.options.keymap.cancelChord()
    if (this.rows.length) this.index = (this.index + delta + this.rows.length) % this.rows.length
    this.message = ''
  }

  private edit(): void {
    const row = this.rows[this.index]
    if (!row) return
    this.options.keymap.cancelChord()
    this.editing = true
    this.message = ''
    this.answer.editor.setText(this.keys(row).join('\n'))
    this.answer.focused = this.focusedState
  }

  private async save(bindings: string[] | null | undefined): Promise<void> {
    const row = this.rows[this.index]
    if (!row || this.saving) return
    this.options.keymap.cancelChord()
    this.saving = true
    this.message = 'Saving…'
    this.failed = false
    try {
      await this.options.onChange(row.action.id, bindings)
      this.editing = false
      this.answer.focused = false
      this.message = bindings === undefined ? 'Default restored' : bindings === null ? 'Disabled' : 'Saved'
    } catch (error) {
      this.failed = true
      this.message = sanitize(error instanceof Error ? error.message : String(error))
    } finally {
      this.saving = false
      this.tui.requestRender()
    }
  }

  private saveText(text: string): void {
    try { void this.save(parseShortcutText(text)) }
    catch (error) { this.failed = true; this.message = sanitize(error instanceof Error ? error.message : String(error)) }
  }

  handleInput(data: string): void {
    if (this.done || this.saving) return
    const pasting = this.editing && this.answer.editor.isPasting()
    // These are recovery controls for this configuration pane only. Editing
    // them cannot lock the user out; normal dialogs retain the user's keymap.
    if (!pasting && matchesKey(data, 'escape')) {
      this.options.keymap.cancelChord()
      if (this.editing) { this.editing = false; this.answer.focused = false; this.message = '' }
      else { this.done = true; this.options.onBack() }
    } else if (this.editing) {
      if (!pasting && matchesKey(data, 'enter')) this.saveText(this.answer.raw)
      else if (!pasting && matchesKey(data, 'shift+enter')) this.answer.editor.ccInsertText('\n')
      else {
        const before = this.answer.editor.captureDraft()
        const result = this.answer.handleKey(data)
        if (result === 'submit') {
          this.answer.editor.restoreDraft(before)
          this.saveText(this.answer.lastSubmittedText ?? before.expandedText)
        } else if (result === 'cancel') { this.editing = false; this.answer.focused = false; this.message = '' }
      }
    } else if (matchesKey(data, 'enter')) this.edit()
    else if (data === 'd' || data === 'D') void this.save(null)
    else if (data === 'r' || data === 'R') void this.save(undefined)
    else if (matchesKey(data, 'up')) this.move(-1)
    else if (matchesKey(data, 'down')) this.move(1)
    else if (matchesKey(data, 'pageUp')) this.move(-5)
    else if (matchesKey(data, 'pageDown')) this.move(5)
    else if (matchesKey(data, 'home')) this.index = 0
    else if (matchesKey(data, 'end')) this.index = Math.max(0, this.rows.length - 1)
    else {
      const action = listAction(this.options.keymap, data)
      if (action?.id === 'list.previous') this.move(-1)
      else if (action?.id === 'list.next') this.move(1)
      else if (action?.id === 'list.page-up') this.move(-5)
      else if (action?.id === 'list.page-down') this.move(5)
      else if (action?.id === 'list.first') this.index = 0
      else if (action?.id === 'list.last') this.index = Math.max(0, this.rows.length - 1)
      else if (action?.id === 'list.select' || action?.id === 'dialog.confirm') this.edit()
      else if (action && ['list.cancel', 'dialog.cancel', 'app.cancel', 'app.interrupt'].includes(action.id)) { this.done = true; this.options.onBack() }
    }
    this.tui.requestRender()
  }

  private rowLines(row: ShortcutRow, index: number, width: number): string[] {
    const focused = index === this.index
    const marker = focused ? cc.suggestion('❯') : ' '
    const style = focused ? cc.suggestion : t.text
    const keys = this.keyLabel(row)
    const lines: string[] = []
    if (width >= 48) {
      const leftWidth = Math.min(32, Math.floor(width * 0.43))
      const rightWidth = Math.max(1, width - leftWidth - 5)
      const left = wrap(keys, leftWidth), right = wrap(row.label, rightWidth)
      for (let line = 0; line < Math.max(left.length, right.length); line++) {
        const key = left[line] ?? ''
        lines.push((line === 0 ? marker : ' ') + ' ' + style(key) + ' '.repeat(Math.max(0, leftWidth - visibleWidth(key))) + dim(' │ ') + style(right[line] ?? ''))
      }
    } else {
      lines.push(...wrap(row.label, Math.max(1, width - 2)).map((line, offset) => (offset === 0 ? marker : ' ') + ' ' + style(line)))
      lines.push(...wrap(keys, Math.max(1, width - 2)).map(line => '  ' + dim(style(line))))
    }
    if (index === 0 || this.rows[index - 1]?.group !== row.group) lines.unshift(' ' + bold(cc.permission(row.group)))
    return lines
  }

  render(width: number): string[] {
    const size = Math.max(1, Math.floor(width))
    const row = this.rows[this.index]
    const out = [cc.inactive('─'.repeat(size)), bold(cc.permission('Keyboard shortcuts')), dim(sanitize(tildePath(this.options.path)))]
    if (this.editing && row) {
      out.push('', t.text(row.label), dim('Current: ' + this.keyLabel(row)), '')
      out.push(...this.answer.render(Math.max(1, size - 2), this.focusedState, 'ctrl+p').map(line => '  ' + line))
      out.push('', ...wrap(dim('One binding per line; spaces make chords. Option = Alt.'), size))
      out.push(...wrap(dim('Enter save · Shift+Enter another binding · Esc cancel'), size))
    } else {
      if (size >= 48) out.push(dim('  Key(s)'.padEnd(Math.min(32, Math.floor(size * 0.43)) + 2) + ' │ Action'))
      const hints = wrap(dim('↑/↓ navigate · Enter edit · d disable · r default · Esc settings'), size)
      const blocks = this.rows.map((item, index) => ({ lines: this.rowLines(item, index, size), focused: index === this.index }))
      out.push(...windowRows(blocks, Math.max(1, rowBudget(this.tui) - hints.length + 1)))
      out.push(dim((row?.group ?? '') + ' · ' + (this.rows.length ? this.index + 1 : 0) + '/' + this.rows.length))
      out.push(...hints)
    }
    if (this.message) out.push(...wrap((this.failed ? t.redSoft : t.muted)(this.message), size))
    return out.map(line => fit(line, size))
  }
}
