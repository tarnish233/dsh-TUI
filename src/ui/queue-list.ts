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
import { oneLine, truncateToWidth, visibleWidth } from './text.ts'

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

export class QueueList implements Component {
  rows: readonly QueueEntry[] = []
  editingId?: string
  private readonly hitboxes = new HitboxRegistry()
  private readonly actions: QueueListActions
  private hovered?: string
  private collapsed = false

  constructor(actions: QueueListActions) {
    this.actions = actions
  }

  invalidate(): void {
    this.hitboxes.clear()
    this.hovered = undefined
    this.collapsed = false
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
    const imageLabel = row.images > 0 ? ` · ${row.images === 1 ? '1 image' : row.images + ' images'}` : ''
    const prefix = `${indexLabel}${steer} `
    const raw = oneLine(row.text) || (row.images > 0 ? '(image)' : '(empty)')
    const room = Math.max(4, width - visibleWidth(prefix) - visibleWidth(imageLabel) - BUTTONS_WIDTH - 2)
    const body = truncateToWidth(raw, room, '…')
    const gap = Math.max(2, width - visibleWidth(prefix) - visibleWidth(body) - visibleWidth(imageLabel) - BUTTONS_WIDTH)
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
    push(' '.repeat(gap), ' '.repeat(gap))
    const regions: MouseHitbox[] = []
    for (const [buttonIndex, button] of BUTTONS.entries()) {
      if (column >= width) break
      if (buttonIndex > 0) push(BUTTON_GAP, BUTTON_GAP)
      const label = truncateToWidth(button.label, Math.max(1, width - column), '')
      if (label === '') break
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
    return { line, regions }
  }
}
