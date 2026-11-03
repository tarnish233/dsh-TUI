/**
 * DSH approval and AskUserQuestion dialogs.
 *
 * Both are Focusable Pi TUI components and capture fullscreen viewport keys
 * while focused. List/dialog navigation is resolved through the shared
 * `CcKeymap` from src/input/index.ts, in `list` then `dialog` context, so
 * remapping or disabling an action is respected. No hardcoded Ctrl+P/N,
 * arrows, j/k or digit fallback is applied after a remap/disable.
 *
 * Constructors (exact):
 *
 *   new SelectDialog(tui, { title, items, onSelect, onCancel, keymap? })
 *
 *   new DecisionDialog(tui, {
 *     request, onSubmit, onCancel, keymap?
 *   })
 *
 * DecisionDialog returns exactly what the backend contract expects:
 *   approval -> the selected option's opaque `value`
 *   question -> { answers: (string | string[])[] } in question order
 *
 * The custom answer row uses the same shared keymap through CcEditor, so
 * editor-context typing, word kill, yank and user overrides work without a
 * second resolve. Parent App owns prompt/history search and passes the shared
 * keymap; it may call `cancelChord()` on focus changes (the dialogs also do).
 *
 * Layout/keys are adapted from agent_tui (MIT) src/ui/{dialogs,questionnaire,
 * select}.ts, rebuilt on public Pi TUI + input components only.
 */
import {
  type Component,
  type Focusable,
  matchesKey,
  type TUI,
} from '@earendil-works/pi-tui'
import type { DecisionOption, DecisionRequest, Question } from '../backend/types.ts'
import { createCcKeymap, type CcKeymap } from '../input/index.ts'
import { InlineAnswer } from './inline-editor.ts'
import { bold, cc, dim, t } from './theme.ts'
import { fit, truncateToWidth, visibleWidth, wrap } from './text.ts'

// ---------------------------------------------------------------------------
// Keymap action dispatch

interface ResolvedDialogAction {
  id: string
  keys: string[]
}

/**
 * Resolve one key for a list/dialog surface without leaking editor-context
 * actions (the `dialog` context deliberately falls back to `editor` for text
 * fields). List/global actions are tried first; only `dialog.confirm` and
 * `dialog.cancel` may fall back. Pending/cancelled chords are consumed once and
 * never retried, so chord state keeps a single owner.
 */
function actionOf(resolution: ReturnType<CcKeymap['resolve']>): ResolvedDialogAction | undefined {
  return resolution.kind === 'action' ? { id: resolution.action.id, keys: resolution.keys } : undefined
}

export function listAction(keymap: CcKeymap, data: string): ResolvedDialogAction | undefined {
  const list = keymap.resolve(data, 'list')
  if (list.kind === 'action') {
    const id = list.action.id
    if (id.startsWith('list.') || isCancelAction(id)) return actionOf(list)
    // Another global/app action (help, expand, …) is not a list action.
    return undefined
  }
  if (list.kind !== 'none') return undefined
  const dialog = keymap.resolve(data, 'dialog')
  if (dialog.kind === 'action' && (dialog.action.id === 'dialog.confirm' || dialog.action.id === 'dialog.cancel')) {
    return actionOf(dialog)
  }
  return undefined
}

const digitOf = (action: ResolvedDialogAction): number | undefined => {
  const key = action.keys[0]
  return key !== undefined && /^[1-9]$/.test(key) ? Number(key) : undefined
}

const isCancelAction = (id: string): boolean =>
  id === 'list.cancel' || id === 'dialog.cancel' || id === 'app.cancel' || id === 'app.interrupt'
const isSelectAction = (id: string): boolean => id === 'list.select' || id === 'dialog.confirm'

const isTab = (data: string): boolean => matchesKey(data, 'tab')
const isShiftTab = (data: string): boolean => matchesKey(data, 'shift+tab')
const isSpace = (data: string): boolean => matchesKey(data, 'space')

// ---------------------------------------------------------------------------
// Layout helpers

const rule = (width: number): string => cc.inactive('─'.repeat(Math.max(1, width)))
const hints = (parts: string[]): string => dim(cc.inactive(parts.join(' · ')))
const pointer = (focused: boolean): string => (focused ? cc.suggestion('❯') : ' ')
const numberLabel = (value: number, numberWidth: number): string => dim(`${value}.`.padEnd(numberWidth + 1))

function head(title: string, width: number): string[] {
  const out = [rule(width)]
  for (const line of wrap(title, Math.max(4, width - 2))) out.push(` ${bold(cc.permission(line))}`)
  return out
}

interface RowBlock {
  lines: string[]
  focused: boolean
}

export function windowRows(blocks: RowBlock[], budget: number): string[] {
  const total = blocks.reduce((sum, block) => sum + block.lines.length, 0)
  if (total <= budget || blocks.length === 0) return blocks.flatMap(block => block.lines)
  let focus = blocks.findIndex(block => block.focused)
  if (focus < 0) focus = blocks.length - 1
  let start = focus
  let end = focus + 1
  let used = blocks[focus]!.lines.length
  for (let grew = true; grew;) {
    grew = false
    if (end < blocks.length && used + blocks[end]!.lines.length <= budget) {
      used += blocks[end]!.lines.length
      end += 1
      grew = true
    }
    if (start > 0 && used + blocks[start - 1]!.lines.length <= budget) {
      start -= 1
      used += blocks[start]!.lines.length
      grew = true
    }
  }
  const out: string[] = []
  for (let index = start; index < end; index += 1) {
    const lines = [...blocks[index]!.lines]
    if (!blocks[index]!.focused && index === start && start > 0) lines[0] = dim('↑') + lines[0]!.slice(1)
    else if (!blocks[index]!.focused && index === end - 1 && end < blocks.length) lines[0] = dim('↓') + lines[0]!.slice(1)
    out.push(...lines)
  }
  return out
}

export function rowBudget(tui: TUI): number {
  const rows = tui.terminal.rows
  return Number.isFinite(rows) && rows > 0 ? Math.max(4, rows - 14) : Number.POSITIVE_INFINITY
}

function choiceBlocks(
  items: readonly DecisionOption[],
  focus: number,
  selected: number | undefined,
  width: number,
  numbered: boolean,
  multi: boolean,
  checked: ReadonlySet<number>,
): RowBlock[] {
  const numberWidth = numbered ? String(items.length).length : 0
  const indent = ' '.repeat(numberWidth + (multi ? 8 : 4))
  return items.map((item, index) => {
    const focused = focus === index
    const chosen = selected === index
    const style = chosen ? cc.success : focused ? cc.suggestion : t.text
    const box = multi ? `${checked.has(index) ? cc.success('[✔]') : t.text('[ ]')} ` : ''
    const prefix = `${pointer(focused)} ${numbered ? `${numberLabel(index + 1, numberWidth)} ` : ''}${box}`
    const label = wrap(item.label, Math.max(4, width - visibleWidth(prefix)))
    const lines = [`${prefix}${style(label[0] ?? '')}${chosen ? ` ${cc.success('✔')}` : ''}`]
    for (const line of label.slice(1)) lines.push(indent + style(line))
    if (item.description !== undefined && item.description.trim() !== '') {
      for (const line of wrap(item.description, Math.max(4, width - indent.length))) lines.push(indent + dim(focused || chosen ? style(line) : t.text(line)))
    }
    return { lines, focused }
  })
}

// ---------------------------------------------------------------------------
// Generic select dialog

export interface SelectDialogOptions {
  title: string
  items: DecisionOption[]
  onSelect: (value: unknown) => void
  onCancel: () => void
  /** Shared keymap from the input subsystem. A default CC keymap is used when omitted. */
  keymap?: CcKeymap
}

export class SelectDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: SelectDialogOptions
  private index = 0
  private focusedState = false
  private done = false

  constructor(tui: TUI, options: SelectDialogOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.keymap.cancelChord()
    this.focusedState = value
  }

  /** Parent hook for focus changes; safe to call repeatedly. */
  cancelChord(): void {
    this.keymap.cancelChord()
  }

  invalidate(): void {}

  private finish(value: unknown): void {
    if (this.done) return
    this.done = true
    this.options.onSelect(value)
  }

  private cancel(): void {
    if (this.done) return
    this.done = true
    this.options.onCancel()
  }

  private move(delta: number): void {
    const count = this.options.items.length
    if (count === 0) return
    this.index = (this.index + delta + count) % count
  }

  handleInput(raw: string): void {
    if (this.done) return
    const action = listAction(this.keymap, raw)
    if (action === undefined) return
    if (isCancelAction(action.id)) {
      this.cancel()
      return
    }
    const count = this.options.items.length
    if (action.id === 'list.previous') this.move(-1)
    else if (action.id === 'list.next') this.move(1)
    else if (action.id === 'list.page-up') this.move(-5)
    else if (action.id === 'list.page-down') this.move(5)
    else if (action.id === 'list.first' && count > 0) this.index = 0
    else if (action.id === 'list.last' && count > 0) this.index = count - 1
    else if (isSelectAction(action.id) && count > 0) this.finish(this.options.items[this.index]!.value)
    else if (action.id === 'list.select-digit') {
      const number = digitOf(action)
      if (number !== undefined && number <= count) this.finish(this.options.items[number - 1]!.value)
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, Math.floor(width))
    const out = [...head(this.options.title, safeWidth), '']
    const items = this.options.items
    if (items.length === 0) {
      out.push(` ${t.muted('No options are available.')}`)
    } else {
      const blocks = choiceBlocks(items, this.index, this.index, safeWidth, true, false, new Set())
      out.push(...windowRows(blocks, rowBudget(this.tui)))
      if (items.length > 1) out.push(` ${t.subtle(`(${this.index + 1}/${items.length})`)}`)
    }
    out.push('', ` ${hints(['Enter to select', '↑/↓ to navigate', 'Esc to cancel'])}`)
    return out.map(line => fit(line, safeWidth))
  }
}

// ---------------------------------------------------------------------------
// Decision dialog (approval or ordered questions)

interface QuestionState {
  focus: number
  selected: number | undefined
  custom: boolean
  /** Custom text survives CcEditor's submit buffer clear. */
  customText: string
  checked: Set<number>
  answer: InlineAnswer
}

export interface DecisionDialogOptions {
  request: DecisionRequest
  onSubmit: (value: unknown) => void
  onCancel: () => void
  /** Shared keymap from the input subsystem. A default CC keymap is used when omitted. */
  keymap?: CcKeymap
}

export class DecisionDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly request: DecisionRequest
  private readonly options: DecisionDialogOptions
  private readonly questions: readonly Question[]
  private readonly states: QuestionState[]
  private readonly approvalItems: readonly DecisionOption[]
  private approvalIndex = 0
  private tab = 0
  private reviewFocus = 0
  private focusedState = false
  private done = false

  constructor(tui: TUI, options: DecisionDialogOptions) {
    this.tui = tui
    this.options = options
    this.request = options.request
    this.keymap = options.keymap ?? createCcKeymap()
    this.questions = this.request.kind === 'question' ? (this.request.questions ?? []) : []
    this.approvalItems = this.request.kind === 'approval' ? (this.request.options ?? []) : []
    this.states = this.questions.map(() => ({
      focus: 0,
      selected: undefined,
      custom: false,
      customText: '',
      checked: new Set<number>(),
      answer: new InlineAnswer(tui, this.keymap),
    }))
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.keymap.cancelChord()
    this.focusedState = value
    this.syncFocus()
  }

  /** Parent hook for focus changes; safe to call repeatedly. */
  cancelChord(): void {
    this.keymap.cancelChord()
  }

  invalidate(): void {
    for (const state of this.states) state.answer.invalidate()
  }

  // -------------------------------------------------------------------------
  // State

  private get isApproval(): boolean {
    return this.request.kind === 'approval'
  }

  private get onReview(): boolean {
    return !this.isApproval && this.tab === this.questions.length
  }

  private get hideSubmitTab(): boolean {
    return !this.isApproval && this.questions.length === 1 && this.questions[0]!.multiSelect !== true
  }

  private get lastTab(): number {
    if (this.isApproval) return 0
    return this.hideSubmitTab ? this.questions.length - 1 : this.questions.length
  }

  private get question(): Question {
    return this.questions[this.tab]!
  }

  private get state(): QuestionState {
    return this.states[this.tab]!
  }

  private customRow(): number {
    return this.question.options.length
  }

  private nextRow(): number {
    return this.question.multiSelect === true ? this.question.options.length + 1 : -1
  }

  private lastRow(): number {
    return this.question.multiSelect === true ? this.question.options.length + 1 : this.question.options.length
  }

  private editing(): boolean {
    return !this.isApproval && !this.onReview && this.state.focus === this.customRow()
  }

  private syncFocus(): void {
    this.states.forEach((state, index) => {
      const question = this.questions[index]
      const customRow = question?.options.length ?? -1
      state.answer.focused = this.focusedState && !this.isApproval && !this.onReview && index === this.tab && state.focus === customRow
    })
  }

  private setTab(tab: number): void {
    this.keymap.cancelChord()
    this.tab = Math.max(0, Math.min(this.lastTab, tab))
    this.reviewFocus = 0
    this.syncFocus()
  }

  private setFocus(row: number): void {
    this.state.focus = Math.max(0, Math.min(this.lastRow(), row))
    this.syncFocus()
  }

  private advance(): void {
    if (this.hideSubmitTab) {
      this.submit()
      return
    }
    this.setTab(this.tab + 1)
  }

  private submit(): void {
    if (this.done) return
    this.done = true
    this.syncFocus()
    this.options.onSubmit({ answers: this.answers() })
  }

  private cancel(): void {
    if (this.done) return
    this.done = true
    this.syncFocus()
    this.options.onCancel()
  }

  private finishApproval(value: unknown): void {
    if (this.done) return
    this.done = true
    this.options.onSubmit(value)
  }

  private answers(): (string | string[])[] {
    return this.questions.map((question, index) => {
      const state = this.states[index]!
      const text = state.answer.text !== '' ? state.answer.text : state.customText
      if (question.multiSelect === true) {
        const values = [...state.checked].sort((a, b) => a - b).map(option => question.options[option]?.label ?? '').filter(label => label !== '')
        if (text !== '') values.push(text)
        return values
      }
      if (state.custom && text !== '') return text
      if (state.selected !== undefined) return question.options[state.selected]?.label ?? ''
      return ''
    })
  }

  private choose(index: number): void {
    this.state.selected = index
    this.state.custom = false
    this.state.customText = ''
    this.advance()
  }

  private chooseCustom(text?: string): void {
    const value = text ?? (this.state.answer.text !== '' ? this.state.answer.text : this.state.customText)
    if (value === '') return
    this.state.customText = value
    this.state.custom = true
    this.state.selected = undefined
    this.advance()
  }

  private toggle(index: number): void {
    if (this.state.checked.has(index)) this.state.checked.delete(index)
    else this.state.checked.add(index)
  }

  // -------------------------------------------------------------------------
  // Input

  handleInput(raw: string): void {
    if (this.done) return
    if (this.isApproval) {
      this.approvalKey(raw)
      return
    }
    if (this.onReview) {
      this.reviewKey(raw)
      return
    }
    if (this.editing()) {
      this.editorKey(raw)
      return
    }
    this.questionKey(raw)
  }

  private approvalKey(raw: string): void {
    const action = listAction(this.keymap, raw)
    if (action === undefined) return
    const count = this.approvalItems.length
    if (isCancelAction(action.id)) {
      this.cancel()
      return
    }
    if (action.id === 'list.previous' && count > 0) this.approvalIndex = (this.approvalIndex - 1 + count) % count
    else if (action.id === 'list.next' && count > 0) this.approvalIndex = (this.approvalIndex + 1) % count
    else if (action.id === 'list.page-up' && count > 0) this.approvalIndex = Math.max(0, this.approvalIndex - 5)
    else if (action.id === 'list.page-down' && count > 0) this.approvalIndex = Math.min(count - 1, this.approvalIndex + 5)
    else if (action.id === 'list.first' && count > 0) this.approvalIndex = 0
    else if (action.id === 'list.last' && count > 0) this.approvalIndex = count - 1
    else if (isSelectAction(action.id) && count > 0) this.finishApproval(this.approvalItems[this.approvalIndex]!.value)
    else if (action.id === 'list.select-digit') {
      const number = digitOf(action)
      if (number !== undefined && number <= count) this.finishApproval(this.approvalItems[number - 1]!.value)
    }
  }

  private questionKey(raw: string): void {
    const action = listAction(this.keymap, raw)
    if (action !== undefined) {
      this.applyQuestionAction(action)
      return
    }
    if (isTab(raw)) {
      this.setTab(this.tab + 1)
      return
    }
    if (isShiftTab(raw)) {
      this.setTab(this.tab - 1)
      return
    }
    if (this.question.multiSelect === true && isSpace(raw)) {
      if (this.state.focus < this.question.options.length) this.toggle(this.state.focus)
      else this.setFocus(this.customRow())
    }
  }

  private applyQuestionAction(action: ResolvedDialogAction): void {
    if (isCancelAction(action.id)) {
      this.cancel()
      return
    }
    const state = this.state
    const count = this.question.options.length
    const last = this.lastRow()
    if (action.id === 'list.previous') {
      this.setFocus(state.focus === 0 ? last : state.focus - 1)
    } else if (action.id === 'list.next') {
      this.setFocus(state.focus === last ? 0 : state.focus + 1)
    } else if (action.id === 'list.page-up') {
      this.setFocus(Math.max(0, state.focus - 5))
    } else if (action.id === 'list.page-down') {
      this.setFocus(Math.min(last, state.focus + 5))
    } else if (action.id === 'list.first') {
      this.setFocus(0)
    } else if (action.id === 'list.last') {
      this.setFocus(last)
    } else if (isSelectAction(action.id)) {
      this.selectFocused()
    } else if (action.id === 'list.select-digit') {
      const number = digitOf(action)
      if (number === undefined) return
      if (number <= count) {
        if (this.question.multiSelect === true) this.toggle(number - 1)
        else this.choose(number - 1)
      } else if (number === count + 1) {
        this.setFocus(count)
      }
    }
  }

  private selectFocused(): void {
    const state = this.state
    const count = this.question.options.length
    if (this.question.multiSelect === true) {
      const next = this.nextRow()
      if (state.focus === next) this.advance()
      else if (state.focus < count) this.toggle(state.focus)
      else this.setFocus(count)
      return
    }
    if (state.focus < count) this.choose(state.focus)
    else this.chooseCustom()
  }

  private editorKey(raw: string): void {
    const state = this.state
    const result = state.answer.handleKey(raw)
    switch (result) {
      case 'cancel':
        this.cancel()
        return
      case 'submit': {
        const submitted = state.answer.lastSubmittedText ?? state.answer.text
        if (submitted === '') {
          if (this.question.multiSelect === true) this.setFocus(this.nextRow())
          return
        }
        state.customText = submitted
        if (this.question.multiSelect === true) this.advance()
        else this.chooseCustom(submitted)
        return
      }
      case 'tab':
        if (this.question.multiSelect === true) this.setFocus(this.nextRow())
        else this.advance()
        return
      case 'up':
        this.setFocus(state.focus - 1)
        return
      case 'down':
        this.setFocus(this.question.multiSelect === true ? this.nextRow() : 0)
        return
      case 'handled':
        return
    }
  }

  private reviewKey(raw: string): void {
    const action = listAction(this.keymap, raw)
    if (action !== undefined) {
      if (isCancelAction(action.id)) {
        this.cancel()
        return
      }
      if (action.id === 'list.previous' || action.id === 'list.next') {
        this.reviewFocus = 1 - this.reviewFocus
        return
      }
      if (action.id === 'list.first') {
        this.reviewFocus = 0
        return
      }
      if (action.id === 'list.last') {
        this.reviewFocus = 1
        return
      }
      if (isSelectAction(action.id)) {
        if (this.reviewFocus === 0) this.submit()
        else this.cancel()
        return
      }
      if (action.id === 'list.select-digit') {
        const number = digitOf(action)
        if (number === 1) this.submit()
        else if (number === 2) this.cancel()
      }
      return
    }
    if (isTab(raw)) {
      this.setTab(0)
      return
    }
    if (isShiftTab(raw)) {
      this.setTab(this.questions.length - 1)
    }
  }

  // -------------------------------------------------------------------------
  // Rendering

  render(width: number): string[] {
    const safeWidth = Math.max(4, Math.floor(width))
    const out: string[] = [...head(this.request.title, safeWidth)]
    const message = this.request.message?.trim() ?? ''
    if (message !== '') {
      out.push(...wrap(message, Math.max(4, safeWidth - 2)).map(line => ` ${dim(t.text(line))}`))
    }
    if (this.isApproval) out.push(...this.renderApproval(safeWidth))
    else out.push(...this.renderQuestions(safeWidth))
    return out.map(line => fit(line, safeWidth))
  }

  private renderApproval(width: number): string[] {
    const out: string[] = ['']
    if (this.approvalItems.length === 0) {
      out.push(` ${t.muted('No approval options are available.')}`, ` ${hints(['Esc to cancel'])}`)
      return out
    }
    const blocks = choiceBlocks(this.approvalItems, this.approvalIndex, this.approvalIndex, width, true, false, new Set())
    out.push(...windowRows(blocks, rowBudget(this.tui)))
    out.push('', ` ${hints(['Enter to select', '↑/↓ to navigate', 'Esc to cancel'])}`)
    return out
  }

  private renderQuestions(width: number): string[] {
    const out: string[] = ['', this.renderTabs(width), '']
    if (this.onReview) {
      out.push(...this.renderReview(width))
      return out
    }
    const question = this.question
    const title = wrap(question.question, Math.max(4, width))
    out.push(...title.map(line => bold(t.text(line))), '')
    const blocks = question.multiSelect === true ? this.multiRows(width) : this.singleRows(width)
    out.push(...windowRows(blocks, rowBudget(this.tui) - title.length - 4))
    const preview = this.previewLines(width)
    if (preview.length > 0) out.push('', ...preview)
    out.push('', ` ${this.renderHints()}`)
    return out
  }

  private renderTabs(width: number): string {
    const arrows = !(this.questions.length === 1 && this.hideSubmitTab)
    const submit = this.hideSubmitTab ? '' : '✔ Submit'
    const headers = this.questions.map((question, index) => {
      const label = question.header !== undefined && question.header !== '' ? question.header : `Q${index + 1}`
      const answered = this.isAnswered(index)
      return `${answered ? '☒' : '☐'} ${label}`
    })
    const reserve = (arrows ? 4 : 0) + (submit === '' ? 0 : visibleWidth(submit) + 4)
    const budget = Math.max(8, width - reserve)
    let shown = headers
    const total = headers.reduce((sum, header) => sum + visibleWidth(header) + 4, 0)
    if (total > budget && headers.length > 0) {
      const each = Math.max(4, Math.floor(budget / headers.length) - 4)
      shown = headers.map(header => truncateToWidth(header, each, '…'))
    }
    const chip = (text: string, active: boolean): string => (active ? cc.chip(` ${text} `) : t.text(` ${text} `))
    let line = arrows ? `${this.tab === 0 ? cc.inactive('←') : t.text('←')} ` : ''
    shown.forEach((header, index) => {
      line += chip(header, index === this.tab)
    })
    if (submit !== '') line += chip(submit, this.onReview)
    if (arrows) line += ` ${this.tab === this.lastTab ? cc.inactive('→') : t.text('→')}`
    return line
  }

  private isAnswered(index: number): boolean {
    const question = this.questions[index]
    const state = this.states[index]
    if (question === undefined || state === undefined) return false
    if (question.multiSelect === true) return state.checked.size > 0 || state.answer.text !== '' || state.customText !== ''
    if (state.custom && (state.answer.text !== '' || state.customText !== '')) return true
    return state.selected !== undefined
  }

  private singleRows(width: number): RowBlock[] {
    const question = this.question
    const state = this.state
    const count = question.options.length
    const numberWidth = String(count + 1).length
    const options: DecisionOption[] = question.options.map(option => ({ label: option.label, description: option.description, value: option.label }))
    const blocks = choiceBlocks(options, state.focus, state.custom ? undefined : state.selected, width, true, false, new Set())
    const indent = ' '.repeat(numberWidth + 4)
    const focused = this.editing()
    const body = state.answer.render(Math.max(4, width - indent.length), focused, 'Type something.')
    const chosen = state.custom && (state.answer.text !== '' || state.customText !== '')
    const lines = [`${pointer(focused)} ${numberLabel(count + 1, numberWidth)} ${body[0] ?? ''}${chosen ? ` ${cc.success('✔')}` : ''}`]
    for (const line of body.slice(1)) lines.push(indent + line)
    blocks.push({ lines, focused })
    return blocks
  }

  private multiRows(width: number): RowBlock[] {
    const question = this.question
    const state = this.state
    const count = question.options.length
    const numberWidth = String(count + 1).length
    const indent = ' '.repeat(numberWidth + 8)
    const box = (checked: boolean): string => (checked ? cc.success('[✔]') : t.text('[ ]'))
    const blocks: RowBlock[] = question.options.map((option, index) => {
      const focused = state.focus === index
      const style = focused ? cc.suggestion : t.text
      const label = wrap(option.label, Math.max(4, width - indent.length))
      const lines = [`${pointer(focused)} ${numberLabel(index + 1, numberWidth)} ${box(state.checked.has(index))} ${style(label[0] ?? '')}`]
      for (const line of label.slice(1)) lines.push(indent + style(line))
      if (option.description !== undefined && option.description.trim() !== '') {
        for (const line of wrap(option.description, Math.max(4, width - indent.length))) lines.push(indent + cc.inactive(line))
      }
      return { lines, focused }
    })
    const editing = this.editing()
    const customChecked = state.answer.text !== '' || state.customText !== ''
    const body = state.answer.render(Math.max(4, width - indent.length), editing, 'Type something (optional)')
    const custom = [`${pointer(editing)} ${numberLabel(count + 1, numberWidth)} ${box(customChecked)} ${body[0] ?? ''}`]
    for (const line of body.slice(1)) custom.push(indent + line)
    blocks.push({ lines: custom, focused: editing })
    const next = this.nextRow()
    const onNext = state.focus === next
    const nextLabel = this.tab === this.questions.length - 1 ? 'Submit' : 'Next'
    blocks.push({ lines: [`${pointer(onNext)}    ${bold((onNext ? cc.suggestion : t.text)(nextLabel))}`], focused: onNext })
    return blocks
  }

  private previewLines(width: number): string[] {
    if (this.question.multiSelect === true) return []
    const option = this.question.options[this.state.focus]
    const preview = option?.preview
    if (preview === undefined || preview.trim() === '') return []
    const inner = Math.max(10, Math.min(width, 72))
    const lines = wrap(preview.replace(/\n+$/, ''), inner - 4).slice(0, 8)
    return [dim(`┌${'─'.repeat(inner - 2)}┐`), ...lines.map(line => `${dim('│')} ${t.muted(line)}`), dim(`└${'─'.repeat(inner - 2)}┘`)]
  }

  private renderHints(): string {
    const parts = ['Enter to select', '↑/↓ to navigate']
    if (this.questions.length > 1) parts.push('Tab to switch questions')
    if (this.question.multiSelect === true) parts.push('Space to toggle')
    if (this.editing()) parts.push('Enter to submit answer')
    parts.push('Esc to cancel')
    return hints(parts)
  }

  private renderReview(width: number): string[] {
    const out = [bold(t.text('Review your answers')), '']
    const answers = this.answers()
    if (answers.some(answer => (Array.isArray(answer) ? answer.length === 0 : answer === ''))) {
      out.push(cc.warning('⚠ You have not answered all questions'), '')
    }
    this.questions.forEach((question, index) => {
      const answer = answers[index]
      const text = Array.isArray(answer) ? answer.join(', ') : answer
      const lines = wrap(question.question, Math.max(4, width - 3))
      out.push(` ● ${t.text(lines[0] ?? '')}`, ...lines.slice(1).map(line => `   ${t.text(line)}`))
      if (text !== '') out.push(...wrap(`→ ${text}`, Math.max(4, width - 3)).map(line => `   ${cc.success(line)}`))
    })
    if (this.questions.length > 0) out.push('')
    out.push(cc.inactive('Ready to submit your answers?'), '')
    ;['Submit answers', 'Cancel'].forEach((label, index) => {
      const focused = index === this.reviewFocus
      out.push(`${pointer(focused)} ${dim(`${index + 1}.`)} ${(focused ? cc.suggestion : t.text)(label)}`)
    })
    return out
  }
}
