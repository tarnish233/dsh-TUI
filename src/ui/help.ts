/**
 * Read-only /help panel.
 *
 * Shape is the shared `ModalFrame` (`standard` size): the frame owns the title,
 * the close affordance, the action footer with the *actual* keymap bindings and
 * the mouse geometry. This component supplies a search row, the catalog body and
 * one status line, and owns nothing else.
 *
 * Contents are the command catalogs passed by the parent (mounted DSH
 * descriptors plus UI commands) and an optional native Skills snapshot.
 * Names, descriptions and input hints are display-only data; no local command
 * classification, execution, prompt filling or selection callback exists here.
 * The parent owns all grouping (including any namespace display convention);
 * this component never inspects a definition id or invents MCP/plugin rows.
 *
 * An optional `note` is rendered compactly above the body (at most two dim
 * lines, then an ellipsis) so the parent can explain a grouping convention or
 * a caveat without turning the panel into a document. It is stripped of ANSI
 * and control characters like every other descriptor field.
 *
 * An optional `skills` snapshot appends one **full-width, read-only** Skills
 * section after the command columns. The section is native metadata only: the
 * literal `/name`, the description, the optional `whenToUse` and a `user-only`
 * marker for `modelInvocable: false`. There is no skill body fetch, no second
 * editor, no execution/selection/prompt-fill and no click target; the snapshot
 * is never interpreted as a capability decision. Availability is reported
 * honestly: `available: false` says native metadata discovery cannot currently
 * serve this composition. A public preset scope can be read without an Agent;
 * this panel never starts one or switches presets. `complete: false` is marked
 * `incomplete`, and only an available, complete, empty catalog may say there
 * are no user-invocable skills. Omitting the option keeps the historical
 * two-section body byte for byte.
 *
 * Search: `modal.search` (Ctrl+F by default) focuses the one CC text field
 * (`modalSearch`). Typing filters labels/descriptions/keywords in place; the
 * field never executes, selects, fills the prompt or runs a skill. Leaving the
 * search (Esc) clears the query and returns to the read-only list; Esc in the
 * list closes the panel. "No match" is distinct from a native catalog that is
 * unavailable or incomplete.
 *
 * Keys are resolved through the shared `CcKeymap` in the unified `modalList`
 * context (list/dialog/global fallbacks, no editor fallback), so remapped or
 * disabled bindings are respected and no literal arrow/Esc fallback is applied:
 * - `list.previous/next`, `list.page-up/down`, `list.first/last` scroll;
 * - `list.cancel`, `dialog.cancel`, `app.cancel` close;
 * - a configured single-key `app.interrupt` (Ctrl+C by default) is global turn
 *   cancellation: it cancels any pending chord, never closes, selects or
 *   submits by itself, and calls the parent's `onInterrupt`;
 * - `list.select`, `list.select-digit`, `dialog.confirm`, printable keys and
 *   every unbound sequence are inert while the list is focused. Enter/digits
 *   can never execute anything.
 *
 * Chord ownership: a cancelled chord's `passthrough` is resolved once, as the
 * editor does, rather than swallowed. `dispose()` is idempotent and only
 * cancels the shared keymap chord while this surface is focused, so removing a
 * hidden panel never steals another editor's half-typed chord.
 *
 * No component writes to stdout or uses console. `dispose()` does not call
 * `onClose`/`onInterrupt`; the parent owns surface lifecycle.
 */
import { matchesKey, type Component, type Focusable, type KeyId, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from '#pi-tui'
import type { SkillCatalogEntry, SkillCatalogSnapshot } from '../backend/types.ts'
import { type CcKeymap } from '../input/index.ts'
import { modalAction, renderModalBody, textPaint, type BodyPaint, type ResolvedModalAction } from './dialogs.ts'
import { InlineAnswer } from './inline-editor.ts'
import { ModalFrame, modalHeight, type ModalFrameOptions, type ModalSize } from './modal.ts'
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
  /**
   * Read-only native skill metadata for the current Agent attachment. Omitted
   * (or `undefined`) renders exactly the historical Commands / Custom commands
   * body; the parent refetches the snapshot itself and never mutates this one.
   */
  skills?: SkillCatalogSnapshot
}

/**
 * The read-only catalog metadata of one Help surface: the only state a refresh
 * may replace. Keymap, callbacks and the surface identity stay parent-owned, so
 * a native command/skill invalidation can never swap the open dialog.
 */
export type HelpPanelCatalog = Pick<HelpPanelOptions, 'commands' | 'customCommands' | 'skills' | 'note'>

/** Two columns need two usable halves; below this the sections stack. */
const WIDE_MIN_COLUMNS = 72
const COLUMN_GAP = 2
const ENTRY_INDENT = '  '
const DESCRIPTION_INDENT = '    '
/**
 * Per-skill height budget. A description/whenToUse is display metadata, not a
 * document: each is capped so one verbose native descriptor cannot push every
 * other skill out of the body window. Truncation is marked with an ellipsis.
 */
const SKILL_DESCRIPTION_LINES = 3
const SKILL_WHEN_LINES = 2
const SKILL_WHEN_PREFIX = 'when: '
const SKILL_USER_ONLY = 'user-only'
/** Query field rows: one line is not a window, an unbounded field eats the body. */
const MAX_QUERY_ROWS = 3
/**
 * Honest boundaries: unknown/incomplete is never painted as "no skills".
 * Metadata readability is independent from model-facing tool visibility and
 * Agent existence. The component must not invent the cause of an unavailable view.
 */
const SKILLS_UNAVAILABLE = 'No skill catalog is available from this DSH composition yet. Directory lookup uses the native registry and preset scope; it never starts an Agent or loads skill instructions. This is not proof that no skills are installed.'
const SKILLS_INCOMPLETE = 'Catalog incomplete: no skills were reported so far, and that is not proof this session has none.'
const SKILLS_EMPTY = 'No user-invocable skills.'
const NO_MATCH = (query: string): string => `Nothing matches "${query}". The catalogs above are loaded; try a shorter search.`

const oneLine = (value: string | undefined): string =>
  sanitize(typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim()

const slashName = (value: string | undefined): string => {
  const name = oneLine(value)
  if (name === '') return '/?'
  return name.startsWith('/') ? name : '/' + name
}

const displayName = (command: HelpCommand): string => slashName(command.name)

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

/** Wrap into at most `max` lines, ellipsizing the last one when clipped. */
function boundedLines(text: string, width: number, max: number): string[] {
  const safeWidth = Math.max(1, width)
  const wrapped = wrap(text, safeWidth)
  if (wrapped.length <= max) return wrapped
  const lines = wrapped.slice(0, Math.max(1, max))
  const last = lines[lines.length - 1] ?? ''
  lines[lines.length - 1] = truncateToWidth(last, Math.max(1, safeWidth - 1)).replace(/\s+$/, '') + '…'
  return lines
}

/** One indented, sanitized, width-safe muted sentence block (bounded height). */
function noticeLines(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const indent = ENTRY_INDENT.length
  // Four bounded rows keep the whole availability sentence (including "this is
  // not proof that no skills are installed") visible at ordinary widths while
  // still refusing to let one notice take over the body.
  return boundedLines(text, Math.max(1, safeWidth - indent), 4)
    .map(line => fit(ENTRY_INDENT + t.muted(line), safeWidth))
}

/** Height-safe guard: a malformed snapshot degrades to no rows, never a crash. */
const skillEntries = (skills: SkillCatalogSnapshot): readonly SkillCatalogEntry[] => {
  const raw: unknown = skills.entries
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is SkillCatalogEntry => entry !== null && typeof entry === 'object')
}

/**
 * One skill row: highlighted literal `/name`, an optional `user-only` marker,
 * then the sanitized description and `whenToUse` wrapped inside the indent.
 * Nothing here is clickable, selectable or executable.
 */
function skillLines(entry: SkillCatalogEntry, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const userOnly = entry.modelInvocable === false
  const head = ENTRY_INDENT + cc.suggestion(slashName(entry.name)) + (userOnly ? ' ' + dim('[' + SKILL_USER_ONLY + ']') : '')
  const lines = [fit(head, safeWidth)]
  const textWidth = Math.max(1, safeWidth - DESCRIPTION_INDENT.length)

  const description = sanitize(typeof entry.description === 'string' ? entry.description : '')
  if (description.trim() !== '') {
    for (const line of boundedLines(description, textWidth, SKILL_DESCRIPTION_LINES)) {
      lines.push(fit(DESCRIPTION_INDENT + dim(line), safeWidth))
    }
  }

  const whenToUse = oneLine(entry.whenToUse)
  if (whenToUse !== '') {
    const whenWidth = Math.max(1, textWidth - SKILL_WHEN_PREFIX.length)
    boundedLines(whenToUse, whenWidth, SKILL_WHEN_LINES).forEach((line, index) => {
      const prefix = index === 0 ? SKILL_WHEN_PREFIX : ' '.repeat(SKILL_WHEN_PREFIX.length)
      lines.push(fit(DESCRIPTION_INDENT + dim(prefix + line), safeWidth))
    })
  }
  return lines
}

/**
 * Full-width read-only Skills section. The heading always tells the truth
 * about availability/completeness; the empty message is reserved for a native
 * catalog that is genuinely available, complete and empty.
 */
function skillSectionLines(skills: SkillCatalogSnapshot, width: number, entries: readonly SkillCatalogEntry[], filtered: boolean): string[] {
  const safeWidth = Math.max(1, width)
  const available = skills.available === true
  const complete = skills.complete === true
  const visible = available ? entries : []
  const count = available ? dim(filtered ? `${visible.length}/` : '') + dim(String(visible.length === 0 ? '0' : String(visible.length))) : dim('?')
  // An unavailable observation is never complete, so "incomplete" would be
  // redundant noise next to the honest unavailable sentence.
  const markers = available && !complete ? ' ' + dim('incomplete') : ''
  const lines = [fit(`${bold(cc.permission('Skills'))} ${count}${markers}`, safeWidth)]

  if (!available) {
    lines.push(...noticeLines(SKILLS_UNAVAILABLE, safeWidth))
    return lines
  }
  if (visible.length === 0) {
    // A filter that removed every row is not an empty catalog.
    lines.push(...noticeLines(filtered ? 'No skills match the search.' : complete ? SKILLS_EMPTY : SKILLS_INCOMPLETE, safeWidth))
    return lines
  }
  for (const entry of visible) lines.push(...skillLines(entry, safeWidth))
  return lines
}

function padRight(line: string, width: number): string {
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)))
}

const isCloseAction = (id: string): boolean =>
  id === 'list.cancel' || id === 'dialog.cancel' || id === 'app.cancel'

const matches = (haystack: string, query: string): boolean =>
  query === '' || haystack.toLowerCase().includes(query)

export class HelpPanel implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: HelpPanelOptions
  /** Current catalog snapshot; `setCatalog` replaces this object atomically. */
  private catalog: HelpPanelCatalog
  private readonly frame = new ModalFrame()
  private readonly search: InlineAnswer
  private focusedState = false
  /** `browse` is the read-only catalog; `search` owns the one CC text field. */
  private mode: 'browse' | 'search' = 'browse'
  private scroll = 0
  private viewport = 10
  /**
   * Body budget of the **painted** window, not the frame width. The body is
   * wrapped at `ModalFrame`'s body width (frame width minus chrome), so a
   * window/status computed from the frame width would under-count wrapped rows
   * and stop the last page above the real tail. `0` means "not painted yet".
   */
  private lastBodyWidth = 0
  private done = false
  private disposedState = false

  constructor(tui: TUI, options: HelpPanelOptions) {
    this.tui = tui
    this.options = options
    this.catalog = {
      commands: options.commands,
      customCommands: options.customCommands,
      ...(options.note === undefined ? {} : { note: options.note }),
      ...(options.skills === undefined ? {} : { skills: options.skills }),
    }
    this.keymap = options.keymap
    this.search = new InlineAnswer(tui, this.keymap)
    this.search.editor.setContext('modalSearch')
    this.search.onChange = () => {
      // Filtering never executes, selects or fills the prompt.
      this.scroll = 0
      this.tui.requestRender()
    }
    this.search.editor.onAction = event => {
      switch (event.id) {
        case 'dialog.cancel':
        case 'app.cancel':
          this.leaveSearch()
          return true
        case 'app.interrupt':
          this.interrupt()
          return true
        case 'dialog.confirm':
          // Enter is inert: this panel never selects, executes or submits.
          return true
        default:
          return false
      }
    }
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
    this.search.focused = value && this.mode === 'search'
  }

  /** Current line offset inside the body window (also useful for render tests). */
  get scrollTop(): number {
    return this.scroll
  }

  /** True while the search field owns typing (`modal.search` was used). */
  get searching(): boolean {
    return this.mode === 'search'
  }

  /**
   * Fragmented bracketed-paste state of the search field, so the App's global
   * Ctrl+C listener never interrupts on a byte that is query text.
   */
  get isPasting(): boolean {
    return this.search.editor.isPasting()
  }

  /** True after idempotent disposal; the parent owns the surface itself. */
  get isDisposed(): boolean {
    return this.disposedState
  }

  /**
   * Release the one query editor and the shared-keymap chord only when this
   * panel still owns focus. Idempotent. Never calls `onClose`/`onInterrupt`.
   */
  dispose(): void {
    if (this.disposedState) return
    this.disposedState = true
    if (this.focusedState) this.keymap.cancelChord()
    this.focusedState = false
    this.search.dispose()
    this.frame.invalidate()
  }

  /** Parent hook for focus changes; safe to call repeatedly. */
  cancelChord(): void {
    this.keymap.cancelChord()
  }

  invalidate(): void {
    this.frame.invalidate()
    this.search.invalidate()
  }

  /**
   * Atomically replace the read-only catalog metadata after a native command/
   * skill refresh. Only display data changes: the query editor, its text, the
   * focus, keymap, callbacks, surface identity and the scroll offset are kept
   * (the next render clamps the offset to the new body, exactly as any other
   * render does). A closed or disposed panel ignores the update, so a late
   * refresh can never resurrect a surface the parent already dismissed.
   */
  setCatalog(catalog: HelpPanelCatalog): void {
    if (this.done || this.disposedState) return
    this.catalog = {
      commands: catalog.commands,
      customCommands: catalog.customCommands,
      ...(catalog.note === undefined ? {} : { note: catalog.note }),
      ...(catalog.skills === undefined ? {} : { skills: catalog.skills }),
    }
    // The body height may change with the catalog, so the frame measurement
    // cache is dropped; the parent's render request paints the new snapshot.
    this.frame.invalidate()
    this.tui.requestRender()
  }

  // -------------------------------------------------------------------------
  // Search state

  private query(): string {
    return this.mode === 'search' ? this.search.text : ''
  }

  private enterSearch(): void {
    if (this.mode === 'search') return
    this.mode = 'search'
    this.scroll = 0
    this.search.focused = this.focusedState
    this.tui.requestRender()
  }

  /** Leaving the search discards the query: the list returns to the catalog. */
  private leaveSearch(): void {
    if (this.mode !== 'search') return
    this.mode = 'browse'
    this.search.focused = false
    this.search.editor.replaceDraftText('')
    this.scroll = 0
    this.tui.requestRender()
  }

  // -------------------------------------------------------------------------
  // Input

  handleInput(raw: string): void {
    if (this.done || this.disposedState) return
    // The one CC field owns paste/chord bytes and every ordinary editing key
    // while it is focused: Ctrl+A is line-start and Ctrl+F is char-right there,
    // never `modal.search`.
    if (this.mode === 'search') {
      if (this.search.editor.isPasting() || this.keymap.isPendingChord()) {
        this.search.handleKey(raw)
        return
      }
      const page = this.pageAction(raw)
      if (page !== undefined) {
        this.apply(page)
        return
      }
      // Esc/Enter/Ctrl+C arrive through the editor's dialog/app fallbacks and
      // are handled in the editor.onAction hook (leave the search / stay inert /
      // interrupt). Everything else is text.
      const draft = this.search.editor.getText()
      const result = this.search.handleKey(raw)
      // Enter is inert in a read-only catalog. CcEditor clears its buffer on
      // submit, so the query is put back unchanged instead of vanishing.
      if (result === 'submit' && draft !== '' && this.search.editor.getText() === '') {
        this.search.editor.replaceDraftText(draft)
      }
      return
    }
    // Browse layer: read-only catalog keys, `modal.search` and scrolling.
    const action = modalAction(this.keymap, raw, ['modal.search'])
    if (action !== undefined) this.apply(action)
    // Printable keys, Enter and digits stay inert in the read-only list.
  }

  /**
   * Page keys stay available inside the search field (a single-line query has
   * nothing to page). Resolved from effective bindings without chord state.
   */
  private pageAction(raw: string): ResolvedModalAction | undefined {
    for (const id of ['list.page-up', 'list.page-down']) {
      const binding = this.keymap.getBindings(id).find(entry => !entry.includes(' ') && matchesKey(raw, entry as KeyId))
      if (binding !== undefined) return { id, keys: [binding] }
    }
    return undefined
  }

  private apply(action: ResolvedModalAction): void {
    if (action.id === 'app.interrupt') {
      this.keymap.cancelChord()
      this.interrupt()
      return
    }
    if (action.id === 'modal.search') {
      this.enterSearch()
      return
    }
    if (isCloseAction(action.id)) {
      if (this.mode === 'search') {
        // Esc cancels the focused local layer (the search), not the surface.
        this.leaveSearch()
        return
      }
      this.close()
      return
    }
    const max = this.maxScroll()
    switch (action.id) {
      case 'list.previous':
        this.scroll = Math.max(0, this.scroll - 1)
        break
      case 'list.next':
        this.scroll = Math.min(max, this.scroll + 1)
        break
      case 'list.page-up':
        this.scroll = Math.max(0, this.scroll - this.viewport)
        break
      case 'list.page-down':
        this.scroll = Math.min(max, this.scroll + this.viewport)
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
    this.tui.requestRender()
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
  // Mouse

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposedState) return undefined
    const chrome = this.frame.handleMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.frame.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type !== 'wheel') return undefined
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return undefined
    this.scroll = Math.max(0, Math.min(this.maxScroll(), this.scroll + (delta < 0 ? -3 : 3)))
    return { handled: true, render: true }
  }

  // -------------------------------------------------------------------------
  // Rendering

  private filteredCommands(commands: readonly HelpCommand[], query: string): HelpCommand[] {
    if (query === '') return [...commands]
    return commands.filter(command =>
      matches(`${command.name}\n${command.description}\n${command.inputHint ?? ''}`, query))
  }

  private filteredSkills(skills: SkillCatalogSnapshot, query: string): readonly SkillCatalogEntry[] {
    const entries = skillEntries(skills)
    if (query === '') return entries
    return entries.filter(entry =>
      matches(`${entry.name}\n${entry.description ?? ''}\n${entry.whenToUse ?? ''}`, query))
  }

  /** The whole body, independent of the current window. */
  private bodyLines(width: number): string[] {
    const query = this.query().toLowerCase()
    const commands = this.filteredCommands(this.catalog.commands, query)
    const custom = this.filteredCommands(this.catalog.customCommands, query)
    const filtered = query !== ''
    let body: string[]
    if (width >= WIDE_MIN_COLUMNS) {
      const leftWidth = Math.floor((width - COLUMN_GAP) / 2)
      const rightWidth = width - COLUMN_GAP - leftWidth
      const left = sectionLines('Commands', commands, leftWidth, filtered ? 'No match.' : 'No commands are available.')
      const right = sectionLines('Custom commands', custom, rightWidth, filtered ? 'No match.' : 'No custom commands.')
      const rows = Math.max(left.length, right.length)
      body = Array.from({ length: rows }, (_, index) =>
        fit(padRight(left[index] ?? '', leftWidth) + ' '.repeat(COLUMN_GAP) + (right[index] ?? ''), width))
    } else {
      body = [
        ...sectionLines('Commands', commands, width, filtered ? 'No match.' : 'No commands are available.'),
        '',
        ...sectionLines('Custom commands', custom, width, filtered ? 'No match.' : 'No custom commands.'),
      ]
    }
    // No snapshot at all keeps the historical body exactly: the parent decides
    // whether this session even has a readable native skill catalog.
    const skills = this.catalog.skills
    if (skills !== undefined) {
      body.push('', ...skillSectionLines(skills, width, this.filteredSkills(skills, query), filtered))
    }
    // A query that removes every row is a search result, never an empty native
    // catalog. Availability notices above stay visible either way.
    const commandRows = commands.length + custom.length
    const skillRows = skills === undefined || skills.available !== true ? 0 : this.filteredSkills(skills, query).length
    if (filtered && commandRows === 0 && skillRows === 0) body.unshift(fit(t.muted(NO_MATCH(oneLine(this.search.text))), width), '')
    return body
  }

  /**
   * Highest line offset the window can reach. It must be derived from the same
   * body width the render paints (`lastBodyWidth`), never from the frame width:
   * the frame width drops four columns of chrome, so wrapping there yields fewer
   * rows and End would stop above the real tail while the status still said
   * `N/N`. Before the first paint there is no measured window at all, so the
   * offset stays 0 and the first render clamps it against freshly measured
   * geometry.
   */
  private maxScroll(): number {
    if (this.lastBodyWidth <= 0) return 0
    return Math.max(0, this.bodyLines(this.lastBodyWidth).length - this.viewport)
  }

  private noteLines(width: number): string[] {
    const note = sanitize(typeof this.catalog.note === 'string' ? this.catalog.note : '')
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

  private baseOptions(): ModalFrameOptions {
    return {
      title: 'Help',
      ownerKey: `help:${this.mode}:${this.query()}`,
      actions: [
        {
          id: 'search',
          label: 'Search',
          action: 'modal.search',
          onActivate: () => this.enterSearch(),
        },
        { id: 'close', label: 'Close', action: 'list.cancel', onActivate: () => this.close() },
      ],
      onClose: () => this.close(),
      maxHeight: modalHeight(this.tui, this.modalSize),
      keymap: this.keymap,
    }
  }

  private chromeLines(bodyWidth: number): string[] {
    const lines: string[] = []
    const note = this.noteLines(bodyWidth)
    lines.push(...note)
    if (this.mode === 'search') {
      const prefix = ` ${dim('Find')} `
      const fieldWidth = Math.max(4, bodyWidth - visibleWidth(prefix))
      const field = this.search.render(fieldWidth, this.focusedState, 'search commands and skills')
      field.slice(0, MAX_QUERY_ROWS).forEach((line, index) => {
        const lead = index === 0 ? prefix : ' '.repeat(visibleWidth(prefix))
        lines.push(fit(lead + line, bodyWidth))
      })
      lines.push('')
    } else {
      lines.push('')
    }
    return lines
  }

  /**
   * One status line for the window actually painted. `total` and `viewport` are
   * the body rows and body height of this render, not a re-measurement at the
   * frame width: the reported window must never disagree with the visible slice.
   */
  private statusText(total: number, viewport: number): string {
    const query = this.query()
    const filtered = query !== ''
    const commands = this.filteredCommands(this.catalog.commands, query).length
    const custom = this.filteredCommands(this.catalog.customCommands, query).length
    const parts = [
      `${commands} command${commands === 1 ? '' : 's'}`,
      `${custom} custom`,
    ]
    const skills = this.catalog.skills
    if (skills !== undefined) {
      if (skills.available !== true) parts.push('skills unavailable')
      else parts.push(`${this.filteredSkills(skills, query).length} skill${this.filteredSkills(skills, query).length === 1 ? '' : 's'}`)
    }
    if (filtered) parts.push(`filter "${oneLine(this.search.text)}"`)
    if (total > viewport) parts.push(`${Math.min(this.scroll + 1, total)}-${Math.min(this.scroll + viewport, total)}/${total}`)
    return parts.join(' · ')
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, Math.floor(width))
    const base = this.baseOptions()
    const bodyWidth = this.frame.measure(safeWidth, base).bodyWidth
    // The status line is one row in both probes: measuring with a spacer first
    // keeps the reported window and the painted body in the same frame (no
    // one-render lag between the scroll indicator and the visible slice).
    const probe: ModalFrameOptions = {
      ...base,
      before: this.chromeLines(bodyWidth),
      after: [fit(' ', bodyWidth)],
    }
    const geometry = this.frame.measure(safeWidth, probe)
    this.viewport = Math.max(1, geometry.bodyHeight)
    // The window, the status line and the painted slice all use this exact body
    // budget. Laying the body out at the frame width instead would wrap fewer
    // rows, so `maxScroll` would stop short of the true tail (the last command
    // or skill stayed clipped below the frame while the footer claimed N/N).
    this.lastBodyWidth = bodyWidth
    const body = this.bodyLines(bodyWidth)
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - this.viewport)))
    const options: ModalFrameOptions = {
      ...probe,
      after: [fit(` ${t.subtle(this.statusText(body.length, this.viewport))}`, bodyWidth)],
    }
    const painted = renderModalBody(this.frame, safeWidth, options, () =>
      textPaint(body.slice(this.scroll, this.scroll + this.viewport)) as BodyPaint)
    return painted.lines
  }
}