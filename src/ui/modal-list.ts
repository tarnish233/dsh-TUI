/**
 * Shared body plumbing for **list-style** modal surfaces.
 *
 * `SettingsDialog` and `KeybindingsDialog` are the same shape: one bounded
 * `ModalFrame`, some already-rendered header rows (search field / category
 * chips / config path), a windowed list of selectable rows, one status row and
 * a footer of actions. This module owns exactly that repeated part:
 *
 * - `windowList` turns grouped row blocks into the painted window **and** the
 *   `HitRange`s for the same rows, so a click can never point at a clipped row.
 * - `ModalListSurface` measures the frame first (from the same options used for
 *   the render), builds the body to that exact inner size, shrinks an
 *   under-filled frame to its content, paints header/status rows and translates
 *   body/header mouse coordinates.
 * - `rowMouse` is the one modal-list press/click policy: a press is pinned by
 *   row identity plus the owner key the chrome already uses, a plain click
 *   still resolves the painted row, and a vanished/moved/owner-changed row
 *   voids the gesture.
 *
 * It deliberately stays a helper, not a second component framework: no editor,
 * no keymap context routing, no native state, no terminal writing. Callers keep
 * their own selection state, mode machine, rendering of rows and action chips.
 *
 * Mouse vocabulary: modal lists use `HitRange` rows (the same type the chooser
 * surfaces use and resolve with `bodyHitAt`). `HitboxRegistry` stays the
 * transcript/tool/thinking layer, where a component owns persistent hover and
 * nested child dispatch. A modal list has neither, so it must not instantiate a
 * second, competing hitbox registry just to get click pinning.
 */
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { CcKeymap } from '../input/index.ts'
import { bodyHitAt, type HitRange } from './dialogs.ts'
import {
  ModalFrame,
  modalHeight,
  type ModalAction,
  type ModalFrameOptions,
  type ModalGeometry,
  type ModalSize,
} from './modal.ts'
import { t } from './theme.ts'
import { wrap } from './text.ts'

/** One painted block: a selectable row or a non-selectable header/note. */
export interface ListBlock {
  readonly lines: readonly string[]
  /** The focused (selected) row block. At most one per list. */
  readonly focused?: boolean
  /** Selectable row index this block paints; omitted = header/note. */
  readonly index?: number
  /** Stable row identity (native id), used to pin a press to its row. */
  readonly key?: string
}

/** Painted body lines plus the row range every selectable block occupies. */
export interface ListWindow {
  /** First painted block index (the preferred/probed start, after clamping). */
  readonly start: number
  /** One past the last painted block index. */
  readonly end: number
  readonly lines: string[]
  /** Painted row -> selectable row index (undefined for header/note rows). */
  readonly rows: Array<number | undefined>
  readonly hits: HitRange[]
}

export interface ListWindowOptions {
  /** Preferred first visible block (a restored scroll offset). */
  readonly start?: number
  /**
   * Center the focused block in the window instead of only keeping it visible.
   * Short value pickers use it so Enter can never apply an unseen row.
   */
  readonly center?: boolean
}

const lineCount = (blocks: readonly ListBlock[]): number =>
  blocks.reduce((total, block) => total + block.lines.length, 0)

/** First block whose line range contains `line` (clamped to the last block). */
function blockAtLine(blocks: readonly ListBlock[], line: number): number {
  let top = 0
  for (const [index, block] of blocks.entries()) {
    const bottom = top + block.lines.length
    if (line < bottom) return index
    top = bottom
  }
  return Math.max(0, blocks.length - 1)
}

/** Which blocks fit the budget while keeping the focused block visible. */
function windowRange(blocks: readonly ListBlock[], budget: number, options: ListWindowOptions): { start: number; end: number } {
  if (blocks.length === 0 || budget <= 0) return { start: 0, end: 0 }
  if (lineCount(blocks) <= budget) return { start: 0, end: blocks.length }
  const found = blocks.findIndex(block => block.focused === true)
  const focus = found < 0 ? 0 : found
  let start: number
  if (options.center === true) {
    let top = 0
    for (let index = 0; index < focus; index += 1) top += blocks[index]!.lines.length
    const firstLine = Math.max(0, Math.min(top - Math.floor(budget / 2), Math.max(0, lineCount(blocks) - budget)))
    start = blockAtLine(blocks, firstLine)
  } else {
    // A restored scroll offset may start above the focus, never below it.
    start = Math.max(0, Math.min(Math.floor(options.start ?? 0), focus))
  }
  let end = start
  let used = 0
  while (end < blocks.length && used + blocks[end]!.lines.length <= budget) {
    used += blocks[end]!.lines.length
    end += 1
  }
  if (options.center !== true && focus >= end) {
    start = focus
    end = start
    used = 0
    while (end < blocks.length && used + blocks[end]!.lines.length <= budget) {
      used += blocks[end]!.lines.length
      end += 1
    }
  }
  // A single block taller than the budget is clipped by the caller, not hidden.
  if (end === start) end = Math.min(blocks.length, start + 1)
  // Backfilling may keep a header beside a tall focused row, but it must leave
  // at least one painted line for that row instead of pushing it out again.
  const backfillBudget = blocks[start]?.focused === true && blocks[start]!.lines.length > budget ? budget - 1 : budget
  while (start > 0 && used + blocks[start - 1]!.lines.length <= backfillBudget) {
    start -= 1
    used += blocks[start]!.lines.length
  }
  return { start, end }
}

/**
 * Paint the visible block window and report the row range of every selectable
 * row. Painted lines are clipped to the budget; a partially visible row keeps
 * only its visible row range, so hit testing and painting cannot disagree.
 */
export function windowList(blocks: readonly ListBlock[], budget: number, options: ListWindowOptions = {}): ListWindow {
  const { start, end } = windowRange(blocks, budget, options)
  const lines: string[] = []
  const rows: Array<number | undefined> = []
  const hits: HitRange[] = []
  for (let index = start; index < end; index += 1) {
    const block = blocks[index]!
    if (block.index !== undefined) {
      const first = lines.length
      const last = first + Math.min(block.lines.length, Math.max(0, budget - first)) - 1
      if (last >= first) {
        hits.push({
          startRow: first,
          endRow: last,
          index: block.index,
          ...(block.key === undefined ? {} : { key: block.key }),
        })
      }
    }
    for (const line of block.lines) {
      if (lines.length >= budget) break
      lines.push(line)
      rows.push(block.index)
    }
  }
  return { start, end, lines, rows, hits }
}

/** A body built for an exact inner size: painted lines plus their row hits. */
export interface ListBody {
  readonly lines: readonly string[]
  readonly hits?: readonly HitRange[]
}

export interface ModalListConfig {
  readonly title: string
  /** Stable owner identity: a mode + selected/edited row, never a status label. */
  readonly ownerKey?: string
  /**
   * Placeholder header-row count used for the measure pass, before the inner
   * width is known. It must equal the final `before` line count whenever that
   * count does not depend on width; a mismatch only leaves blank body rows.
   */
  readonly beforeRows: number
  /** Already-rendered header rows for the final frame inner width. */
  readonly before?: (bodyWidth: number) => readonly string[]
  /** Status/failure rows rendered above the footer. */
  readonly status?: (bodyWidth: number) => readonly string[]
  readonly actions?: readonly ModalAction[]
  readonly onClose?: () => void
  readonly keymap?: CcKeymap
}

export interface ModalListSurfaceOptions {
  /** Bounded modal height (defaults to the shared size budget). */
  readonly maxHeight?: number
  readonly size?: ModalSize
  /** Under-filled frames shrink to content but keep this usable minimum. */
  readonly minHeight?: number
}

const DEFAULT_MIN_HEIGHT = 8

/** Saving/saved/failure row shared by every list surface. */
export function listStatusLines(message: string, failed: boolean, width: number): string[] {
  if (message === '') return []
  const style = failed ? t.redSoft : message === 'Saving…' ? t.muted : t.green
  return wrap(style(message), Math.max(4, width - 1)).slice(0, 2).map(line => ' ' + line)
}

/** A single printable byte is text in a search field, never list navigation. */
export function isPrintableByte(data: string): boolean {
  return data.length === 1 && /[\x20-\x7e]/.test(data)
}

/** Resolve one key in a list context without leaking editors or global actions. */
export function resolveListAction(keymap: CcKeymap, data: string, context: 'settingsList' | 'keybindingsList'): { id: string; keys: string[] } | undefined {
  const resolution = keymap.resolve(data, context)
  return resolution.kind === 'action' ? { id: resolution.action.id, keys: [...resolution.keys] } : undefined
}

interface PressPin {
  readonly key: string
  readonly owner: string
  readonly x: number
  readonly y: number
}

/**
 * Frame + body composition for a modal list.
 *
 * Geometry is measured first from the same options used for the render, the
 * body is built to that exact inner size, and every ordinary body line is
 * expected to be width-safe already (the frame clips it).
 */
export class ModalListSurface {
  private readonly frame = new ModalFrame()
  private readonly tui: Pick<TUI, 'terminal'>
  private readonly options: ModalListSurfaceOptions
  private geometry?: ModalGeometry
  private beforeCount = 0
  private hits: readonly HitRange[] = []
  private press?: PressPin

  constructor(tui: Pick<TUI, 'terminal'>, options: ModalListSurfaceOptions = {}) {
    this.tui = tui
    this.options = options
  }

  /** Last painted frame geometry (body rect and offset). */
  get bodyGeometry(): ModalGeometry | undefined {
    return this.geometry
  }

  /** Row hits for the last painted body. */
  get bodyHits(): readonly HitRange[] {
    return this.hits
  }

  invalidate(): void {
    this.frame.invalidate()
    this.geometry = undefined
    this.beforeCount = 0
    this.hits = []
    this.press = undefined
  }

  /** Bounded height; a test/standalone host without terminal rows stays open. */
  private heightCap(): number {
    const rows = this.tui.terminal?.rows
    if (!Number.isFinite(rows) || rows <= 0) return 200
    return Math.max(1, Math.floor(this.options.maxHeight ?? modalHeight(this.tui, this.options.size)))
  }

  /**
   * Measure, build the body for the measured inner size, shrink an under-filled
   * frame to its content and render. `build` may be called twice (once at the
   * cap to learn the content height); it must be a pure function of
   * width/height plus the caller's own view state.
   */
  render(width: number, config: ModalListConfig, build: (bodyWidth: number, bodyHeight: number) => ListBody): string[] {
    const size = Math.max(1, Math.floor(width))
    const cap = this.heightCap()
    const optionsFor = (height: number, before?: readonly string[], status?: readonly string[]): ModalFrameOptions => ({
      title: config.title,
      ...(config.ownerKey === undefined ? {} : { ownerKey: config.ownerKey }),
      before: before ?? new Array<string>(Math.max(0, config.beforeRows)).fill(''),
      ...(status === undefined ? {} : { after: status }),
      ...(config.actions === undefined ? {} : { actions: config.actions }),
      ...(config.onClose === undefined ? {} : { onClose: config.onClose }),
      maxHeight: height,
      ...(config.keymap === undefined ? {} : { keymap: config.keymap }),
    })
    const layoutFor = (height: number) => {
      const base = this.frame.measure(size, optionsFor(height))
      const before = config.before?.(base.bodyWidth) ?? new Array<string>(Math.max(0, config.beforeRows)).fill('')
      const status = config.status?.(base.bodyWidth) ?? []
      const options = optionsFor(height, before, status)
      return { geometry: this.frame.measure(size, options), before, status, options }
    }
    // Header AND status rows are real chrome in both passes. Measuring without
    // status can clip the focused row when a short frame gains Saving…/error.
    const capLayout = layoutFor(cap)
    const tentative = build(capLayout.geometry.bodyWidth, capLayout.geometry.bodyHeight)
    const chrome = cap - capLayout.geometry.bodyHeight
    const minHeight = Math.max(1, Math.floor(this.options.minHeight ?? DEFAULT_MIN_HEIGHT))
    const height = Math.max(Math.min(cap, minHeight), Math.min(cap, tentative.lines.length + chrome))
    const painted = height === cap ? capLayout : layoutFor(height)
    const geometry = painted.geometry
    this.geometry = geometry
    const body = height === cap ? tentative : build(geometry.bodyWidth, geometry.bodyHeight)
    this.beforeCount = painted.before.length
    this.hits = body.hits ?? []
    return this.frame.render(size, body.lines.slice(0, geometry.bodyHeight), painted.options)
  }

  /** Chrome-only mouse handling (close affordance, action chips). */
  chromeMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.frame.handleMouse(event)
  }

  /** Translate a mouse event into body-local coordinates, if it is in the body. */
  bodyMouse(event: TuiMouseEvent): TuiMouseEvent | undefined {
    try {
      const translated = this.frame.bodyMouse(event)
      if (translated !== undefined) return translated
    } catch {
      // Fall through to the geometry-based translation below.
    }
    const geometry = this.geometry
    if (geometry === undefined) return undefined
    if (event.x < geometry.bodyCol || event.x >= geometry.bodyCol + geometry.bodyWidth) return undefined
    if (event.y < geometry.bodyRow || event.y >= geometry.bodyRow + geometry.bodyHeight) return undefined
    return { ...event, x: event.x - geometry.bodyCol, y: event.y - geometry.bodyRow }
  }

  /**
   * Index of a painted `before` line under a component-local row, derived from
   * the measured frame geometry (title row, header rows, separator).
   */
  beforeIndex(y: number): number | undefined {
    const geometry = this.geometry
    if (geometry === undefined || this.beforeCount === 0) return undefined
    const separator = geometry.bodyCol > 0 ? 1 : 0
    const first = geometry.bodyRow - this.beforeCount - separator
    const index = y - first
    return index >= 0 && index < this.beforeCount ? index : undefined
  }

  /**
   * Shared modal-list mouse policy for selectable rows.
   *
   * - A press over a row claims the gesture and pins that row's identity plus
   *   the caller's owner key (the same key the chrome uses).
   * - A click runs the pressed row even if a repaint moved it, but only while
   *   its identity/owner/coordinates are unchanged and the row still exists.
   * - A click without a recorded press resolves the row currently painted
   *   under the pointer (settings/keyboard click tests and native synthesized
   *   clicks after selection drags).
   * - Drag, a new press, a vanished row, a different row under the pointer or a
   *   changed owner voids the pin; motion never becomes a click.
   */
  rowMouse(event: TuiMouseEvent, owner: string, onClick: (hit: HitRange) => void): TuiMouseEventResult | undefined {
    const body = this.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'press') {
      if (event.button !== 'left') return undefined
      const hit = this.hitAt(body.y)
      this.press = hit?.key === undefined ? undefined : { key: hit.key, owner, x: body.x, y: body.y }
      // Pinning is invisible. Without an explicit false the native renderer
      // treats every claimed press as a repaint, then paints again on click.
      return hit === undefined ? undefined : { handled: true, render: false }
    }
    if (event.type === 'drag') {
      this.press = undefined
      return undefined
    }
    if (event.type !== 'click' || event.button !== 'left') return undefined
    const pressed = this.press
    this.press = undefined
    if (pressed !== undefined) {
      const sameGesture = pressed.owner === owner && pressed.x === body.x && pressed.y === body.y
      const box = sameGesture ? this.hits.find(hit => hit.key === pressed.key) : undefined
      if (box === undefined) return { handled: true, render: false }
      onClick(box)
      return { handled: true, render: true }
    }
    const hit = this.hitAt(body.y)
    if (hit === undefined) return undefined
    onClick(hit)
    return { handled: true, render: true }
  }

  private hitAt(row: number): HitRange | undefined {
    return bodyHitAt(this.hits, row)
  }
}