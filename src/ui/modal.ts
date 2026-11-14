/** Shared popup chrome. It owns no editor, native request or terminal writer. */
import type { OverlayOptions, TUI, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { CcKeymap } from '../input/index.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import { fit, oneLine, sanitize, truncateToWidth, visibleWidth, wrap } from './text.ts'
import { bold, cc, surfaces, t } from './theme.ts'

export type ModalSize = 'compact' | 'standard' | 'wide'

export interface ModalAction {
  id: string
  label: string
  action?: string
  onActivate?: () => void
  disabled?: boolean
}

export interface ModalFrameOptions {
  title: string
  /** Stable native/row identity for mutating footer actions, not a status label. */
  ownerKey?: string
  subtitle?: string
  before?: readonly string[]
  after?: readonly string[]
  actions?: readonly ModalAction[]
  onClose?: () => void
  maxHeight?: number
  keymap?: CcKeymap
}

export interface ModalGeometry {
  width: number
  bodyWidth: number
  bodyHeight: number
  bodyRow: number
  bodyCol: number
}

interface ActionPaint {
  action: ModalAction
  text: string
  row: number
  col: number
}

interface FrameLayout extends ModalGeometry {
  height: number
  framed: boolean
  before: readonly string[]
  after: readonly string[]
  footer: readonly string[]
  actionPaints: readonly ActionPaint[]
  closeCol?: number
  title: string
}

/**
 * The dialog plate is a semantic surface, never a private color: it derives
 * from `surfaces.dialog`, which inherits the application canvas (the terminal
 * background). This used to be a hardcoded near-black hex literal, which is why
 * the Settings panel read as a black box over a transparent transcript that
 * paints no background at all. Every framed line is painted through
 * `surface.fill()` so the plate, its padding and its right edge all agree —
 * including after Pi's `truncateToWidth()` appends a full reset.
 */
const surface = surfaces.dialog
const graphicLine = (line: string): boolean => /\x1b(?:_G|\]1337;File=)/.test(line)
const whole = (value: number, minimum: number): number => Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : minimum

export function modalOverlayOptions(size: ModalSize = 'standard'): OverlayOptions {
  return {
    anchor: 'center',
    width: size === 'compact' ? 64 : size === 'wide' ? '96%' : 100,
    minWidth: 1,
    maxHeight: size === 'compact' ? 18 : '90%',
    margin: 1,
  }
}

export function modalHeight(tui: Pick<TUI, 'terminal'>, size: ModalSize = 'standard'): number {
  const rows = whole(tui.terminal.rows, 1)
  // Normal terminals keep a calm three-row margin on either side, leaving
  // the native status/footer readable. Tiny terminals spend less on chrome.
  const available = rows >= 18 ? rows - 6 : rows - 2
  return Math.max(1, Math.min(available, Math.floor(rows * 0.9), size === 'compact' ? 18 : Number.POSITIVE_INFINITY))
}

/**
 * The one modal close family: `list.cancel` (a list/dialog surface),
 * `dialog.cancel` (a focused dialog layer) and `app.cancel` (the global
 * fallback). Surfaces resolve these through the shared keymap, so a remap or a
 * disabled row has to change every surface at once — one shared set here instead
 * of a private copy per component.
 */
export const CLOSE_ACTIONS: ReadonlySet<string> = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])

/** `switch`-friendly form of {@link CLOSE_ACTIONS}. */
export const isCloseAction = (id: string): boolean => CLOSE_ACTIONS.has(id)

/** Never print a shortcut which is disabled or actually owned by interrupt. */
export function modalBinding(keymap: CcKeymap, actionId: string, excludeInterrupt = false): string | undefined {
  const interrupts = excludeInterrupt ? new Set(keymap.getBindings('app.interrupt')) : undefined
  return keymap.getBindings(actionId).find(binding => !interrupts?.has(binding))
}

function actionLabel(action: ModalAction, keymap?: CcKeymap): string {
  const binding = action.action === undefined || keymap === undefined ? undefined
    : modalBinding(keymap, action.action, action.action === 'list.cancel' || action.action === 'dialog.cancel')
  return (binding === undefined ? '' : sanitize(oneLine(binding, 80)) + ' ') + sanitize(oneLine(action.label, 100))
}

function footerLayout(width: number, actions: readonly ModalAction[], keymap?: CcKeymap): {
  lines: string[]; paints: ActionPaint[]
} {
  const lines: string[] = []
  const paints: ActionPaint[] = []
  let row = 0, col = 0, line = ''
  for (const action of actions) {
    const label = actionLabel(action, keymap)
    const text = width >= 3 ? '[' + truncateToWidth(label, width - 2, '…') + ']' : truncateToWidth(label, width, '')
    const length = visibleWidth(text)
    if (length === 0) continue
    if (col > 0 && col + 2 + length > width) {
      lines.push(line)
      row += 1; col = 0; line = ''
    }
    if (row >= 2) break
    if (col > 0) { line += '  '; col += 2 }
    paints.push({ action, text, row, col })
    line += text; col += length
  }
  if (line !== '') lines.push(line)
  return { lines, paints }
}

/** Clamp chrome before allocating body rows; never let a footer fall off-screen. */
function layout(width: number, options: ModalFrameOptions): FrameLayout {
  const size = whole(width, 1)
  const height = whole(options.maxHeight ?? 20, 1)
  const framed = size >= 8 && height >= 6
  const bodyCol = framed ? 2 : 0
  const bodyWidth = Math.max(1, size - (framed ? 4 : 0))
  const title = sanitize(oneLine(options.title, 240))
  const subtitle = options.subtitle === undefined ? [] : wrap(sanitize(oneLine(options.subtitle, 500)), bodyWidth).slice(0, 1)
  const before = [...subtitle, ...(options.before ?? [])]
  const after = [...(options.after ?? [])].slice(0, 2)
  const footer = footerLayout(bodyWidth, options.actions ?? [], options.keymap)
  if (!framed) {
    // The title and a usable action compete for the last row, not an empty box.
    const footerRows = height >= 3 ? Math.min(1, footer.lines.length) : 0
    const headerRows = height >= 2 ? 1 : 0
    const beforeRows = Math.min(before.length, Math.max(0, height - headerRows - footerRows - 1))
    return {
      width: size, height, framed, bodyWidth, bodyCol,
      bodyRow: headerRows + beforeRows,
      bodyHeight: Math.max(0, height - headerRows - beforeRows - footerRows),
      title, before: before.slice(0, beforeRows), after: [],
      footer: footer.lines.slice(0, footerRows),
      actionPaints: footer.paints.filter(paint => paint.row < footerRows),
    }
  }
  // Borders/title = 2 rows. Separators exist only for rendered header/footer.
  let beforeRows = before.length
  let afterRows = after.length
  let footerRows = footer.lines.length
  const chromeRows = (): number => 2 + beforeRows + (beforeRows > 0 ? 1 : 0)
    + afterRows + footerRows + (afterRows + footerRows > 0 ? 1 : 0)
  while (chromeRows() > height - 1) {
    if (afterRows > 0) afterRows -= 1
    else if (beforeRows > 1) beforeRows -= 1
    else if (footerRows > 1) footerRows -= 1
    else if (beforeRows > 0) beforeRows -= 1
    else if (footerRows > 0) footerRows -= 1
    else break
  }
  return {
    width: size, height, framed, bodyWidth, bodyCol,
    bodyRow: 1 + beforeRows + (beforeRows > 0 ? 1 : 0),
    bodyHeight: Math.max(1, height - chromeRows()),
    title, before: before.slice(0, beforeRows), after: after.slice(0, afterRows),
    footer: footer.lines.slice(0, footerRows),
    actionPaints: footer.paints.filter(paint => paint.row < footerRows),
    ...(options.onClose === undefined || size < 14 ? {} : { closeCol: size - 6 }),
  }
}

export class ModalFrame {
  private readonly hitboxes = new HitboxRegistry()
  private geometry?: FrameLayout
  private hovered?: string
  private chrome: readonly MouseHitbox[] = []
  private ownerKey?: string
  private press?: { id?: string; invalidated: boolean }

  measure(width: number, options: ModalFrameOptions): ModalGeometry {
    const value = layout(width, options)
    return { width: value.width, bodyWidth: value.bodyWidth, bodyHeight: value.bodyHeight, bodyRow: value.bodyRow, bodyCol: value.bodyCol }
  }

  render(width: number, body: readonly string[], options: ModalFrameOptions): string[] {
    const value = layout(width, options)
    const ownerKey = options.ownerKey ?? options.title
    if (this.press !== undefined && this.ownerKey !== undefined && this.ownerKey !== ownerKey) this.press.invalidated = true
    this.ownerKey = ownerKey
    this.geometry = value
    const boxes: MouseHitbox[] = []
    const lines: string[] = []
    const rule = (): string => surface.fill(cc.inactive('├' + '─'.repeat(value.width - 2) + '┤'), value.width)
    const row = (text: string): string => {
      if (!value.framed) return fit(text, value.bodyWidth)
      // Image owners already enforce their width/height budget. Do not parse,
      // sanitize, reflow or re-measure native APC transfers as terminal text.
      if (graphicLine(text)) return surface.style(cc.inactive('│') + ' ' + text + ' ' + cc.inactive('│'))
      const clipped = fit(text, value.bodyWidth)
      const content = clipped + ' '.repeat(Math.max(0, value.bodyWidth - visibleWidth(clipped)))
      return surface.fill(cc.inactive('│') + ' ' + content + ' ' + cc.inactive('│'), value.width)
    }
    if (value.framed) {
      const titleWidth = Math.max(1, (value.closeCol ?? value.width - 1) - 4)
      const title = truncateToWidth(value.title, titleWidth, '…')
      let top = cc.inactive('┌─ ') + bold(t.accentBright(title))
      const occupied = visibleWidth(top)
      if (value.closeCol !== undefined) {
        top += cc.inactive('─'.repeat(Math.max(0, value.closeCol - occupied)))
        const closeId = 'modal:close'
        top += (this.hovered === closeId ? t.accentBright : t.muted)('[×]')
        top += cc.inactive('─'.repeat(Math.max(0, value.width - visibleWidth(top) - 1)) + '┐')
        boxes.push({ id: closeId, startRow: 0, endRow: 0, startCol: value.closeCol, endCol: value.closeCol + 2,
          onClick: options.onClose, onHover: on => { this.hovered = on ? closeId : undefined } })
      } else top += cc.inactive('─'.repeat(Math.max(0, value.width - occupied - 1)) + '┐')
      lines.push(surface.fill(top, value.width))
    } else if (value.height >= 2) lines.push(fit(bold(t.accentBright(value.title)), value.width))
    for (const line of value.before) lines.push(row(line))
    if (value.framed && value.before.length > 0) lines.push(rule())
    for (let index = 0; index < value.bodyHeight; index++) lines.push(row(body[index] ?? ''))
    if (value.framed && value.after.length + value.footer.length > 0) lines.push(rule())
    for (const line of value.after) lines.push(row(line))
    const footerRow = lines.length
    for (let index = 0; index < value.footer.length; index++) {
      let line = ''
      const paints = value.actionPaints.filter(paint => paint.row === index)
      for (const paint of paints) {
        line += ' '.repeat(Math.max(0, paint.col - visibleWidth(line)))
        const id = 'modal:action:' + paint.action.id
        const style = paint.action.disabled ? t.muted : this.hovered === id ? t.accentBright : t.accent
        line += style(paint.text)
        if (!paint.action.disabled && paint.action.onActivate !== undefined) {
          boxes.push({ id, startRow: footerRow + index, endRow: footerRow + index,
            startCol: value.bodyCol + paint.col, endCol: value.bodyCol + paint.col + visibleWidth(paint.text) - 1,
            onClick: paint.action.onActivate, onHover: on => { this.hovered = on ? id : undefined } })
        }
      }
      lines.push(row(line))
    }
    if (value.framed) lines.push(surface.fill(cc.inactive('└' + '─'.repeat(value.width - 2) + '┘'), value.width))
    if (this.press?.id !== undefined && !boxes.some(box => box.id === this.press?.id)) this.press.invalidated = true
    this.chrome = boxes
    this.hitboxes.sync(boxes)
    return lines.slice(0, value.height)
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const target = this.chrome.find(box => event.x >= (box.startCol ?? 0) && event.x <= (box.endCol ?? Number.POSITIVE_INFINITY) && event.y >= box.startRow && event.y <= box.endRow)
    if (event.type === 'press' && event.button === 'left') this.press = { id: target?.id, invalidated: false }
    if (event.type === 'drag' && this.press !== undefined) this.press.invalidated = true
    if (event.type === 'click' && event.button === 'left') {
      const pressed = this.press
      this.press = undefined
      if (pressed !== undefined && (pressed.invalidated || (target !== undefined && target.id !== pressed.id))) return { handled: true, render: false }
    }
    return this.hitboxes.handleMouse(event)
  }

  bodyMouse(event: TuiMouseEvent): TuiMouseEvent | undefined {
    const value = this.geometry
    if (value === undefined || event.x < value.bodyCol || event.x >= value.bodyCol + value.bodyWidth
      || event.y < value.bodyRow || event.y >= value.bodyRow + value.bodyHeight) return undefined
    return {
      ...event, x: event.x - value.bodyCol, y: event.y - value.bodyRow,
      width: value.bodyWidth, height: value.bodyHeight,
    }
  }

  invalidate(): void {
    if (this.press !== undefined) this.press.invalidated = true
    this.hitboxes.clear()
    this.chrome = []
    this.geometry = undefined
    this.hovered = undefined
  }
}
