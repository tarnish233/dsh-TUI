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

/** Frame body text: border columns removed so section order can be asserted. */
function body(panel: Panel, width: number): string[] {
  return stripTerminalSequences(panel.render(width).join('\n'))
    .split('\n')
    .map(line => line.replace(/^│\s?/, '').replace(/\s*│$/, ''))
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
    assert.match(stripTerminalSequences(lines[0] ?? ''), /^┌─ Help/, 'the frame title names the surface')
    assert.equal(panel.capturesViewportInput, true)
  }

  for (const width of [20, 40]) {
    const { panel } = makePanel({ commands: catalog(), customCommands: customCatalog() })
    const { lines, text } = render(panel, width)
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`)
    const plain = lines.map(line => stripTerminalSequences(line))
    assert.ok(!plain.some(line => /Commands.*Custom commands/.test(line)), `width ${width} must stack`)
    const stacked = body(panel, width)
    const commandsAt = stacked.findIndex(line => /^\s*Commands\b/.test(line))
    const customAt = stacked.findIndex(line => /^\s*Custom comman/.test(line))
    assert.ok(commandsAt >= 0 && customAt > commandsAt, `stacked order at width ${width}: ${JSON.stringify(stacked)}`)
    assert.match(text, /\/deploy <env>/)
  }
})

test('the footer prints real bindings and never claims Enter/choose/select behavior', () => {
  const { panel } = makePanel({ commands: catalog(), customCommands: customCatalog(), rows: 20 })
  const lines = panel.render(80).map(stripTerminalSequences)
  const footer = lines.slice(-3).join('\n')
  assert.match(footer, /\[escape Close\]/, 'the close affordance uses the effective binding')
  assert.match(footer, /\[ctrl\+f Search\]/, 'search is discoverable with its real key')
  assert.doesNotMatch(footer, /enter (select|choose)|Enter to select/i)
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

test('no Skills section exists unless the parent supplies a native snapshot', () => {
  // The historical two-section body is untouched: omitting the option (or
  // passing undefined) adds no heading, separator, count or empty sentence.
  for (const width of [40, 80, 120]) {
    const omitted = render(makePanel({ commands: catalog(), customCommands: customCatalog() }).panel, width)
    const explicit = new HelpPanel(fakeTui(30, 80), {
      commands: catalog(),
      customCommands: customCatalog(),
      keymap: keymap(),
      onClose: () => {},
      onInterrupt: () => {},
      skills: undefined,
    })
    assert.deepEqual(omitted.lines, explicit.render(width))
    assert.doesNotMatch(omitted.text, /Skills/i)
  }
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

  // On a short terminal the note is frame chrome: the frame trims it (and then
  // the status line) before it would eat the body, and the panel never grows
  // past the measured height. With room, it is capped at two painted rows.
  const roomy = makePanel({ commands: catalog(), customCommands: customCatalog(), note: 'Custom commands includes plugin and unattributed native registrations.' })
  const roomyRows = body(roomy.panel, 80).filter(line => /Custom commands includes|registrations/.test(line))
  assert.ok(roomyRows.length > 0, 'the note is shown when there is room')
  assert.ok(roomyRows.length <= 2, `the note took ${roomyRows.length} rows`)

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
  const pageSize = panel.scrollTop
  assert.ok(pageSize > 0, 'PageDown scrolls by the measured body height')
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

test('Esc closes exactly once and default Ctrl+C is the local close, not a native interrupt', () => {
  const closeOnce = makePanel({ commands: catalog() })
  closeOnce.panel.handleInput('\x1b')
  assert.equal(closeOnce.calls.close, 1)
  assert.equal(closeOnce.calls.interrupt, 0)
  closeOnce.panel.handleInput('\x1b')
  closeOnce.panel.handleInput('\r')
  assert.equal(closeOnce.calls.close, 1)

  // Default Ctrl+C is the global `app.clear`; inside the focused panel it is the
  // local close (`list.cancel`), never a native interrupt or a hidden draft clear.
  const cleared = makePanel({ commands: catalog() })
  cleared.panel.handleInput('\x03')
  assert.equal(cleared.calls.close, 1, 'default Ctrl+C closes the focused local surface')
  assert.equal(cleared.calls.interrupt, 0, 'default Ctrl+C must not invoke the native interrupt')
  cleared.panel.handleInput('\x03')
  assert.equal(cleared.calls.close, 1, 'one close, idempotent on the closed panel')

  // An explicit user interrupt override keeps its priority.
  const interrupted = makePanel({ commands: catalog(), keymap: keymap({ 'app.interrupt': 'ctrl+c' }) })
  interrupted.panel.handleInput('\x03')
  assert.equal(interrupted.calls.interrupt, 1)
  assert.equal(interrupted.calls.close, 0, 'an explicit interrupt must not be converted into a local close/answer')
  // Still open and usable while the parent cancels the turn.
  assert.match(render(interrupted.panel, 80).text, /Commands/)
  interrupted.panel.handleInput('\r')
  assert.equal(interrupted.calls.interrupt, 1)
  assert.equal(interrupted.calls.close, 0)
  interrupted.panel.handleInput('\x1b')
  assert.equal(interrupted.calls.close, 1)

  const fallback = makePanel({ commands: catalog(), keymap: keymap({ 'app.interrupt': 'ctrl+x' }), onInterrupt: null })
  fallback.panel.handleInput('\x18')
  assert.equal(fallback.calls.close, 1, 'without a parent handler, explicit interrupt is only a local dismissal')
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
  // The App paints a surface before it can receive keys: the window budget is
  // measured from the frame body width on that first render.
  remapped.panel.render(80)
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
  disabled.panel.render(80)
  for (const key of ['\x0e', '\x1b[B', '\x1b[6~', '\x1b[F', '\x1b[H']) disabled.panel.handleInput(key)
  assert.equal(disabled.panel.scrollTop, 0)
  assert.equal(disabled.calls.close, 0)
})

// ---------------------------------------------------------------------------
// Focus and chord ownership

test('default Ctrl+C cancels a pending chord and then closes locally; an explicit interrupt keeps priority', () => {
  const local = makePanel({ commands: catalog(), keymap: keymap() })
  local.panel.focused = true
  local.panel.handleInput('\x18') // Ctrl+X chord prefix
  assert.equal(local.panel.keymap.isPendingChord(), true)
  local.panel.handleInput('\x03') // default app.clear: chord cancelled, local close
  assert.equal(local.panel.keymap.isPendingChord(), false)
  assert.equal(local.calls.close, 1)
  assert.equal(local.calls.interrupt, 0)

  const explicit = makePanel({ commands: catalog(), keymap: keymap({ 'app.interrupt': 'ctrl+c' }) })
  explicit.panel.focused = true
  explicit.panel.handleInput('\x18')
  assert.equal(explicit.panel.keymap.isPendingChord(), true)
  explicit.panel.handleInput('\x03') // explicit override keeps priority through the chord
  assert.equal(explicit.panel.keymap.isPendingChord(), false)
  assert.equal(explicit.calls.interrupt, 1)
  assert.equal(explicit.calls.close, 0)
})

test('a cancelled chord re-dispatches its fresh key and mismatch keys stay inert', () => {
  const scroll = makePanel({ commands: manyCommands(40), rows: 12 })
  scroll.panel.focused = true
  scroll.panel.render(80)
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
// ---------------------------------------------------------------------------
// Browse stays inert until modal.search (on-demand search design)

test('browse printables, digits, Enter and clicks never execute, filter or trap the panel', () => {
  const { panel, calls } = makePanel({ commands: manyCommands(12), customCommands: [], rows: 24 })
  panel.focused = true
  const before = render(panel, 80).text
  const scrollBefore = panel.scrollTop
  // A regular key sequence in the read-only list: nothing may filter, execute,
  // select or change the surface.
  for (const key of ['x', '1', '9', '?', ' ', '\r', '\n', '\t', '\x0f']) panel.handleInput(key)
  assert.equal(panel.searching, false, 'the search field is on demand only')
  assert.equal(panel.scrollTop, scrollBefore)
  assert.equal(render(panel, 80).text, before, 'browse keys are inert and no caret is painted')
  assert.equal(calls.close, 0)
  assert.equal(calls.interrupt, 0)

  // A click on a catalog row is not claimed: it stays native text selection.
  const row = stripTerminalSequences(panel.render(80).join('\n'))
    .split('\n')
    .findIndex(line => /\/cmd0[0-9]/.test(line))
  assert.ok(row > 0)
  const press = panel.handleMouse({
    type: 'press', button: 'left', x: 8, y: row, screenX: 8, screenY: row,
    width: 80, height: panel.render(80).length, shift: false, alt: false, ctrl: false,
  })
  assert.equal(press, undefined, 'catalog rows own no mouse target')
  assert.equal(render(panel, 80).text, before)

  // Even a stale chord prefix must not swallow the next Esc.
  panel.handleInput('\x18') // Ctrl+X prefix from the shared prompt keymap
  assert.equal(panel.searching, false)
  // The next Esc still closes the panel exactly once: no stuck search layer.
  panel.handleInput('\x1b')
  assert.equal(calls.close, 1, 'one Esc closes the read-only panel')
  assert.equal(calls.interrupt, 0, 'and never interrupts the turn')
})

test('the search layer activates only through modal.search, and then Esc leaves it first', () => {
  const { panel, calls } = makePanel({ commands: manyCommands(6), customCommands: [], rows: 24 })
  panel.focused = true
  panel.handleInput('\x06') // Ctrl+F = modal.search
  assert.equal(panel.searching, true)
  for (const char of 'cmd0') panel.handleInput(char)
  assert.match(render(panel, 80).text, /\/cmd0\d/, 'the field really filters')
  assert.equal(calls.close, 0)

  panel.handleInput('\r') // Enter stays inert inside the field
  assert.match(render(panel, 80).text, /\/cmd0\d/, 'Enter neither executes nor clears the query')
  panel.handleInput('\x1b')
  assert.equal(panel.searching, false, 'Esc leaves the search layer')
  assert.equal(calls.close, 0, 'and the surface stays open')
  assert.match(render(panel, 80).text, /\/cmd0[0-9]/, 'the full catalog is listed again')
  panel.handleInput('\x1b')
  assert.equal(calls.close, 1, 'the second Esc closes')
})

// ---------------------------------------------------------------------------
// In-place native catalog refresh (A5): metadata changes, surface does not

test('setCatalog replaces only metadata and preserves the live search query, focus and editor', () => {
  const tui = createFakeTui(24, 80)
  const calls = { close: 0, interrupt: 0 }
  const panel = new HelpPanel(asTui(tui), {
    commands: manyCommands(12),
    customCommands: [],
    keymap: keymap(),
    onClose: () => { calls.close += 1 },
    onInterrupt: () => { calls.interrupt += 1 },
  })
  panel.focused = true
  panel.render(80)
  panel.handleInput('\x06') // Ctrl+F = modal.search
  for (const char of 'cmd1') panel.handleInput(char)
  assert.equal(panel.searching, true)

  const beforeRequests = tui.renderRequests
  panel.setCatalog({
    commands: [{ name: 'model', description: 'Choose a DSH model' }],
    customCommands: customCatalog(),
    note: 'Refreshed after the native command change.',
  })
  assert.ok(tui.renderRequests > beforeRequests, 'the refresh requests a repaint')

  // The same editor keeps its text: the query still filters the NEW catalog.
  const searched = render(panel, 80).text.replace(/\s+/g, ' ')
  assert.equal(panel.searching, true, 'the search layer is not replaced or closed')
  assert.equal(panel.focused, true, 'focus is untouched')
  assert.match(searched, /Nothing matches "cmd1"/, 'the typed query survives the refresh')
  assert.match(searched, /Refreshed after the native command change\./)

  panel.handleInput('\x1b') // leave the search layer: the query is discarded, the surface stays open
  assert.equal(panel.searching, false)
  assert.equal(calls.close, 0)
  const listed = render(panel, 80).text
  assert.match(listed, /\/model/)
  assert.match(listed, /\/deploy <env>/)
  assert.doesNotMatch(listed, /\/cmd0\d/, 'the old catalog is gone')

  // The original keymap and callbacks still own the surface: default Ctrl+C is
  // the local close, the native interrupt hook stays untouched.
  panel.handleInput('\x03')
  assert.equal(calls.interrupt, 0)
  assert.equal(calls.close, 1)
})

test('setCatalog keeps the scroll position and clamps it only in the next render', () => {
  const { panel } = makePanel({ commands: manyCommands(60), rows: 12 })
  panel.render(80)
  panel.handleInput('\x1b[F') // End
  const before = panel.scrollTop
  assert.ok(before > 0)

  // A same-size refresh preserves the reader's place exactly.
  panel.setCatalog({ commands: manyCommands(60), customCommands: [] })
  panel.render(80)
  assert.equal(panel.scrollTop, before)

  // A shorter catalog clamps by the existing render path, never a blank window.
  panel.setCatalog({ commands: manyCommands(3), customCommands: [] })
  const text = render(panel, 80).text
  assert.ok(panel.scrollTop < before, 'a shorter body clamps the kept offset')
  assert.match(text, /\/cmd02/, 'the last row is still visible, never a blank window')
})

test('setCatalog refreshes commands, custom commands, skills and note as one read-only snapshot', () => {
  const { panel } = makePanel({ commands: [{ name: 'help', description: 'Commands and shortcuts' }] })
  assert.doesNotMatch(render(panel, 80).text, /Skills/i)

  panel.setCatalog({
    commands: [{ name: 'review', description: 'Review the current diff' }],
    customCommands: customCatalog(),
    skills: {
      available: true,
      complete: true,
      entries: [{ name: 'review-all', description: 'Review everything', modelInvocable: true }],
    },
    note: 'Native snapshot refreshed.',
  })
  const refreshed = render(panel, 80).text.replace(/\s+/g, ' ')
  assert.match(refreshed, /\/review\b/)
  assert.match(refreshed, /Review the current diff/)
  assert.match(refreshed, /\/deploy <env>/)
  assert.match(refreshed, /Skills/)
  assert.match(refreshed, /\/review-all/)
  assert.match(refreshed, /Native snapshot refreshed\./)

  // Replacing the snapshot without skills/note removes those sections: this is
  // a whole-metadata replacement, not an accumulating overlay.
  panel.setCatalog({ commands: [{ name: 'help', description: 'Commands and shortcuts' }], customCommands: [] })
  const replaced = render(panel, 80).text
  assert.match(replaced, /\/help/)
  assert.doesNotMatch(replaced, /Skills/i)
  assert.doesNotMatch(replaced, /Native snapshot refreshed/)
  assertWidths(panel, [20, 40, 80, 120])
})

test('a closed or disposed Help panel ignores a late catalog refresh', () => {
  const closedTui = createFakeTui(20, 80)
  const closed = new HelpPanel(asTui(closedTui), {
    commands: catalog(),
    customCommands: [],
    keymap: keymap(),
    onClose: () => {},
  })
  const closedBefore = render(closed, 80).text
  closed.handleInput('\x1b')
  const closedRequests = closedTui.renderRequests
  closed.setCatalog({ commands: [{ name: 'late', description: 'late' }], customCommands: [], note: 'late note' })
  assert.equal(closedTui.renderRequests, closedRequests, 'a closed surface requests no repaint')
  assert.equal(render(closed, 80).text, closedBefore)
  assert.doesNotMatch(render(closed, 80).text, /late note/)

  const disposedTui = createFakeTui(20, 80)
  const disposed = new HelpPanel(asTui(disposedTui), {
    commands: catalog(),
    customCommands: [],
    keymap: keymap(),
    onClose: () => {},
  })
  disposed.render(80)
  disposed.dispose()
  const disposedRequests = disposedTui.renderRequests
  disposed.setCatalog({ commands: [{ name: 'late', description: 'late' }], customCommands: [], note: 'late note' })
  assert.equal(disposedTui.renderRequests, disposedRequests, 'a disposed surface requests no repaint')
  assert.doesNotMatch(render(disposed, 80).text, /late note/)
  assert.equal(disposed.isDisposed, true)
})
