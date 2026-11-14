/**
 * Read-only **native inventory** summary: Loader plugin entries, the active
 * Agent's tool catalog and the session's mounted capability names.
 *
 * DSH owns every fact here. This surface is a whitelisted projection of the
 * inspection adapter (`src/backend/native-inspection.ts`):
 *
 * - plugin entry: `entryId`, `moduleName`, `enabled`, `fiberPhase` — nothing
 *   else. Package metadata, `!!js` condition expressions, diagnostics text,
 *   profile/config values, credentials and host paths are never painted, and a
 *   failed phase is a lifecycle word, not an exception message.
 * - tool: `name`, `deferredLoading` and (on the selected row only) the
 *   adapter's bounded, control-stripped `description`. Tool parameters,
 *   schemas, executor identity and any argument are not part of this surface.
 * - capability: the exact native capability name from `SessionInfo`.
 *
 * There is no mutation, no refresh timer and no polling: the parent re-reads on
 * `native_ui_changed` (`domain: 'inventory' | 'tools'`) and calls
 * `setReads()`. `available: false` is painted as one honest line per section
 * with the adapter's reason code — never as "none mounted". `complete: false`
 * marks that section `incomplete`.
 *
 * Chrome, list windowing, height shrinking and hit testing come from the shared
 * `ModalListSurface`/`windowList`; input is resolved once through the shared
 * `modalList` keymap context (`modalAction`), so navigation and Esc follow the
 * user's real bindings with no second editor, raw stdin listener or hardcoded
 * shortcut label. Enter and printables are inert because the surface is
 * read-only. No stdout writes.
 *
 * @module dsh-tui/ui/native-inspection-dialog
 */
import {
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type {
  PluginEntryView,
  PluginInventoryRead,
  PluginInventorySnapshot,
  ToolCatalogRead,
  ToolCatalogSnapshot,
} from '../backend/native-inspection.ts'
import { createCcKeymap, type CcKeymap } from '../input/index.ts'
import { isInterruptKey, modalAction } from './dialogs.ts'
import {
  ModalListSurface,
  windowList,
  type ListBlock,
  type ListBody,
} from './modal-list.ts'
import { CLOSE_ACTIONS, type ModalAction, type ModalSize } from './modal.ts'
import { fit, oneLine, sanitize, truncateToWidth, visibleWidth, wrap } from './text.ts'
import { bold, dim, t } from './theme.ts'

/** One parent refresh: three independent native reads. */
export interface NativeInspectionReads {
  readonly plugins?: PluginInventoryRead
  readonly tools?: ToolCatalogRead
  /** `SessionInfo.capabilities` in native order (informational names only). */
  readonly capabilities?: readonly string[]
}

/** Ephemeral restore record; never a native inventory fact. */
export interface InspectionViewState {
  /** Stable row key (`plugin:<entryId>`, `tool:<name>`, `capability:<name>`). */
  readonly selectedKey?: string
  readonly scroll: number
}

export interface NativeInspectionDialogOptions {
  /** Initial reads; `getReads` wins when supplied. */
  reads?: NativeInspectionReads
  /** Live reads re-sampled on every paint; never cached as truth. */
  getReads?: () => NativeInspectionReads | undefined
  /** Parent's read flag, so "not read yet" never looks like "none mounted". */
  loading?: boolean
  /** Restore the selected row/scroll when the parent reopens this modal. */
  initialState?: InspectionViewState
  /** Shared keymap; defaults to the CC defaults for tests/standalone hosts. */
  keymap?: CcKeymap
  maxHeight?: number
  onClose: () => void
  /**
   * Explicit native interrupt (a configured `app.interrupt`, no shipped
   * default); defaults to closing. Default Ctrl+C is the local cancel.
   */
  onInterrupt?: () => void
  /** Optional repaint hook for hosts that own rendering. */
  onRenderRequest?: () => void
}

/** One selectable inventory row, already width-safe. */
interface InspectionRow {
  readonly key: string
  readonly kind: 'plugin' | 'tool' | 'capability'
  readonly plugin?: PluginEntryView
  readonly toolName?: string
  readonly toolDescription?: string
  readonly deferred?: boolean
  readonly capability?: string
}

interface InspectionSection {
  readonly title: string
  readonly rows: readonly InspectionRow[]
  /** Honest per-section state line(s); never an empty authoritative list. */
  readonly notes: readonly string[]
}

const phaseLabel = (phase: unknown): string => {
  if (phase === null || phase === undefined) return 'no fiber'
  const text = oneLine(sanitize(String(phase)), 40)
  return text === '' ? 'no fiber' : text
}

const reasonLabel = (reason: unknown): string => {
  const text = oneLine(sanitize(String(reason ?? '')), 40)
  return text === '' ? 'native-failed' : text
}

/** True when a read answered with a snapshot the UI may display. */
function isAvailable<T extends { readonly available: boolean }>(read: T | undefined): read is T & { readonly available: true } {
  return read !== undefined && read.available === true
}

export class NativeInspectionDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap

  private readonly tui: TUI
  private readonly options: NativeInspectionDialogOptions
  private readonly list: ModalListSurface
  private reads: NativeInspectionReads | undefined
  private reading: boolean
  private selectedKey: string | undefined
  private selectedIndex = 0
  private windowStart = 0
  private focusedState = false
  private done = false
  private disposed = false

  constructor(tui: TUI, options: NativeInspectionDialogOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.reads = options.reads
    this.reading = options.loading === true
    this.selectedKey = options.initialState?.selectedKey
    this.windowStart = Number.isFinite(options.initialState?.scroll)
      ? Math.max(0, Math.floor(options.initialState?.scroll as number))
      : 0
    this.list = new ModalListSurface(tui, {
      size: this.modalSize,
      ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
    })
  }

  // -------------------------------------------------------------------------
  // Parent surface

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.keymap.cancelChord()
    this.focusedState = value
  }

  get isDone(): boolean {
    return this.done
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Replace the reads (repeatable; keeps the selected row key). */
  setReads(reads: NativeInspectionReads | undefined): void {
    if (this.done || this.disposed) return
    this.reads = reads
    this.reconcile()
    this.repaint()
  }

  setLoading(loading: boolean): void {
    if (this.done || this.disposed || this.reading === loading) return
    this.reading = loading
    this.list.invalidate()
    this.repaint()
  }

  /** Ephemeral restore record for the parent. */
  captureView(): InspectionViewState {
    return {
      ...(this.selectedKey === undefined ? {} : { selectedKey: this.selectedKey }),
      scroll: this.windowStart,
    }
  }

  private readsValue(): NativeInspectionReads | undefined {
    return this.options.getReads === undefined ? this.reads : this.options.getReads()
  }

  invalidate(): void {
    this.list.invalidate()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.focusedState) this.keymap.cancelChord()
  }

  private close(): void {
    if (this.done) return
    this.done = true
    this.keymap.cancelChord()
    this.options.onClose()
  }

  private interrupt(): void {
    this.keymap.cancelChord()
    if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
    else this.close()
  }

  private repaint(): void {
    try {
      this.tui.requestRender()
    } catch {
      // A closing host may already have torn the renderer down.
    }
    this.options.onRenderRequest?.()
  }

  // -------------------------------------------------------------------------
  // Rows (native order, deduplicated stable keys)

  private sections(): readonly InspectionSection[] {
    const reads = this.readsValue() ?? {}
    const sections: InspectionSection[] = []

    const plugins = reads.plugins
    if (plugins === undefined) {
      sections.push({ title: 'Plugins', rows: [], notes: ['Native plugin inventory is not available in this snapshot.'] })
    } else if (!isAvailable(plugins)) {
      sections.push({ title: 'Plugins', rows: [], notes: [`Native plugin inventory is unavailable (${reasonLabel(plugins.reason)}).`] })
    } else {
      const snapshot = plugins as PluginInventorySnapshot
      const rows: InspectionRow[] = []
      const seen = new Map<string, number>()
      for (const entry of Array.isArray(snapshot.entries) ? snapshot.entries : []) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.entryId !== 'string' || entry.entryId === '') continue
        const occurrence = seen.get(entry.entryId) ?? 0
        seen.set(entry.entryId, occurrence + 1)
        const key = occurrence === 0 ? `plugin:${entry.entryId}` : `plugin:${entry.entryId}#${occurrence}`
        rows.push({ key, kind: 'plugin', plugin: entry })
      }
      const summary = snapshot.summary
      const parts = [`Plugins · ${rows.length}`]
      if (summary !== undefined && Number.isFinite(summary.failed) && summary.failed > 0) parts.push(`${summary.failed} failed`)
      if (summary !== undefined && Number.isFinite(summary.disabled) && summary.disabled > 0) parts.push(`${summary.disabled} disabled`)
      if (snapshot.complete === false) parts.push('incomplete')
      sections.push({ title: parts.join(' · '), rows, notes: [] })
    }

    const capabilities = reads.capabilities
    if (capabilities === undefined) {
      sections.push({ title: 'Capabilities', rows: [], notes: ['No native capability list in this snapshot.'] })
    } else {
      const rows: InspectionRow[] = []
      const seen = new Map<string, number>()
      for (const name of capabilities) {
        if (typeof name !== 'string' || name === '') continue
        const occurrence = seen.get(name) ?? 0
        seen.set(name, occurrence + 1)
        const key = occurrence === 0 ? `capability:${name}` : `capability:${name}#${occurrence}`
        rows.push({ key, kind: 'capability', capability: name })
      }
      sections.push({ title: `Capabilities · ${rows.length}`, rows, notes: [] })
    }

    const tools = reads.tools
    if (tools === undefined) {
      sections.push({ title: 'Tools', rows: [], notes: ['The native tool catalog is not available in this snapshot.'] })
    } else if (!isAvailable(tools)) {
      sections.push({ title: 'Tools', rows: [], notes: [`The native tool catalog is unavailable (${reasonLabel(tools.reason)}).`] })
    } else {
      const snapshot = tools as ToolCatalogSnapshot
      const rows: InspectionRow[] = []
      const seen = new Map<string, number>()
      for (const tool of Array.isArray(snapshot.tools) ? snapshot.tools : []) {
        if (tool === null || typeof tool !== 'object') continue
        if (typeof tool.name !== 'string' || tool.name === '') continue
        const occurrence = seen.get(tool.name) ?? 0
        seen.set(tool.name, occurrence + 1)
        const key = occurrence === 0 ? `tool:${tool.name}` : `tool:${tool.name}#${occurrence}`
        rows.push({
          key, kind: 'tool', toolName: tool.name,
          ...(typeof tool.description === 'string' ? { toolDescription: tool.description } : {}),
          ...(tool.deferredLoading === true ? { deferred: true } : {}),
        })
      }
      const parts = [`Tools · ${rows.length}`]
      if (snapshot.complete === false) parts.push('incomplete')
      sections.push({ title: parts.join(' · '), rows, notes: [] })
    }

    return sections
  }

  /** Flattened selectable rows in painted order (section headers excluded). */
  private rows(): readonly InspectionRow[] {
    return this.sections().flatMap(section => section.rows)
  }

  private reconcile(): void {
    const rows = this.rows()
    if (rows.length === 0) {
      this.selectedKey = undefined
      this.selectedIndex = 0
      return
    }
    if (this.selectedKey !== undefined) {
      const found = rows.findIndex(row => row.key === this.selectedKey)
      if (found >= 0) {
        this.selectedIndex = found
        return
      }
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, rows.length - 1))
    this.selectedKey = rows[this.selectedIndex]?.key
  }

  private move(delta: number): void {
    const rows = this.rows()
    if (rows.length === 0) return
    const from = Math.max(0, Math.min(this.selectedIndex, rows.length - 1))
    const next = ((from + delta) % rows.length + rows.length) % rows.length
    this.selectedIndex = next
    this.selectedKey = rows[next]?.key
    if (next < this.windowStart) this.windowStart = next
    this.repaint()
  }

  private moveTo(index: number): void {
    const rows = this.rows()
    if (rows.length === 0) return
    this.selectedIndex = Math.max(0, Math.min(index, rows.length - 1))
    this.selectedKey = rows[this.selectedIndex]?.key
    if (this.selectedIndex < this.windowStart) this.windowStart = this.selectedIndex
    this.repaint()
  }

  // -------------------------------------------------------------------------
  // Input (one shared keymap resolution; read-only)

  handleInput(raw: string): void {
    if (this.done || this.disposed) return
    if (isInterruptKey(this.keymap, raw)) {
      this.interrupt()
      return
    }
    const action = modalAction(this.keymap, raw)
    if (action === undefined) return
    switch (action.id) {
      case 'list.previous': this.move(-1); return
      case 'list.next': this.move(1); return
      case 'list.page-up': this.move(-5); return
      case 'list.page-down': this.move(5); return
      case 'list.first': this.moveTo(0); return
      case 'list.last': this.moveTo(this.rows().length - 1); return
      case 'list.select':
      case 'dialog.confirm': return // read-only: Enter has no action
      default:
        if (CLOSE_ACTIONS.has(action.id)) this.close()
        // Every other global/app action stays inert inside this modal.
        return
    }
  }

  // -------------------------------------------------------------------------
  // Rendering

  private frameActions(): ModalAction[] {
    return [{ id: 'close', label: 'close', action: 'list.cancel', onActivate: () => this.close() }]
  }

  private headerLine(width: number): string {
    const reads = this.readsValue()
    const parts = ['Native inventory']
    // Counts appear only for a read that actually answered; an unavailable
    // section never looks like an authoritative zero.
    if (reads?.plugins !== undefined && isAvailable(reads.plugins)) parts.push(`plugins ${reads.plugins.entries.length}`)
    if (reads?.tools !== undefined && isAvailable(reads.tools)) parts.push(`tools ${reads.tools.tools.length}`)
    if (reads?.capabilities !== undefined) parts.push(`capabilities ${reads.capabilities.length}`)
    return fit(dim(parts.join(' · ')), width)
  }

  private statusLines(width: number): string[] {
    if (this.reading) return [fit(` ${t.muted('Reading native inventory…')}`, width)]
    const reads = this.readsValue()
    if (reads === undefined) return [fit(` ${t.muted('Native inventory has not been read in this session.')}`, width)]
    const sections = this.sections()
    if (sections.every(section => section.rows.length === 0 && section.notes.length === 0)) {
      return [fit(` ${t.muted('No native plugins, capabilities or tools are mounted.')}`, width)]
    }
    return []
  }

  private rowText(row: InspectionRow, width: number, focused: boolean): string[] {
    const lines: string[] = []
    if (row.kind === 'plugin') {
      const plugin = row.plugin
      const enabled = plugin?.enabled === true
      const marker = enabled ? t.green('☑') : t.muted('☐')
      const moduleName = oneLine(sanitize(typeof plugin?.moduleName === 'string' ? plugin.moduleName : ''), 200)
      const name = moduleName === '' ? '(unnamed module)' : moduleName
      const phase = phaseLabel(plugin?.fiberPhase)
      const tone = plugin?.fiberPhase === 'failed' ? t.redSoft : plugin?.fiberPhase === 'active' ? t.green : t.muted
      const prefix = `${focused ? t.accentBright('❯') : ' '} ${marker} `
      const suffix = ` · ${phase}`
      const room = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix))
      const body = truncateToWidth(name, room, '…')
      lines.push(fit(prefix + (focused ? bold(t.accentBright(body)) : t.text(body)) + tone(dim(suffix)), width))
      if (focused) {
        const entryId = oneLine(sanitize(typeof plugin?.entryId === 'string' ? plugin.entryId : ''), 160)
        if (entryId !== '') lines.push(fit(`    ${dim('entry ' + entryId)}`, width))
      }
      return lines
    }
    if (row.kind === 'tool') {
      const name = oneLine(sanitize(row.toolName ?? ''), 120)
      const parts = [`${focused ? t.accentBright('❯') : ' '} ${dim('·')} ${focused ? bold(t.accentBright(name)) : t.text(name)}`]
      if (row.deferred === true) parts.push(dim(' · deferred'))
      lines.push(fit(parts.join(''), width))
      if (focused) {
        const description = oneLine(sanitize(row.toolDescription ?? ''), 400)
        if (description !== '') lines.push(fit(`    ${dim(truncateToWidth(description, Math.max(1, width - 4), '…'))}`, width))
      }
      return lines
    }
    const capability = oneLine(sanitize(row.capability ?? ''), 160)
    lines.push(fit(`${focused ? t.accentBright('❯') : ' '} ${dim('·')} ${focused ? bold(t.accentBright(capability)) : t.text(capability)}`, width))
    return lines
  }

  private buildBody(width: number, height: number): ListBody {
    if (height <= 0) return { lines: [] }
    const rows = this.rows()
    this.reconcile()
    const sections = this.sections()
    if (rows.length === 0 && sections.every(section => section.notes.length === 0)) return { lines: [] }
    const blocks: ListBlock[] = []
    let index = 0
    for (const section of sections) {
      if (section.rows.length === 0 && section.notes.length === 0) continue
      blocks.push({ lines: [fit(dim(section.title), width)] })
      for (const note of section.notes) {
        blocks.push({ lines: wrap(`  ${t.muted(note)}`, Math.max(4, width)).slice(0, 2).map(line => fit(line, width)) })
      }
      for (const row of section.rows) {
        const focused = index === this.selectedIndex
        blocks.push({ lines: this.rowText(row, width, focused), ...(focused ? { focused: true } : {}), index, key: row.key })
        index += 1
      }
    }
    const window = windowList(blocks, height, { start: this.windowStart })
    this.windowStart = window.start
    return { lines: window.lines, hits: window.hits }
  }

  render(width: number): string[] {
    if (this.done || this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    return this.list.render(size, {
      title: 'Inventory',
      ownerKey: `inventory:${this.selectedKey ?? ''}`,
      beforeRows: 1,
      before: bodyWidth => [this.headerLine(bodyWidth)],
      status: bodyWidth => this.statusLines(bodyWidth),
      actions: this.frameActions(),
      onClose: () => this.close(),
      keymap: this.keymap,
    }, (bodyWidth, bodyHeight) => this.buildBody(bodyWidth, bodyHeight))
  }

  // -------------------------------------------------------------------------
  // Mouse (selection only; read-only rows have no action)

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done || this.disposed) return undefined
    const chrome = this.list.chromeMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.list.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'wheel') {
      this.move((event.wheelDelta ?? 0) < 0 ? -1 : 1)
      return { handled: true, render: true }
    }
    return this.list.rowMouse(event, `inventory:${this.selectedKey ?? ''}`, hit => {
      const index = hit.index
      if (index === undefined) return
      const row = this.rows()[index]
      if (row === undefined) return
      this.selectedIndex = index
      this.selectedKey = row.key
      this.repaint()
    })
  }
}