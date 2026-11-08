// Must stay FIRST: forces truecolor before any src module.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { QueueEntry } from '../src/backend/types.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

const input = await loadInputModule()
const { QueueDialog } = await import('../src/ui/queue-dialog.ts')
const { QueueList } = await import('../src/ui/queue-list.ts')

type Dialog = InstanceType<typeof QueueDialog>

const ESC = '\x1b'
const DOWN = '\x0e'
const CTRL_F = '\x06'

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const ENTRIES: readonly QueueEntry[] = [
  { messageId: 'msg-1', text: 'first queued message', target: 'next-turn', images: 0 },
  { messageId: 'msg-2', text: 'second queued message 中文 🚀', target: 'next-step', images: 2 },
  { messageId: 'msg-3', text: '', target: 'next-turn', images: 1 },
]

const lines = (dialog: Dialog, width = 80): string[] => dialog.render(width)
const text = (dialog: Dialog, width = 80): string => stripTerminalSequences(lines(dialog, width).join('\n'))

function rowOf(dialog: Dialog, needle: string, width = 80): number {
  const index = lines(dialog, width).findIndex(line => stripTerminalSequences(line).includes(needle))
  assert.ok(index >= 0, `${needle} is rendered`)
  return index
}

function columnOf(dialog: Dialog, row: number, needle: string, width = 80): number {
  const line = stripTerminalSequences(lines(dialog, width)[row] ?? '')
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `${needle} is on row ${row}`)
  return visibleWidth(line.slice(0, index))
}

function mouse(dialog: Dialog, type: 'press' | 'click' | 'wheel', row: number, col: number, width = 80, wheelDelta?: number): void {
  const rendered = lines(dialog, width)
  dialog.handleMouse?.({
    type, button: 'left', x: col, y: row, screenX: col, screenY: row,
    width, height: rendered.length, shift: false, alt: false, ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
    ...(wheelDelta === undefined ? {} : { wheelDelta }),
  })
}

function harness(options: {
  entries?: readonly QueueEntry[]
  getEntries?: () => readonly QueueEntry[]
  bindings?: Record<string, string | string[] | null>
  rows?: number
  maxHeight?: number
  onEdit?: (entry: QueueEntry) => void | Promise<void>
  onCancelEntry?: (entry: QueueEntry) => void | Promise<void>
  onSendNow?: (entry: QueueEntry) => void | Promise<void>
}) {
  const tui = createFakeTui(options.rows ?? 24, 100)
  const keymap = input.createCcKeymap({ bindings: options.bindings ?? {} })
  const calls: Array<{ action: string; id: string; text: string; images: number; target: string }> = []
  const events: string[] = []
  const dialog = new QueueDialog(asTui(tui), {
    ...(options.entries === undefined ? {} : { entries: options.entries }),
    ...(options.getEntries === undefined ? {} : { getEntries: options.getEntries }),
    keymap,
    onEdit: entry => { calls.push({ action: 'edit', id: entry.messageId, text: entry.text, images: entry.images, target: entry.target }); return options.onEdit?.(entry) },
    onCancelEntry: entry => { calls.push({ action: 'cancel', id: entry.messageId, text: entry.text, images: entry.images, target: entry.target }); return options.onCancelEntry?.(entry) },
    onSendNow: entry => { calls.push({ action: 'send', id: entry.messageId, text: entry.text, images: entry.images, target: entry.target }); return options.onSendNow?.(entry) },
    onClose: () => { events.push('close') },
    ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
  })
  dialog.focused = true
  return { dialog, keymap, calls, events }
}

test('renders the native queue with target/image context and keeps ids, not indexes', () => {
  const f = harness({ entries: ENTRIES, bindings: { 'queue.send-now': 'alt+s' } })
  assert.equal(f.dialog.modalSize, 'standard')
  const rendered = text(f.dialog)
  assert.match(rendered, /Native queue · 3 messages/)
  assert.match(rendered, /first queued message/)
  assert.match(rendered, /next step/)
  assert.match(rendered, /2 images/)
  assert.match(rendered, /msg-1/)
  assert.match(rendered, /\(image\)/)
  f.dialog.handleInput(DOWN)
  assert.match(text(f.dialog), /msg-2/, 'the focused native entry shows its exact id')
  f.dialog.handleInput('\x10') // back to the first entry (list.previous)

  f.dialog.handleInput('e')
  f.dialog.handleInput('d')
  f.dialog.handleInput('\x1bs')
  assert.deepEqual(f.calls.map(call => [call.action, call.id]), [['edit', 'msg-1'], ['cancel', 'msg-1'], ['send', 'msg-1']])
  // The complete native entry (image count and target) is handed over verbatim;
  // the modal never strips or rewrites image data.
  for (const call of f.calls) {
    assert.equal(call.images, ENTRIES[0]!.images)
    assert.equal(call.target, ENTRIES[0]!.target)
  }
})

test('live roster refresh keeps the selected native id and retires removed ids', () => {
  let entries: readonly QueueEntry[] = ENTRIES
  const f = harness({ getEntries: () => entries })
  f.dialog.handleInput(DOWN)
  assert.equal(f.dialog.selectedId, 'msg-2')
  entries = [
    ENTRIES[0]!,
    { messageId: 'msg-9', text: 'replacement', target: 'next-turn', images: 0 },
  ]
  f.dialog.render(80)
  assert.equal(f.dialog.selectedId, 'msg-9', 'a removed native id is not resurrected')
  entries = [ENTRIES[1]!, { messageId: 'msg-9', text: 'replacement', target: 'next-turn', images: 0 }]
  f.dialog.render(80)
  assert.equal(f.dialog.selectedId, 'msg-9', 'the nearest available row stays selected')
  f.dialog.handleInput('e')
  assert.deepEqual(f.calls.at(-1), { action: 'edit', id: 'msg-9', text: 'replacement', images: 0, target: 'next-turn' })
})

test('the dialog never mutates or reorders its native snapshot', () => {
  const f = harness({ entries: ENTRIES })
  const before = f.dialog.entries().map(entry => entry.messageId)
  f.dialog.handleInput('d')
  f.dialog.handleInput('e')
  f.dialog.handleInput('\x1bs')
  assert.deepEqual(f.dialog.entries().map(entry => entry.messageId), before)
  assert.deepEqual(f.dialog.entries(), ENTRIES)
})

test('search filters by text, id and target without becoming a local queue', () => {
  const f = harness({ entries: ENTRIES })
  f.dialog.handleInput(CTRL_F)
  for (const char of 'msg-3') f.dialog.handleInput(char)
  assert.equal(f.dialog.query, 'msg-3')
  assert.match(text(f.dialog), /1\/3 match/)
  assert.match(text(f.dialog), /\(image\)/)
  assert.doesNotMatch(text(f.dialog), /first queued message/)
  f.dialog.handleInput(ESC)
  assert.equal(f.dialog.isDone, false, 'Esc leaves the search field first')
  f.dialog.handleInput(ESC)
  assert.deepEqual(f.events, ['close'])

  const none = harness({ entries: ENTRIES })
  none.dialog.handleInput(CTRL_F)
  for (const char of 'zzzz') none.dialog.handleInput(char)
  assert.match(text(none.dialog), /No queued messages match/)
  assert.equal(none.dialog.isDone, false)
})

test('empty and no-match states keep close usable and do not advertise destructive chips', () => {
  const f = harness({ entries: [] })
  assert.match(text(f.dialog), /native inbox is empty/)
  assert.match(text(f.dialog), /\[edit\]/)
  f.dialog.handleInput('e')
  assert.equal(f.calls.length, 0)
  f.dialog.handleInput(ESC)
  assert.deepEqual(f.events, ['close'])
})

test('remapped and disabled queue actions are respected; unbound capability stays visible', () => {
  const f = harness({
    entries: ENTRIES,
    bindings: { 'queue.edit': 'alt+e', 'queue.cancel-entry': null, 'queue.send-now': 'alt+s', 'modal.search': null },
  })
  const rendered = text(f.dialog)
  assert.match(rendered, /alt\+e edit/i)
  assert.doesNotMatch(rendered, /ctrl\+enter/i)
  assert.match(rendered, /\[cancel entry\]/, 'a disabled action keeps its clickable label without a fake key')
  assert.match(rendered, /\[search\]/)
  f.dialog.handleInput('e')
  assert.equal(f.calls.length, 0, 'the default edit key is inert after the remap')
  f.dialog.handleInput('d')
  assert.equal(f.calls.length, 0, 'the default cancel key is disabled')
  f.dialog.handleInput('\x1be')
  assert.deepEqual(f.calls.at(-1)?.action, 'edit')
})

test('callback failures stay visible and do not lock close/back', async () => {
  const f = harness({
    entries: ENTRIES,
    onEdit: () => Promise.reject(new Error('Native inbox entry changed; refresh and retry')),
  })
  f.dialog.handleInput('e')
  assert.equal(f.dialog.isBusy, true)
  await tick()
  assert.equal(f.dialog.isBusy, false)
  assert.match(text(f.dialog), /Native inbox entry changed/)
  f.dialog.handleInput(ESC)
  assert.deepEqual(f.events, ['close'])
})

test('a busy action is not double submitted', async () => {
  let resolve!: () => void
  const gate = new Promise<void>(res => { resolve = res })
  const f = harness({ entries: ENTRIES, onEdit: () => gate })
  f.dialog.handleInput('e')
  f.dialog.handleInput('e')
  assert.equal(f.calls.length, 1)
  resolve()
  await tick()
  assert.equal(f.dialog.isBusy, false)
})

test('mouse selects, then edits on a second click; wheel moves the native selection', () => {
  const f = harness({ entries: ENTRIES, maxHeight: 12 })
  const row = rowOf(f.dialog, 'second queued message')
  const col = columnOf(f.dialog, row, 'second queued message')
  mouse(f.dialog, 'click', row, col)
  assert.equal(f.dialog.selectedId, 'msg-2')
  assert.equal(f.calls.length, 0, 'the first click only selects')
  mouse(f.dialog, 'click', rowOf(f.dialog, 'second queued message'), col)
  assert.deepEqual(f.calls.at(-1), { action: 'edit', id: 'msg-2', text: 'second queued message 中文 🚀', images: 2, target: 'next-step' })

  mouse(f.dialog, 'wheel', rowOf(f.dialog, 'first queued message'), 4, 80, -1)
  assert.equal(f.dialog.selectedId, 'msg-1')
})

test('a pressed mutating chip cannot act on a different native entry after selection changes', () => {
  const f = harness({ entries: ENTRIES, maxHeight: 14 })
  const sendRow = rowOf(f.dialog, 'send now')
  const sendCol = columnOf(f.dialog, sendRow, 'send now')
  mouse(f.dialog, 'press', sendRow, sendCol)
  f.dialog.handleInput(DOWN)
  mouse(f.dialog, 'click', sendRow, sendCol)
  assert.equal(f.calls.length, 0, 'the pressed action belongs to the previous native id')
})

test('status rows are reserved in measurement and never become body targets', async () => {
  const many = Array.from({ length: 14 }, (_, index) => ({
    messageId: `msg-${index}`,
    text: `queued ${index}`,
    target: 'next-turn' as const,
    images: 0,
  }))
  const f = harness({ entries: many, maxHeight: 18 })
  f.dialog.handleInput('d')
  await tick()
  await tick()
  assert.match(text(f.dialog), /Requested/)
  const rendered = lines(f.dialog)
  const separator = rendered.findLastIndex(line => stripTerminalSequences(line).startsWith('├'))
  assert.ok(separator > 0)
  const before = f.calls.length
  // A click on the body/status divider is chrome, not an unseen native row.
  mouse(f.dialog, 'click', separator, 4)
  mouse(f.dialog, 'click', separator, 4)
  assert.equal(f.calls.length, before, 'status rows cannot shift a body hit into chrome')
})

test('narrow QueueList rows never overflow and clipped chips own no hitbox', () => {
  const calls: string[] = []
  const list = new QueueList({
    sendNow: () => { calls.push('send') },
    edit: () => { calls.push('edit') },
    cancel: () => { calls.push('cancel') },
    changed: () => {},
  })
  list.rows = ENTRIES
  for (const width of [8, 10, 16, 20, 24, 28, 32]) {
    for (const line of list.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
  }
  list.render(16)
  list.handleMouse?.({ type: 'click', button: 'left', x: 15, y: 1, screenX: 15, screenY: 1, width: 16, height: 4, shift: false, alt: false, ctrl: false, clickCount: 1 })
  assert.deepEqual(calls, [], 'a chip that did not fully fit is not clickable')
})

test('width-safe rendering for narrow, short, CJK and zero-row hosts', () => {
  const f = harness({ entries: ENTRIES, rows: 0 })
  for (const width of [1, 4, 8, 16, 20, 24, 32, 40, 52, 80, 120]) {
    for (const line of lines(f.dialog, width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
  }
  assert.match(text(f.dialog, 120), /中文/)
  for (const height of [4, 6, 8, 12]) {
    const short = harness({ entries: ENTRIES, rows: 8, maxHeight: height })
    assert.ok(lines(short.dialog, 40).length <= height)
  }
})

test('fragmented paste in queue search is reported for the interrupt listener', () => {
  const f = harness({ entries: ENTRIES })
  f.dialog.handleInput(CTRL_F)
  f.dialog.handleInput('\x1b[200~fir')
  assert.equal(f.dialog.isPasting, true)
  f.dialog.handleInput('\x1b[201~')
  assert.equal(f.dialog.isPasting, false)
  assert.equal(f.dialog.query, 'fir')
})

test('QueueList.setDefaultCollapsed is a display preference and survives normal renders', () => {
  let changed = 0
  const list = new QueueList({
    sendNow: () => {},
    edit: () => {},
    cancel: () => {},
    changed: () => { changed += 1 },
  })
  list.rows = ENTRIES
  list.setDefaultCollapsed(true)
  const collapsed = stripTerminalSequences(list.render(80).join('\n'))
  assert.match(collapsed, /▸ queued · 3/)
  assert.doesNotMatch(collapsed, /first queued message/)
  assert.ok(changed > 0)

  // A normal native render keeps the manual fold.
  list.render(80)
  list.render(80)
  assert.match(stripTerminalSequences(list.render(80).join('\n')), /▸ queued · 3/)

  // A new/invalidated list starts from the configured preference again.
  list.invalidate()
  list.render(80)
  assert.match(stripTerminalSequences(list.render(80).join('\n')), /▸ queued · 3/)

  list.setDefaultCollapsed(false)
  assert.match(stripTerminalSequences(list.render(80).join('\n')), /first queued message/)

  // A manual fold is not overridden by normal rows updates.
  list.invalidate()
  const header = list.render(80)[0] ?? ''
  assert.match(stripTerminalSequences(header), /▾ queued/)
  const box = { startRow: 0, startCol: 0, endCol: 80 }
  list.handleMouse?.({ type: 'click', button: 'left', x: 1, y: 0, screenX: 1, screenY: 0, width: 80, height: 10, shift: false, alt: false, ctrl: false, clickCount: 1 })
  list.rows = [...ENTRIES]
  assert.match(stripTerminalSequences(list.render(80)[0] ?? ''), /▸ queued/)
  assert.ok(box.endCol > 0)
})