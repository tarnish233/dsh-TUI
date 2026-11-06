import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'
import type { HelpCommand } from '../src/ui/help.ts'

const input = await loadInputModule()
const { HelpPanel } = await import('../src/ui/help.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Panel = InstanceType<typeof HelpPanel>

const fakeTui = (rows = 30, columns = 80) => asTui(createFakeTui(rows, columns))
const keymap = (bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap =>
  input.createCcKeymap({ bindings })

interface Harness {
  panel: Panel
  calls: { close: number; interrupt: number }
}

function makePanel(options: {
  commands?: readonly HelpCommand[]
  customCommands?: readonly HelpCommand[]
  keymap?: CcKeymap
  rows?: number
  columns?: number
  onInterrupt?: (() => void) | null
  note?: string
} = {}): Harness {
  const calls = { close: 0, interrupt: 0 }
  const panel = new HelpPanel(fakeTui(options.rows ?? 30, options.columns ?? 80), {
    commands: options.commands ?? [],
    customCommands: options.customCommands ?? [],
    keymap: options.keymap ?? keymap(),
    onClose: () => { calls.close += 1 },
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.onInterrupt === null ? {} : {
      onInterrupt: () => {
        calls.interrupt += 1
        options.onInterrupt?.()
      },
    }),
  })
  return { panel, calls }
}

function render(panel: Panel, width: number): { lines: string[]; text: string } {
  const lines = panel.render(width)
  return { lines, text: stripTerminalSequences(lines.join('\n')) }
}

function assertWidths(panel: Panel, widths: readonly number[] = [20, 40, 80, 120]): void {
  for (const width of widths) {
    for (const line of panel.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`)
    }
  }
}

const catalog = (): HelpCommand[] => [
  { name: 'help', description: 'Commands and shortcuts' },
  { name: 'model', description: 'Choose a DSH model', inputHint: '[provider/model]' },
  { name: 'permission', description: 'Switch the native permission preset' },
]

const customCatalog = (): HelpCommand[] => [
  { name: 'deploy', description: 'Deploy with 中文 and emoji 🚀', inputHint: '<env>' },
]

const manyCommands = (count = 40): HelpCommand[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `cmd${String(index).padStart(2, '0')}`,
    description: `Description for command ${index}`,
  }))

// ---------------------------------------------------------------------------
// Read-only shape, columns and widths

test('wide terminals show Commands and Custom commands side by side; narrow ones stack', () => {
  for (const width of [80, 120]) {
    const { panel } = makePanel({ commands: catalog(), customCommands: customCatalog() })
    const { lines, text } = render(panel, width)
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`)
    const shared = lines.map(line => stripTerminalSequences(line))
      .find(line => line.includes('Commands') && line.includes('Custom commands'))
    assert.ok(shared, `expected one row with both section headings at width ${width}`)
    assert.match(text, /\/model \[provider\/model\]/)
    assert.match(text, /\/deploy <env>/)
    assert.doesNotMatch(text, /❯/, 'a read-only panel has no selection pointer')
    assert.doesNotMatch(text, /Enter to select/)
    assert.match(text, /^\s*Help$/m)
    assert.equal(panel.capturesViewportInput, true)
  }

  for (const width of [20, 40]) {
    const { panel } = makePanel({ commands: catalog(), customCommands: customCatalog() })
    const { lines, text } = render(panel, width)
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`)
    const plain = lines.map(line => stripTerminalSequences(line))
    assert.ok(!plain.some(line => line.includes('Commands') && line.includes('Custom commands')), `width ${width} must stack`)
    const commandsAt = plain.findIndex(line => /^\s*Commands\b/.test(line))
    const customAt = plain.findIndex(line => /^\s*Custom commands\b/.test(line))
    assert.ok(commandsAt >= 0 && customAt > commandsAt)
    assert.match(text, /\/deploy <env>/)
  }
})

test('slashes in the hints never claim Enter/choose/select behavior', () => {
  const { panel } = makePanel({ commands: catalog(), customCommands: customCatalog(), rows: 20 })
  const hints = stripTerminalSequences(panel.render(80).at(-1) ?? '')
  assert.match(hints, /close/)
  assert.doesNotMatch(hints, /Enter|choose|select/i)
})

test('names, descriptions and hints stay width-safe with CJK, emoji, ANSI/OSC and long text', () => {
  const commands: HelpCommand[] = [
    {
      name: 'very-long-command-name-'.repeat(6),
      description: `A long description ${'word '.repeat(60)}中文混排 👨‍👩‍👧‍👦 \x1b[31mred\x1b[0m \x1b]0;pwned\x07 done`,
      inputHint: `<${'very-long-hint-'.repeat(6)}>`,
    },
    { name: '部署/中文', description: 'emoji 🚀 and `/a/very/long/path/that/should/wrap/at/the/edge.ts`' },
    { name: '', description: '' },
  ]
  const custom: HelpCommand[] = [
    { name: '/already-slash', description: 'Slash prefix is preserved' },
  ]
  const { panel } = makePanel({ commands, customCommands: custom })
  assertWidths(panel)

  const joined = [20, 40, 80, 120].map(width => panel.render(width).join('\n')).join('\n')
  assert.ok(!joined.includes('pwned'), 'OSC sequence content must be stripped')
  assert.ok(!joined.includes('\x07'), 'control characters must be stripped')

  const wide = render(panel, 120).text
  assert.match(wide, /\/部署\/中文/)
  assert.match(wide, /\/already-slash/)
  assert.doesNotMatch(wide, /\/\/already-slash/)
  assert.match(wide, /\/\?/, 'an unnamed descriptor stays display-only, not hidden or executed')
  assert.match(wide, /🚀/)
})

test('empty custom commands and fully empty catalogs render explicit empty text', () => {
  const onlyCommands = makePanel({ commands: catalog() })
  const text = render(onlyCommands.panel, 80).text
  assert.match(text, /Custom commands 0/)
  assert.match(text, /No custom commands/)

  const empty = makePanel()
  const emptyText = render(empty.panel, 40).text
  assert.match(emptyText, /No commands are available/)
  assert.match(emptyText, /No custom commands/)

  // Degenerate widths still render without throwing or exceeding the budget.
  assertWidths(empty.panel, [4, 10, 20, 40, 80, 120])
})

test('an optional note renders compactly, sanitized and inside the height budget', () => {
  const note = 'Custom commands includes plugin and unattributed native registrations. \x1b[31mred\x1b[0m \x1b]0;pwned\x07'
  const { panel } = makePanel({
    commands: catalog(),
    customCommands: customCatalog(),
    note,
    rows: 10,
    columns: 80,
  })
  const wide = render(panel, 80)
  assert.match(wide.text, /Custom commands includes plugin and unattributed native registrations/)
  assert.ok(!wide.text.includes('pwned'))
  assert.ok(wide.lines.length <= 10)

  const narrow = render(panel, 20)
  for (const line of narrow.lines) assert.ok(visibleWidth(line) <= 20, JSON.stringify(line))
  assert.ok(narrow.lines.length <= 10, `note panel rendered ${narrow.lines.length} lines for 10 rows`)
  assert.match(narrow.text, /…/, 'a note longer than two lines is capped')

  const emptyNote = makePanel({ commands: catalog(), note: '' })
  assert.equal(emptyNote.panel.render(80).length, makePanel({ commands: catalog() }).panel.render(80).length)
})

// ---------------------------------------------------------------------------
// Height and scrolling

test('a long catalog is windowed to the dialog row budget and scrolls with list actions', () => {
  const { panel, calls } = makePanel({ commands: manyCommands(40), customCommands: [], rows: 12, columns: 80 })
  const first = render(panel, 80)
  assert.ok(first.lines.length <= 12, `rendered ${first.lines.length} lines for a 12-row terminal`)
  assert.equal(panel.scrollTop, 0)
  assert.match(first.text, /\/cmd00/)
  assert.doesNotMatch(first.text, /\/cmd39/)

  panel.handleInput('\x1b[6~') // PageDown
  assert.equal(panel.scrollTop, 4)
  const paged = render(panel, 80)
  assert.ok(paged.lines.length <= 12)
  assert.doesNotMatch(paged.text, /\/cmd00/)

  panel.handleInput('\x1b[F') // End
  assert.ok(panel.scrollTop > 0)
  const last = render(panel, 80)
  assert.match(last.text, /\/cmd39/)
  assert.ok(last.lines.length <= 12)

  panel.handleInput('\x1b[H') // Home
  assert.equal(panel.scrollTop, 0)
  assert.match(render(panel, 80).text, /\/cmd00/)

  panel.handleInput('\x1b[B') // Down -> one line
  assert.equal(panel.scrollTop, 1)
  panel.handleInput('\x1b[A') // Up
  assert.equal(panel.scrollTop, 0)
  panel.handleInput('\x1b[A') // clamp at the top
  assert.equal(panel.scrollTop, 0)

  assert.equal(calls.close, 0)
  assert.equal(calls.interrupt, 0)
})

test('short terminals still keep the header, a usable body window and the help line', () => {
  for (const rows of [10, 12, 16, 24]) {
    const { panel } = makePanel({ commands: manyCommands(60), customCommands: manyCommands(10), rows, columns: 100 })
    const { lines } = render(panel, 100)
    assert.ok(lines.length <= rows, `${lines.length} lines for rows=${rows}`)
    assert.ok(lines.length >= 7, 'header, body and hints must remain visible')
  }
})

// ---------------------------------------------------------------------------
// Inert Enter / digits / printable keys

test('Enter, digits, printable keys and unrelated globals are inert', () => {
  const { panel, calls } = makePanel({ commands: manyCommands(40), rows: 12 })
  panel.handleInput('\x1b[6~') // move away from the top first
  const beforeScroll = panel.scrollTop
  const before = render(panel, 80).text

  for (const key of ['\r', '\n', '1', '9', 'x', '?', ' ', '\t', '\x0f']) panel.handleInput(key)

  assert.equal(panel.scrollTop, beforeScroll)
  assert.equal(render(panel, 80).text, before)
  assert.equal(calls.close, 0, 'Enter/digits/printables must never close or choose')
  assert.equal(calls.interrupt, 0)
})

// ---------------------------------------------------------------------------
// Close and interrupt

test('Esc closes exactly once and Ctrl+C is global cancellation, not a choice', () => {
  const closeOnce = makePanel({ commands: catalog() })
  closeOnce.panel.handleInput('\x1b')
  assert.equal(closeOnce.calls.close, 1)
  assert.equal(closeOnce.calls.interrupt, 0)
  closeOnce.panel.handleInput('\x1b')
  closeOnce.panel.handleInput('\r')
  assert.equal(closeOnce.calls.close, 1)

  const interrupted = makePanel({ commands: catalog() })
  interrupted.panel.handleInput('\x03')
  assert.equal(interrupted.calls.interrupt, 1)
  assert.equal(interrupted.calls.close, 0, 'global interrupt must not be converted into a local close/answer')
  // Still open and usable while the parent cancels the turn.
  assert.match(render(interrupted.panel, 80).text, /Commands/)
  interrupted.panel.handleInput('\r')
  assert.equal(interrupted.calls.interrupt, 1)
  assert.equal(interrupted.calls.close, 0)
  interrupted.panel.handleInput('\x1b')
  assert.equal(interrupted.calls.close, 1)

  const fallback = makePanel({ commands: catalog(), onInterrupt: null })
  fallback.panel.handleInput('\x03')
  assert.equal(fallback.calls.close, 1, 'without a parent handler, interrupt is only a local dismissal')
})

test('disabled or remapped close/interrupt bindings are respected', () => {
  const remappedInterrupt = makePanel({ commands: catalog(), keymap: keymap({ 'app.interrupt': 'ctrl+q' }) })
  remappedInterrupt.panel.handleInput('\x11')
  assert.equal(remappedInterrupt.calls.interrupt, 1)
  assert.equal(remappedInterrupt.calls.close, 0)
  remappedInterrupt.panel.handleInput('\x03') // Ctrl+C is no longer interrupt: list.cancel closes
  assert.equal(remappedInterrupt.calls.close, 1)

  const disabledInterrupt = makePanel({ commands: catalog(), keymap: keymap({ 'app.interrupt': null }) })
  disabledInterrupt.panel.handleInput('\x03')
  assert.equal(disabledInterrupt.calls.interrupt, 0)
  assert.equal(disabledInterrupt.calls.close, 1)

  const remappedClose = makePanel({
    commands: catalog(),
    keymap: keymap({ 'list.cancel': null, 'app.cancel': null, 'dialog.cancel': 'ctrl+q' }),
  })
  remappedClose.panel.handleInput('\x1b')
  assert.equal(remappedClose.calls.close, 0, 'Escape must not fall back after a remap')
  remappedClose.panel.handleInput('\x11')
  assert.equal(remappedClose.calls.close, 1)

  const noClose = makePanel({
    commands: catalog(),
    keymap: keymap({ 'list.cancel': null, 'app.cancel': null, 'dialog.cancel': null }),
  })
  noClose.panel.handleInput('\x1b')
  assert.equal(noClose.calls.close, 0)
})

test('remapped and disabled list navigation never falls back to defaults', () => {
  const remapped = makePanel({
    commands: manyCommands(40),
    rows: 12,
    keymap: keymap({ 'list.previous': 'alt+k', 'list.next': 'alt+j' }),
  })
  remapped.panel.handleInput('\x0e') // Ctrl+N no longer bound to list.next
  assert.equal(remapped.panel.scrollTop, 0)
  remapped.panel.handleInput('\x1bj') // Alt+J
  assert.equal(remapped.panel.scrollTop, 1)
  remapped.panel.handleInput('\x1bk') // Alt+K
  assert.equal(remapped.panel.scrollTop, 0)

  const disabled = makePanel({
    commands: manyCommands(40),
    rows: 12,
    keymap: keymap({
      'list.previous': null,
      'list.next': null,
      'list.page-up': null,
      'list.page-down': null,
      'list.first': null,
      'list.last': null,
    }),
  })
  for (const key of ['\x0e', '\x1b[B', '\x1b[6~', '\x1b[F', '\x1b[H']) disabled.panel.handleInput(key)
  assert.equal(disabled.panel.scrollTop, 0)
  assert.equal(disabled.calls.close, 0)
})

// ---------------------------------------------------------------------------
// Focus and chord ownership

test('a pending chord can still be interrupted by global Ctrl+C', () => {
  const { panel, calls } = makePanel({ commands: catalog(), keymap: keymap() })
  panel.focused = true
  panel.handleInput('\x18') // Ctrl+X chord prefix
  assert.equal(panel.keymap.isPendingChord(), true)
  panel.handleInput('\x03') // Ctrl+C stays global through the chord
  assert.equal(panel.keymap.isPendingChord(), false)
  assert.equal(calls.interrupt, 1)
  assert.equal(calls.close, 0)
})

test('a cancelled chord re-dispatches its fresh key and mismatch keys stay inert', () => {
  const scroll = makePanel({ commands: manyCommands(40), rows: 12 })
  scroll.panel.focused = true
  scroll.panel.handleInput('\x18') // Ctrl+X pending
  assert.equal(scroll.panel.keymap.isPendingChord(), true)
  scroll.panel.handleInput('\x1b[B') // mismatch -> fresh Down should still scroll
  assert.equal(scroll.panel.keymap.isPendingChord(), false)
  assert.equal(scroll.panel.scrollTop, 1)

  scroll.panel.handleInput('\x18')
  scroll.panel.handleInput('z') // mismatch -> inert printable
  assert.equal(scroll.panel.keymap.isPendingChord(), false)
  assert.equal(scroll.panel.scrollTop, 1)
})

test('focus changes and disposal own only this surface\'s chord', () => {
  const km = keymap()
  const { panel, calls } = makePanel({ commands: catalog(), keymap: km })
  panel.focused = true
  panel.handleInput('\x18')
  assert.equal(km.isPendingChord(), true)
  panel.focused = false
  assert.equal(km.isPendingChord(), false, 'losing focus releases the chord')

  // A hidden/disposed panel must not steal another editor's half-typed chord.
  const other = keymap()
  const hidden = makePanel({ commands: catalog(), keymap: other })
  other.resolve('\x18', 'editor')
  assert.equal(other.isPendingChord(), true)
  hidden.panel.dispose()
  hidden.panel.dispose()
  assert.equal(hidden.panel.isDisposed, true)
  assert.equal(other.isPendingChord(), true, 'disposing an unfocused panel leaves the chord alone')
  other.cancelChord()

  // A focused panel does release the chord it owns.
  const focused = makePanel({ commands: catalog(), keymap: other })
  focused.panel.focused = true
  other.resolve('\x18', 'editor')
  assert.equal(other.isPendingChord(), true)
  focused.panel.dispose()
  assert.equal(other.isPendingChord(), false)

  assert.equal(calls.close, 0)
  assert.equal(calls.interrupt, 0)
  assert.equal(hidden.calls.close, 0)
  assert.equal(hidden.calls.interrupt, 0)
  assert.equal(focused.calls.close, 0)
  assert.equal(focused.calls.interrupt, 0)

  // Disposed input is inert and rendering stays safe.
  const before = render(focused.panel, 80).text
  focused.panel.handleInput('\x1b')
  assert.equal(focused.calls.close, 0)
  assert.equal(render(focused.panel, 80).text, before)
})