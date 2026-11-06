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
const CTRL_O = '\x0f'
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
} = {}): Harness {
  const tui = createFakeTui(options.rows ?? 40, 100)
  const copies: string[] = []
  const events: string[] = []
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
  })
  dialog.focused = true
  const lines = (width = 80): string[] => dialog.render(width)
  return {
    dialog,
    copies,
    events,
    renders: () => tui.renderRequests,
    tui,
    lines,
    text: (width = 80) => stripTerminalSequences(lines(width).join('\n')),
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

function click(dialog: Details, lines: string[], row: number, col: number, width = 80): void {
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

// ---------------------------------------------------------------------------
// Frame and honest state

test('renders the tool header, section tabs, status and preformatted input', () => {
  const { dialog, text } = harness()
  const rendered = text()
  assert.match(rendered, /Tool details · Bash/)
  assert.match(rendered, /Input/)
  assert.match(rendered, /Output/)
  assert.match(rendered, /done/)
  assert.match(rendered, /command: npm test/)
  assert.match(rendered, /description: run tests/)
  assert.equal(dialog.capturesViewportInput, true)
  assert.equal(dialog.section, 'input')
  assert.equal(dialog.focused, true)
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
  assert.match(harnessText(dialog, 50), /finished/)
  assert.match(harnessText(dialog, 50), /done/)

  // A newer, larger result does not silently follow the end while scrolled.
  dialog.handleInput(END)
  const outputScroll = dialog.scrollTop('output')
  dialog.setTool({ ...initial, version: 3, status: 'done', resultText: 'finished\n' + Array.from({ length: 200 }, (_, index) => `more-${index}`).join('\n') })
  dialog.render(50)
  assert.equal(dialog.scrollTop('output'), outputScroll, 'scroll is preserved across version updates')
  dialog.handleInput(END)
  dialog.render(50)
  assert.match(harnessText(dialog, 50), /more-199/)
})

/** Render without a harness closure (small helper for mutation tests). */
function harnessText(dialog: Details, width: number): string {
  return stripTerminalSequences(dialog.render(width).join('\n'))
}

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

test('copy and section hints come from the effective keymap', () => {
  const remapped = input.createCcKeymap({
    bindings: {
      'tool.details.copy': 'y',
      'tool.details.next-section': 'n',
      'tool.details.previous-section': 'p',
    },
  })
  const { dialog, text, copies } = harness({ keymap: remapped })
  assert.match(text(), /N\/P section/)
  assert.match(text(), /Y copy/)
  dialog.handleInput('c')
  assert.equal(copies.length, 0, 'the old copy key is gone')
  dialog.handleInput('n')
  assert.equal(dialog.section, 'output')
  dialog.handleInput('p')
  assert.equal(dialog.section, 'input')
  dialog.handleInput('y')
  assert.equal(copies.length, 1)

  const disabled = input.createCcKeymap({
    bindings: { 'tool.details.copy': null, 'tool.details.next-section': null, 'tool.details.previous-section': null },
  })
  const off = harness({ keymap: disabled })
  assert.doesNotMatch(off.text(), /copy/)
  assert.doesNotMatch(off.text(), /section/)
  off.dialog.handleInput('c')
  off.dialog.handleInput(TAB)
  assert.equal(off.dialog.section, 'input')
  assert.equal(off.copies.length, 0)
})

test('disabled modal actions never fall through to permission or tool-expand globals', () => {
  const keymap = input.createCcKeymap({
    bindings: { 'tool.details.previous-section': null, 'tool.details.next-section': null, 'tool.details.copy': null },
  })
  const { dialog, events, renders } = harness({ keymap })
  dialog.render(80)
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

  // The details chord itself is also inert once already inside the modal.
  dialog.handleInput(CTRL_X)
  dialog.handleInput(CTRL_O)
  assert.equal(dialog.isDone, false)
  assert.equal(dialog.section, 'input')
  assert.equal(renders(), before)
})

test('Ctrl+C is the global interrupt, Esc closes, and chords never leak', () => {
  const interrupt = harness({ withInterrupt: true })
  interrupt.dialog.handleInput(CTRL_C)
  assert.deepEqual(interrupt.events.filter(event => event === 'interrupt'), ['interrupt'])
  assert.equal(interrupt.dialog.isDone, false, 'interrupt is not a local close')

  const local = harness()
  local.dialog.handleInput(CTRL_C)
  assert.equal(local.dialog.isDone, true, 'without a handler the surface closes through onClose')
  assert.deepEqual(local.events.filter(event => event === 'close'), ['close'])

  const esc = harness()
  esc.dialog.handleInput(ESC)
  assert.equal(esc.dialog.isDone, true)

  // Read-only: editor movement/kill/undo never reach it.
  const editing = harness()
  editing.dialog.handleInput('\x01')
  editing.dialog.handleInput('\x17')
  editing.dialog.handleInput('\x1f')
  assert.equal(editing.dialog.notice, '')
})

test('closing and copy follow remapped list/dialog bindings', async () => {
  const keymap = input.createCcKeymap({
    bindings: { 'list.cancel': 'q', 'dialog.cancel': 'q', 'app.cancel': 'ctrl+g', 'tool.details.copy': 'y' },
  })
  const { dialog, events, copies, text } = harness({ keymap })
  assert.match(text(), /Q close/)
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

test('mouse clicks switch sections, copy and close at the rendered coordinates', async () => {
  const { dialog, copies, events, lines } = harness()
  const frame = lines(80)
  assert.equal(dialog.section, 'input')
  click(dialog, frame, 2, columnOf(frame[2]!, 'Output'), 80)
  assert.equal(dialog.section, 'output')

  const outputFrame = lines(80)
  click(dialog, outputFrame, 2, columnOf(outputFrame[2]!, 'Input'), 80)
  assert.equal(dialog.section, 'input')

  const copyRow = rowOf(lines(80), '[ Copy ]')
  const copyFrame = lines(80)
  click(dialog, copyFrame, copyRow, columnOf(copyFrame[copyRow]!, 'Copy'), 80)
  await tick()
  assert.deepEqual(copies, [toolCopyText(tool(), 'input')])

  const closeRow = rowOf(lines(80), '[ Close ]')
  const closeFrame = lines(80)
  click(dialog, closeFrame, closeRow, columnOf(closeFrame[closeRow]!, 'Close'), 80)
  assert.equal(dialog.isDone, true)
  assert.deepEqual(events.filter(event => event === 'close'), ['close'])
})

test('wheel events scroll the active section through the same public scroll state', () => {
  const item = tool({ resultText: Array.from({ length: 100 }, (_, index) => `wheel-${index}`).join('\n') })
  const { dialog, lines } = harness({ item, rows: 24, section: 'output' })
  dialog.render(60)
  assert.equal(dialog.scrollTop('output'), 0)
  dialog.handleMouse?.({
    type: 'wheel', button: 'none', x: 3, y: 5, screenX: 3, screenY: 5,
    width: 60, height: lines(60).length, shift: false, alt: false, ctrl: false, wheelDelta: 4,
  })
  assert.equal(dialog.scrollTop('output'), 4)
  dialog.handleMouse?.({
    type: 'wheel', button: 'none', x: 3, y: 5, screenX: 3, screenY: 5,
    width: 60, height: lines(60).length, shift: false, alt: false, ctrl: false, wheelDelta: -2,
  })
  assert.equal(dialog.scrollTop('output'), 2)
})

test('hitboxes are rebuilt on resize and stale coordinates stop working', () => {
  const { dialog, events, lines } = harness()
  const wide = lines(80)
  const closeRow = rowOf(wide, '[ Close ]')
  const closeCol = columnOf(wide[closeRow]!, 'Close')

  // At width 12 the Close button is clipped away; the old coordinates are inert.
  const narrow = lines(12)
  assert.equal(dialog.handleMouse?.({
    type: 'click', button: 'left', x: closeCol, y: closeRow, screenX: closeCol, screenY: closeRow,
    width: 12, height: narrow.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  }), undefined)
  assert.equal(dialog.isDone, false)
  assert.deepEqual(events.filter(event => event === 'close'), [])

  // After growing again the button has a fresh hitbox and works.
  const wideAgain = lines(60)
  const row = rowOf(wideAgain, '[ Close ]')
  click(dialog, wideAgain, row, columnOf(wideAgain[row]!, 'Close'), 60)
  assert.equal(dialog.isDone, true)
})

test('resize keeps every line inside the width, including width 1', () => {
  const long = tool({
    arguments: JSON.stringify({ command: 'a'.repeat(400) }),
    resultText: Array.from({ length: 60 }, (_, index) => `very long output line ${index} ` + 'z'.repeat(120)).join('\n'),
  })
  const { dialog } = harness({ item: long })
  for (const width of [1, 24, 40, 80, 120]) {
    for (const line of dialog.render(width)) {
      assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
    }
  }
  dialog.handleInput(TAB)
  for (const width of [1, 24, 40, 80, 120]) {
    for (const line of dialog.render(width)) {
      assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
    }
  }
})

test('maxHeight bounds the frame so an overlay never clips the footer', () => {
  const { dialog, lines } = harness({ rows: 40, maxHeight: 14 })
  const frame = lines(80)
  assert.ok(frame.length <= 14, `${frame.length} lines exceed maxHeight`)
  assert.ok(frame.some(line => stripTerminalSequences(line).includes('[ Copy ]')))

  const tiny = harness({ maxHeight: 6 })
  assert.ok(tiny.lines(80).length <= 8, 'a tiny cap still renders a bounded frame')
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
  assert.deepEqual(dialog.render(80), [])
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

test('different callIds keep the section, reset scroll and never call onClose', () => {
  const bigInput = JSON.stringify({ command: Array.from({ length: 300 }, (_, index) => `step-${index}`).join('\n') })
  const { dialog, events } = harness({ item: tool({ arguments: bigInput }) })
  dialog.handleInput(TAB)
  assert.equal(dialog.section, 'output')
  dialog.handleInput(TAB)
  assert.equal(dialog.section, 'input')
  dialog.render(50)
  dialog.handleInput(END)
  assert.ok(dialog.scrollTop('input') > 0)

  dialog.setTool(tool({ callId: 'call-2', name: 'read', arguments: bigInput }))
  assert.deepEqual(events.filter(event => event === 'close'), [])
  assert.equal(dialog.currentTool.callId, 'call-2')
  assert.equal(dialog.section, 'input', 'cross-call navigation keeps the reader in the same section')
  dialog.render(50)
  assert.equal(dialog.scrollTop('input'), 0, 'a different call starts at its own top')
})
// ---------------------------------------------------------------------------
// Multi-call inspector navigation (optional parent hooks)

type NavPosition = { index: number; total: number }

function navigationHarness(position: NavPosition, extra: Parameters<typeof harness>[0] = {}): Harness {
  return harness({
    getToolNavigation: () => ({ ...position }),
    onPreviousTool: () => {},
    onNextTool: () => {},
    ...extra,
  })
}

test('toolbar reads the live Tool N / total count on every render', () => {
  const position: NavPosition = { index: 1, total: 3 }
  const { dialog, text } = navigationHarness(position)
  assert.match(text(), /Tool 2 \/ 3/)
  assert.match(text(), /\[Prev\]/)
  assert.match(text(), /\[Next\]/)
  assert.match(text(), /\[\/\] tool/, 'the nav keys come from the effective keymap')

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
  nav.dialog.render(80)
  nav.events.length = 0
  nav.dialog.handleInput('[')
  nav.dialog.handleInput('\x1b[1;3D')
  assert.deepEqual(nav.events, [])
  nav.dialog.handleInput(']')
  assert.deepEqual(nav.events, ['next'])

  // Right boundary: Next is inert.
  position.index = 2
  nav.dialog.render(80)
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
  assert.match(custom.text(), /P\/N tool/)
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
  assert.doesNotMatch(off.text(), /P\/N tool|\[\/\] tool/)
  off.dialog.handleInput('[')
  off.dialog.handleInput(']')
  assert.deepEqual(off.events, [])

  // A single-call surface never advertises or reacts to the nav actions.
  const standalone = harness()
  assert.doesNotMatch(standalone.text(), /\[\/\] tool/)
  standalone.dialog.handleInput(']')
  assert.deepEqual(standalone.events, [])
})

test('mouse Prev/Next navigate once, respect boundaries and never fire on press', () => {
  const position: NavPosition = { index: 0, total: 3 }
  const nav = navigationHarness(position)
  const first = nav.lines(80)
  const nextRow = rowOf(first, '[Next]')
  click(nav.dialog, first, nextRow, columnOf(first[nextRow]!, 'Next'), 80)
  assert.deepEqual(nav.events.filter(event => event === 'next'), ['next'])

  // Press is claimed but does not navigate; the synthesized click navigates once
  // even when a repaint happened between press and release.
  nav.events.length = 0
  const frame = nav.lines(80)
  const row = rowOf(frame, '[Next]')
  const col = columnOf(frame[row]!, 'Next')
  const press = nav.dialog.handleMouse?.({
    type: 'press', button: 'left', x: col, y: row, screenX: col, screenY: row,
    width: 80, height: frame.length, shift: false, alt: false, ctrl: false,
  })
  assert.equal(press?.handled, true)
  assert.deepEqual(nav.events, [], 'a press alone never navigates')
  position.index = 1 // the list updated (e.g. another call arrived) between press/release
  nav.dialog.render(80)
  nav.dialog.handleMouse?.({
    type: 'release', button: 'left', x: col, y: row, screenX: col, screenY: row,
    width: 80, height: frame.length, shift: false, alt: false, ctrl: false,
  })
  click(nav.dialog, nav.lines(80), row, col, 80)
  assert.deepEqual(nav.events.filter(event => event === 'next'), ['next'], 'one press/release is exactly one navigation')

  // Left boundary: the dim Prev control has no hitbox at all.
  position.index = 0
  nav.dialog.render(80)
  nav.events.length = 0
  const boundary = nav.lines(80)
  const prevRow = rowOf(boundary, 'Prev')
  assert.equal(nav.dialog.handleMouse?.({
    type: 'click', button: 'left', x: columnOf(boundary[prevRow]!, 'Prev'), y: prevRow,
    screenX: 0, screenY: 0, width: 80, height: boundary.length,
    shift: false, alt: false, ctrl: false, clickCount: 1,
  }), undefined)
  assert.deepEqual(nav.events, [])
})

test('narrow layouts collapse the controls but keep keyboard navigation', () => {
  const position: NavPosition = { index: 1, total: 3 }
  const nav = navigationHarness(position)
  const compact = nav.lines(24)
  assert.ok(compact.some(line => stripTerminalSequences(line).includes('Tool 2 / 3')))
  assert.ok(compact.some(line => stripTerminalSequences(line).includes('‹')))
  assert.ok(compact.some(line => stripTerminalSequences(line).includes('›')))
  for (const line of compact) assert.ok(visibleWidth(line) <= 24, `${visibleWidth(line)} > 24`)

  // Mouse still works on the compact control.
  const row = nav.lines(24).findIndex(line => stripTerminalSequences(line).includes('›'))
  assert.ok(row >= 0)
  const frame = nav.lines(24)
  click(nav.dialog, frame, row, columnOf(frame[row]!, '›'), 24)
  assert.deepEqual(nav.events, ['next'])

  // Width 1 has no room for a hitbox, but the key path is still live.
  for (const line of nav.lines(1)) assert.ok(visibleWidth(line) <= 1)
  nav.dialog.render(1)
  nav.dialog.handleInput('[')
  assert.deepEqual(nav.events, ['next', 'prev'])

  // Wide layout shows the full labels.
  assert.match(stripTerminalSequences(nav.lines(80).join('\n')), /\[Prev\]/)
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
  const tail = stripTerminalSequences(nav.lines(24).join('\n'))
  assert.match(tail, /第119行/)
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
