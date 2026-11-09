/**
 * Queued human messages above the prompt, one Grok-style row each.
 *
 * The rows are a projection of DSH's inbox. The header folds them away.
 * Send now, Edit and Cancel sit on the message row.
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { QueueEntry } from '../backend/types.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import { dim, t } from './theme.ts'
import { truncateToWidth, visibleWidth } from './text.ts'
import { queueAttachmentLabel, queueContentLabel } from './queue-content.ts'

export interface QueueListActions {
  sendNow(messageId: string): void
  edit(messageId: string): void
  cancel(messageId: string): void
  changed(): void
}

const BUTTONS = [
  { action: 'send', label: '[Send now]' },
  { action: 'edit', label: '[Edit]' },
  { action: 'cancel', label: '[Cancel]' },
] as const

const BUTTON_GAP = '  '
const BUTTONS_WIDTH = BUTTONS.reduce((sum, button, index) => sum + button.label.length + (index === 0 ? 0 : BUTTON_GAP.length), 0)
/** Header row + the blank row that separates the list from the editor. */
const CHROME_ROWS = 2

export class QueueList implements Component {
  rows: readonly QueueEntry[] = []
  editingId?: string
  private readonly hitboxes = new HitboxRegistry()
  private readonly actions: QueueListActions
  private hovered?: string
  private collapsed = false
  private defaultCollapsed = false

  constructor(actions: QueueListActions) {
    this.actions = actions
  }

  /**
   * Display preference hook (`queueCollapsed`). The parent calls this only on
   * the initial mount and when the setting changes; a normal native row update
   * never re-applies it, so a manual fold/unfold survives streaming updates.
   */
  setDefaultCollapsed(value: boolean): void {
    this.defaultCollapsed = value
    if (this.collapsed === value) return
    this.collapsed = value
    this.actions.changed()
  }

  invalidate(): void {
    this.hitboxes.clear()
    this.hovered = undefined
    // A new/reset list starts from the configured display preference instead of
    // a hard-coded expanded state.
    this.collapsed = this.defaultCollapsed
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    if (this.rows.length === 0) {
      this.collapsed = false
      this.hitboxes.sync([])
      return []
    }
    const lines = [this.header(safeWidth)]
    const boxes: MouseHitbox[] = [{
      id: 'queue:toggle',
      startRow: 0,
      endRow: 0,
      startCol: 0,
      endCol: Math.max(0, visibleWidth(lines[0] ?? '') - 1),
      onClick: () => {
        this.collapsed = !this.collapsed
        this.actions.changed()
      },
    }]
    if (!this.collapsed) {
      for (const [index, row] of this.rows.entries()) {
        const rowIndex = lines.length
        const rendered = this.rowLine(row, index, safeWidth, rowIndex)
        lines.push(rendered.line)
        boxes.push(...rendered.regions)
      }
    }
    lines.push('')
    this.hitboxes.sync(boxes)
    return lines
  }

  /**
   * Rows this list paints at `width`, without subscribing hitboxes.
   *
   * The parent's fixed-dock budget needs this height before it lays the frame
   * out, and the contract forbids a second render just to count rows. The count
   * is state-derived and can never drift from the paint: every queued message is
   * exactly one row (`rowLine` composes and truncates a single line at any
   * width), collapsed lists paint the header only, and an empty list paints
   * nothing. `measureRows(width) === render(width).length` is pinned by test.
   */
  measureRows(_width: number): number {
    if (this.rows.length === 0) return 0
    const body = this.collapsed ? 0 : this.rows.length
    return CHROME_ROWS + body
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.hitboxes.handleMouse(event)
  }

  private header(width: number): string {
    const arrow = this.collapsed ? '▸' : '▾'
    const count = this.collapsed ? ` · ${this.rows.length}` : ''
    return truncateToWidth(dim(`${arrow} queued${count}`), width, '')
  }

  private rowLine(row: QueueEntry, index: number, width: number, rowIndex: number): {
    line: string
    regions: MouseHitbox[]
  } {
    const indexLabel = `#${index + 1}`
    const steer = row.target === 'next-step' ? ' steer' : ''
    const attachments = queueAttachmentLabel(row)
    const imageLabel = attachments === '' ? '' : ' · ' + attachments
    const prefix = `${indexLabel}${steer} `
    const raw = queueContentLabel(row)
    const showButtons = width - visibleWidth(prefix) - visibleWidth(imageLabel) - BUTTONS_WIDTH - 2 >= 4
    const room = showButtons
      ? Math.max(1, width - visibleWidth(prefix) - visibleWidth(imageLabel) - BUTTONS_WIDTH - 2)
      : Math.max(1, width - visibleWidth(prefix) - visibleWidth(imageLabel) - 1)
    const body = truncateToWidth(raw, room, '…')
    const gap = showButtons ? Math.max(2, width - visibleWidth(prefix) - visibleWidth(body) - visibleWidth(imageLabel) - BUTTONS_WIDTH) : 0
    let line = ''
    let column = 0
    const push = (plain: string, styled: string): void => {
      line += styled
      column += visibleWidth(plain)
    }
    push(indexLabel, dim(indexLabel))
    if (steer !== '') push(steer, dim(steer))
    push(' ', ' ')
    push(body, this.editingId === row.messageId ? t.accent(body) : dim(body))
    if (imageLabel !== '') push(imageLabel, dim(imageLabel))
    if (showButtons) push(' '.repeat(gap), ' '.repeat(gap))
    const regions: MouseHitbox[] = []
    if (showButtons) {
      for (const [buttonIndex, button] of BUTTONS.entries()) {
        const gapWidth = buttonIndex === 0 ? 0 : BUTTON_GAP.length
        const labelWidth = visibleWidth(button.label)
        if (column + gapWidth + labelWidth > width) break
        if (buttonIndex > 0) push(BUTTON_GAP, BUTTON_GAP)
        const label = button.label
        const id = `${row.messageId}:${button.action}`
        const startCol = column
        push(label, this.hovered === id ? t.accentBright(label) : t.accent(label))
        regions.push({
          id,
          startRow: rowIndex,
          endRow: rowIndex,
          startCol,
          endCol: column - 1,
          onClick: () => {
            if (button.action === 'send') this.actions.sendNow(row.messageId)
            else if (button.action === 'edit') this.actions.edit(row.messageId)
            else this.actions.cancel(row.messageId)
          },
          onHover: entering => {
            const next = entering ? id : undefined
            if (this.hovered === next) return
            this.hovered = next
            this.actions.changed()
          },
        })
      }
    }
    return { line: truncateToWidth(line, width, ''), regions: regions.filter(region => (region.endCol ?? -1) < width) }
  }
}
