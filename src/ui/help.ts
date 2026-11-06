/**
 * Read-only /help panel.
 *
 * Shape is deliberately the same as the `/model` SelectDialog: a ruled title,
 * a body window sized with the shared dialog row budget, and one hint line.
 * What differs is semantic: this surface has no selection. It renders the
 * command catalogs passed by the parent (mounted DSH descriptors plus UI
 * commands) as two labelled sections, side by side when the terminal is wide
 * enough and stacked otherwise. Names, descriptions and input hints are
 * display-only data; no local command classification, execution, prompt
 * filling or selection callback exists here. The parent owns all grouping
 * (including any namespace display convention); this component never inspects
 * a definition id or invents MCP/plugin rows.
 *
 * An optional `note` is rendered compactly below the title (at most two dim
 * lines, then an ellipsis) so the parent can explain a grouping convention or
 * a caveat without turning the panel into a document. It is stripped of ANSI
 * and control characters like every other descriptor field.
 *
 * Keys are resolved through the shared `CcKeymap` in `list` context, then
 * `dialog` context for cancel fallbacks, so remapped or disabled bindings are
 * respected and no literal arrow/Esc fallback is applied:
 * - `list.previous/next`, `list.page-up/down`, `list.first/last` scroll;
 * - `list.cancel`, `dialog.cancel`, `app.cancel` close;
 * - a single-key `app.interrupt` (Ctrl+C by default) is global turn
 *   cancellation: it cancels any pending chord, never closes, selects or
 *   submits by itself, and calls the parent's `onInterrupt`. It also works
 *   while a chord prefix is pending, matching the input layer's rule that
 *   cancellation is never blocked by chord UI;
 * - `list.select`, `list.select-digit`, `dialog.confirm`, printable keys and
 *   every unbound sequence are inert. Enter/digits can never execute anything.
 *
 * Chord ownership: a cancelled chord's `passthrough` is resolved once, as the
 * editor does, rather than swallowed. `dispose()` is idempotent and only
 * cancels the shared keymap chord while this surface is focused, so removing a
 * hidden panel never steals another editor's half-typed chord.
 *
 * No component writes to stdout or uses console. `dispose()` does not call
 * `onClose`/`onInterrupt`; the parent owns surface lifecycle.
 */
import { matchesKey, type Component, type Focusable, type KeyId, type TUI } from '#pi-tui'
import { formatBinding, type CcKeymap } from '../input/index.ts'
import { isInterruptKey, rowBudget } from './dialogs.ts'
import { bold, cc, dim, t } from './theme.ts'
import { fit, sanitize, truncateToWidth, visibleWidth, wrap } from './text.ts'

export type HelpCommand = {
  name: string
  description: string
  inputHint?: string
}

export interface HelpPanelOptions {
  /** Authoritative mounted DSH command descriptors plus UI commands. */
  commands: readonly HelpCommand[]
  /** Native custom-command descriptors, when the parent has them. */
  customCommands: readonly HelpCommand[]
  /** Shared input keymap; a remap/disable must change this panel's behavior. */
  keymap: CcKeymap
  /** Local close (Esc/list cancel). Called at most once. */
  onClose: () => void
  /**
   * Global turn cancellation (`app.interrupt`, Ctrl+C by default). The panel
   * remains open: the parent runs its normal cancel path and closes the surface
   * when appropriate. Without it, interrupt falls back to `onClose`.
   */
  onInterrupt?: () => void
  /**
   * Optional display-only note rendered below the title (max two lines). Use it
   * for a grouping-convention caveat; the component does not interpret it.
   */
  note?: string
}

/** Two columns need two usable halves; below this the sections stack. */
const WIDE_MIN_COLUMNS = 72
const COLUMN_GAP = 2
const ENTRY_INDENT = '  '
const DESCRIPTION_INDENT = '    '

interface HelpAction {
  id: string
}

const rule = (width: number): string => cc.inactive('─'.repeat(Math.max(1, width)))

const oneLine = (value: string | undefined): string =>
  sanitize(typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim()

const displayName = (command: HelpCommand): string => {
  const name = oneLine(command.name)
  if (name === '') return '/?'
  return name.startsWith('/') ? name : '/' + name
}

/** Every command row is display-only: highlighted label, optional hint, dim description. */
function commandLines(command: HelpCommand, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const hint = oneLine(command.inputHint)
  const first = ENTRY_INDENT + cc.suggestion(displayName(command)) + (hint === '' ? '' : dim(' ' + hint))
  const lines = [fit(first, safeWidth)]
  const description = sanitize(typeof command.description === 'string' ? command.description : '')
  if (description.trim() !== '') {
    const descriptionWidth = Math.max(1, safeWidth - DESCRIPTION_INDENT.length)
    for (const line of wrap(description, descriptionWidth)) {
      lines.push(fit(DESCRIPTION_INDENT + dim(line), safeWidth))
    }
  }
  return lines
}

function sectionLines(title: string, commands: readonly HelpCommand[], width: number, empty: string): string[] {
  const safeWidth = Math.max(1, width)
  const lines = [fit(`${bold(cc.permission(title))} ${dim(String(commands.length))}`, safeWidth)]
  if (commands.length === 0) {
    lines.push(fit(ENTRY_INDENT + t.muted(empty), safeWidth))
    return lines
  }
  for (const command of commands) lines.push(...commandLines(command, safeWidth))
  return lines
}

function padRight(line: string, width: number): string {
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)))
}

const firstBinding = (keymap: CcKeymap, action: string): string | undefined => {
  const binding = keymap.getBindings(action)[0]
  return binding === undefined ? undefined : formatBinding(binding.split(' '))
}

const isCloseAction = (id: string): boolean =>
  id === 'list.cancel' || id === 'dialog.cancel' || id === 'app.cancel'

export class HelpPanel implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: HelpPanelOptions
  private focusedState = false
  private scroll = 0
  private lastWidth = 80
  private done = false
  private disposedState = false

  constructor(tui: TUI, options: HelpPanelOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (this.disposedState) {
      this.focusedState = false
      return
    }
    if (value === this.focusedState) return
    this.focusedState = value
    // Focus changes transfer chord ownership in both directions.
    this.keymap.cancelChord()
  }

  /** Current line offset inside the body window (also useful for render tests). */
  get scrollTop(): number {
    return this.scroll
  }

  /** True after idempotent disposal; the parent owns the surface itself. */
  get isDisposed(): boolean {
    return this.disposedState
  }

  /**
   * Release the shared-keymap chord only when this panel still owns focus.
   * Idempotent. Never calls `onClose`/`onInterrupt` and never cancels another
   * editor's pending chord.
   */
  dispose(): void {
    if (this.disposedState) return
    this.disposedState = true
    if (this.focusedState) this.keymap.cancelChord()
    this.focusedState = false
  }

  /** Parent hook for focus changes; safe to call repeatedly. */
  cancelChord(): void {
    this.keymap.cancelChord()
  }

  invalidate(): void {}

  // -------------------------------------------------------------------------
  // Input

  /**
   * Ctrl+C (or whatever single key `app.interrupt` resolves to) must stay
   * global even while a chord prefix is pending. `isInterruptKey` intentionally
   * defers to chord resolution when pending; the second branch restores the
   * input layer's rule for a _single-key_ interrupt only. A chord-bound
   * interrupt is left to normal resolution so it can still complete.
   */
  private interruptInput(data: string): boolean {
    if (!this.keymap.isPendingChord()) return isInterruptKey(this.keymap, data)
    return this.keymap
      .getBindings('app.interrupt')
      .some(binding => !binding.includes(' ') && matchesKey(data, binding as KeyId))
  }

  /**
   * Resolve one key for this read-only surface.
   *
   * This mirrors the shared list/dialog precedence (list actions first, then
   * dialog confirm/cancel fallbacks) but re-dispatches a cancelled chord's
   * passthrough once, like CcEditor, instead of dropping the fresh key.
   */
  private actionFor(data: string): HelpAction | undefined {
    let raw = data
    for (let pass = 0; pass < 2; pass += 1) {
      const list = this.keymap.resolve(raw, 'list')
      if (list.kind === 'cancelled-chord') {
        raw = list.passthrough
        continue
      }
      if (list.kind === 'pending') return undefined
      if (list.kind === 'action') {
        const id = list.action.id
        if (id.startsWith('list.') || id === 'app.interrupt' || id === 'app.cancel' || id === 'dialog.cancel') {
          return { id }
        }
        // Any other app/global action (help, model picker, …) is not part of
        // this surface and stays inert.
        return undefined
      }
      const dialog = this.keymap.resolve(raw, 'dialog')
      if (dialog.kind === 'action') {
        const id = dialog.action.id
        if (id === 'dialog.confirm' || id === 'dialog.cancel' || id === 'app.interrupt') return { id }
      }
      return undefined
    }
    return undefined
  }

  /**
   * Compact optional note. Wrapping is capped at two lines so a short terminal
   * keeps a usable body; the second line gets an ellipsis when truncated.
   */
  private noteLines(width: number): string[] {
    const note = sanitize(typeof this.options.note === 'string' ? this.options.note : '')
      .replace(/\s+/g, ' ')
      .trim()
    if (note === '') return []
    const wrapped = wrap(note, Math.max(1, width - 2))
    const lines = wrapped.slice(0, 2)
    if (wrapped.length > 2 && lines.length === 2) {
      lines[1] = truncateToWidth(lines[1] ?? '', Math.max(1, width - 3)).replace(/\s+$/, '') + '…'
    }
    return lines.map(line => fit(' ' + dim(line), width))
  }

  private viewport(width: number): number {
    const budget = rowBudget(this.tui)
    const note = this.noteLines(width).length
    if (!Number.isFinite(budget)) return Number.MAX_SAFE_INTEGER
    return Math.max(1, Math.floor(budget) - note)
  }

  private maxScroll(width: number): number {
    return Math.max(0, this.bodyLines(width).length - this.viewport(width))
  }

  handleInput(raw: string): void {
    if (this.done || this.disposedState) return
    if (this.interruptInput(raw)) {
      this.keymap.cancelChord()
      this.interrupt()
      return
    }
    const action = this.actionFor(raw)
    if (action === undefined) return
    if (action.id === 'app.interrupt') {
      this.keymap.cancelChord()
      this.interrupt()
      return
    }
    if (isCloseAction(action.id)) {
      this.close()
      return
    }
    const max = this.maxScroll(this.lastWidth)
    switch (action.id) {
      case 'list.previous':
        this.scroll = Math.max(0, this.scroll - 1)
        break
      case 'list.next':
        this.scroll = Math.min(max, this.scroll + 1)
        break
      case 'list.page-up':
        this.scroll = Math.max(0, this.scroll - this.viewport(this.lastWidth))
        break
      case 'list.page-down':
        this.scroll = Math.min(max, this.scroll + this.viewport(this.lastWidth))
        break
      case 'list.first':
        this.scroll = 0
        break
      case 'list.last':
        this.scroll = max
        break
      default:
        // list.select / list.select-digit / dialog.confirm and anything else
        // are intentionally inert: this panel never selects or executes.
        break
    }
  }

  private close(): void {
    if (this.done) return
    this.done = true
    this.keymap.cancelChord()
    this.options.onClose()
  }

  /**
   * Global turn cancellation. The panel itself is not a decision: it never
   * submits/answers. With no parent handler it falls back to a local close.
   */
  private interrupt(): void {
    if (this.done) return
    this.keymap.cancelChord()
    if (this.options.onInterrupt !== undefined) {
      this.options.onInterrupt()
      return
    }
    this.close()
  }

  // -------------------------------------------------------------------------
  // Rendering

  private bodyLines(width: number): string[] {
    if (width >= WIDE_MIN_COLUMNS) {
      const leftWidth = Math.floor((width - COLUMN_GAP) / 2)
      const rightWidth = width - COLUMN_GAP - leftWidth
      const left = sectionLines('Commands', this.options.commands, leftWidth, 'No commands are available.')
      const right = sectionLines('Custom commands', this.options.customCommands, rightWidth, 'No custom commands.')
      const rows = Math.max(left.length, right.length)
      return Array.from({ length: rows }, (_, index) =>
        fit(padRight(left[index] ?? '', leftWidth) + ' '.repeat(COLUMN_GAP) + (right[index] ?? ''), width))
    }
    return [
      ...sectionLines('Commands', this.options.commands, width, 'No commands are available.'),
      '',
      ...sectionLines('Custom commands', this.options.customCommands, width, 'No custom commands.'),
    ]
  }

  /** One width-safe hint line; close comes first so narrow terminals keep it. */
  private hints(scrollable: boolean): string {
    const parts: string[] = []
    const close = firstBinding(this.keymap, 'list.cancel')
      ?? firstBinding(this.keymap, 'dialog.cancel')
      ?? firstBinding(this.keymap, 'app.cancel')
    if (close !== undefined) parts.push(close + ' close')

    if (scrollable) {
      const previous = firstBinding(this.keymap, 'list.previous')
      const next = firstBinding(this.keymap, 'list.next')
      if (previous !== undefined && next !== undefined) parts.push(`${previous}/${next} scroll`)
      else if (previous !== undefined) parts.push(previous + ' scroll up')
      else if (next !== undefined) parts.push(next + ' scroll down')

      const pageUp = firstBinding(this.keymap, 'list.page-up')
      const pageDown = firstBinding(this.keymap, 'list.page-down')
      if (pageUp !== undefined && pageDown !== undefined) parts.push(`${pageUp}/${pageDown} page`)
      else if (pageUp !== undefined) parts.push(pageUp + ' page up')
      else if (pageDown !== undefined) parts.push(pageDown + ' page down')

      const first = firstBinding(this.keymap, 'list.first')
      const last = firstBinding(this.keymap, 'list.last')
      if (first !== undefined && last !== undefined) parts.push(`${first}/${last} jump`)
      else if (first !== undefined) parts.push(first + ' jump to top')
      else if (last !== undefined) parts.push(last + ' jump to end')
    }

    if (this.options.onInterrupt !== undefined) {
      const interrupt = firstBinding(this.keymap, 'app.interrupt')
      if (interrupt !== undefined) parts.push(interrupt + ' interrupt')
    }
    return parts.length === 0 ? '' : dim(cc.inactive(parts.join(' · ')))
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, Math.floor(width))
    this.lastWidth = safeWidth
    const body = this.bodyLines(safeWidth)
    const note = this.noteLines(safeWidth)
    const viewport = Math.min(this.viewport(safeWidth), Math.max(1, body.length))
    const max = Math.max(0, body.length - viewport)
    this.scroll = Math.max(0, Math.min(this.scroll, max))
    const visible = body.slice(this.scroll, this.scroll + viewport)
    const out = [
      rule(safeWidth),
      fit(' ' + bold(cc.permission('Help')), safeWidth),
      ...note,
      '',
      ...visible,
      '',
      fit(' ' + this.hints(max > 0), safeWidth),
    ]
    return out.map(line => fit(line, safeWidth))
  }
}