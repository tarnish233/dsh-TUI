/**
 * `/settings` as a three-tab dialog.
 *
 * The old Settings surface was a flat list of labels where every row toggled on
 * Enter. As the roster grew (tool display, thinking preview, live timer, native
 * auto title) that became one long undifferentiated column, so the surface is
 * now three tabs:
 *
 *   General   Auto title · Default screen · Keyboard shortcuts
 *   Thinking  Show thinking · Preview lines · Live timer
 *   Tools     every tool-card/diff preference from `TOOL_SETTING_KEYS`
 *
 * The General tab deliberately no longer repeats tool display: its previous
 * "Tool details" row is the Tools tab's `expandTools` row now, and the shared
 * tool roster (`groupTools`, expanded line limits, diff layout, …) lives in one
 * place instead of being split between tabs.
 *
 * Interaction stays inside the existing visual language (the same rule, title,
 * chips, `❯` pointer and hint rows as `dialogs.ts` / `model-picker.ts`):
 *
 *   ←/→ (or Tab/Shift+Tab)  switch tab      — captured by the dialog itself
 *   ↑/↓ Ctrl+P/Ctrl+N       move between rows (shared keymap `list.*`)
 *   Enter                   change the focused row's value (in-place cycle)
 *   Esc                     close
 *
 * Values cycle in place rather than opening a submenu: the roster is small, the
 * current value stays readable while it changes, and every write goes through
 * the parent's `onChange` (which owns `SettingsStore.set`). The two rows whose
 * effect is not a local preference — native auto title and the keybinding
 * editor — are explicit parent callbacks; this component never invents DSH
 * state and never writes files.
 *
 * Colors come from `theme.ts` only (`t.*` / `cc.*`); every line is width-safe.
 */
import { matchesKey, type Component, type Focusable, type TUI } from '#pi-tui'
import {
  DIFF_INDICATOR_MODE_VALUES,
  DIFF_SPLIT_MIN_WIDTH_VALUES,
  DIFF_VIEW_MODE_VALUES,
  EDIT_DIFF_COLLAPSED_LINES_VALUES,
  EXPANDED_INPUT_MAX_LINES_VALUES,
  EXPANDED_OUTPUT_MAX_LINES_VALUES,
  THINKING_LIVE_TIMER_MS_VALUES,
  THINKING_PREVIEW_LINES_VALUES,
  TOOL_LABEL_CLIP_VALUES,
  TOOL_SETTING_KEYS,
  WRITE_DIFF_COLLAPSED_LINES_VALUES,
  type Settings,
} from '../config.ts'
import { createCcKeymap, type CcKeymap } from '../input/index.ts'
import { isInterruptKey, listAction, rowBudget, windowRows } from './dialogs.ts'
import { fit, oneLine, sanitize, visibleWidth, wrap } from './text.ts'
import { bold, cc, dim, t } from './theme.ts'

export type SettingsTab = 'general' | 'thinking' | 'tools'

export interface SettingsTabDescriptor {
  readonly id: SettingsTab
  readonly label: string
}

/** Tab order is the ←/→ order. */
export const SETTINGS_TABS: readonly SettingsTabDescriptor[] = [
  { id: 'general', label: 'General' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'tools', label: 'Tools' },
]

/** One tool preference key; the Tools tab is built from the shared roster. */
type ToolSettingKey = typeof TOOL_SETTING_KEYS[number]

/** Labels/descriptions follow pi-cc-extensions' config panel wording. */
const TOOL_ROW_LABELS: Record<ToolSettingKey, string> = {
  groupTools: 'Group tool calls',
  expandTools: 'Expand tool details',
  expandedInputMaxLines: 'Expanded input lines',
  expandedOutputMaxLines: 'Expanded output lines',
  toolLabelClip: 'Tool label clip',
  diffViewMode: 'Diff layout',
  diffIndicatorMode: 'Diff indicator',
  diffSplitMinWidth: 'Split min width',
  editDiffCollapsedLines: 'Edit collapsed lines',
  writeDiffCollapsedLines: 'Write collapsed lines',
  diffWordWrap: 'Diff word wrap',
}

const TOOL_ROW_DESCRIPTIONS: Record<ToolSettingKey, string> = {
  groupTools: 'Fold adjacent non-diff tool calls into one summary',
  expandTools: 'Open tool cards as Input/Output details instead of the folded summary',
  expandedInputMaxLines: 'Input lines shown in an expanded tool card before the show-more hint',
  expandedOutputMaxLines: 'Output lines shown in an expanded tool card before the show-more hint',
  toolLabelClip: 'Max characters for paths/commands in tool summaries; auto fits the terminal width',
  diffViewMode: 'auto picks side-by-side when the terminal is wide enough; split/unified force one layout',
  diffIndicatorMode: 'Change marker style used by diff rows',
  diffSplitMinWidth: 'Minimum terminal width before an auto/split diff uses two columns',
  editDiffCollapsedLines: 'Edit diff body lines before the expand hint; 0 shows change counts only',
  writeDiffCollapsedLines: 'Write-only diff body lines before the expand hint',
  diffWordWrap: 'Wrap long diff lines instead of truncating them to the panel width',
}

/**
 * One settings row as the dialog sees it. `id` is stable and is what the parent
 * may use in tests/telemetry; the label/value are display strings only.
 */
export interface SettingsRowView {
  readonly id: string
  readonly tab: SettingsTab
  readonly label: string
  readonly value: string
  readonly description?: string
}

export interface SettingsDialogOptions {
  /** Effective settings snapshot (`SettingsStore.get()`). */
  settings: Settings
  /**
   * Local TUI preference change. The parent persists it through
   * `SettingsStore.set` and pushes the refreshed snapshot back via
   * `setSettings` when it differs.
   */
  onChange: (patch: Partial<Settings>) => void | Promise<void>
  /**
   * Native auto-title round trip. DSH owns the capability and its effective
   * value, so the parent runs the command and reports the outcome.
   */
  onAutoTitle: () => void
  /** Open the existing keybinding editor (parent-owned screen). */
  onKeybindings: () => void
  /** Display label of the native auto-title state, e.g. `inherit · native on`. */
  autoTitleLabel?: string
  /** Shared keymap from the input subsystem. A default CC keymap is used when omitted. */
  keymap?: CcKeymap
  /** Screen the app is running in; shown as context on the default-screen row. */
  screen?: 'inline' | 'fullscreen'
  /** Settings file path, shown in the title like the previous flat dialog. */
  path?: string
  /** Local dismissal (Esc / list.cancel). */
  onCancel: () => void
  /**
   * Global turn cancellation (`app.interrupt`, Ctrl+C by default). When omitted
   * the interrupt key closes this surface through `onCancel`.
   */
  onInterrupt?: () => void
}

const CANCEL_ACTIONS: ReadonlySet<string> = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])
const SELECT_ACTIONS: ReadonlySet<string> = new Set(['list.select', 'dialog.confirm'])

/** Next value in a small roster, wrapping at the end. */
function nextInRoster<T>(values: readonly T[], current: T): T {
  const index = values.indexOf(current)
  if (index < 0) return values[0] ?? current
  return values[(index + 1) % values.length] ?? current
}

const onOff = (value: boolean): string => (value ? 'on' : 'off')

/**
 * Three-tab settings surface. One instance is mounted by the parent; every change
 * that lands is applied to the local snapshot immediately so the row value and
 * the following cycle step never depend on the parent's re-render timing.
 */
export class SettingsDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: SettingsDialogOptions
  private current: Settings
  private tabIndex = 0
  private rowIndex = 0
  private focusedState = false
  private done = false
  private message = ''
  private failed = false

  constructor(tui: TUI, options: SettingsDialogOptions) {
    this.tui = tui
    this.options = options
    this.current = { ...options.settings }
    this.keymap = options.keymap ?? createCcKeymap()
  }

  // -------------------------------------------------------------------------
  // State accessors (parent/tests)

  get settings(): Settings {
    return { ...this.current }
  }

  /** Parent hook: refresh after a reload or a native round trip. */
  setSettings(next: Settings): void {
    this.current = { ...next }
    this.clampRow()
    this.tui.requestRender()
  }

  get activeTab(): SettingsTab {
    return SETTINGS_TABS[this.tabIndex]?.id ?? 'general'
  }

  get activeRowId(): string | undefined {
    return this.rows()[this.rowIndex]?.id
  }

  /** Every row of all tabs, in tab order. */
  get allRows(): readonly SettingsRowView[] {
    return [...this.generalRows(), ...this.thinkingRows(), ...this.toolRows()]
  }

  /** Rows of the active tab, in display order. */
  rows(): readonly SettingsRowView[] {
    if (this.activeTab === 'general') return this.generalRows()
    if (this.activeTab === 'thinking') return this.thinkingRows()
    return this.toolRows()
  }

  get isDone(): boolean {
    return this.done
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

  // -------------------------------------------------------------------------
  // Rows

  private generalRows(): SettingsRowView[] {
    const screenNote = this.options.screen === undefined ? '' : ` · running ${this.options.screen}`
    return [
      {
        id: 'autoTitle',
        tab: 'general',
        label: 'Auto title',
        value: this.options.autoTitleLabel ?? (this.current.autoTitle === 'inherit' ? 'inherit' : onOff(this.current.autoTitle)),
        description: 'Native DSH session titles may use the model; inherit follows the profile',
      },
      {
        id: 'screen',
        tab: 'general',
        label: 'Default screen',
        value: `${this.current.screen} (next launch)${screenNote}`,
        description: 'Inline keeps the transcript in scrollback, fullscreen uses the alternate screen',
      },
      {
        id: 'keys',
        tab: 'general',
        label: 'Keyboard shortcuts',
        value: 'edit',
        description: 'View or customize keybindings',
      },
    ]
  }

  private thinkingRows(): SettingsRowView[] {
    return [
      {
        id: 'thinking',
        tab: 'thinking',
        label: 'Show thinking',
        value: onOff(this.current.showThinking),
        description: 'Collapsed reasoning summary in the transcript; off hides the text entirely',
      },
      {
        id: 'preview',
        tab: 'thinking',
        label: 'Preview lines',
        value: String(this.current.thinkingPreviewLines),
        description: 'Reasoning lines kept under the summary (0 shows the summary alone)',
      },
      {
        id: 'timer',
        tab: 'thinking',
        label: 'Live timer',
        value: this.current.thinkingLiveTimerMs === 0 ? 'off' : `${this.current.thinkingLiveTimerMs}ms`,
        description: 'Refresh interval for the live thinking duration',
      },
    ]
  }

  /**
   * The Tools tab is `TOOL_SETTING_KEYS` verbatim: one shared roster drives the
   * row order, and each row id is the settings key so tests/parents never depend
   * on a display string. No duplicate row exists on General.
   */
  private toolRows(): SettingsRowView[] {
    return TOOL_SETTING_KEYS.map(key => ({
      id: key,
      tab: 'tools' as const,
      label: TOOL_ROW_LABELS[key],
      value: this.toolValue(key),
      description: TOOL_ROW_DESCRIPTIONS[key],
    }))
  }

  private toolValue(key: ToolSettingKey): string {
    switch (key) {
      case 'groupTools': return onOff(this.current.groupTools)
      case 'expandTools': return onOff(this.current.expandTools)
      case 'expandedInputMaxLines': return String(this.current.expandedInputMaxLines)
      case 'expandedOutputMaxLines': return String(this.current.expandedOutputMaxLines)
      case 'toolLabelClip': return this.current.toolLabelClip === 0 ? 'auto' : `${this.current.toolLabelClip} cols`
      case 'diffViewMode': return this.current.diffViewMode
      case 'diffIndicatorMode': return this.current.diffIndicatorMode
      case 'diffSplitMinWidth': return `${this.current.diffSplitMinWidth} cols`
      case 'editDiffCollapsedLines': return String(this.current.editDiffCollapsedLines)
      case 'writeDiffCollapsedLines': return String(this.current.writeDiffCollapsedLines)
      case 'diffWordWrap': return onOff(this.current.diffWordWrap)
    }
  }

  // -------------------------------------------------------------------------
  // Mutation

  private setTab(index: number): void {
    const count = SETTINGS_TABS.length
    this.keymap.cancelChord()
    this.tabIndex = ((index % count) + count) % count
    this.rowIndex = Math.min(this.rowIndex, Math.max(0, this.rows().length - 1))
    this.message = ''
    this.tui.requestRender()
  }

  private move(delta: number): void {
    const count = this.rows().length
    if (count === 0) return
    this.keymap.cancelChord()
    this.rowIndex = ((this.rowIndex + delta) % count + count) % count
    this.message = ''
    this.tui.requestRender()
  }

  private clampRow(): void {
    this.rowIndex = Math.min(this.rowIndex, Math.max(0, this.rows().length - 1))
  }

  /** Apply one preference patch and hand it to the parent for persistence. */
  private apply(patch: Partial<Settings>): void {
    this.current = { ...this.current, ...patch }
    this.message = ''
    this.failed = false
    try {
      const result = this.options.onChange(patch)
      if (result !== undefined && typeof result.then === 'function') {
        void result.catch((error: unknown) => {
          this.failed = true
          this.message = sanitize(error instanceof Error ? error.message : String(error))
          this.tui.requestRender()
        })
      }
    } catch (error) {
      this.failed = true
      this.message = sanitize(error instanceof Error ? error.message : String(error))
    }
    this.tui.requestRender()
  }

  private activate(row: SettingsRowView): void {
    switch (row.id) {
      case 'autoTitle':
        this.message = ''
        this.options.onAutoTitle()
        this.tui.requestRender()
        return
      case 'screen':
        this.apply({ screen: this.current.screen === 'inline' ? 'fullscreen' : 'inline' })
        return
      case 'keys':
        this.message = ''
        this.options.onKeybindings()
        this.tui.requestRender()
        return
      case 'thinking':
        this.apply({ showThinking: !this.current.showThinking })
        return
      case 'preview':
        this.apply({ thinkingPreviewLines: nextInRoster(THINKING_PREVIEW_LINES_VALUES, this.current.thinkingPreviewLines) })
        return
      case 'timer':
        this.apply({ thinkingLiveTimerMs: nextInRoster(THINKING_LIVE_TIMER_MS_VALUES, this.current.thinkingLiveTimerMs) })
        return
      // Tools tab: one row per shared tool preference. Booleans toggle, numbers
      // and enums cycle through the rosters exported by config.ts.
      case 'groupTools':
        this.apply({ groupTools: !this.current.groupTools })
        return
      case 'expandTools':
        this.apply({ expandTools: !this.current.expandTools })
        return
      case 'expandedInputMaxLines':
        this.apply({ expandedInputMaxLines: nextInRoster(EXPANDED_INPUT_MAX_LINES_VALUES, this.current.expandedInputMaxLines) })
        return
      case 'expandedOutputMaxLines':
        this.apply({ expandedOutputMaxLines: nextInRoster(EXPANDED_OUTPUT_MAX_LINES_VALUES, this.current.expandedOutputMaxLines) })
        return
      case 'toolLabelClip':
        this.apply({ toolLabelClip: nextInRoster(TOOL_LABEL_CLIP_VALUES, this.current.toolLabelClip) })
        return
      case 'diffViewMode':
        this.apply({ diffViewMode: nextInRoster(DIFF_VIEW_MODE_VALUES, this.current.diffViewMode) })
        return
      case 'diffIndicatorMode':
        this.apply({ diffIndicatorMode: nextInRoster(DIFF_INDICATOR_MODE_VALUES, this.current.diffIndicatorMode) })
        return
      case 'diffSplitMinWidth':
        this.apply({ diffSplitMinWidth: nextInRoster(DIFF_SPLIT_MIN_WIDTH_VALUES, this.current.diffSplitMinWidth) })
        return
      case 'editDiffCollapsedLines':
        this.apply({ editDiffCollapsedLines: nextInRoster(EDIT_DIFF_COLLAPSED_LINES_VALUES, this.current.editDiffCollapsedLines) })
        return
      case 'writeDiffCollapsedLines':
        this.apply({ writeDiffCollapsedLines: nextInRoster(WRITE_DIFF_COLLAPSED_LINES_VALUES, this.current.writeDiffCollapsedLines) })
        return
      case 'diffWordWrap':
        this.apply({ diffWordWrap: !this.current.diffWordWrap })
        return
      default:
        return
    }
  }

  private cancel(): void {
    if (this.done) return
    this.done = true
    this.keymap.cancelChord()
    this.options.onCancel()
  }

  /** Global interrupt never becomes a settings change or a local close. */
  private interrupt(): void {
    this.keymap.cancelChord()
    if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
    else this.cancel()
  }

  // -------------------------------------------------------------------------
  // Input

  handleInput(raw: string): void {
    if (this.done) return
    if (isInterruptKey(this.keymap, raw)) {
      this.interrupt()
      return
    }
    // Tab switching is this dialog's own key (not a list action): the arrows
    // are free in list context and the roster has no text field to conflict
    // with. Tab/Shift+Tab are accepted as the keyboard-only equivalent.
    if (matchesKey(raw, 'left') || matchesKey(raw, 'shift+tab')) {
      this.setTab(this.tabIndex - 1)
      return
    }
    if (matchesKey(raw, 'right') || matchesKey(raw, 'tab')) {
      this.setTab(this.tabIndex + 1)
      return
    }
    const action = listAction(this.keymap, raw)
    if (action === undefined) return
    if (action.id === 'app.interrupt') {
      this.interrupt()
      return
    }
    if (CANCEL_ACTIONS.has(action.id)) {
      this.cancel()
      return
    }
    const row = this.rows()[this.rowIndex]
    if (action.id === 'list.previous') this.move(-1)
    else if (action.id === 'list.next') this.move(1)
    else if (action.id === 'list.page-up') this.move(-3)
    else if (action.id === 'list.page-down') this.move(3)
    else if (action.id === 'list.select-digit') {
      // Same quick-select UX as SelectDialog: digit N activates row N of the
      // active tab directly.
      const key = action.keys[0]
      const number = key !== undefined && /^[1-9]$/.test(key) ? Number(key) : undefined
      const rows = this.rows()
      if (number !== undefined && number <= rows.length) {
        this.rowIndex = number - 1
        this.activate(rows[number - 1]!)
      }
    }
    else if (action.id === 'list.first') {
      if (this.rows().length > 0) {
        this.rowIndex = 0
        this.tui.requestRender()
      }
    } else if (action.id === 'list.last') {
      const count = this.rows().length
      if (count > 0) {
        this.rowIndex = count - 1
        this.tui.requestRender()
      }
    } else if (SELECT_ACTIONS.has(action.id) && row !== undefined) {
      this.activate(row)
    }
  }

  // -------------------------------------------------------------------------
  // Rendering

  render(width: number): string[] {
    const size = Math.max(1, Math.floor(width))
    const out: string[] = [cc.inactive('─'.repeat(size))]
    const title = this.options.path === undefined ? 'Settings' : `Settings · ${this.options.path}`
    out.push(` ${bold(cc.permission(oneLine(title, 160)))}`)
    out.push('')
    out.push(this.renderTabs(size))
    out.push('')

    const rows = this.rows()
    const blocks = rows.map((row, index) => ({ lines: this.rowLines(row, index, size), focused: index === this.rowIndex }))
    if (rows.length === 0) out.push(` ${t.muted('No settings on this tab.')}`)
    else out.push(...windowRows(blocks, Math.max(2, rowBudget(this.tui))))

    out.push('')
    out.push(` ${dim(cc.inactive(['←/→ switch tab', '↑/↓ navigate', 'Enter to change', 'Esc to close'].join(' · ')))}`)
    if (this.message !== '') out.push(...wrap((this.failed ? t.redSoft : t.muted)(this.message), size))
    return out.map(line => fit(line, size))
  }

  private renderTabs(width: number): string {
    const chip = (text: string, active: boolean): string => (active ? cc.chip(` ${text} `) : t.text(` ${text} `))
    let line = `${this.tabIndex === 0 ? cc.inactive('←') : t.text('←')} `
    line += SETTINGS_TABS.map((tab, index) => chip(tab.label, index === this.tabIndex)).join('')
    line += ` ${this.tabIndex === SETTINGS_TABS.length - 1 ? cc.inactive('→') : t.text('→')}`
    return fit(line, width)
  }

  /**
   * `❯ Tool details            on` on wide terminals; a stacked label/value pair
   * when the two columns would squeeze either side. The focused row is the only
   * one in the suggestion color, matching the rest of the dialog family.
   */
  private rowLines(row: SettingsRowView, index: number, width: number): string[] {
    const focused = index === this.rowIndex
    const marker = focused ? cc.suggestion('❯') : ' '
    const style = focused ? cc.suggestion : t.text
    const label = oneLine(row.label, 120)
    const value = oneLine(row.value, 120)
    const lines: string[] = []
    const leftWidth = Math.min(24, Math.max(10, Math.floor(width * 0.42)))
    if (width >= 46) {
      const rightWidth = Math.max(4, width - leftWidth - 6)
      const left = wrap(label, leftWidth)
      const right = wrap(value, rightWidth)
      const total = Math.max(left.length, right.length)
      for (let line = 0; line < total; line += 1) {
        const key = left[line] ?? ''
        const room = Math.max(0, leftWidth - visibleWidth(key))
        const body = `${style(key)}${' '.repeat(room)}${dim(' │ ')}${style(right[line] ?? '')}`
        lines.push(`${line === 0 ? `${marker} ` : '  '}${body}`)
      }
    } else {
      for (const [offset, text] of wrap(label, Math.max(4, width - 2)).entries()) {
        lines.push(`${offset === 0 ? `${marker} ` : '  '}${style(text)}`)
      }
      const valueIndent = '    '
      for (const text of wrap(value, Math.max(4, width - valueIndent.length))) {
        lines.push(`${valueIndent}${dim(text)}`)
      }
    }
    if (row.description !== undefined && focused) {
      for (const text of wrap(row.description, Math.max(4, width - 4))) lines.push(`    ${dim(t.muted(text))}`)
    }
    return lines
  }
}