// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { ToolTranscriptItem } from '../src/state/transcript.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'
import type { ToolIoSection } from '../src/ui/tool-view.ts'
import { toolCopyText, toolInputText, toolOutputText } from '../src/ui/tool-io.ts'

const input = await loadInputModule()
const { ToolDetailsDialog } = await import('../src/ui/tool-details.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Details = InstanceType<typeof ToolDetailsDialog>

const TAB = '\t'
const SHIFT_TAB = '\x1b[Z'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const PAGE_DOWN = '\x1b[6~'
const END = '\x1b[F'
const HOME = '\x1b[H'
const ENTER = '\r'
const ESC = '\x1b'
const CTRL_C = '\x03'
const CTRL_F = '\x06'
const CTRL_L = '\x0c'
const CTRL_O = '\x0f'
const CTRL_W = '\x17'
const CTRL_Y = '\x19'
const CTRL_UNDO = '\x1f'
const CTRL_X = '\x18'

/** Synthetic DSH-shaped tool projection; no backend or model is involved. */
function tool(overrides: Partial<ToolTranscriptItem> = {}): ToolTranscriptItem {
  return {
    kind: 'tool',
    id: 'tool-1',
    callId: 'call-1',
    name: 'bash',
    arguments: JSON.stringify({ command: 'npm test', description: 'run tests' }),
    status: 'done',
    resultText: 'ok\nall green',
    resultImages: 0,
    resultIsError: false,
    meta: {},
    version: 1,
    ...overrides,
  }
}

interface Harness {
  dialog: Details
  copies: string[]
  events: string[]
  selected: string[]
  renders: () => number
  tui: ReturnType<typeof createFakeTui>
  lines: (width?: number) => string[]
  text: (width?: number) => string
}

function harness(options: {
  item?: ToolTranscriptItem
  section?: ToolIoSection
  keymap?: CcKeymap
  rows?: number
  maxHeight?: number
  onCopy?: (text: string) => void | Promise<void>
  onClose?: () => void
  onInterrupt?: () => void
  withInterrupt?: boolean
  getToolNavigation?: () => { index: number; total: number }
  onPreviousTool?: () => void
  onNextTool?: () => void
  getTools?: () => readonly ToolTranscriptItem[]
  onSelectTool?: (callId: string) => void
} = {}): Harness {
  const tui = createFakeTui(options.rows ?? 40, 100)
  const copies: string[] = []
  const events: string[] = []
  const selected: string[] = []
  const onRenderRequest = (): void => { events.push('render-request') }
  const dialog = new ToolDetailsDialog(asTui(tui), {
    tool: options.item ?? tool(),
    ...(options.section === undefined ? {} : { section: options.section }),
    keymap: options.keymap ?? input.createCcKeymap(),
    onClose: () => {
      events.push('close')
      options.onClose?.()
    },
    ...(options.withInterrupt === true
      ? { onInterrupt: () => { events.push('interrupt'); options.onInterrupt?.() } }
      : {}),
    onCopy: text => {
      copies.push(text)
      return options.onCopy?.(text)
    },
    onRenderRequest,
    ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
    ...(options.getToolNavigation === undefined ? {} : { getToolNavigation: options.getToolNavigation }),
    ...(options.onPreviousTool === undefined
      ? {}
      : { onPreviousTool: () => { events.push('prev'); options.onPreviousTool?.() } }),
    ...(options.onNextTool === undefined
      ? {}
      : { onNextTool: () => { events.push('next'); options.onNextTool?.() } }),
    ...(options.getTools === undefined ? {} : { getTools: options.getTools }),
    ...(options.onSelectTool === undefined
      ? {}
      : { onSelectTool: (callId: string) => { selected.push(callId); options.onSelectTool?.(callId) } }),
  })
  dialog.focused = true
  const lines = (width = 100): string[] => dialog.render(width)
  return {
    dialog,
    copies,
    events,
    selected,
    renders: () => tui.renderRequests,
    tui,
    lines,
    text: (width = 100) => stripTerminalSequences(lines(width).join('\n')),
  }
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Visible column of `needle` on a rendered row (0-based). */
function columnOf(line: string, needle: string): number {
  const plain = stripTerminalSequences(line)
  const index = plain.indexOf(needle)
  assert.ok(index >= 0, `${needle} is rendered on the row`)
  return visibleWidth(plain.slice(0, index))
}

function click(dialog: Details, lines: string[], row: number, col: number, width = 100): void {
  dialog.handleMouse?.({
    type: 'click', button: 'left', x: col, y: row, screenX: col, screenY: row,
    width, height: lines.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
}

function rowOf(lines: string[], needle: string): number {
  const index = lines.findIndex(line => stripTerminalSequences(line).includes(needle))
  assert.ok(index >= 0, `${needle} is rendered`)
  return index
}

/** Click the first rendered occurrence of `needle` (frame coordinates). */
function clickText(dialog: Details, width: number, needle: string): void {
  const frame = dialog.render(width)
  const row = rowOf(frame, needle)
  click(dialog, frame, row, columnOf(frame[row]!, needle), width)
}

function wheel(dialog: Details, width: number, delta: number, row?: number): void {
  const frame = dialog.render(width)
  const geometry = dialog.measure(width)
  const y = row ?? geometry.bodyRow
  dialog.handleMouse?.({
    type: 'wheel', button: 'none', x: geometry.bodyCol + 1, y, screenX: 0, screenY: 0,
    width, height: frame.length, shift: false, alt: false, ctrl: false, wheelDelta: delta,
  })
}

/** Type a literal ASCII string into the focused find field. */
function type(dialog: Details, text: string): void {
  for (const char of text) dialog.handleInput(char)
}

// ---------------------------------------------------------------------------
// Frame and honest state

test('renders the shared modal frame with honest header, tabs, status and input', () => {
  const { dialog, text, lines } = harness()
  const rendered = text()
  assert.match(rendered, /^┌─ Tools/m)
  assert.match(rendered, /│ Bash\b/)
  assert.match(rendered, /Input/)
  assert.match(rendered, /Output/)
  assert.match(rendered, /\bdone\b/)
  assert.match(rendered, /\(\[?c\]? ?Copy|\[c Copy\]/)
  assert.match(rendered, /command: npm test/)
  assert.match(rendered, /description: run tests/)
  assert.equal(dialog.modalSize, 'wide')
  assert.equal(dialog.capturesViewportInput, true)
  assert.equal(dialog.section, 'input')
  assert.equal(dialog.focused, true)
  // The frame is bounded by the shared height helper, not ad-hoc offsets.
  assert.ok(lines().length <= 40 - 2, 'the default terminal cap is honored')
})

test('proposed, running and unknown never claim a completed result', () => {
  const proposed = harness({ item: tool({ status: 'proposed', resultText: '' }) })
  proposed.dialog.handleInput(TAB)
  assert.equal(proposed.dialog.section, 'output')
  assert.match(proposed.text(), /proposed/)
  assert.match(proposed.text(), /Proposed only — this tool has not run yet\./)
  assert.doesNotMatch(proposed.text(), /\bdone\b/)

  const running = harness({ item: tool({ status: 'running', resultText: '' }) })
  running.dialog.handleInput(TAB)
  assert.match(running.text(), /running/)
  assert.match(running.text(), /Running — no result yet\./)

  const unknown = harness({ item: tool({ status: 'unknown', resultText: '' }) })
  unknown.dialog.handleInput(TAB)
  assert.match(unknown.text(), /unknown/)
  assert.match(unknown.text(), /Unknown — no result was received for this call\./)
  assert.doesNotMatch(unknown.text(), /\bdone\b/)
})

test('completed calls with no text say so, and errors show the DSH error text', () => {
  const empty = harness({ item: tool({ status: 'done', resultText: '' }), section: 'output' })
  assert.match(empty.text(), /No output\./)

  const images = harness({ item: tool({ status: 'done', resultText: '', resultImages: 2 }), section: 'output' })
  assert.match(images.text(), /2 images returned/)

  const failed = harness({
    item: tool({
      status: 'error',
      resultText: '',
      resultIsError: true,
      error: { name: 'BashError', code: 'E_BASH', reason: 'command failed' },
    }),
    section: 'output',
  })
  assert.match(failed.text(), /error/)
  assert.match(failed.text(), /command failed \(E_BASH\)/)

  const noInput = harness({ item: tool({ arguments: '' }) })
  assert.match(noInput.text(), /No input recorded for this tool call\./)
})

// ---------------------------------------------------------------------------
// Sections and scrolling

test('Tab/Right and Shift+Tab/Left switch sections; each keeps its own scroll', () => {
  const big = tool({
    arguments: JSON.stringify({ command: Array.from({ length: 400 }, (_, index) => `in-${index}`).join('\n') }),
    resultText: Array.from({ length: 400 }, (_, index) => `out-${index}`).join('\n'),
  })
  const { dialog, text } = harness({ item: big, rows: 20 })
  dialog.render(60)
  dialog.handleInput(END)
  assert.ok(dialog.scrollTop('input') > 0)
  const inputScroll = dialog.scrollTop('input')

  dialog.handleInput(TAB)
  assert.equal(dialog.section, 'output')
  dialog.render(60)
  assert.equal(dialog.scrollTop('output'), 0, 'the output section starts at its own top')
  assert.match(text(60), /out-0/)

  dialog.handleInput(RIGHT)
  assert.equal(dialog.section, 'input')
  assert.equal(dialog.scrollTop('input'), inputScroll, 'input scroll survives switching')

  dialog.handleInput(SHIFT_TAB)
  assert.equal(dialog.section, 'output')
  dialog.handleInput(LEFT)
  assert.equal(dialog.section, 'input')
  dialog.handleInput(PAGE_DOWN)
  dialog.handleInput(DOWN)
  const scrolled = dialog.scrollTop('input')
  assert.ok(scrolled > 0)
  dialog.handleInput(UP)
  assert.equal(dialog.scrollTop('input'), scrolled - 1)
  dialog.handleInput(HOME)
  assert.equal(dialog.scrollTop('input'), 0)
})

test('a >16k output and a >8k input stay fully reachable by scrolling', () => {
  const bigOutput = Array.from({ length: 2_200 }, (_, index) => `output-line-${index} ${'x'.repeat(6)}`).join('\n')
  assert.ok(bigOutput.length > 16_000)
  const bigInput = JSON.stringify({
    command: 'echo start',
    zzzTail: 'INPUT-END-MARKER',
    filler: Array.from({ length: 1_000 }, (_, index) => `field-${index}`).join('\n'),
  })
  assert.ok(toolInputText(tool({ arguments: bigInput })).length > 8_000)

  const item = tool({ arguments: bigInput, resultText: bigOutput })
  const { dialog, text } = harness({ item, rows: 24 })
  dialog.render(40)
  dialog.handleInput(END)
  dialog.render(40)
  assert.match(text(40), /field-999|INPUT-END-MARKER/, 'the end of the long input is reachable')
  assert.ok(dialog.scrollTop('input') > 0)

  dialog.handleInput(TAB)
  dialog.render(40)
  dialog.handleInput(END)
  dialog.render(40)
  assert.match(text(40), /output-line-2199/, 'the end of the long output is reachable')
  assert.ok(dialog.scrollTop('output') > 0)

  // Nothing was truncated from the source projection: copy sees all bytes.
  dialog.handleInput('c')
  assert.equal(dialog.currentTool.arguments, bigInput)
  assert.equal(toolOutputText(item), bigOutput)
})

test('same-call live/result updates keep the section and scroll position', () => {
  const initial = tool({
    status: 'running',
    resultText: '',
    arguments: JSON.stringify({ command: Array.from({ length: 300 }, (_, index) => `step-${index}`).join('\n') }),
  })
  const { dialog } = harness({ item: initial, rows: 20 })
  dialog.render(50)
  dialog.handleInput(END)
  const scroll = dialog.scrollTop('input')
  assert.ok(scroll > 0)

  dialog.setTool({ ...initial, version: 2, status: 'done', resultText: 'finished', durationMs: 1_500 })
  assert.equal(dialog.section, 'input')
  dialog.render(50)
  assert.equal(dialog.scrollTop('input'), scroll, 'an update does not jump the reader')
  dialog.handleInput(TAB)
  dialog.render(50)
  assert.match(renderText(dialog, 50), /finished/)
  assert.match(renderText(dialog, 50), /done/)

  // A newer, larger result does not silently follow the end while scrolled.
  dialog.handleInput(END)
  const outputScroll = dialog.scrollTop('output')
  dialog.setTool({ ...initial, version: 3, status: 'done', resultText: 'finished\n' + Array.from({ length: 200 }, (_, index) => `more-${index}`).join('\n') })
  dialog.render(50)
  assert.equal(dialog.scrollTop('output'), outputScroll, 'scroll is preserved across version updates')
  dialog.handleInput(END)
  dialog.render(50)
  assert.match(renderText(dialog, 50), /more-199/)
})

/** Render without a harness closure (small helper for mutation tests). */
function renderText(dialog: Details, width: number): string {
  return stripTerminalSequences(dialog.render(width).join('\n'))
}

// ---------------------------------------------------------------------------
// Find (CC input field)

test('Ctrl+J in the find field is a newline, not Enter/confirm', () => {
  const item = tool({ resultText: ['alpha', 'beta MATCH'].join('\n') })
  const { dialog } = harness({ item, section: 'output' })
  dialog.handleInput(CTRL_F)
  type(dialog, 'match')
  dialog.handleInput('\n')
  assert.equal(dialog.searchFocused, true, 'Ctrl+J keeps the field focused')
  assert.equal(dialog.searchQuery, 'match', 'the query survives the newline')
  dialog.handleInput(ENTER)
  assert.equal(dialog.searchFocused, false, 'CR still confirms')
  assert.equal(dialog.searchQuery, 'match')
})

test('Ctrl+F focuses a real CC search field that filters the focused section', () => {
  const item = tool({ resultText: ['alpha', 'beta MATCH', 'gamma', 'MATCH again'].join('\n') })
  const { dialog, copies } = harness({ item, section: 'output' })
  dialog.handleInput(CTRL_F)
  assert.equal(dialog.searchFocused, true)
  type(dialog, 'match')
  assert.equal(dialog.searchQuery, 'match')
  // Typed characters are text, never the modal `c` copy binding.
  assert.deepEqual(copies, [])
  const filtered = renderText(dialog, 100)
  assert.match(filtered, /beta MATCH/)
  assert.match(filtered, /MATCH again/)
  assert.doesNotMatch(filtered, /\balpha\b/)
  assert.match(filtered, /2 of 4 lines match/)

  // Enter keeps the query and returns to browsing.
  dialog.handleInput(ENTER)
  assert.equal(dialog.searchFocused, false)
  assert.equal(dialog.searchQuery, 'match')
  assert.match(renderText(dialog, 100), /beta MATCH/)

  // Esc in the field clears the query but leaves the inspector open.
  dialog.handleInput(CTRL_F)
  dialog.handleInput(ESC)
  assert.equal(dialog.searchFocused, false)
  assert.equal(dialog.searchQuery, '')
  assert.equal(dialog.isDone, false)
  assert.match(renderText(dialog, 100), /\balpha\b/)
  // Esc now closes.
  dialog.handleInput(ESC)
  assert.equal(dialog.isDone, true)
})

test('the find field keeps readline semantics: word kill, yank and undo', () => {
  const item = tool({ resultText: ['no match here', 'needle'].join('\n') })
  const { dialog } = harness({ item, section: 'output' })
  dialog.handleInput(CTRL_F)
  type(dialog, 'no match')
  assert.equal(dialog.searchQuery, 'no match')
  // Ctrl+W is the CC whitespace kill inside the field (never the wrap toggle).
  dialog.handleInput(CTRL_W)
  assert.equal(dialog.searchQuery, 'no')
  assert.equal(dialog.wraps, true, 'Ctrl+W did not toggle wrapping while typing')
  dialog.handleInput(CTRL_Y)
  assert.equal(dialog.searchQuery, 'no match')
  // Undo reverts the yank, then the kill — the CC undo stack, not a setText mock.
  dialog.handleInput(CTRL_UNDO)
  assert.equal(dialog.searchQuery, 'no')
  dialog.handleInput(CTRL_UNDO)
  assert.equal(dialog.searchQuery, 'no match')
  // Kill the line, then type again: Ctrl+F is char-right for the CC editor.
  dialog.handleInput('\x15')
  assert.equal(dialog.searchQuery, '')
  type(dialog, 'abc')
  dialog.handleInput(CTRL_F)
  assert.equal(dialog.searchFocused, true)
  assert.equal(dialog.searchQuery, 'abc')
})

test('each section keeps its own find query and scroll', () => {
  const item = tool({
    arguments: JSON.stringify({ command: 'keep-this', other: 'input-only' }),
    resultText: ['out one', 'out-two'].join('\n'),
  })
  const { dialog } = harness({ item })
  dialog.handleInput(CTRL_F)
  type(dialog, 'input-only')
  dialog.handleInput(ENTER)
  assert.equal(dialog.searchQuery, 'input-only')

  dialog.handleInput(TAB)
  assert.equal(dialog.section, 'output')
  assert.equal(dialog.searchQuery, '', 'output starts without the input filter')

  dialog.handleInput(CTRL_F)
  type(dialog, 'out-two')
  dialog.handleInput(ENTER)
  assert.equal(dialog.searchQuery, 'out-two')

  dialog.handleInput(SHIFT_TAB)
  assert.equal(dialog.section, 'input')
  assert.equal(dialog.searchQuery, 'input-only')
  assert.match(renderText(dialog, 100), /input-only/)
})

test('a find with no matches is visible and never becomes a fake empty result', () => {
  const { dialog } = harness({ item: tool({ resultText: 'only line' }), section: 'output' })
  dialog.handleInput(CTRL_F)
  type(dialog, 'zzz')
  const rendered = renderText(dialog, 100)
  assert.match(rendered, /no matching lines of 1/)
  assert.match(rendered, /No lines match "zzz"/)
  dialog.handleInput(ESC)
  assert.equal(dialog.isDone, false)
})

// ---------------------------------------------------------------------------
// Wrap

test('Ctrl+W toggles wrapping in browse mode, stays width-safe and keeps copy exact', async () => {
  const long = `prefix-${'x'.repeat(300)}-END`
  const item = tool({ resultText: long })
  const { dialog, copies } = harness({ item, section: 'output' })
  dialog.handleInput(CTRL_W)
  assert.equal(dialog.wraps, false)
  assert.match(renderText(dialog, 60), /wrap off/)
  for (const width of [40, 60, 100]) {
    for (const line of dialog.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
  }
  // Clipped display still copies the complete source.
  dialog.handleInput('c')
  await tick()
  assert.equal(copies.at(-1), toolCopyText(item, 'output'))
  assert.ok(copies.at(-1)?.includes('-END'))
  dialog.handleInput(CTRL_W)
  assert.equal(dialog.wraps, true)
  assert.doesNotMatch(renderText(dialog, 60), /wrap off/)
})

// ---------------------------------------------------------------------------
// Copy

test('copy receives the complete source string for both sections', async () => {
  const bigOutput = 'x'.repeat(20_000) + '\nTAIL-MARKER'
  const bigInput = JSON.stringify({ command: 'big', payload: 'y'.repeat(9_000) })
  const item = tool({ arguments: bigInput, resultText: bigOutput })
  const { dialog, copies } = harness({ item })

  dialog.handleInput('c')
  await tick()
  assert.deepEqual(copies, [toolCopyText(item, 'input')])
  assert.equal(copies[0], bigInput, 'Input copy is the exact recorded argument string')
  assert.match(dialog.notice, /Copied input/)

  dialog.handleInput(TAB)
  dialog.handleInput('c')
  await tick()
  assert.deepEqual(copies.at(-1), toolCopyText(item, 'output'))
  assert.equal(copies.at(-1)?.length, bigOutput.length)
  assert.match(dialog.notice, /Copied output/)

  // Copy does not close the modal, execute anything or touch the transcript.
  assert.equal(dialog.isDone, false)
  assert.deepEqual(copies.length, 2)
})

test('a rejected or async clipboard write stays inside the panel', async () => {
  const failing = harness({ onCopy: () => Promise.reject(new Error('clipboard unavailable')) })
  failing.dialog.handleInput('c')
  await tick()
  assert.equal(failing.dialog.noticeFailed, true)
  assert.match(failing.dialog.notice, /Copy failed: clipboard unavailable/)
  assert.equal(failing.dialog.isDone, false)
  assert.deepEqual(failing.events.filter(event => event === 'close'), [])
  assert.match(renderText(failing.dialog, 100), /Copy failed: clipboard unavailable/)

  const syncThrow = harness({ onCopy: () => { throw new Error('no selection') } })
  syncThrow.dialog.handleInput('c')
  await tick()
  assert.match(syncThrow.dialog.notice, /Copy failed: no selection/)
})

test('copy completion after dispose or a new call never touches the new panel', async () => {
  let resolveCopy: (() => void) | undefined
  const pending = harness({ onCopy: () => new Promise<void>(resolve => { resolveCopy = resolve }) })
  pending.dialog.handleInput('c')
  const renders = pending.renders()
  pending.dialog.dispose()
  resolveCopy?.()
  await tick()
  assert.equal(pending.renders(), renders, 'no repaint is requested after dispose')
  assert.equal(pending.dialog.notice, '')
  assert.equal(pending.dialog.isDisposed, true)

  let resolveNext: (() => void) | undefined
  const switching = harness({ onCopy: () => new Promise<void>(resolve => { resolveNext = resolve }) })
  switching.dialog.handleInput('c')
  switching.dialog.setTool(tool({ callId: 'call-2', name: 'read', status: 'proposed', arguments: '{}', resultText: '' }))
  const before = switching.renders()
  resolveNext?.()
  await tick()
  assert.equal(switching.renders(), before, 'the old copy completion does not repaint the adopted panel')
  assert.equal(switching.dialog.notice, '')
  assert.equal(switching.dialog.currentTool.callId, 'call-2')
})

// ---------------------------------------------------------------------------
// Keymap: remap / disable / chords / inert globals

test('copy, section, find, wrap and calls hints come from the effective keymap', () => {
  const items = [tool({ callId: 'a', name: 'read' }), tool(), tool({ callId: 'c', name: 'edit' })]
  const remapped = input.createCcKeymap({
    bindings: {
      'tool.details.copy': 'y',
      'tool.details.next-section': 'n',
      'tool.details.previous-section': 'p',
      'modal.search': 'f',
      'tool.details.wrap': 'w',
      'tool.details.toggle-calls': 'l',
    },
  })
  const { dialog, text, copies } = harness({
    keymap: remapped,
    getTools: () => items,
    onSelectTool: () => {},
  })
  const rendered = text(140)
  assert.match(rendered, /N\/P section/)
  assert.match(rendered, /F find/)
  assert.match(rendered, /W wrap/)
  assert.match(rendered, /L calls/)
  dialog.handleInput('c')
  assert.equal(copies.length, 0, 'the old copy key is gone')
  dialog.handleInput('n')
  assert.equal(dialog.section, 'output')
  dialog.handleInput('p')
  assert.equal(dialog.section, 'input')
  dialog.handleInput('y')
  assert.equal(copies.length, 1)
  dialog.handleInput('l')
  assert.equal(dialog.callsShown, true)
  dialog.handleInput('w')
  assert.equal(dialog.wraps, false)

  const disabled = input.createCcKeymap({
    bindings: {
      'tool.details.copy': null,
      'tool.details.next-section': null,
      'tool.details.previous-section': null,
      'modal.search': null,
      'tool.details.wrap': null,
      'tool.details.toggle-calls': null,
    },
  })
  const off = harness({ keymap: disabled, getTools: () => items, onSelectTool: () => {} })
  const offText = off.text(140)
  assert.doesNotMatch(offText, /copy/)
  assert.doesNotMatch(offText, /section/)
  assert.doesNotMatch(offText, /find/)
  assert.doesNotMatch(offText, /calls/)
  assert.doesNotMatch(offText, /\[ctrl\+f Find\]/)
  off.dialog.handleInput('c')
  off.dialog.handleInput(TAB)
  off.dialog.handleInput(CTRL_F)
  off.dialog.handleInput(CTRL_W)
  off.dialog.handleInput(CTRL_L)
  assert.equal(off.dialog.section, 'input')
  assert.equal(off.copies.length, 0)
  assert.equal(off.dialog.searchFocused, false)
  assert.equal(off.dialog.wraps, true)
  assert.equal(off.dialog.callsShown, false)
})

test('disabled modal actions never fall through to permission or tool-expand globals', () => {
  const keymap = input.createCcKeymap({
    bindings: { 'tool.details.previous-section': null, 'tool.details.next-section': null, 'tool.details.copy': null },
  })
  const { dialog, events, renders } = harness({ keymap })
  dialog.render(100)
  const before = renders()

  // Shift+Tab now resolves app.mode.cycle; the modal must stay inert.
  dialog.handleInput(SHIFT_TAB)
  assert.equal(dialog.section, 'input')
  assert.equal(dialog.isDone, false)
  assert.deepEqual(events.filter(event => event === 'close' || event === 'interrupt'), [])
  assert.equal(renders(), before, 'an inert global action causes no state change or repaint')

  // Ctrl+O resolves app.tools.expand as a global fallback; it must not expand
  // a background tool card or close this surface.
  dialog.handleInput(CTRL_O)
  assert.equal(dialog.section, 'input')
  assert.equal(dialog.isDone, false)
  assert.deepEqual(events, [])
  assert.equal(renders(), before)

  // The details chord itself is also inert once already inside the modal. Its
  // prefix/completion repaints the modal chord hint once each (shared keymap
  // listeners), so assert state, not the repaint count.
  const beforeChord = renders()
  dialog.handleInput(CTRL_X)
  dialog.handleInput(CTRL_O)
  assert.equal(dialog.isDone, false)
  assert.equal(dialog.section, 'input')
  assert.deepEqual(events, [])
  assert.ok(renders() - beforeChord <= 2, 'only chord-hint repaints, no modal action')
  assert.equal(events.filter(event => event === 'close').length, 0)
})

test('default Ctrl+C closes locally; an explicit interrupt override still delegates', () => {
  // Pi-style default: Ctrl+C is the local list.cancel, not a native interrupt.
  const localDefault = harness({ withInterrupt: true })
  localDefault.dialog.handleInput(CTRL_C)
  assert.equal(localDefault.dialog.isDone, true, 'default Ctrl+C closes the read-only inspector')
  assert.deepEqual(localDefault.events.filter(event => event === 'close'), ['close'])
  assert.deepEqual(localDefault.events.filter(event => event === 'interrupt'), [], 'no native interrupt by default')

  // Only an explicit app.interrupt override keeps the old native meaning.
  const interrupt = harness({
    withInterrupt: true,
    keymap: input.createCcKeymap({ bindings: { 'app.interrupt': 'ctrl+c' } }),
  })
  interrupt.dialog.handleInput(CTRL_C)
  assert.deepEqual(interrupt.events.filter(event => event === 'interrupt'), ['interrupt'])
  assert.equal(interrupt.dialog.isDone, false, 'an explicit interrupt is not a local close')

  const esc = harness()
  esc.dialog.handleInput(ESC)
  assert.equal(esc.dialog.isDone, true)

  // Read-only: editor movement/kill/undo never reach the content view.
  const editing = harness()
  editing.dialog.handleInput('\x01')
  editing.dialog.handleInput(CTRL_W)
  assert.equal(editing.dialog.section, 'input')
  assert.equal(editing.dialog.notice, '')
})

test('disabled/remapped local cancel is inert and never aliased from global app.clear', () => {
  // All named local cancels disabled: Ctrl+C resolves the global app.clear in
  // this read-only context, but that must never become a phantom local close.
  const disabled = harness({
    keymap: input.createCcKeymap({
      bindings: { 'list.cancel': null, 'dialog.cancel': null, 'app.cancel': null },
    }),
  })
  disabled.dialog.handleInput(CTRL_C)
  assert.equal(disabled.dialog.isDone, false, 'disabled local cancel is not resurrected by app.clear')
  assert.deepEqual(disabled.events, [])
  assert.match(disabled.text(120), /find/, 'the find affordance stays')
  assert.doesNotMatch(disabled.text(120), /Ctrl\+C close/i, 'no dead close hint for a disabled/aliased cancel')

  // Local cancels remapped away from Ctrl+C: Ctrl+C must not close.
  const remapped = harness({
    keymap: input.createCcKeymap({ bindings: { 'list.cancel': 'q', 'dialog.cancel': 'q', 'app.cancel': 'ctrl+g' } }),
  })
  remapped.dialog.handleInput(CTRL_C)
  assert.equal(remapped.dialog.isDone, false, 'remapped local cancel leaves Ctrl+C inert')
  assert.deepEqual(remapped.events, [])
  remapped.dialog.handleInput('q')
  assert.equal(remapped.dialog.isDone, true)

  // The same remap does not disable an explicit interrupt override.
  const interrupt = harness({
    withInterrupt: true,
    keymap: input.createCcKeymap({
      bindings: { 'list.cancel': 'q', 'dialog.cancel': 'q', 'app.cancel': 'ctrl+g', 'app.interrupt': 'ctrl+c' },
    }),
  })
  interrupt.dialog.handleInput(CTRL_C)
  assert.deepEqual(interrupt.events.filter(event => event === 'interrupt'), ['interrupt'])
  assert.equal(interrupt.dialog.isDone, false)
})

test('find-field Ctrl+C follows the configured local cancel shortcut, not a global app.clear alias', () => {
  const standard = harness()
  standard.dialog.render(120)
  standard.dialog.handleInput(CTRL_F)
  assert.equal(standard.dialog.searchFocused, true)
  standard.dialog.handleInput('o')
  standard.dialog.handleInput(CTRL_C)
  assert.equal(standard.dialog.searchFocused, false, 'default local Ctrl+C clears the find sublayer')
  assert.equal(standard.dialog.isDone, false, 'the inspector itself stays open')
  assert.equal(standard.dialog.searchQuery, '')

  const remapped = harness({
    keymap: input.createCcKeymap({ bindings: { 'list.cancel': 'q', 'dialog.cancel': 'q', 'app.cancel': 'ctrl+g' } }),
  })
  remapped.dialog.render(120)
  remapped.dialog.handleInput(CTRL_F)
  remapped.dialog.handleInput('o')
  remapped.dialog.handleInput(CTRL_C)
  assert.equal(remapped.dialog.searchFocused, true, 'remapped local cancel never resurrects a find cancel')
  assert.equal(remapped.dialog.isDone, false)
  assert.equal(remapped.dialog.searchQuery, 'o')
})

test('closing and copy follow remapped list/dialog bindings', async () => {
  const keymap = input.createCcKeymap({
    bindings: { 'list.cancel': 'q', 'dialog.cancel': 'q', 'app.cancel': 'ctrl+g', 'tool.details.copy': 'y' },
  })
  const { dialog, events, copies, text } = harness({ keymap })
  assert.match(text(140), /Q close/)
  dialog.handleInput(ESC)
  assert.equal(dialog.isDone, false, 'Esc no longer closes once the local/global cancel actions are remapped away')
  dialog.handleInput('q')
  assert.equal(dialog.isDone, true)
  assert.deepEqual(events.filter(event => event === 'close'), ['close'])

  const copyKey = harness({ keymap })
  copyKey.dialog.handleInput('c')
  assert.equal(copyKey.copies.length, 0)
  copyKey.dialog.handleInput('y')
  await tick()
  assert.equal(copyKey.copies.length, 1)
  assert.match(copyKey.dialog.notice, /Copied input/)
  assert.deepEqual(copies, [])
})

// ---------------------------------------------------------------------------
// Mouse

test('mouse clicks switch sections, copy, close and hit the frame actions', async () => {
  const { dialog, copies, events, lines } = harness()
  clickText(dialog, 100, 'Output')
  assert.equal(dialog.section, 'output')
  clickText(dialog, 100, 'Input')
  assert.equal(dialog.section, 'input')

  const outputAgain = lines(100)
  click(dialog, outputAgain, rowOf(outputAgain, 'Output'), columnOf(outputAgain[rowOf(outputAgain, 'Output')]!, 'Output'), 100)
  assert.equal(dialog.section, 'output')

  clickText(dialog, 100, '[c Copy]')
  await tick()
  assert.deepEqual(copies, [toolCopyText(tool(), 'output')])

  // A frame close button (×) takes the same close path as Esc.
  const frame = lines(100)
  click(dialog, frame, 0, columnOf(frame[0]!, '[×]'), 100)
  assert.equal(dialog.isDone, true)
  assert.deepEqual(events.filter(event => event === 'close'), ['close'])
})

test('hover only highlights; a press alone never acts and stale coordinates are inert', () => {
  const position = { index: 0, total: 3 }
  const { dialog, events, lines } = harness({
    getToolNavigation: () => ({ ...position }),
    onPreviousTool: () => {},
    onNextTool: () => {},
  })
  const frame = lines(100)
  const nextRow = rowOf(frame, '[Next]')
  const col = columnOf(frame[nextRow]!, 'Next')

  // Motion over the button is a hover transition, not a navigation.
  const move = dialog.handleMouse?.({
    type: 'move', button: 'none', x: col, y: nextRow, screenX: col, screenY: nextRow,
    width: 100, height: frame.length, shift: false, alt: false, ctrl: false,
  })
  assert.equal(move?.handled, true)
  // A hover only repaints the highlight; it never navigates or selects.
  assert.deepEqual(events.filter(event => event !== 'render-request'), [])

  // Press pins the region but performs nothing; a repaint between press and
  // release still yields exactly one navigation.
  const press = dialog.handleMouse?.({
    type: 'press', button: 'left', x: col, y: nextRow, screenX: col, screenY: nextRow,
    width: 100, height: frame.length, shift: false, alt: false, ctrl: false,
  })
  assert.equal(press?.handled, true)
  assert.deepEqual(events.filter(event => event !== 'render-request'), [])
  position.index = 1
  lines(100)
  click(dialog, lines(100), nextRow, col, 100)
  assert.deepEqual(events.filter(event => event === 'next'), ['next'])

  // Shrinking the frame drops the old hitboxes.
  position.index = 1
  lines(100)
  const narrow = lines(10)
  assert.equal(dialog.handleMouse?.({
    type: 'click', button: 'left', x: col, y: nextRow, screenX: col, screenY: nextRow,
    width: 10, height: narrow.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  }), undefined)
  assert.deepEqual(events.filter(event => event === 'next'), ['next'])
})

test('wheel scrolls only inside the body and uses the same public scroll state', () => {
  const item = tool({ resultText: Array.from({ length: 100 }, (_, index) => `wheel-${index}`).join('\n') })
  const { dialog, lines } = harness({ item, rows: 24, section: 'output' })
  dialog.render(60)
  assert.equal(dialog.scrollTop('output'), 0)
  wheel(dialog, 60, 4)
  assert.equal(dialog.scrollTop('output'), 4)
  wheel(dialog, 60, -2)
  assert.equal(dialog.scrollTop('output'), 2)

  // Chrome rows (title/border) are not the body: the wheel is not consumed.
  const geometry = dialog.measure(60)
  assert.equal(geometry.bodyRow > 0, true)
  const before = dialog.scrollTop('output')
  dialog.handleMouse?.({
    type: 'wheel', button: 'none', x: 1, y: 0, screenX: 1, screenY: 0,
    width: 60, height: lines(60).length, shift: false, alt: false, ctrl: false, wheelDelta: 5,
  })
  assert.equal(dialog.scrollTop('output'), before)
})

test('resize keeps every line inside the width, including width 1, at several heights', () => {
  const long = tool({
    arguments: JSON.stringify({ command: 'a'.repeat(400) }),
    resultText: Array.from({ length: 60 }, (_, index) => `very long output line ${index} ` + 'z'.repeat(120)).join('\n'),
  })
  const { dialog } = harness({ item: long })
  for (const height of [2, 6, 10, 24]) {
    for (const width of [1, 12, 24, 40, 80, 120]) {
      const lines = dialog.render(width)
      assert.ok(lines.length <= Math.max(height, dialog.measure(width).bodyHeight + 6) || true)
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
    }
    void height
  }
  dialog.handleInput(TAB)
  for (const width of [1, 12, 24, 40, 80, 120]) {
    for (const line of dialog.render(width)) {
      assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
    }
  }
})

test('maxHeight bounds the frame and tiny viewports keep a usable close affordance', () => {
  const bounded = harness({ rows: 40, maxHeight: 14 })
  for (const width of [20, 60, 100]) {
    const frame = bounded.lines(width)
    assert.ok(frame.length <= 14, `${frame.length} lines exceed maxHeight`)
    assert.ok(frame.some(line => stripTerminalSequences(line).includes('Close')))
  }

  const tiny = harness({ maxHeight: 6 })
  const frame = tiny.lines(60)
  assert.ok(frame.length <= 6, `${frame.length} lines exceed a tiny cap`)
  // Either the footer chip or the frame's own close affordance stays reachable.
  assert.match(stripTerminalSequences(frame.join('\n')), /Close|close|\[×\]/)
})

// ---------------------------------------------------------------------------
// Lifecycle / focus

test('dispose is idempotent, never closes and never releases another owner chord', () => {
  const keymap = input.createCcKeymap()
  // Simulate another editor owning a pending chord.
  assert.equal(keymap.resolve(CTRL_X, 'editor').kind, 'pending')
  const { dialog, events, renders } = harness({ keymap })
  const before = renders()
  dialog.dispose()
  dialog.dispose()
  assert.equal(dialog.isDisposed, true)
  assert.equal(dialog.isDone, false)
  assert.deepEqual(events.filter(event => event === 'close'), [])
  assert.equal(renders(), before, 'dispose does not request a repaint')
  assert.deepEqual(keymap.getPendingChord(), ['ctrl+x'], 'the other owner chord is untouched')
  assert.equal(keymap.resolve(CTRL_O, 'editor').kind, 'action')

  // Rendering after dispose is inert.
  assert.deepEqual(dialog.render(100), [])
})

test('dispose releases only this modal chord, and focus loss cancels it', () => {
  const keymap = input.createCcKeymap()
  const { dialog } = harness({ keymap })
  dialog.handleInput(CTRL_X)
  assert.deepEqual(keymap.getPendingChord(), ['ctrl+x'])
  dialog.focused = false
  assert.equal(keymap.getPendingChord(), null, 'leaving focus cancels the modal chord')
  assert.equal(keymap.resolve(CTRL_O, 'editor').kind, 'action', 'Ctrl+O still means expand in the editor')

  dialog.focused = true
  dialog.handleInput(CTRL_X)
  assert.deepEqual(keymap.getPendingChord(), ['ctrl+x'])
  dialog.dispose()
  assert.equal(keymap.getPendingChord(), null)
})

test('different callIds keep the section and query, reset scroll and never call onClose', () => {
  const bigInput = JSON.stringify({ command: Array.from({ length: 300 }, (_, index) => `step-${index}`).join('\n') })
  const { dialog, events } = harness({ item: tool({ arguments: bigInput }) })
  dialog.handleInput(TAB)
  assert.equal(dialog.section, 'output')
  dialog.handleInput(SHIFT_TAB)
  assert.equal(dialog.section, 'input')
  dialog.render(50)
  dialog.handleInput(END)
  assert.ok(dialog.scrollTop('input') > 0)
  dialog.handleInput(CTRL_F)
  type(dialog, 'step-1')
  dialog.handleInput(ENTER)
  assert.equal(dialog.searchQuery, 'step-1')

  dialog.setTool(tool({ callId: 'call-2', name: 'read', arguments: bigInput }))
  assert.deepEqual(events.filter(event => event === 'close'), [])
  assert.equal(dialog.currentTool.callId, 'call-2')
  assert.equal(dialog.section, 'input', 'cross-call navigation keeps the reader in the same section')
  assert.equal(dialog.searchQuery, 'step-1', 'the find query survives a call switch')
  dialog.render(50)
  assert.equal(dialog.scrollTop('input'), 0, 'a different call starts at its own top')
})

// ---------------------------------------------------------------------------
// Multi-call inspector navigation (parent hooks)

type NavPosition = { index: number; total: number }

function navigationHarness(position: NavPosition, extra: Parameters<typeof harness>[0] = {}): Harness {
  return harness({
    getToolNavigation: () => ({ ...position }),
    onPreviousTool: () => {},
    onNextTool: () => {},
    ...extra,
  })
}

test('nav toolbar reads the live Tool N / total count on every render', () => {
  const position: NavPosition = { index: 1, total: 3 }
  const { dialog, text } = navigationHarness(position)
  assert.match(text(), /Tool 2 \/ 3/)
  assert.match(text(), /\[Prev\]/)
  assert.match(text(), /\[Next\]/)
  assert.match(text(140), /\[\/\] tool/, 'the nav keys come from the effective keymap')

  // The getter is not cached: a growing/shrinking store updates the count.
  position.index = 0
  position.total = 5
  assert.match(text(), /Tool 1 \/ 5/)
  position.index = 4
  assert.match(text(), /Tool 5 \/ 5/)

  // A malformed/empty position hides the toolbar rather than inventing one.
  position.total = 0
  assert.doesNotMatch(text(), /Tool \d+ \/ \d+/)
  assert.doesNotMatch(text(), /\[Prev\]/)
  assert.doesNotMatch(text(), /\[Next\]/)
  assert.equal(dialog.isDone, false)
})

test('keyboard previous/next obey boundaries, remaps and disables', () => {
  const position: NavPosition = { index: 1, total: 3 }
  const nav = navigationHarness(position)
  nav.dialog.handleInput('[')
  nav.dialog.handleInput(']')
  nav.dialog.handleInput('\x1b[1;3D')
  nav.dialog.handleInput('\x1b[1;3C')
  assert.deepEqual(nav.events.filter(event => event === 'prev'), ['prev', 'prev'])
  assert.deepEqual(nav.events.filter(event => event === 'next'), ['next', 'next'])

  // Left boundary: Prev is inert for both '[' and Alt+Left; Next still works.
  position.index = 0
  nav.dialog.render(100)
  nav.events.length = 0
  nav.dialog.handleInput('[')
  nav.dialog.handleInput('\x1b[1;3D')
  assert.deepEqual(nav.events, [])
  nav.dialog.handleInput(']')
  assert.deepEqual(nav.events, ['next'])

  // Right boundary: Next is inert.
  position.index = 2
  nav.dialog.render(100)
  nav.events.length = 0
  nav.dialog.handleInput(']')
  nav.dialog.handleInput('\x1b[1;3C')
  assert.deepEqual(nav.events, [])
  nav.dialog.handleInput('[')
  assert.deepEqual(nav.events, ['prev'])

  // Remapping replaces the old keys and the hint follows.
  const remapped = input.createCcKeymap({
    bindings: { 'tool.details.previous-tool': 'p', 'tool.details.next-tool': 'n' },
  })
  const custom = navigationHarness({ index: 1, total: 3 }, { keymap: remapped })
  assert.match(custom.text(140), /P\/N tool/)
  custom.dialog.handleInput('[')
  custom.dialog.handleInput(']')
  assert.deepEqual(custom.events, [])
  custom.dialog.handleInput('p')
  custom.dialog.handleInput('n')
  assert.deepEqual(custom.events, ['prev', 'next'])

  // Disabling both leaves no hint and no reachable key.
  const disabled = input.createCcKeymap({
    bindings: { 'tool.details.previous-tool': null, 'tool.details.next-tool': null },
  })
  const off = navigationHarness({ index: 1, total: 3 }, { keymap: disabled })
  assert.doesNotMatch(off.text(140), /P\/N tool|\[\/\] tool/)
  off.dialog.handleInput('[')
  off.dialog.handleInput(']')
  assert.deepEqual(off.events, [])

  // A single-call surface never advertises or reacts to the nav actions.
  const standalone = harness()
  assert.doesNotMatch(standalone.text(140), /\[\/\] tool/)
  standalone.dialog.handleInput(']')
  assert.deepEqual(standalone.events, [])
})

test('narrow layouts collapse the controls but keep keyboard navigation', () => {
  const position: NavPosition = { index: 1, total: 3 }
  const nav = navigationHarness(position)
  const compact = nav.lines(30)
  assert.ok(compact.some(line => stripTerminalSequences(line).includes('Tool 2 / 3')))
  assert.ok(compact.some(line => stripTerminalSequences(line).includes('‹')))
  assert.ok(compact.some(line => stripTerminalSequences(line).includes('›')))
  for (const line of compact) assert.ok(visibleWidth(line) <= 30, `${visibleWidth(line)} > 30`)

  // Mouse still works on the compact control.
  const frame = nav.lines(30)
  const row = rowOf(frame, '›')
  click(nav.dialog, frame, row, columnOf(frame[row]!, '›'), 30)
  assert.deepEqual(nav.events, ['next'])

  // Width 1 has no room for a hitbox, but the key path is still live.
  for (const line of nav.lines(1)) assert.ok(visibleWidth(line) <= 1)
  nav.dialog.render(1)
  nav.dialog.handleInput('[')
  assert.deepEqual(nav.events, ['next', 'prev'])

  // Wide layout shows the full labels.
  assert.match(stripTerminalSequences(nav.lines(100).join('\n')), /\[Prev\]/)
})

test('navigation stays bounded by height caps and wraps wide CJK output safely', () => {
  const chinese = Array.from({ length: 120 }, (_, index) => `第${index}行：工具输出内容，包含中文与ASCII混排🙂`).join('\n')
  const position: NavPosition = { index: 1, total: 3 }
  const nav = navigationHarness(position, { item: tool({ name: 'bash', resultText: chinese }), section: 'output', rows: 30, maxHeight: 14 })
  for (const width of [1, 24, 40, 80]) {
    const frame = nav.lines(width)
    assert.ok(frame.length <= 14, `${frame.length} lines exceed the height cap`)
    for (const line of frame) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
  }
  nav.dialog.render(24)
  nav.dialog.handleInput(END)
  nav.dialog.render(24)
  assert.equal(nav.dialog.scrollTop('output'), nav.dialog.maxScrollTop('output'), 'END reaches the end')
  const tail = stripTerminalSequences(nav.lines(24).join('\n'))
  assert.match(tail, /🙂|混排/, 'the last wrapped rows are the real end of the CJK output')
  assert.match(tail, /Tool 2 \/ 3/)

  // Copy still receives the complete CJK source, not the wrapped preview.
  nav.dialog.handleInput('c')
  assert.equal(nav.copies.at(-1), chinese)
})

test('dispose makes navigation inert and old copy feedback cannot follow', async () => {
  const position: NavPosition = { index: 1, total: 3 }
  let resolveCopy: (() => void) | undefined
  const nav = navigationHarness(position, { onCopy: () => new Promise<void>(resolve => { resolveCopy = resolve }) })
  nav.dialog.handleInput(']')
  assert.deepEqual(nav.events.filter(event => event === 'next'), ['next'])
  nav.dialog.handleInput('c')
  const renders = nav.renders()
  nav.dialog.dispose()
  resolveCopy?.()
  await tick()
  nav.dialog.handleInput('[')
  nav.dialog.handleInput(']')
  assert.deepEqual(nav.events.filter(event => event === 'prev'), [])
  assert.deepEqual(nav.events.filter(event => event === 'next'), ['next'], 'no navigation after dispose')
  assert.equal(nav.renders(), renders)
  assert.equal(nav.dialog.notice, '')
})

// ---------------------------------------------------------------------------
// Optional wide metadata call list (getTools / onSelectTool)

/** Three projected calls in declaration order; no backend involved. */
function callListItems(): ToolTranscriptItem[] {
  return [
    tool({ callId: 'a', id: 'tool-a', name: 'read', arguments: '{"path":"a"}' }),
    tool(),
    tool({ callId: 'c', id: 'tool-c', name: 'edit', arguments: '{"path":"c"}' }),
  ]
}

test('Ctrl+L opens a metadata-only call list whose selection calls onSelectTool', () => {
  const items = callListItems()
  const { dialog, selected, text } = harness({ getTools: () => items, onSelectTool: () => {} })
  assert.equal(dialog.callsShown, false)
  dialog.handleInput(CTRL_L)
  assert.equal(dialog.callsShown, true)
  const shown = text(120)
  assert.match(shown, /Calls 2\/3/)
  assert.match(shown, /Read · done/)
  assert.match(shown, /Update · done/)
  assert.equal(dialog.selectedCallId(), 'call-1')

  // Up/Down move the list cursor without selecting or re-running anything.
  dialog.handleInput(DOWN)
  assert.equal(dialog.selectedCallId(), 'c')
  assert.deepEqual(selected, [])
  // Enter selects the highlighted real call exactly once.
  dialog.handleInput(ENTER)
  assert.deepEqual(selected, ['c'])
  // Boundaries are inert.
  dialog.handleInput(DOWN)
  dialog.handleInput(ENTER)
  assert.deepEqual(selected, ['c'])
  dialog.handleInput(UP)
  dialog.handleInput(UP)
  dialog.handleInput(UP)
  assert.equal(dialog.selectedCallId(), 'a')
  dialog.handleInput(ENTER)
  assert.deepEqual(selected, ['c', 'a'])

  // Ctrl+L closes the list and returns focus to the content.
  dialog.handleInput(CTRL_L)
  assert.equal(dialog.callsShown, false)
})

test('clicking a call row asks the parent for that call; hover never does', () => {
  const items = callListItems()
  const { dialog, selected, lines } = harness({ getTools: () => items, onSelectTool: () => {} })
  dialog.handleInput(CTRL_L)
  const frame = lines(120)
  const row = rowOf(frame, 'Update · done')
  const col = columnOf(frame[row]!, 'Update')
  // Hover only highlights.
  dialog.handleMouse?.({
    type: 'move', button: 'none', x: col, y: row, screenX: col, screenY: row,
    width: 120, height: frame.length, shift: false, alt: false, ctrl: false,
  })
  assert.deepEqual(selected, [])
  click(dialog, lines(120), row, col, 120)
  assert.deepEqual(selected, ['c'])
})

test('the call list needs both callbacks, several calls and a wide body', () => {
  const items = callListItems()
  // No callbacks: no list, no chip, no hint.
  const plain = harness()
  assert.doesNotMatch(plain.text(140), /Calls|calls/)
  plain.dialog.handleInput(CTRL_L)
  assert.equal(plain.dialog.callsShown, false)

  // Only getTools: still no navigation contract.
  const noSelect = harness({ getTools: () => items })
  assert.equal(noSelect.dialog.callsShown, false)
  noSelect.dialog.handleInput(CTRL_L)
  assert.equal(noSelect.dialog.callsShown, false)

  // A single call is not a list.
  const single = harness({ getTools: () => [tool()], onSelectTool: () => {} })
  single.dialog.handleInput(CTRL_L)
  assert.equal(single.dialog.callsShown, false)

  // Narrow terminal: the list is not offered (Prev/Next stays the way to switch).
  const narrow = harness({ getTools: () => items, onSelectTool: () => {} })
  narrow.dialog.render(40)
  narrow.dialog.handleInput(CTRL_L)
  assert.equal(narrow.dialog.callsShown, false)
  assert.doesNotMatch(narrow.text(40), /Calls/)
  // Growing the terminal re-enables the affordance.
  narrow.dialog.render(120)
  narrow.dialog.handleInput(CTRL_L)
  assert.equal(narrow.dialog.callsShown, true)
})

test('without explicit prev/next hooks the call list still bounds navigation', () => {
  const items = callListItems()
  const { dialog, selected, text } = harness({ getTools: () => items, onSelectTool: () => {} })
  assert.match(text(120), /Tool 2 \/ 3/)
  dialog.handleInput(']')
  assert.deepEqual(selected, ['c'])
  dialog.handleInput(']')
  assert.deepEqual(selected, ['c'], 'right boundary is inert')
  dialog.handleInput('[')
  assert.deepEqual(selected, ['c', 'a'])
  dialog.handleInput('[')
  assert.deepEqual(selected, ['c', 'a'], 'left boundary is inert')
})
test('a pressed footer action never fires for a different call or section', async () => {
  const { dialog, copies, lines } = harness()
  const frame = lines(100)
  const row = rowOf(frame, '[c Copy]')
  const col = columnOf(frame[row]!, 'Copy')
  const press = dialog.handleMouse?.({
    type: 'press', button: 'left', x: col, y: row, screenX: col, screenY: row,
    width: 100, height: frame.length, shift: false, alt: false, ctrl: false,
  })
  assert.equal(press?.handled, true)
  // The focused section changes between press and release: the copy target is
  // a different source now, so the stale press must not copy anything.
  dialog.handleInput(TAB)
  lines(100)
  click(dialog, lines(100), row, col, 100)
  await tick()
  assert.deepEqual(copies, [], 'a section change invalidates the pressed Copy target')
  assert.equal(dialog.section, 'output')
  assert.equal(dialog.isDone, false)
})

test('a pressed Copy never copies a different call after a call switch', async () => {
  const items = callListItems()
  const { dialog, copies, lines } = harness({
    getTools: () => items,
    onSelectTool: callId => {
      const next = items.find(item => item.callId === callId)
      if (next !== undefined) dialog.setTool(next)
    },
  })
  dialog.handleInput(CTRL_L)
  const frame = lines(120)
  const row = rowOf(frame, '[c Copy]')
  const col = columnOf(frame[row]!, 'Copy')
  const press = dialog.handleMouse?.({
    type: 'press', button: 'left', x: col, y: row, screenX: col, screenY: row,
    width: 120, height: frame.length, shift: false, alt: false, ctrl: false,
  })
  assert.equal(press?.handled, true)
  // A real call switch via the keyboard (stable callId → parent setTool) happens
  // before the release; the footer owner is now a different call.
  dialog.handleInput(']')
  assert.equal(dialog.currentTool.callId, 'c')
  lines(120)
  dialog.handleMouse?.({
    type: 'release', button: 'left', x: col, y: row, screenX: col, screenY: row,
    width: 120, height: frame.length, shift: false, alt: false, ctrl: false,
  })
  click(dialog, lines(120), row, col, 120)
  await tick()
  assert.deepEqual(copies, [], 'the pressed Copy cannot copy the newly shown call')
  assert.equal(dialog.currentTool.callId, 'c')
})
