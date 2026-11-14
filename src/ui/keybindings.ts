/**
 * `/settings` → Keyboard shortcuts: one grouped, filterable shortcut editor.
 *
 * There is deliberately no standalone `/hotkeys`, no profile hierarchy and no
 * second override file: the rows are the existing `CcKeymap` registry, and one
 * write changes exactly one `keybindings.json` entry through the parent's
 * `onChange` (which owns the conflict/diagnostic check and the atomic write).
 * `reset` deletes only that one override; `disable` stores `null` for it.
 *
 * The list is a normal `ModalFrame` body (src/ui/modal.ts) with the shared
 * group order:
 *
 *   Navigation · Editing · Application · Completion · Lists & dialogs · History search
 *
 * Input is resolved through the shared keymap in the `keybindingsList`
 * context; the search field is the modal's one text field and reuses
 * `InlineAnswer`'s CC editor grammar. Hints always come from the real bindings
 * of `keybindings.edit` / `keybindings.disable` / `keybindings.reset` /
 * `modal.search` / `list.cancel`, so a disabled action never advertises a dead
 * key. A narrow set of physical recovery keys (arrows, pages, Home/End, Enter,
 * Esc) keeps this configuration pane escapable even if a user disables the
 * shared list actions — they are not advertised as fake bindings.
 */
import { matchesKey, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from '#pi-tui'
import {
  formatBinding,
  matchesConfiguredKey,
  parseBindingSpec,
  type CcActionDefinition,
  type CcKeymap,
} from '../input/index.ts'
import { isInterruptKey, type HitRange } from './dialogs.ts'
import { InlineAnswer } from './inline-editor.ts'
import {
  isPrintableByte,
  listStatusLines,
  ModalListSurface,
  resolveListAction,
  windowList,
  type ListBlock,
  type ListBody,
} from './modal-list.ts'
import { CLOSE_ACTIONS, modalBinding, type ModalAction, type ModalSize } from './modal.ts'
import { fit, oneLine, sanitize, tildePath, visibleWidth, wrap } from './text.ts'
import { bold, cc, dim, t } from './theme.ts'

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

/**
 * The only label overrides: one-line cursor-position labels, where the native
 * `description` is a sentence ("Move to the start of the current logical line")
 * that costs a wrapped row in a two-column list. Everything else renders
 * `action.description` verbatim — a second copy of a description is what let the
 * old table claim "Todo panel (not implemented)" and "images not implemented"
 * long after both shipped.
 */
const SHORT_LABELS: Readonly<Record<string, string>> = {
  'editor.move.line-start': 'Start of line',
  'editor.move.line-end': 'End of line',
  'editor.move.char-left': 'Move cursor left',
  'editor.move.char-right': 'Move cursor right',
}

function labelOf(action: CcActionDefinition): string {
  return sanitize(SHORT_LABELS[action.id] ?? action.description)
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

interface ResolvedModalAction {
  readonly id: string
  readonly keys: string[]
}

/**
 * The binding-text field is a real embedded CC editor (`editor` context), where
 * default Ctrl+C resolves the global `app.clear`. It consumes that key as its
 * own local cancel ("abandon this edit"), but only under the same rule the list
 * layers use: the *physical* key must still be an enabled single-key binding of
 * a local cancel action, checked non-mutatingly (no resolution, no chord state).
 * Disabling every cancel row, or remapping all of them away from Ctrl+C, leaves
 * the key inert instead of inventing a cancel/back; the hidden root draft is
 * never cleared and the native turn is never interrupted. Pasted bytes remain
 * content (the caller guards paste state).
 */
function cancelFallback(keymap: CcKeymap, data: string): boolean {
  if (keymap.isPendingChord()) return false
  // `matchesConfiguredKey`, not the bare Pi match: a bare LF is Ctrl+J, never
  // the Enter of an `enter`/`return` binding. A real CR keeps matching.
  const simple = (binding: string): boolean =>
    !binding.includes(' ') && matchesConfiguredKey(data, binding)
  if (!keymap.getBindings('app.clear').some(simple)) return false
  return [...CLOSE_ACTIONS].some(id => keymap.getBindings(id).some(simple))
}

const errorText = (error: unknown): string => sanitize(error instanceof Error ? error.message : String(error))

export interface KeybindingsDialogOptions {
  keymap: CcKeymap
  path: string
  /** undefined removes just this override; null disables just this action. */
  onChange: (actionId: string, bindings: string[] | null | undefined) => Promise<void>
  onBack: () => void
  /**
   * Optional explicit native interrupt hook. When provided, a configured
   * `app.interrupt` binding (no shipped default) calls it instead of leaving
   * Settings; when omitted this pane keeps its local recovery behaviour.
   * Default Ctrl+C is `app.clear` and stays a local edit cancel here.
   */
  onInterrupt?: () => void
  /** Bounded modal height (defaults to the shared standard modal budget). */
  maxHeight?: number
}

export class KeybindingsDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: KeybindingsDialogOptions
  private readonly rows: ShortcutRow[]
  private readonly list: ModalListSurface
  private readonly answer: InlineAnswer
  private readonly search: InlineAnswer
  private selectedId: string | undefined
  private selectedIndex = 0
  private windowStart = 0
  private searchFocused = false
  private focusedState = false
  private editing = false
  private saving = false
  private done = false
  private disposed = false
  private message = ''
  private failed = false

  constructor(tui: TUI, options: KeybindingsDialogOptions) {
    this.tui = tui
    this.options = options
    this.list = new ModalListSurface(tui, {
      size: this.modalSize,
      ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
    })
    this.keymap = options.keymap
    const actions = options.keymap.getActions()
    this.rows = GROUPS.flatMap(group =>
      actions.filter(action => groupOf(action) === group).map(action => ({ action, group, label: labelOf(action) })),
    )
    this.selectedId = this.rows[0]?.action.id
    this.answer = new InlineAnswer(tui, options.keymap)
    this.search = new InlineAnswer(tui, options.keymap)
    this.search.onChange = () => { this.reconcile(); this.windowStart = 0; this.tui.requestRender() }
  }

  // -------------------------------------------------------------------------
  // State accessors (parent/tests)

  get selectedActionId(): string | undefined {
    return this.visibleRows()[this.currentIndex()]?.action.id
  }

  get isEditing(): boolean {
    return this.editing
  }

  get isSaving(): boolean {
    return this.saving
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * True while a fragmented bracketed paste is still arriving in the binding or
   * search field; the parent's global interrupt listener can leave it alone.
   */
  get isPasting(): boolean {
    return (this.editing && this.answer.editor.isPasting())
      || (this.searchFocused && this.search.editor.isPasting())
  }

  get isDone(): boolean {
    return this.done
  }

  get bindingText(): string {
    return this.answer.raw
  }

  get query(): string {
    return this.search.raw.trim()
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.keymap.cancelChord()
    this.focusedState = value
    this.answer.focused = value && this.editing
    this.search.focused = value && this.searchFocused
  }

  invalidate(): void {
    this.list.invalidate()
    this.answer.invalidate()
    this.search.invalidate()
  }

  /** Release the inline binding editor and its shared-keymap listeners. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Shared keymap: an inactive Settings pane must not cancel a chord that the
    // focused prompt is still typing.
    if (this.focusedState) this.options.keymap.cancelChord()
    this.answer.dispose()
    this.search.dispose()
  }

  // -------------------------------------------------------------------------
  // Rows

  private keys(row: ShortcutRow): string[] {
    return this.options.keymap.getBindings(row.action.id)
  }

  private keyLabel(row: ShortcutRow): string {
    const keys = this.keys(row)
    if (keys.length) {
      return keys
        .map(key => formatBinding(key.split(' ')).replace(/\bAlt\+/g, process.platform === 'darwin' ? 'Option+' : 'Alt+'))
        .join(' / ')
    }
    const override = this.options.keymap.getUserConfig()[row.action.id]
    return override === null || (Array.isArray(override) && !override.length) ? 'Disabled' : 'Not bound'
  }

  private visibleRows(): ShortcutRow[] {
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return this.rows
    return this.rows.filter(row => {
      const haystack = [
        row.label,
        row.action.id,
        row.action.description,
        row.action.note ?? '',
        row.group,
        this.keyLabel(row),
      ].join(' ').toLowerCase()
      return terms.every(term => haystack.includes(term))
    })
  }

  private currentIndex(): number {
    const rows = this.visibleRows()
    if (rows.length === 0) return 0
    if (this.selectedId !== undefined) {
      const found = rows.findIndex(row => row.action.id === this.selectedId)
      if (found >= 0) return found
    }
    return Math.min(this.selectedIndex, rows.length - 1)
  }

  private reconcile(): void {
    const rows = this.visibleRows()
    if (rows.length === 0) {
      this.selectedIndex = 0
      this.selectedId = undefined
      return
    }
    const found = this.selectedId === undefined ? -1 : rows.findIndex(row => row.action.id === this.selectedId)
    if (found >= 0) {
      this.selectedIndex = found
      return
    }
    this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1)
    this.selectedId = rows[this.selectedIndex]?.action.id
  }

  private move(delta: number): void {
    const rows = this.visibleRows()
    if (rows.length === 0) return
    const from = this.currentIndex()
    const next = ((from + delta) % rows.length + rows.length) % rows.length
    this.selectedIndex = next
    this.selectedId = rows[next]?.action.id
    if (next < this.windowStart) this.windowStart = next
    this.clearMessage()
    this.keymap.cancelChord()
    this.tui.requestRender()
  }

  private moveTo(index: number): void {
    const rows = this.visibleRows()
    if (rows.length === 0) return
    this.selectedIndex = Math.max(0, Math.min(index, rows.length - 1))
    this.selectedId = rows[this.selectedIndex]?.action.id
    if (this.selectedIndex < this.windowStart) this.windowStart = this.selectedIndex
    this.tui.requestRender()
  }

  private clearMessage(): void {
    this.message = ''
    this.failed = false
  }

  // -------------------------------------------------------------------------
  // Editing / saving

  private selectedRow(): ShortcutRow | undefined {
    return this.visibleRows()[this.currentIndex()]
  }

  private edit(): void {
    const row = this.selectedRow()
    if (row === undefined || this.saving) return
    this.keymap.cancelChord()
    this.editing = true
    this.searchFocused = false
    this.search.focused = false
    this.clearMessage()
    this.answer.editor.setText(this.keys(row).join('\n'))
    this.answer.focused = this.focusedState
    this.tui.requestRender()
  }

  private cancelEdit(): void {
    this.editing = false
    this.answer.focused = false
    this.clearMessage()
    this.keymap.cancelChord()
    this.tui.requestRender()
  }

  private async save(bindings: string[] | null | undefined): Promise<void> {
    const row = this.selectedRow()
    if (row === undefined || this.saving) return
    this.keymap.cancelChord()
    this.saving = true
    this.message = 'Saving…'
    this.failed = false
    try {
      await this.options.onChange(row.action.id, bindings)
      this.editing = false
      this.answer.focused = false
      this.message = bindings === undefined ? 'Default restored' : bindings === null ? 'Disabled' : 'Saved'
      this.failed = false
    } catch (error) {
      this.failed = true
      this.message = errorText(error)
    } finally {
      this.saving = false
      this.tui.requestRender()
    }
  }

  private saveText(text: string): void {
    try {
      void this.save(parseShortcutText(text))
    } catch (error) {
      this.failed = true
      this.message = errorText(error)
      this.tui.requestRender()
    }
  }

  // -------------------------------------------------------------------------
  // Input

  private resolve(data: string): ResolvedModalAction | undefined {
    return resolveListAction(this.options.keymap, data, 'keybindingsList')
  }

  handleInput(data: string): void {
    if (this.done || this.disposed) return
    const pasting = this.isPasting
    if (!pasting && this.options.onInterrupt !== undefined && isInterruptKey(this.options.keymap, data)) {
      this.options.keymap.cancelChord()
      this.options.onInterrupt()
      this.tui.requestRender()
      return
    }
    // A pending save must not trap the keyboard. Esc closes this pane while the
    // parent-owned write settles; all mutating shortcuts stay gated below.
    if (this.saving) {
      if (matchesKey(data, 'escape')) this.back()
      return
    }
    if (this.editing) {
      this.inputEditing(data)
      return
    }
    if (this.searchFocused) {
      this.inputSearch(data)
      return
    }
    this.inputBrowse(data)
  }

  private inputEditing(raw: string): void {
    if (matchesKey(raw, 'escape')) {
      this.cancelEdit()
      return
    }
    // Ctrl+C is `app.clear` in this embedded editor: abandon the edit locally
    // instead of dropping the key on the hidden root draft.
    if (!this.answer.editor.isPasting() && cancelFallback(this.options.keymap, raw)) {
      this.cancelEdit()
      return
    }
    if (!this.answer.editor.isPasting()) {
      // A bare LF is Ctrl+J (newline), not Enter. Check the newline aliases
      // first so a legacy ^J byte cannot save the edit.
      if (matchesKey(raw, 'shift+enter') || matchesKey(raw, 'ctrl+j')) {
        this.answer.editor.ccInsertText('\n')
        this.tui.requestRender()
        return
      }
      // A real CR lands here; a bare LF was already taken as Ctrl+J above.
      if (matchesKey(raw, 'enter')) {
        this.saveText(this.answer.raw)
        return
      }
    }
    const before = this.answer.editor.captureDraft()
    const result = this.answer.handleKey(raw)
    if (result === 'submit') {
      this.answer.editor.restoreDraft(before)
      this.saveText(this.answer.lastSubmittedText ?? before.expandedText)
    } else if (result === 'cancel' || result === 'interrupt') {
      if (result === 'interrupt' && this.options.onInterrupt !== undefined) this.options.onInterrupt()
      else this.cancelEdit()
    }
    this.tui.requestRender()
  }

  private inputSearch(raw: string): void {
    // A fragmented bracketed paste owns the bytes while it arrives: a pasted
    // Ctrl+C/Esc byte stays query content and never blurs or closes the surface.
    const action = this.search.editor.isPasting() ? undefined : this.resolve(raw)
    if (action !== undefined) {
      switch (action.id) {
        case 'keybindings.edit':
        case 'list.select':
        case 'dialog.confirm':
          this.searchFocused = false
          this.search.focused = false
          this.edit()
          return
        case 'list.cancel':
        case 'dialog.cancel':
        case 'app.cancel':
          this.searchFocused = false
          this.search.focused = false
          this.tui.requestRender()
          return
        case 'list.previous':
          if (!isPrintableByte(raw)) { this.move(-1); return }
          break
        case 'list.next':
          if (!isPrintableByte(raw)) { this.move(1); return }
          break
        case 'list.page-up':
          if (!isPrintableByte(raw)) { this.move(-5); return }
          break
        case 'list.page-down':
          if (!isPrintableByte(raw)) { this.move(5); return }
          break
        case 'list.first':
          if (!isPrintableByte(raw)) { this.moveTo(0); return }
          break
        case 'list.last':
          if (!isPrintableByte(raw)) { this.moveTo(this.visibleRows().length - 1); return }
          break
        default:
          break
      }
    }
    const result = this.search.handleKey(raw)
    if (result === 'submit') {
      this.searchFocused = false
      this.search.focused = false
      this.edit()
    } else if (result === 'cancel') {
      this.searchFocused = false
      this.search.focused = false
      this.tui.requestRender()
    }
  }

  private focusSearch(): void {
    this.searchFocused = true
    this.search.focused = this.focusedState
    this.clearMessage()
    this.keymap.cancelChord()
    this.tui.requestRender()
  }

  private inputBrowse(raw: string): void {
    const action = this.resolve(raw)
    if (action !== undefined) {
      switch (action.id) {
        case 'modal.search': this.focusSearch(); return
        case 'keybindings.edit':
        case 'list.select':
        case 'dialog.confirm': this.edit(); return
        case 'keybindings.disable': { const row = this.selectedRow(); if (row !== undefined) void this.save(null); return }
        case 'keybindings.reset': { const row = this.selectedRow(); if (row !== undefined) void this.save(undefined); return }
        case 'list.previous': this.move(-1); return
        case 'list.next': this.move(1); return
        case 'list.page-up': this.move(-5); return
        case 'list.page-down': this.move(5); return
        case 'list.first': this.moveTo(0); return
        case 'list.last': this.moveTo(this.visibleRows().length - 1); return
        case 'app.interrupt':
          // Without a parent interrupt hook, the configured interrupt key stays
          // this pane's escape hatch instead of becoming a dead key.
          this.back()
          return
        default:
          if (CLOSE_ACTIONS.has(action.id)) this.back()
          // Any other global/app action is inert inside this configuration pane.
          return
      }
    }
    // Recovery controls for this configuration pane only. They are not shown as
    // bindings (no fake hints), but they keep a disabled list action from
    // locking the user out of the shortcut editor.
    if (matchesKey(raw, 'escape')) this.back()
    else if (matchesKey(raw, 'up')) this.move(-1)
    else if (matchesKey(raw, 'down')) this.move(1)
    else if (matchesKey(raw, 'pageUp')) this.move(-5)
    else if (matchesKey(raw, 'pageDown')) this.move(5)
    else if (matchesKey(raw, 'home')) this.moveTo(0)
    else if (matchesKey(raw, 'end')) this.moveTo(this.visibleRows().length - 1)
    // Recovery only: a bare LF is Ctrl+J/newline, never a row edit.
    else if (raw !== '\n' && matchesKey(raw, 'enter')) this.edit()
  }

  private back(): void {
    if (this.done) return
    this.done = true
    this.keymap.cancelChord()
    this.options.onBack()
  }

  // -------------------------------------------------------------------------
  // Rendering

  private frameActions(): ModalAction[] {
    if (this.editing) {
      return [
        { id: 'save', label: 'save', action: 'list.select', onActivate: () => this.saveText(this.answer.raw) },
        { id: 'cancel', label: 'cancel', action: 'list.cancel', onActivate: () => this.cancelEdit() },
      ]
    }
    return [
      { id: 'edit', label: 'edit', action: 'keybindings.edit', onActivate: () => this.edit() },
      { id: 'disable', label: 'disable', action: 'keybindings.disable', onActivate: () => { void this.save(null) } },
      { id: 'reset', label: 'reset', action: 'keybindings.reset', onActivate: () => { void this.save(undefined) } },
      { id: 'search', label: 'search', action: 'modal.search', onActivate: () => this.focusSearch() },
      { id: 'back', label: 'back', action: 'list.cancel', onActivate: () => this.back() },
    ]
  }

  private searchLine(width: number): string {
    return this.search.render(Math.max(4, width), this.searchFocused, 'Search shortcuts…', '')[0] ?? ''
  }

  private rowLines(row: ShortcutRow, width: number, focused: boolean): string[] {
    const marker = focused ? cc.suggestion('❯') : ' '
    const style = focused ? cc.suggestion : t.text
    const keys = this.keyLabel(row)
    const lines: string[] = []
    if (width >= 48) {
      const leftWidth = Math.min(32, Math.floor(width * 0.43))
      const rightWidth = Math.max(1, width - leftWidth - 5)
      const left = wrap(keys, leftWidth)
      const right = wrap(row.label, rightWidth)
      for (let line = 0; line < Math.max(left.length, right.length); line += 1) {
        const key = left[line] ?? ''
        lines.push(`${line === 0 ? marker : ' '} ${style(key)}${' '.repeat(Math.max(0, leftWidth - visibleWidth(key)))}${dim(' │ ')}${style(right[line] ?? '')}`)
      }
    } else {
      lines.push(...wrap(row.label, Math.max(1, width - 2)).map((line, offset) => `${offset === 0 ? marker : ' '} ${style(line)}`))
      lines.push(...wrap(keys, Math.max(1, width - 2)).map(line => '  ' + dim(style(line))))
    }
    return lines
  }

  private editLines(width: number): string[] {
    const row = this.selectedRow()
    if (row === undefined) return []
    const lines = [
      ` ${bold(t.text(oneLine(row.label, 160)))}`,
      dim(` Current: ${this.keyLabel(row)}`),
      '',
    ]
    const rendered = this.answer.render(Math.max(4, width - 2), this.focusedState, 'ctrl+p')
    lines.push(...rendered.map(line => '  ' + line))
    lines.push('')
    lines.push(...wrap(dim('One binding per line; spaces make chords. Option = Alt.'), width))
    lines.push(...wrap(dim('Enter save · Shift+Enter another binding · Esc cancel'), width))
    return lines.map(line => fit(line, width))
  }

  /** Frame identity: mode plus the action the mutating footer would act on. */
  private ownerKey(): string {
    return `${this.editing ? 'keybindings:edit' : 'keybindings:row'}:${this.selectedActionId ?? ''}`
  }

  render(width: number): string[] {
    return this.list.render(width, {
      title: 'Keyboard shortcuts',
      ownerKey: this.ownerKey(),
      beforeRows: this.options.path === '' ? 1 : 2,
      before: bodyWidth => {
        const before = [this.searchLine(bodyWidth)]
        if (this.options.path !== '') before.push(fit(dim(sanitize(tildePath(this.options.path))), bodyWidth))
        return before
      },
      status: bodyWidth => listStatusLines(this.message, this.failed, bodyWidth),
      actions: this.frameActions(),
      onClose: () => (this.editing ? this.cancelEdit() : this.back()),
      keymap: this.keymap,
    }, (bodyWidth, bodyHeight) => this.buildBody(bodyWidth, bodyHeight))
  }

  private buildBody(width: number, height: number): ListBody {
    if (height <= 0) return { lines: [] }
    if (this.editing) return { lines: this.editLines(width).slice(0, height) }
    const rows = this.visibleRows()
    if (rows.length === 0) {
      return { lines: [fit(` ${t.muted(`No shortcuts match “${oneLine(this.query, 60)}”.`)}`, width)] }
    }
    const blocks: ListBlock[] = []
    if (width >= 48) {
      const leftWidth = Math.min(32, Math.floor(width * 0.43))
      blocks.push({ lines: [dim(' ' + 'Key(s)'.padEnd(leftWidth + 2) + '│ Action')] })
    }
    const selected = this.currentIndex()
    for (const [index, row] of rows.entries()) {
      if (index === 0 || rows[index - 1]?.group !== row.group) {
        blocks.push({ lines: [' ' + bold(cc.permission(row.group))] })
      }
      blocks.push({
        lines: this.rowLines(row, width, index === selected),
        focused: index === selected,
        index,
        key: row.action.id,
      })
    }
    const window = windowList(blocks, height, { start: this.windowStart })
    this.windowStart = window.start
    return { lines: window.lines, hits: window.hits }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done || this.disposed) return undefined
    const chrome = this.list.chromeMouse(event)
    if (chrome !== undefined) return chrome
    const beforeIndex = this.list.beforeIndex(event.y)
    if (beforeIndex === 0 && !this.editing) {
      if (event.type === 'press' && event.button === 'left') return { handled: true }
      if (event.type === 'click' && event.button === 'left') {
        this.focusSearch()
        return { handled: true, render: true }
      }
    }
    const body = this.list.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'wheel' && !this.editing) {
      this.move((event.wheelDelta ?? 0) < 0 ? -3 : 3)
      return { handled: true, render: true }
    }
    return this.list.rowMouse(event, this.ownerKey(), hit => this.activateHit(hit))
  }

  /** A click selects its row; clicking the selected row edits it. */
  private activateHit(hit: HitRange): void {
    const row = this.visibleRows()[hit.index]
    if (row === undefined) return
    const wasSelected = this.selectedActionId === row.action.id
    this.moveTo(hit.index)
    if (wasSelected) this.edit()
    this.tui.requestRender()
  }
}
