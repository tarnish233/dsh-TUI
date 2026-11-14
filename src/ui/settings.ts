/**
 * `/settings` as one continuous, grouped, searchable preferences page.
 *
 * The roster is one flat metadata table rendered through the shared
 * `ModalFrame` (src/ui/modal.ts). Every available section shares the *same*
 * scrollable list, in metadata order, separated by non-selectable group
 * headers — there are no tab pages and nothing is hidden or rebuilt when the
 * focus moves between groups:
 *
 *   General   Default screen · Copy on select · Queue folded · Reduced motion
 *   Thinking  Show thinking · Preview lines · Live timer
 *   Tools     every tool-card/diff preference from `TOOL_SETTING_KEYS`
 *   Agents    Progress above input · Group agent messages
 *   Images    Viewer preview
 *   DSH       parent-supplied native navigation/information rows
 *   Keyboard  one entry into the existing shortcut editor
 *
 * Browsing is the Grok Build/OpenCode "searchable grouped list": the search
 * field filters label/description/keywords across *every* section, Up/Down (and
 * PageUp/PageDown/Home/End/wheel) cross group boundaries naturally, and the
 * `settings.previous-category` / `next-category` actions are section jumps in
 * that same list: they move the selection to the next group's first row and
 * never switch a page, resize the body or change the visible roster. Typed rows
 * do not cycle blindly: booleans toggle, enums open a value picker, integers
 * open the value picker with a `Custom…` typed editor that still accepts any
 * legal number. Every local write goes through the parent's `onChange` /
 * `onReset` and the row keeps an explicit saving → saved / failed state; a
 * failed write reverts only that value.
 *
 * Rendering hot path: the roster is rebuilt from the live settings snapshot and
 * the parent's native rows at most once per painted frame (memoised across the
 * frame's measure/paint passes), a section jump only moves a row index, and
 * mouse events never re-read native rows, start a parent operation, or repaint
 * when nothing visible changed.
 * *
 * Ownership boundaries:
 * - DSH owns model/tool/permission/preset/session/credential business. The DSH
 *   category only shows parent-supplied `NativeSettingsEntry` rows; this file
 *   imports no native runtime and invents no preference.
 * - Native auto-title is a read-only DSH row, keyboard shortcuts stay
 *   parent-owned (`onKeybindings`), and the search/value fields reuse the one
 *   CC editor grammar through `InlineAnswer`.
 * - The component never writes stdout; the renderer owns terminal output.
 */
import {
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import {
  defaults,
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
import { BracketedPasteFilter, createCcKeymap, type CcKeymap } from '../input/index.ts'
import { bodyHitAt, isInterruptKey, type HitRange } from './dialogs.ts'
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

export type SettingsCategory = 'general' | 'thinking' | 'tools' | 'agents' | 'images' | 'dsh' | 'keyboard'

export interface SettingsCategoryDescriptor {
  readonly id: SettingsCategory
  readonly label: string
}

/** Category order is the ←/→ (`settings.previous/next-category`) order. */
export const SETTINGS_CATEGORIES: readonly SettingsCategoryDescriptor[] = [
  { id: 'general', label: 'General' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'tools', label: 'Tools & Diff' },
  { id: 'agents', label: 'Agents' },
  { id: 'images', label: 'Images' },
  { id: 'dsh', label: 'DSH' },
  { id: 'keyboard', label: 'Keyboard' },
]

/** Backwards-compatible alias for the old tab descriptor export. */
export const SETTINGS_TABS = SETTINGS_CATEGORIES

/**
 * One parent-supplied native row. Neutral navigation/information only: the UI
 * neither reads DSH runtime state nor writes native settings itself.
 */
export interface NativeSettingsEntry {
  id: string
  label: string
  value: string
  description?: string
  /** False renders the row as a clearly unavailable native capability. */
  available?: boolean
  /**
   * Search aliases owned by the parent (defaults to the supplied
   * label/description plus the historical `native dsh` prefix). Only the
   * search haystack uses it: it is never painted, never writes a preference and
   * never decides a row's value/availability.
   */
  keywords?: string
  /** Existing parent operation (open picker/command). Omitted = information. */
  onActivate?: () => void
}

/** View state preserved across Settings → Keyboard → back. */
export interface SettingsViewState {
  readonly category: SettingsCategory
  readonly rowId?: string
  readonly query?: string
  readonly scroll?: number
}

/** Row kinds drive typed editing and what the footer "change" action means. */
export type SettingsRowKind = 'boolean' | 'enum' | 'integer' | 'action' | 'info'

/**
 * One settings row as the modal sees it. `id` is stable and is what the parent
 * may use in tests/telemetry; label/value are display strings only.
 */
export interface SettingsRowView {
  readonly id: string
  readonly category: SettingsCategory
  /** Compatibility alias for the previous tab-based API. */
  readonly tab: SettingsCategory
  readonly label: string
  readonly value: string
  readonly description?: string
  readonly kind: SettingsRowKind
  readonly key?: keyof Settings
  readonly keywords?: string
  readonly available?: boolean
}

export interface SettingsDialogOptions {
  /** Effective settings snapshot (`SettingsStore.get()`). */
  settings: Settings
  /**
   * Local TUI preference change. The parent persists it through
   * `SettingsStore.set`; it may return the confirmed snapshot, and a rejected
   * write is surfaced in the dialog (only that value is reverted).
   */
  onChange: (patch: Partial<Settings>) => void | Promise<void | Settings>
  /** Remove one local override (defaults to writing the known default). */
  onReset?: (key: keyof Settings) => void | Promise<void | Settings>
  /** Open the existing keybinding editor (parent-owned screen). */
  onKeybindings: () => void
  /** Native DSH navigation/information rows for the DSH category. */
  getNativeEntries?: () => readonly NativeSettingsEntry[]
  /** Shared keymap from the input subsystem. A default CC keymap is used when omitted. */
  keymap?: CcKeymap
  /** Screen the app is running in; shown as context on the default-screen row. */
  screen?: 'inline' | 'fullscreen'
  /** Settings file path, shown as a dim context line. */
  path?: string
  /** Restore category/row/query/scroll after a child surface returns. */
  initialState?: SettingsViewState
  /** Bounded modal height (defaults to the shared standard modal budget). */
  maxHeight?: number
  /** Local dismissal (`list.cancel` / Esc; default Ctrl+C is also local). */
  onCancel: () => void
  /**
   * Explicit native interrupt (a configured `app.interrupt`; no shipped
   * default key). When omitted the interrupt key closes this surface through
   * `onCancel`. Default Ctrl+C never lands here: it is the local cancel.
   */
  onInterrupt?: () => void
}

type SettingValue = string | number | boolean

interface RowMeta extends SettingsRowView {
  readonly roster?: readonly SettingValue[]
  readonly labels?: Readonly<Record<string, string>>
  readonly min?: number
  readonly max?: number
  readonly allowZero?: boolean
  readonly activate?: () => void
}

interface PickerEntry {
  readonly label: string
  readonly value: SettingValue | 'custom'
}

/**
 * The one embedded text field in this surface (numeric value entry) runs on the
 * CC editor context, where default Ctrl+C resolves `app.clear` instead of a
 * list cancel. It consumes that key as its own local cancel, but only under the
 * same rule the list layers use: the *physical* key must still be an enabled
 * single-key binding of a local cancel action, checked non-mutatingly (no
 * resolution, no chord state). A remapped-away or disabled cancel row therefore
 * leaves Ctrl+C inert instead of inventing a close/back, and the hidden root
 * draft is never cleared and the native turn is never interrupted.
 */
function cancelFallback(keymap: CcKeymap, data: string): boolean {
  if (keymap.isPendingChord()) return false
  const simple = (binding: string): boolean =>
    !binding.includes(' ') && matchesKey(data, binding as Parameters<typeof matchesKey>[1])
  if (!keymap.getBindings('app.clear').some(simple)) return false
  return [...CLOSE_ACTIONS].some(id => keymap.getBindings(id).some(simple))
}

const TOOL_LABELS: Record<typeof TOOL_SETTING_KEYS[number], string> = {
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

const TOOL_DESCRIPTIONS: Record<typeof TOOL_SETTING_KEYS[number], string> = {
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

const TOOL_KEYWORDS: Record<typeof TOOL_SETTING_KEYS[number], string> = {
  groupTools: 'tools transcript fold summary',
  expandTools: 'tools card input output expanded',
  expandedInputMaxLines: 'tools input lines height',
  expandedOutputMaxLines: 'tools output lines height',
  toolLabelClip: 'tools label width clip path command',
  diffViewMode: 'diff layout split unified auto',
  diffIndicatorMode: 'diff indicator bars classic none markers',
  diffSplitMinWidth: 'diff width split columns',
  editDiffCollapsedLines: 'diff edit collapsed lines',
  writeDiffCollapsedLines: 'diff write collapsed lines',
  diffWordWrap: 'diff wrap lines',
}

/** A local row before its value is formatted from the live snapshot. */
interface LocalRowSpec {
  readonly id: string
  readonly category: SettingsCategory
  readonly label: string
  readonly description: string
  readonly keywords: string
  readonly kind: Exclude<SettingsRowKind, 'action' | 'info'>
  readonly key?: keyof Settings
  readonly roster?: readonly SettingValue[]
  readonly labels?: Readonly<Record<string, string>>
  readonly min?: number
  readonly max?: number
  readonly allowZero?: boolean
  readonly format: (settings: Settings) => string
}

const onOff = (value: boolean): string => (value ? 'on' : 'off')

/** Integer pickers list the documented roster and still allow a typed value. */
function integerRow(spec: Omit<LocalRowSpec, 'kind' | 'format'> & { readonly formatValue?: (value: number) => string }): LocalRowSpec {
  const formatValue = spec.formatValue ?? ((value: number) => String(value))
  return {
    ...spec,
    kind: 'integer',
    format: settings => formatValue(Number(settings[spec.key as keyof Settings])),
  }
}

function enumRow(spec: Omit<LocalRowSpec, 'kind' | 'format'> & { readonly formatValue?: (value: SettingValue) => string }): LocalRowSpec {
  const formatValue = spec.formatValue ?? ((value: SettingValue) =>
    spec.labels?.[String(value)] ?? (typeof value === 'boolean' ? onOff(value) : String(value)))
  return {
    ...spec,
    kind: 'enum',
    format: settings => formatValue(settings[spec.key as keyof Settings] as SettingValue),
  }
}

function booleanRow(spec: Omit<LocalRowSpec, 'kind' | 'format'> & { readonly formatValue?: (value: boolean) => string }): LocalRowSpec {
  const formatValue = spec.formatValue ?? onOff
  return {
    ...spec,
    kind: 'boolean',
    format: settings => formatValue(Boolean(settings[spec.key as keyof Settings])),
  }
}

const LOCAL_ROWS: readonly LocalRowSpec[] = [
  // --- General -----------------------------------------------------------
  enumRow({
    id: 'screen',
    category: 'general',
    label: 'Default screen',
    description: 'Inline keeps the transcript in scrollback, fullscreen uses the alternate screen',
    keywords: 'screen inline fullscreen alternate scrollback launch',
    key: 'screen',
    roster: ['inline', 'fullscreen'],
  }),
  booleanRow({
    id: 'copyOnSelect',
    category: 'general',
    label: 'Copy on select',
    description: 'Fullscreen drag-copy writes the selection to the clipboard; inline copy stays terminal-owned',
    keywords: 'clipboard selection mouse copy fullscreen',
    key: 'copyOnSelect',
  }),
  booleanRow({
    id: 'queueCollapsed',
    category: 'general',
    label: 'Queue folded',
    description: 'Start the queued-message list folded; the header still toggles it',
    keywords: 'queue inbox fold collapsed messages',
    key: 'queueCollapsed',
  }),
  booleanRow({
    id: 'reducedMotion',
    category: 'general',
    label: 'Reduced motion',
    description: 'Use a static work marker instead of the shared spinner sequence',
    keywords: 'motion animation spinner reduce',
    key: 'reducedMotion',
  }),

  booleanRow({
    id: 'terminalStatus',
    category: 'general',
    label: 'Terminal status',
    description: 'Publish working, blocked, done and failed work to terminals that implement the program status protocol',
    keywords: 'terminal status osc 7501 rex ghostty program status progress tab indicator',
    key: 'terminalStatus',
  }),
  booleanRow({
    id: 'terminalTitle',
    category: 'general',
    label: 'Terminal title',
    description: 'Show the native DSH session title (or the workspace name) in the window/tab title',
    keywords: 'terminal title window tab workspace osc 0 osc 7 cwd title',
    key: 'terminalTitle',
  }),
  enumRow({
    id: 'terminalNotifications',
    category: 'general',
    label: 'Terminal notifications',
    description: 'Automatic: when unfocused (Rex uses native alerts). Off: no direct alerts. Always can duplicate native alerts.',
    keywords: 'terminal notifications notify osc 777 attention unfocused background done blocked',
    key: 'terminalNotifications',
    roster: ['auto', 'off', 'always'],
    labels: { auto: 'Automatic', off: 'Off', always: 'Always' },
  }),

  // --- Thinking ----------------------------------------------------------
  booleanRow({
    id: 'thinking',
    category: 'thinking',
    label: 'Show thinking',
    description: 'Collapsed reasoning summary in the transcript; off hides the text entirely',
    keywords: 'thinking reasoning summary hidden',
    key: 'showThinking',
  }),
  enumRow({
    id: 'preview',
    category: 'thinking',
    label: 'Preview lines',
    description: 'Reasoning lines kept under the summary (0 shows the summary alone)',
    keywords: 'thinking preview lines reasoning',
    key: 'thinkingPreviewLines',
    roster: THINKING_PREVIEW_LINES_VALUES,
  }),
  enumRow({
    id: 'timer',
    category: 'thinking',
    label: 'Live timer',
    description: 'Refresh interval for the live thinking duration',
    keywords: 'thinking timer duration interval',
    key: 'thinkingLiveTimerMs',
    roster: THINKING_LIVE_TIMER_MS_VALUES,
    formatValue: value => (value === 0 ? 'off' : `${value}ms`),
  }),

  // --- Tools & Diff ------------------------------------------------------
  ...TOOL_SETTING_KEYS.map((key): LocalRowSpec => {
    const base = {
      id: key,
      category: 'tools' as const,
      label: TOOL_LABELS[key],
      description: TOOL_DESCRIPTIONS[key],
      keywords: TOOL_KEYWORDS[key],
      key,
    }
    switch (key) {
      case 'groupTools':
      case 'expandTools':
      case 'diffWordWrap':
        return booleanRow(base)
      case 'diffViewMode':
        return enumRow({ ...base, roster: DIFF_VIEW_MODE_VALUES })
      case 'diffIndicatorMode':
        return enumRow({ ...base, roster: DIFF_INDICATOR_MODE_VALUES })
      case 'expandedInputMaxLines':
        return integerRow({ ...base, roster: EXPANDED_INPUT_MAX_LINES_VALUES, min: 1, max: 5_000 })
      case 'expandedOutputMaxLines':
        return integerRow({ ...base, roster: EXPANDED_OUTPUT_MAX_LINES_VALUES, min: 1, max: 5_000 })
      case 'toolLabelClip':
        return integerRow({
          ...base, roster: TOOL_LABEL_CLIP_VALUES, min: 8, max: 500, allowZero: true,
          formatValue: value => (value === 0 ? 'auto' : `${value} cols`),
        })
      case 'diffSplitMinWidth':
        return integerRow({
          ...base, roster: DIFF_SPLIT_MIN_WIDTH_VALUES, min: 40, max: 300,
          formatValue: value => `${value} cols`,
        })
      case 'editDiffCollapsedLines':
        return integerRow({ ...base, roster: EDIT_DIFF_COLLAPSED_LINES_VALUES, min: 0, max: 500 })
      case 'writeDiffCollapsedLines':
        return integerRow({ ...base, roster: WRITE_DIFF_COLLAPSED_LINES_VALUES, min: 0, max: 500 })
    }
  }),

  // --- Agents ------------------------------------------------------------
  booleanRow({
    id: 'showSubagentProgress',
    category: 'agents',
    label: 'Progress above input',
    description: 'Show active child agents above the one prompt; settled children always retire',
    keywords: 'agents progress subagent activity widget',
    key: 'showSubagentProgress',
  }),
  booleanRow({
    id: 'groupSubagentMessages',
    category: 'agents',
    label: 'Group agent messages',
    description: 'Fold consecutive child messages into one group; independent of tool grouping',
    keywords: 'agents group messages subagent transcript fold',
    key: 'groupSubagentMessages',
  }),

  // --- Images ------------------------------------------------------------
  enumRow({
    id: 'imagePreview',
    category: 'images',
    label: 'Viewer preview',
    description: 'Automatic renders the image when the terminal supports it; text keeps metadata only',
    keywords: 'images preview viewer protocol fallback',
    key: 'imagePreview',
    roster: ['auto', 'text'],
    labels: { auto: 'Automatic', text: 'Text only' },
  }),
]

const isThenable = (value: unknown): value is Promise<void | Settings> =>
  value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function'

function isSettingsSnapshot(value: unknown): value is Settings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.screen === 'string' && Object.keys(defaults).every(key => Object.hasOwn(candidate, key))
}

const errorText = (error: unknown): string => sanitize(error instanceof Error ? error.message : String(error))

type SettingsMode = 'browse' | 'picker' | 'edit'

/**
 * Grouped searchable Settings modal. One instance is mounted by the parent;
 * writes are confirmed (or reverted) before the row claims success.
 */
export class SettingsDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: SettingsDialogOptions
  private readonly list: ModalListSurface
  private readonly search: InlineAnswer
  private numberAnswer: InlineAnswer | undefined
  private current: Settings
  private confirmed: Settings
  private selectedId: string | undefined
  private index = 0
  private windowStart = 0
  private mode: SettingsMode = 'browse'
  private pickerId: string | undefined
  private pickerIndex = 0
  private editId: string | undefined
  private searchFocused = false
  /** Bracketed-paste framing for the non-text list surfaces (browse/picker). */
  private readonly listPaste = new BracketedPasteFilter()
  private focusedState = false
  private done = false
  private disposed = false
  private message = ''
  private failed = false
  /** Native feedback survives the local write's generic Saved acknowledgement. */
  private externalMessage?: { text: string; error: boolean }
  private readonly pending = new Set<string>()
  private writeToken = 0
  /**
   * Section of the selected row. One continuous page means this is derived
   * state, never a page filter: it is what `captureView()`/`initialState`
   * carry and it stays meaningful while a search has no match.
   */
  private section: SettingsCategory = 'general'
  /** One roster build per painted frame; cleared at the start of `render`. */
  private rosterCache?: { readonly source: Settings; readonly rows: RowMeta[] }

  constructor(tui: TUI, options: SettingsDialogOptions) {
    this.tui = tui
    this.options = options
    this.list = new ModalListSurface(tui, {
      size: this.modalSize,
      ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
    })
    this.current = { ...options.settings }
    this.confirmed = { ...options.settings }
    this.keymap = options.keymap ?? createCcKeymap()
    this.search = new InlineAnswer(tui, this.keymap)
    this.search.onChange = () => this.onQueryChanged()
    const initial = options.initialState
    if (initial !== undefined) this.applyInitialState(initial)
  }

  // -------------------------------------------------------------------------
  // Public surface (parent/tests)

  get settings(): Settings {
    return { ...this.current }
  }

  /** Parent hook: refresh after a reload or a native round trip. */
  setSettings(next: Settings): void {
    this.current = { ...next }
    this.confirmed = { ...next }
    this.reconcile()
    this.tui.requestRender()
  }

  /**
   * Parent feedback for native navigation (the panel stays open). The message
   * is shown in this surface's status row; `error` uses the failure styling.
   */
  setMessage(message: string, error = false): void {
    this.message = sanitize(message)
    this.externalMessage = { text: this.message, error }
    this.failed = error
    this.tui.requestRender()
  }

  /**
   * Group (section) of the selected row on the one continuous page. It is a
   * label for the current position, never a page filter: every section is
   * always part of the same visible roster.
   */
  get activeCategory(): SettingsCategory {
    return this.section
  }

  /** Compatibility alias for the previous tab API. */
  get activeTab(): SettingsCategory {
    return this.activeCategory
  }

  get activeRowId(): string | undefined {
    return this.selectedRow()?.id
  }

  /** 0-based index of the selected row inside `getVisibleRows()`. */
  get activeRowIndex(): number {
    return this.currentIndex(this.visibleRows())
  }

  get activeRow(): SettingsRowView | undefined {
    const row = this.selectedRow()
    return row === undefined ? undefined : this.viewOf(row)
  }

  get isDone(): boolean {
    return this.done
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get isSaving(): boolean {
    return this.pending.size > 0
  }

  /**
   * Row ids with an in-flight local write. Read-only view of the existing
   * `pending` set: the parent can wait for a specific row (for example
   * `terminalNotifications`) to settle before asserting its persisted value.
   */
  get pendingKeys(): readonly string[] {
    return [...this.pending]
  }

  /**
   * True while a fragmented bracketed paste is still arriving in the search or
   * numeric field. The parent's global interrupt listener checks this before
   * cancelling, so paste content can never be mistaken for a real interrupt.
   */
  get isPasting(): boolean {
    return (this.searchFocused && this.search.editor.isPasting())
      || (this.mode === 'edit' && (this.numberAnswer?.editor.isPasting() ?? false))
      || this.listPaste.isPasting
  }

  get searchFocusedState(): boolean {
    return this.searchFocused
  }

  get query(): string {
    return this.search.raw.trim()
  }

  get scroll(): number {
    return this.windowStart
  }

  /** Every available row of the one page, in metadata (section/row) order. */
  get allRows(): readonly SettingsRowView[] {
    return this.buildRows().map(row => this.viewOf(row))
  }

  /**
   * The selectable rows of the **one continuous page**, in metadata order.
   *
   * - Empty search: every section is present (group headers are paint-time
   *   chrome and are never rows), so a section jump or Up/Down never changes
   *   this array.
   * - Non-empty search: the matching rows across all sections, still in
   *   metadata order.
   *
   * `activeRowIndex` and mouse hits are 0-based indices into this array.
   * `list.select-digit` maps 1–9 to the corresponding page row (digit minus
   * one), never a section-relative index. `allRows` ignores the search query.
   */
  getVisibleRows(): readonly SettingsRowView[] {
    return this.rows()
  }

  /** Compatibility name for {@link getVisibleRows}. */
  rows(): readonly SettingsRowView[] {
    return this.visibleRows().map(row => this.viewOf(row))
  }

  /** Parent hook for Settings → Keyboard → back; no parent-opaque state. */
  captureView(): SettingsViewState {
    const rowId = this.activeRowId
    return {
      category: this.activeCategory,
      ...(rowId === undefined ? {} : { rowId }),
      query: this.search.raw,
      scroll: this.windowStart,
    }
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.keymap.cancelChord()
    this.focusedState = value
    this.search.focused = value && this.searchFocused
    if (this.numberAnswer !== undefined) this.numberAnswer.focused = value && this.mode === 'edit'
  }

  /** Parent hook for focus changes; safe to call repeatedly. */
  cancelChord(): void {
    this.keymap.cancelChord()
  }

  invalidate(): void {
    this.list.invalidate()
    this.search.invalidate()
    this.numberAnswer?.invalidate()
    this.rosterCache = undefined
  }

  /** Release the search/value editor states and any shared-keymap listeners. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listPaste.reset()
    this.search.dispose()
    this.numberAnswer?.dispose()
  }

  // -------------------------------------------------------------------------
  // Row metadata

  private viewOf(row: RowMeta): SettingsRowView {
    const { roster: _roster, labels: _labels, min: _min, max: _max, allowZero: _allowZero,
      activate: _activate, ...view } = row
    return view
  }

  /**
   * The one roster in metadata order. Memoised per settings snapshot identity so
   * a single frame (and its measure/paint passes) asks the parent for its native
   * rows exactly once; `render()` drops the cache so every painted frame sees
   * fresh native state without any hover/selection-triggered re-read.
   */
  private buildRows(): RowMeta[] {
    const cached = this.rosterCache
    if (cached !== undefined && cached.source === this.current) return cached.rows
    const rows = this.rosterRows()
    this.rosterCache = { source: this.current, rows }
    return rows
  }

  private rosterRows(): RowMeta[] {
    const local = LOCAL_ROWS.map((spec): RowMeta => ({
      id: spec.id,
      category: spec.category,
      tab: spec.category,
      label: spec.label,
      value: spec.format(this.current),
      description: spec.description,
      kind: spec.kind,
      ...(spec.key === undefined ? {} : { key: spec.key }),
      keywords: spec.keywords,
      ...(spec.roster === undefined ? {} : { roster: spec.roster }),
      ...(spec.labels === undefined ? {} : { labels: spec.labels }),
      ...(spec.min === undefined ? {} : { min: spec.min }),
      ...(spec.max === undefined ? {} : { max: spec.max }),
      ...(spec.allowZero === undefined ? {} : { allowZero: spec.allowZero }),
    }))

    const native = this.nativeRows()
    const keyboard: RowMeta[] = [{
      id: 'keys',
      category: 'keyboard',
      tab: 'keyboard',
      label: 'Keyboard shortcuts',
      value: 'edit',
      description: 'One grouped override list; reset deletes a single binding file entry',
      kind: 'action',
      keywords: 'keybindings shortcuts keys bindings remap disable',
      activate: () => this.openKeybindings(),
    }]
    const ordered = SETTINGS_CATEGORIES.flatMap(category => {
      if (category.id === 'dsh') return native
      if (category.id === 'keyboard') return keyboard
      return local.filter(row => row.category === category.id)
    })
    return ordered
  }

  private nativeRows(): RowMeta[] {
    const entries = this.options.getNativeEntries?.() ?? []
    if (entries.length === 0) {
      return [{
        id: 'native:none',
        category: 'dsh',
        tab: 'dsh',
        label: 'No native DSH settings exposed',
        value: '',
        description: 'DSH owns models, permissions, presets and profile settings; this TUI only navigates existing native surfaces',
        kind: 'info',
        available: false,
        keywords: 'model effort preset permission plan skills native profile',
      }]
    }
    return entries.map((entry): RowMeta => {
      const available = entry.available !== false
      return {
        id: `native:${entry.id}`,
        category: 'dsh',
        tab: 'dsh',
        label: entry.label,
        value: available ? entry.value : `${entry.value} · unavailable`,
        description: entry.description ?? 'Native DSH status; DSH owns the value and any persistence',
        kind: entry.onActivate === undefined ? 'info' : 'action',
        available,
        keywords: entry.keywords ?? `native dsh ${entry.label} ${entry.description ?? ''}`,
        ...(entry.onActivate === undefined ? {} : { activate: entry.onActivate }),
      }
    })
  }

  // -------------------------------------------------------------------------
  // Filtering / selection

  private visibleRows(): RowMeta[] {
    return this.browseRows()
  }

  /**
   * Every available section shares one list: with no search terms the whole
   * metadata-ordered roster is visible, so section jumps and Up/Down never
   * change which rows (or sections) exist.
   */
  private browseRows(): RowMeta[] {
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return this.buildRows()
    const categoryLabel = (category: SettingsCategory): string =>
      SETTINGS_CATEGORIES.find(item => item.id === category)?.label ?? category
    return this.buildRows().filter(row => {
      const haystack = [
        row.label,
        row.description ?? '',
        row.keywords ?? '',
        categoryLabel(row.category),
        row.value,
      ].join(' ').toLowerCase()
      return terms.every(term => haystack.includes(term))
    })
  }

  private selectedRow(): RowMeta | undefined {
    const rows = this.visibleRows()
    if (rows.length === 0) return undefined
    return rows[this.currentIndex(rows)]
  }

  private currentIndex(rows: readonly RowMeta[]): number {
    if (this.selectedId !== undefined) {
      const found = rows.findIndex(row => row.id === this.selectedId)
      if (found >= 0) return found
    }
    return Math.min(this.index, Math.max(0, rows.length - 1))
  }

  /** The one place a selection changes, so the focused section cannot drift. */
  private selectIndex(rows: readonly RowMeta[], index: number): void {
    if (rows.length === 0) return
    this.index = Math.max(0, Math.min(index, rows.length - 1))
    const row = rows[this.index]
    this.selectedId = row?.id
    if (row !== undefined) this.section = row.category
  }

  private reconcile(): void {
    const rows = this.visibleRows()
    if (rows.length === 0) {
      this.index = 0
      this.selectedId = undefined
      return
    }
    const found = this.selectedId === undefined ? -1 : rows.findIndex(row => row.id === this.selectedId)
    this.selectIndex(rows, found >= 0 ? found : Math.min(this.index, rows.length - 1))
  }

  private move(delta: number): void {
    const rows = this.visibleRows()
    if (rows.length === 0) return
    const from = this.currentIndex(rows)
    const next = ((from + delta) % rows.length + rows.length) % rows.length
    this.selectIndex(rows, next)
    this.clearMessage()
    this.keymap.cancelChord()
    this.tui.requestRender()
  }

  private moveTo(index: number): void {
    const rows = this.visibleRows()
    if (rows.length === 0) return
    this.selectIndex(rows, index)
    this.tui.requestRender()
  }

  /** Ordered sections present in the current visible roster. */
  private visibleSections(rows: readonly RowMeta[]): SettingsCategory[] {
    const order: SettingsCategory[] = []
    for (const row of rows) if (order[order.length - 1] !== row.category) order.push(row.category)
    return order
  }

  /**
   * `settings.previous-category` / `next-category`: a section jump **inside the
   * same list**. Nothing is hidden, rebuilt or re-fetched; only the selected row
   * index moves to the neighbouring section's first row (search results included).
   */
  private jumpSection(delta: number): void {
    const rows = this.visibleRows()
    if (rows.length === 0) return
    const order = this.visibleSections(rows)
    if (order.length <= 1) return
    const step = delta < 0 ? -1 : 1
    const at = order.indexOf(this.section)
    const from = at >= 0 ? at : (step > 0 ? -1 : 0)
    const next = ((from + step) % order.length + order.length) % order.length
    const target = order[next]
    if (target === undefined) return
    const index = rows.findIndex(row => row.category === target)
    if (index < 0) return
    this.selectIndex(rows, index)
    this.clearMessage()
    this.keymap.cancelChord()
    this.tui.requestRender()
  }

  private applyInitialState(state: SettingsViewState): void {
    const restored = SETTINGS_CATEGORIES.some(item => item.id === state.category) ? state.category : 'general'
    this.section = restored
    this.selectedId = state.rowId
    this.index = 0
    this.windowStart = Math.max(0, Math.floor(state.scroll ?? 0))
    if (state.query !== undefined) this.search.editor.setText(state.query)
    const rows = this.visibleRows()
    if (rows.length === 0) return
    const found = state.rowId === undefined ? -1 : rows.findIndex(row => row.id === state.rowId)
    const firstInSection = rows.findIndex(row => row.category === restored)
    if (found >= 0) this.selectIndex(rows, found)
    else if (firstInSection >= 0) this.selectIndex(rows, firstInSection)
    else this.selectIndex(rows, 0)
  }

  // -------------------------------------------------------------------------
  // Mutation (confirmed writes, per-key revert)

  private clearMessage(): void {
    this.externalMessage = undefined
    this.message = ''
    this.failed = false
  }

  private fail(error: unknown, row?: RowMeta): void {
    this.externalMessage = undefined
    this.failed = true
    this.message = (row === undefined ? '' : row.label + ': ') + errorText(error)
  }

  private changeKey(row: RowMeta, value: SettingValue): void {
    const key = row.key
    if (key === undefined) return
    if (this.pending.has(row.id)) return
    this.current = { ...this.current, [key]: value } as Settings
    const patch = { [key]: value } as Partial<Settings>
    this.write(row, () => this.options.onChange(patch), 'Saved', key)
  }

  private resetRow(row: RowMeta): void {
    if (row.key === undefined || row.kind === 'action' || row.kind === 'info') {
      this.clearMessage()
      this.message = row.kind === 'info' || row.kind === 'action'
        ? 'This row has no local default; use its action.'
        : 'This row has no local default.'
      this.tui.requestRender()
      return
    }
    if (this.pending.has(row.id)) return
    const key = row.key
    this.current = { ...this.current, [key]: defaults[key] } as Settings
    const run = this.options.onReset === undefined
      ? () => this.options.onChange({ [key]: defaults[key] } as Partial<Settings>)
      : () => this.options.onReset?.(key)
    this.write(row, run, 'Default restored', key)
  }

  private write(row: RowMeta, run: () => void | Promise<void | Settings>, success: string, key: keyof Settings): void {
    this.writeById(row.id, run, success, key, row)
  }

  /**
   * One confirmed write. A returned snapshot is adopted as the new truth; a
   * rejection reverts only this key (other rows stay untouched) and reports the
   * failure in this surface. Re-entrant writes for the same row are ignored.
   */
  private writeById(
    rowId: string,
    run: () => void | Promise<void | Settings>,
    success: string,
    key: keyof Settings,
    row?: RowMeta,
  ): void {
    if (this.pending.has(rowId)) return
    this.clearMessage()
    this.message = 'Saving…'
    this.failed = false
    let result: void | Promise<void | Settings>
    try {
      result = run()
    } catch (error) {
      this.current = { ...this.current, [key]: this.confirmed[key] }
      this.fail(error, row)
      this.tui.requestRender()
      return
    }
    if (!isThenable(result)) {
      this.confirmed = { ...this.confirmed, [key]: this.current[key] }
      this.message = this.externalMessage?.text ?? success
      this.failed = this.externalMessage?.error ?? false
      this.tui.requestRender()
      return
    }
    this.pending.add(rowId)
    const token = ++this.writeToken
    this.tui.requestRender()
    void result.then(value => {
      this.pending.delete(rowId)
      if (isSettingsSnapshot(value)) {
        this.current = { ...value }
        this.confirmed = { ...value }
      } else {
        this.confirmed = { ...this.confirmed, [key]: this.current[key] }
      }
      if (token === this.writeToken) {
        this.message = this.externalMessage?.text ?? success
        this.failed = this.externalMessage?.error ?? false
      }
      this.reconcile()
      this.tui.requestRender()
    }, (error: unknown) => {
      this.pending.delete(rowId)
      // Revert to the last confirmed truth, never to a stale pre-write value:
      // a newer confirmed snapshot may already own this key.
      this.current = { ...this.current, [key]: this.confirmed[key] }
      if (token === this.writeToken) this.fail(error, row)
      this.tui.requestRender()
    })
  }

  // -------------------------------------------------------------------------
  // Activation and typed editing

  private activateSelected(): void {
    const row = this.selectedRow()
    if (row === undefined) return
    this.activateRow(row)
  }

  private activateRow(row: RowMeta): void {
    if (row.available === false) {
      this.clearMessage()
      this.message = 'This native capability is not available in the current DSH runtime.'
      this.tui.requestRender()
      return
    }
    switch (row.kind) {
      case 'boolean': {
        const key = row.key
        if (key === undefined) return
        this.changeKey(row, !this.current[key])
        return
      }
      case 'enum':
        this.openPicker(row)
        return
      case 'integer':
        this.openPicker(row)
        return
      case 'action':
        this.clearMessage()
        row.activate?.()
        this.tui.requestRender()
        return
      case 'info':
        this.clearMessage()
        this.message = 'Information only; DSH owns this value.'
        this.tui.requestRender()
        return
    }
  }

  private openKeybindings(): void {
    this.options.onKeybindings()
  }

  private pickerTarget(): RowMeta | undefined {
    if (this.pickerId === undefined) return undefined
    return this.buildRows().find(row => row.id === this.pickerId)
  }

  private pickerValues(row: RowMeta): PickerEntry[] {
    const values = (row.roster ?? []).map(value => ({
      label: row.labels?.[String(value)] ?? (typeof value === 'boolean' ? onOff(value) : String(value)),
      value,
    }))
    if (row.kind === 'integer') values.push({ label: 'Custom…', value: 'custom' })
    return values
  }

  private currentValueOf(row: RowMeta): SettingValue | undefined {
    if (row.key === undefined) return undefined
    const value = this.current[row.key]
    return typeof value === 'object' ? undefined : value
  }

  private openPicker(row: RowMeta): void {
    const values = this.pickerValues(row)
    if (values.length === 0) return
    this.mode = 'picker'
    this.pickerId = row.id
    const current = this.currentValueOf(row)
    const found = values.findIndex(entry => entry.value === current)
    this.pickerIndex = found >= 0 ? found : row.kind === 'integer' ? values.length - 1 : 0
    this.clearMessage()
    this.keymap.cancelChord()
    this.tui.requestRender()
  }

  private closePicker(): void {
    this.mode = 'browse'
    this.pickerId = undefined
    this.clearMessage()
    this.tui.requestRender()
  }

  private choosePickerValue(entry: PickerEntry): void {
    const row = this.pickerTarget()
    if (row === undefined) return
    if (entry.value === 'custom' && row.kind === 'integer') {
      this.mode = 'browse'
      this.pickerId = undefined
      this.openNumberEditor(row)
      return
    }
    this.mode = 'browse'
    this.pickerId = undefined
    this.clearMessage()
    this.changeKey(row, entry.value)
  }

  private numberEditor(): InlineAnswer {
    if (this.numberAnswer === undefined) this.numberAnswer = new InlineAnswer(this.tui, this.keymap)
    return this.numberAnswer
  }

  private openNumberEditor(row: RowMeta): void {
    if (row.kind !== 'integer') return
    this.mode = 'edit'
    this.editId = row.id
    const answer = this.numberEditor()
    const current = this.currentValueOf(row)
    answer.editor.setText(current === undefined ? '' : String(current))
    answer.focused = this.focusedState
    this.clearMessage()
    this.keymap.cancelChord()
    this.tui.requestRender()
  }

  private closeNumberEditor(): void {
    this.mode = 'browse'
    this.editId = undefined
    if (this.numberAnswer !== undefined) this.numberAnswer.focused = false
    this.clearMessage()
    this.tui.requestRender()
  }

  private submitNumber(): void {
    const row = this.buildRows().find(item => item.id === this.editId)
    if (row === undefined) {
      this.closeNumberEditor()
      return
    }
    // Enter submits through InlineAnswer, which clears the draft after handing
    // over `lastSubmittedText`; read that first so the value is not lost.
    const submitted = this.numberAnswer?.lastSubmittedText
    const text = (submitted ?? this.numberAnswer?.text ?? '').trim()
    const value = Number(text)
    if (text === '' || !Number.isInteger(value)) {
      this.failed = true
      this.message = `${row.label}: enter a whole number (${this.rangeText(row)})`
      this.tui.requestRender()
      return
    }
    if (this.outOfRange(row, value)) {
      this.failed = true
      this.message = `${row.label}: ${value} must be a whole number (${this.rangeText(row)})`
      this.tui.requestRender()
      return
    }
    this.mode = 'browse'
    this.editId = undefined
    if (this.numberAnswer !== undefined) this.numberAnswer.focused = false
    this.changeKey(row, value)
  }

  private rangeText(row: RowMeta): string {
    if (row.min === undefined || row.max === undefined) return 'any whole number'
    return row.allowZero === true ? `${row.min} to ${row.max}, or 0 for auto` : `${row.min} to ${row.max}`
  }

  private outOfRange(row: RowMeta, value: number): boolean {
    if (row.allowZero === true && value === 0) return false
    if (row.min !== undefined && value < row.min) return true
    if (row.max !== undefined && value > row.max) return true
    return false
  }

  // -------------------------------------------------------------------------
  // Search field

  private get searchActive(): boolean {
    return this.searchFocused && this.mode === 'browse'
  }

  private focusSearch(): void {
    this.mode = 'browse'
    this.searchFocused = true
    this.search.focused = this.focusedState
    this.clearMessage()
    this.keymap.cancelChord()
    this.tui.requestRender()
  }

  private blurSearch(): void {
    if (!this.searchFocused) return
    this.searchFocused = false
    this.search.focused = false
  }

  private onQueryChanged(): void {
    this.reconcile()
    // A new filter starts at the top of its own result list; the section is
    // re-derived from the selection, never used to hide rows.
    this.windowStart = 0
    this.tui.requestRender()
  }

  // -------------------------------------------------------------------------
  // Input

  private resolve(data: string) {
    return resolveListAction(this.keymap, data, 'settingsList')
  }

  /**
   * True for the non-text list surfaces (browse list and value picker), which
   * have no editor of their own to own the paste state.
   */
  private get listSurface(): boolean {
    return this.mode === 'picker' || (this.mode === 'browse' && !this.searchFocused)
  }

  handleInput(raw: string): void {
    if (this.done || this.disposed) return
    if (this.listSurface) {
      this.inputListChunk(raw)
      return
    }
    if (!this.isPasting && isInterruptKey(this.keymap, raw)) {
      this.interrupt()
      return
    }
    if (this.mode === 'edit') {
      this.inputNumber(raw)
      return
    }
    this.inputSearch(raw)
  }

  /**
   * List surfaces reuse the editor's bracketed-paste framing: a pasted chunk
   * (fragmented markers included) is never interpreted as controls, so a pasted
   * TAB cannot jump groups and a pasted Enter cannot apply a value or close the
   * surface. Genuine keys before/after the paste keep their normal meaning.
   */
  private inputListChunk(raw: string): void {
    for (const token of this.listPaste.push(raw)) {
      if (token.kind !== 'keys' || token.data === '') continue
      if (isInterruptKey(this.keymap, token.data)) {
        this.interrupt()
        return
      }
      if (this.mode === 'picker') this.inputPicker(token.data)
      else this.inputBrowse(token.data)
    }
  }

  private inputBrowse(raw: string): void {
    const action = this.resolve(raw)
    if (action !== undefined) {
      switch (action.id) {
        case 'modal.search': this.focusSearch(); return
        case 'settings.reset': { const row = this.selectedRow(); if (row !== undefined) this.resetRow(row); return }
        case 'settings.previous-category': this.jumpSection(-1); return
        case 'settings.next-category': this.jumpSection(1); return
        case 'list.previous': this.move(-1); return
        case 'list.next': this.move(1); return
        case 'list.page-up': this.move(-5); return
        case 'list.page-down': this.move(5); return
        case 'list.first': this.moveTo(0); return
        case 'list.last': this.moveTo(this.visibleRows().length - 1); return
        case 'list.select':
        case 'dialog.confirm': this.activateSelected(); return
        case 'list.select-digit': {
          const key = action.keys[0]
          const number = key !== undefined && /^[1-9]$/.test(key) ? Number(key) : undefined
          if (number !== undefined) {
            this.moveTo(number - 1)
            this.activateSelected()
          }
          return
        }
        default:
          if (CLOSE_ACTIONS.has(action.id)) this.cancel()
          // Any other global/app action stays inert inside this modal.
          return
      }
    }
    // A physical Escape keeps this pane escapable even if the user disabled
    // every shared cancel action. Other disabled list actions stay genuinely
    // inert; they are never advertised as synthetic bindings.
    if (matchesKey(raw, 'escape')) this.cancel()
  }

  private inputSearch(raw: string): void {
    // A fragmented bracketed paste owns the bytes while it arrives: a pasted
    // Ctrl+C/Esc byte stays query content and never blurs or closes the surface.
    const action = this.search.editor.isPasting() ? undefined : this.resolve(raw)
    if (action !== undefined) {
      switch (action.id) {
        case 'list.select':
        case 'dialog.confirm':
          this.blurSearch()
          this.activateSelected()
          return
        case 'list.cancel':
        case 'dialog.cancel':
        case 'app.cancel':
          this.blurSearch()
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
      this.blurSearch()
      this.activateSelected()
    } else if (result === 'cancel') {
      this.blurSearch()
      this.tui.requestRender()
    } else if (result === 'interrupt') {
      this.interrupt()
    }
  }

  private inputPicker(raw: string): void {
    const action = this.resolve(raw)
    if (action === undefined) return
    const row = this.pickerTarget()
    if (row === undefined) {
      this.closePicker()
      return
    }
    const values = this.pickerValues(row)
    switch (action.id) {
      case 'modal.search':
        this.mode = 'browse'
        this.pickerId = undefined
        this.focusSearch()
        return
      case 'settings.reset': this.resetRow(row); return
      case 'list.previous': this.pickerIndex = (this.pickerIndex - 1 + values.length) % values.length; this.tui.requestRender(); return
      case 'list.next': this.pickerIndex = (this.pickerIndex + 1) % values.length; this.tui.requestRender(); return
      case 'list.page-up': this.pickerIndex = Math.max(0, this.pickerIndex - 5); this.tui.requestRender(); return
      case 'list.page-down': this.pickerIndex = Math.min(values.length - 1, this.pickerIndex + 5); this.tui.requestRender(); return
      case 'list.first': this.pickerIndex = 0; this.tui.requestRender(); return
      case 'list.last': this.pickerIndex = values.length - 1; this.tui.requestRender(); return
      case 'list.select':
      case 'dialog.confirm': {
        const entry = values[this.pickerIndex]
        if (entry !== undefined) this.choosePickerValue(entry)
        return
      }
      default:
        if (CLOSE_ACTIONS.has(action.id)) this.closePicker()
        return
    }
  }

  private inputNumber(raw: string): void {
    const answer = this.numberAnswer
    if (answer === undefined) {
      this.closeNumberEditor()
      return
    }
    // Ctrl+C is `app.clear` in this embedded editor context: cancel the entry
    // layer locally instead of dropping the key on a hidden root draft. This is
    // the same local cancel the list layers get from `list.cancel`; pasted bytes
    // stay content, and a remapped/disabled cancel row gets no fallback.
    if (!answer.editor.isPasting() && cancelFallback(this.keymap, raw)) {
      this.closeNumberEditor()
      return
    }
    const result = answer.handleKey(raw)
    if (result === 'submit') this.submitNumber()
    else if (result === 'cancel') this.closeNumberEditor()
    else if (result === 'interrupt') this.interrupt()
    else this.tui.requestRender()
  }

  private cancel(): void {
    if (this.done) return
    this.done = true
    this.listPaste.reset()
    this.keymap.cancelChord()
    this.options.onCancel()
  }

  /** The close affordance follows Esc: leave the nested layer before Settings. */
  private closeSurface(): void {
    if (this.mode === 'picker') { this.closePicker(); return }
    if (this.mode === 'edit') { this.closeNumberEditor(); return }
    if (this.searchFocused) {
      this.blurSearch()
      this.tui.requestRender()
      return
    }
    this.cancel()
  }

  /** Global interrupt never becomes a settings change or a local close. */
  private interrupt(): void {
    this.keymap.cancelChord()
    if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
    else this.cancel()
  }

  // -------------------------------------------------------------------------
  // Rendering

  private frameTitle(): string {
    if (this.mode === 'picker') {
      const row = this.pickerTarget()
      return row === undefined ? 'Settings' : `Settings › ${row.label}`
    }
    if (this.mode === 'edit') {
      const row = this.buildRows().find(item => item.id === this.editId)
      return row === undefined ? 'Settings' : `Settings › ${row.label}`
    }
    return 'Settings'
  }

  private frameActions(): ModalAction[] {
    if (this.mode === 'picker') {
      return [
        { id: 'apply', label: 'apply', action: 'list.select', onActivate: () => {
          const row = this.pickerTarget()
          if (row === undefined) return
          const entry = this.pickerValues(row)[this.pickerIndex]
          if (entry !== undefined) this.choosePickerValue(entry)
        } },
        { id: 'reset', label: 'reset', action: 'settings.reset', onActivate: () => {
          const row = this.pickerTarget()
          if (row !== undefined) this.resetRow(row)
        } },
        { id: 'back', label: 'back', action: 'list.cancel', onActivate: () => this.closePicker() },
      ]
    }
    if (this.mode === 'edit') {
      return [
        { id: 'save', label: 'save', action: 'list.select', onActivate: () => this.submitNumber() },
        { id: 'back', label: 'back', action: 'list.cancel', onActivate: () => this.closeNumberEditor() },
      ]
    }
    return [
      { id: 'change', label: 'change', ...this.changeAction(), onActivate: () => this.activateSelected() },
      { id: 'reset', label: 'reset', action: 'settings.reset', onActivate: () => {
        const row = this.selectedRow()
        if (row !== undefined) this.resetRow(row)
      } },
      { id: 'search', label: 'search', action: 'modal.search', onActivate: () => this.focusSearch() },
      // Section jumps are the only "group" navigation on the one page; the
      // chip shows the real first binding (right/tab by default) instead of a
      // tab bar the surface deliberately does not have.
      { id: 'group', label: 'group', action: 'settings.next-category', onActivate: () => this.jumpSection(1) },
      { id: 'close', label: 'close', action: 'list.cancel', onActivate: () => this.cancel() },
    ]
  }

  private changeAction(): { action?: string } {
    if (modalBinding(this.keymap, 'list.select') !== undefined) return { action: 'list.select' }
    if (modalBinding(this.keymap, 'dialog.confirm') !== undefined) return { action: 'dialog.confirm' }
    return {}
  }

  private searchLine(width: number): string {
    const rendered = this.search.render(Math.max(4, width), this.searchActive, 'Search settings…', '')
    return rendered[0] ?? ''
  }

  /**
   * One non-selectable group header. Space between groups is this header line;
   * there is no tab/segment bar and nothing about it is focusable or clickable.
   */
  private sectionLine(category: SettingsCategory, width: number): string {
    const label = oneLine(SETTINGS_CATEGORIES.find(item => item.id === category)?.label ?? category, 60)
    const title = bold(cc.permission(label))
    const used = visibleWidth(title)
    if (used + 4 > width) return fit(title, width)
    return fit(title + ' ' + dim('─'.repeat(Math.max(0, width - used - 1))), width)
  }

  private rowLines(row: RowMeta, width: number, focused: boolean): string[] {
    const marker = focused ? cc.suggestion('❯') : ' '
    const labelStyle = focused ? cc.suggestion : t.text
    const valueStyle = focused ? cc.suggestion : t.muted
    const label = oneLine(row.label, 160)
    const value = oneLine(row.value, 160)
    const lines: string[] = []
    if (width >= 44 && value !== '') {
      const leftWidth = Math.min(28, Math.max(12, Math.floor(width * 0.46)))
      const rightWidth = Math.max(4, width - leftWidth - 5)
      const left = wrap(label, leftWidth)
      const right = wrap(value, rightWidth)
      const total = Math.max(left.length, right.length)
      for (let line = 0; line < total; line += 1) {
        const key = left[line] ?? ''
        const room = Math.max(0, leftWidth - visibleWidth(key))
        lines.push(`${line === 0 ? marker : ' '} ${labelStyle(key)}${' '.repeat(room)}${dim(' │ ')}${valueStyle(right[line] ?? '')}`)
      }
    } else {
      for (const [offset, text] of wrap(label, Math.max(4, width - 2)).entries()) {
        lines.push(`${offset === 0 ? marker : ' '} ${labelStyle(text)}`)
      }
      if (value !== '') for (const text of wrap(value, Math.max(4, width - 4))) lines.push(`    ${valueStyle(text)}`)
    }
    if (row.available === false) lines.push(`    ${t.yellow('unavailable in this DSH runtime')}`)
    if (focused && row.description !== undefined && row.description !== '') {
      for (const text of wrap(row.description, Math.max(4, width - 4))) lines.push(`    ${dim(t.muted(text))}`)
    }
    return lines
  }

  private pickerBlocks(row: RowMeta, width: number): ListBlock[] {
    const values = this.pickerValues(row)
    const current = this.currentValueOf(row)
    const blocks: ListBlock[] = values.map((entry, index) => {
      const focused = index === this.pickerIndex
      const marker = focused ? cc.suggestion('❯') : ' '
      const isCurrent = entry.value === current
      const suffix = entry.value === 'custom' ? '' : isCurrent ? dim(' · current') : ''
      const room = Math.max(4, width - 4 - visibleWidth(suffix))
      const label = fit((focused ? cc.suggestion : t.text)(oneLine(entry.label, 160)), room)
      return { lines: [`${marker} ${label}${suffix}`], focused, index, key: `picker:${index}:${entry.label}` }
    })
    if (row.description !== undefined && width >= 40) {
      for (const text of wrap(dim(row.description), Math.max(4, width - 4)).slice(0, 2)) {
        blocks.push({ lines: [`    ${text}`] })
      }
    }
    return blocks
  }

  private editLines(width: number): string[] {
    const row = this.buildRows().find(item => item.id === this.editId)
    const answer = this.numberAnswer
    if (row === undefined || answer === undefined) return []
    const lines = [` ${cc.suggestion(oneLine(row.label, 160))}`]
    const input = answer.render(Math.max(4, width - 4), this.focusedState, 'value')
    lines.push('   ' + (input[0] ?? ''))
    lines.push('   ' + dim(`whole number · ${this.rangeText(row)}`))
    return lines.map(line => fit(line, width))
  }

  private buildBody(width: number, height: number): ListBody {
    if (height <= 0) return { lines: [] }
    if (this.mode === 'edit') {
      return { lines: this.editLines(width).slice(0, height) }
    }
    if (this.mode === 'picker') {
      const row = this.pickerTarget()
      if (row === undefined) return { lines: [] }
      // A short picker centers the focused value: slicing from the top alone
      // would hide the `❯` row and let Enter apply an unseen value.
      const window = windowList(this.pickerBlocks(row, width), height, { center: true })
      return { lines: window.lines, hits: window.hits }
    }
    const rows = this.visibleRows()
    if (rows.length === 0) {
      const terms = this.query
      return { lines: [fit(` ${t.muted(terms === '' ? 'No settings available.' : `No settings match “${oneLine(terms, 60)}”.`)}`, width)] }
    }
    const blocks: ListBlock[] = []
    const selected = this.currentIndex(rows)
    let lastSection: SettingsCategory | undefined
    for (const [rowIndex, row] of rows.entries()) {
      // Every available section lives in this one list; the header is the only
      // thing that separates groups, so group boundaries are visible while
      // browsing *and* while searching, and a jump never rebuilds a page.
      if (row.category !== lastSection) {
        lastSection = row.category
        blocks.push({ lines: [this.sectionLine(row.category, width)] })
      }
      blocks.push({ lines: this.rowLines(row, width, rowIndex === selected), focused: rowIndex === selected, index: rowIndex, key: row.id })
    }
    // Bounded window around the focused row. The requested start survives a
    // child-surface round trip, and the focused row is always visible.
    const window = windowList(blocks, height, { start: this.windowStart })
    this.windowStart = window.start
    return { lines: window.lines, hits: window.hits }
  }

  /** Frame identity: mode plus the row the mutating footer would act on. */
  private ownerKey(): string {
    if (this.mode === 'picker') return `settings:picker:${this.pickerId ?? ''}`
    if (this.mode === 'edit') return `settings:edit:${this.editId ?? ''}`
    return `settings:row:${this.activeRowId ?? ''}`
  }

  render(width: number): string[] {
    // One roster build per painted frame: the parent's native rows are read
    // once for this frame (measure + paint), never per hover/click/selection.
    this.rosterCache = undefined
    const browsing = this.mode === 'browse'
    return this.list.render(width, {
      title: this.frameTitle(),
      ownerKey: this.ownerKey(),
      // Placeholder header count for the measure pass; the real rows are
      // rendered once the inner width is known.
      beforeRows: browsing ? (this.options.path === undefined ? 1 : 2) : 1,
      before: bodyWidth => {
        const before: string[] = []
        if (browsing) before.push(this.searchLine(bodyWidth))
        if (this.options.path !== undefined) before.push(fit(dim(sanitize(tildePath(this.options.path))), bodyWidth))
        return before
      },
      status: bodyWidth => listStatusLines(this.message, this.failed, bodyWidth),
      actions: this.frameActions(),
      onClose: () => this.closeSurface(),
      keymap: this.keymap,
    }, (bodyWidth, bodyHeight) => this.buildBody(bodyWidth, bodyHeight))
  }

  /**
   * Mouse policy. Gestures that change no visible state report `render: false`
   * so a press that only pins row identity (and every inert group header /
   * blank body cell / chrome cell) cannot trigger a repaint or leak into a root
   * selection. Only a real focus/selection change repaints.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done || this.disposed) return undefined
    // An unfinished paste keeps its input owner. A mouse focus/mode change
    // cannot redirect the remaining paste bytes into another field or action.
    if (this.isPasting) return { handled: true, render: false }
    const chrome = this.list.chromeMouse(event)
    if (chrome !== undefined) return chrome
    const beforeIndex = this.list.beforeIndex(event.y)
    if (beforeIndex !== undefined) {
      const searchRow = this.mode === 'browse' && beforeIndex === 0
      if (event.type === 'click' && event.button === 'left' && searchRow) {
        if (this.searchFocused) return { handled: true, render: false }
        this.focusSearch()
        return { handled: true, render: true }
      }
      if (event.type === 'press' && event.button === 'left') return { handled: true, render: false }
    }
    const body = this.list.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'wheel') {
      const delta = (event.wheelDelta ?? 0) < 0 ? -3 : 3
      if (this.mode === 'picker') {
        const row = this.pickerTarget()
        const values = row === undefined ? [] : this.pickerValues(row)
        if (values.length > 0) {
          this.pickerIndex = Math.max(0, Math.min(values.length - 1, this.pickerIndex + (delta > 0 ? 1 : -1)))
          this.tui.requestRender()
        }
        return { handled: true, render: true }
      }
      if (this.mode === 'browse') {
        this.move(delta)
        return { handled: true, render: true }
      }
      return undefined
    }
    // A group header or a blank cell is inert chrome: claim the gesture so it
    // cannot become a root action or terminal text selection, without a repaint.
    if ((event.type === 'press' || event.type === 'click') && event.button === 'left'
      && bodyHitAt(this.list.bodyHits, body.y) === undefined) return { handled: true, render: false }
    return this.list.rowMouse(event, this.ownerKey(), hit => this.activateHit(hit))
  }

  /** A click selects its row; clicking the selected row runs its action. */
  private activateHit(hit: HitRange): void {
    if (this.mode === 'picker') {
      this.pickerIndex = hit.index
      this.tui.requestRender()
      return
    }
    if (this.mode !== 'browse') return
    const rows = this.visibleRows()
    // The press pin is the row's stable id. A roster that was rebuilt between
    // the press and the release (a native settings push can drop the roster
    // cache without a repaint) makes the painted index point at a *different*
    // row, so the id wins and the index is only the fallback for a hit without
    // one (a plain click resolved against the current paint).
    const pinned = hit.key === undefined ? -1 : rows.findIndex(row => row.id === hit.key)
    // A press identified by a row id whose row disappeared must not fall back to
    // the old index: that index now addresses a different row after a native
    // roster push. Only a hit without a key (a plain click) uses the painted
    // index.
    if (hit.key !== undefined && pinned < 0) return
    const index = pinned >= 0 ? pinned : hit.index
    const row = rows[index]
    if (row === undefined) return
    const wasSelected = this.activeRowId === row.id
    this.moveTo(index)
    if (wasSelected) this.activateRow(row)
    this.tui.requestRender()
  }
}
