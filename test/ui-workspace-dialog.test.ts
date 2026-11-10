// Must stay FIRST: forces truecolor before src modules snapshot terminal mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '#pi-tui'
import type {
  WorkspaceChangeDiffResult,
  WorkspaceChangesSummary,
  WorkspaceFileDiff,
} from '../src/backend/types.ts'
import { asTui, createFakeTui } from '../src/input/testing/harness.ts'
import { createCcKeymap } from '../src/input/keymap.ts'
import { WorkspaceChangesDialog } from '../src/ui/workspace-changes-dialog.ts'

/**
 * Native workspace diff surface: list/detail, exact identity, late-close and
 * session guards, honest binary/oversized/coarse labels and width safety.
 *
 * The dialog is pure presentation: the only native operation is the injected
 * `loadDiff(seq,index)` request. These tests never read a file, run git or start
 * a watcher, and the fake TUI only counts repaint requests.
 */

const SESSION = 'session-1'
const ATTACH = 'attachment-1'
const SEQ = 7

const DOWN = '\x0e'
const UP = '\x10'
const ENTER = '\r'
const ESC = '\x1b'

const summary: WorkspaceChangesSummary = {
  turn: 3,
  files: [
    { path: '/private/repo/src/greet.ts', display: 'src/greet.ts', added: 12, deleted: 3 },
    { path: '/private/repo/assets/logo.png', display: 'assets/logo.png', added: 0, deleted: 0, binary: true },
    { path: '/private/repo/big.json', display: 'big.json', added: 1000, deleted: 0, oversized: true },
    { path: '/private/repo/src/组件/✅.ts', display: 'src/组件/✅.ts', added: 2, deleted: 1 },
  ],
  total: 4,
  added: 1014,
  deleted: 4,
}

const textDiff = (overrides: Partial<Extract<WorkspaceFileDiff, { kind: 'text' }>> = {}): Extract<WorkspaceFileDiff, { kind: 'text' }> => ({
  kind: 'text',
  path: '/private/repo/src/greet.ts',
  display: 'src/greet.ts',
  before: true,
  after: true,
  coarse: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [' export const x = 1', '-console.log(x)', '+console.log(x + 1)', ' // done'],
    },
  ],
  ...overrides,
})

const binaryDiff: WorkspaceFileDiff = {
  kind: 'binary',
  path: '/private/repo/assets/logo.png',
  display: 'assets/logo.png',
}

const oversizedDiff: WorkspaceFileDiff = {
  kind: 'oversized',
  path: '/private/repo/big.json',
  display: 'big.json',
}

const result = (diff: WorkspaceFileDiff | undefined, overrides: Partial<WorkspaceChangeDiffResult> = {}): WorkspaceChangeDiffResult => ({
  sessionId: SESSION,
  attachmentId: ATTACH,
  seq: SEQ,
  index: 0,
  ...(diff === undefined ? {} : { diff }),
  ...overrides,
})

interface Harness {
  dialog: WorkspaceChangesDialog
  requests: Array<{ seq: number; index: number }>
  closes: () => number
  render: (width?: number) => string[]
  text: (width?: number) => string
}

function create(overrides: {
  summary?: WorkspaceChangesSummary
  loadDiff?: ((seq: number, index: number) => void) | undefined
  isSessionCurrent?: () => boolean
  attachmentId?: string
  initialIndex?: number
} = {}): Harness {
  const tui = createFakeTui(40, 80)
  const requests: Array<{ seq: number; index: number }> = []
  let closes = 0
  const loadDiff = 'loadDiff' in overrides
    ? overrides.loadDiff
    : (seq: number, index: number) => { requests.push({ seq, index }) }
  const dialog = new WorkspaceChangesDialog(asTui(tui), {
    seq: SEQ,
    summary: overrides.summary ?? summary,
    sessionId: SESSION,
    ...('attachmentId' in overrides ? {} : { attachmentId: ATTACH }),
    ...(overrides.attachmentId === undefined ? {} : { attachmentId: overrides.attachmentId }),
    ...(overrides.initialIndex === undefined ? {} : { initialIndex: overrides.initialIndex }),
    keymap: createCcKeymap(),
    ...(loadDiff === undefined ? {} : { loadDiff }),
    ...(overrides.isSessionCurrent === undefined ? {} : { isSessionCurrent: overrides.isSessionCurrent }),
    onClose: () => { closes += 1 },
  })
  return {
    dialog,
    requests,
    closes: () => closes,
    render: (width = 100) => dialog.render(width),
    text: (width = 100) => stripTerminalSequences(dialog.render(width).join('\n')),
  }
}

function fileRow(dialog: WorkspaceChangesDialog, display: string, width = 100): number {
  const lines = dialog.render(width).map(line => stripTerminalSequences(line))
  const row = lines.findIndex(line => line.includes(display))
  assert.ok(row >= 0, `row for ${display}`)
  return row
}

function mouse(type: TuiMouseEvent['type'], row: number, width = 100, height = 40, x = 5): TuiMouseEvent {
  return {
    type,
    button: type === 'move' ? 'none' : 'left',
    x,
    y: row,
    screenX: x,
    screenY: row,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  }
}

function assertWidths(harness: Harness): void {
  for (const width of [4, 8, 16, 24, 40, 80, 120]) {
    const lines = harness.dialog.render(width)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${JSON.stringify(stripTerminalSequences(line))}`)
    }
  }
}

// ---------------------------------------------------------------------------

test('list mode shows every native file fact and advertises a real detail action', () => {
  const harness = create()
  const text = harness.text()
  assert.match(text, /Workspace changes/)
  assert.match(text, /turn 3/)
  assert.match(text, /4 files/)
  assert.match(text, /\+1014/)
  assert.match(text, /-4/)
  assert.match(text, /src\/greet\.ts/)
  assert.match(text, /\+12 -3/)
  assert.match(text, /assets\/logo\.png/)
  assert.match(text, /binary/)
  assert.match(text, /big\.json/)
  assert.match(text, /oversized/)
  assert.match(text, /src\/组件\/✅\.ts/)
  assert.doesNotMatch(text, /private\/repo/, 'only the native display label is painted')
  assertWidths(harness)
})

test('Enter requests the selected file exactly once and a matching result paints the diff', () => {
  const harness = create()
  harness.render()
  harness.dialog.handleInput(ENTER)
  assert.equal(harness.dialog.mode, 'detail')
  assert.equal(harness.dialog.detailIndex, 0)
  assert.deepEqual(harness.requests, [{ seq: SEQ, index: 0 }])
  assert.match(harness.text(), /Reading native diff/)

  const accepted = harness.dialog.setDiff(result(textDiff(), { index: 0 }))
  assert.equal(accepted, true)
  const text = harness.text()
  assert.match(text, /src\/greet\.ts/)
  assert.match(text, /@@ -1,3 \+1,3 @@/)
  assert.match(text, /\+console\.log\(x \+ 1\)/)
  assert.match(text, /-console\.log\(x\)/)
  assert.match(text, /text/)
  assert.doesNotMatch(text, /private\/repo/)
  assertWidths(harness)

  // Reopening the same open file does not issue a second native read.
  harness.dialog.openDetail()
  assert.equal(harness.requests.length, 1)
})

test('coarse native text is labelled coarse, never presented as exact', () => {
  const harness = create()
  harness.render()
  harness.dialog.openDetail(3)
  assert.deepEqual(harness.requests, [{ seq: SEQ, index: 3 }])
  assert.equal(harness.dialog.setDiff(result(textDiff({
    display: 'src/组件/✅.ts',
    path: '/private/repo/src/组件/✅.ts',
    coarse: true,
  }), { index: 3 })), true)
  const text = harness.text()
  assert.match(text, /coarse/i)
  assert.match(text, /Coarse text diff/)
  assertWidths(harness)
})

test('a new/deleted file keeps its native before/after facts', () => {
  const harness = create()
  harness.render()
  harness.dialog.openDetail(0)
  harness.dialog.setDiff(result(textDiff({ before: false, after: true }), { index: 0 }))
  assert.match(harness.text(), /new file/)
  harness.dialog.closeDetail()
  harness.dialog.openDetail(0)
  harness.dialog.setDiff(result(textDiff({ before: true, after: false }), { index: 0 }))
  assert.match(harness.text(), /deleted file/)
})

test('binary and oversized results stay honest and do not fabricate rows', () => {
  const binary = create()
  binary.render()
  binary.dialog.openDetail(1)
  assert.deepEqual(binary.requests, [{ seq: SEQ, index: 1 }])
  assert.equal(binary.dialog.setDiff(result(binaryDiff, { index: 1 })), true)
  const binaryText = binary.text()
  assert.match(binaryText, /Binary file/)
  assert.match(binaryText, /binary/)
  assert.doesNotMatch(binaryText, /@@/)

  const oversized = create()
  oversized.render()
  oversized.dialog.openDetail(2)
  assert.deepEqual(oversized.requests, [{ seq: SEQ, index: 2 }])
  assert.equal(oversized.dialog.setDiff(result(oversizedDiff, { index: 2 })), true)
  const oversizedText = oversized.text()
  assert.match(oversizedText, /too large/)
  assert.match(oversizedText, /oversized/)
  assert.doesNotMatch(oversizedText, /@@/)
})

test('a missing diff payload is stated, not painted as an empty change', () => {
  const harness = create()
  harness.render()
  harness.dialog.openDetail(0)
  assert.equal(harness.dialog.setDiff(result(undefined, { index: 0 })), true)
  assert.match(harness.text(), /No native diff was returned/)
})

test('late, closed, switched and disposed responses are dropped', () => {
  const harness = create()
  harness.render()
  harness.dialog.openDetail(0)
  assert.equal(harness.dialog.setDiff(result(textDiff(), { index: 0 })), true)

  // Closing the detail invalidates its request identity.
  harness.dialog.closeDetail()
  assert.equal(harness.dialog.setDiff(result(textDiff(), { index: 0 })), false)
  assert.equal(harness.dialog.mode, 'list')

  // Switching files makes the previous response stale.
  harness.dialog.openDetail(0)
  harness.dialog.openDetail(1)
  assert.deepEqual(harness.requests, [{ seq: SEQ, index: 0 }, { seq: SEQ, index: 0 }, { seq: SEQ, index: 1 }])
  assert.equal(harness.dialog.setDiff(result(textDiff(), { index: 0 })), false, 'the old index cannot repaint the new file')
  assert.match(harness.text(), /Reading native diff/)
  assert.equal(harness.dialog.setDiff(result(binaryDiff, { index: 1 })), true)
  assert.match(harness.text(), /Binary file/)

  // Disposal is terminal for every late response.
  harness.dialog.dispose()
  assert.equal(harness.dialog.setDiff(result(textDiff(), { index: 1 })), false)
  assert.deepEqual(harness.dialog.render(100), [])
})

test('session, attachment and supplied guard identity are exact', () => {
  let current = true
  const harness = create({ isSessionCurrent: () => current })
  harness.render()
  harness.dialog.openDetail(0)
  assert.equal(harness.dialog.setDiff(result(textDiff(), { sessionId: 'other' })), false)
  assert.equal(harness.dialog.setDiff(result(textDiff(), { attachmentId: 'other' })), false)
  assert.equal(harness.dialog.setDiff(result(textDiff(), { seq: SEQ + 1 })), false)
  assert.equal(harness.dialog.setDiff(result(textDiff(), { index: 2 })), false)
  current = false
  assert.equal(harness.dialog.setDiff(result(textDiff())), false)
  current = true
  assert.equal(harness.dialog.setDiff(result(textDiff())), true)
})

test('an adapter failure is shown only for the open request and never invents a diff', () => {
  const harness = create()
  harness.render()
  harness.dialog.openDetail(0)
  harness.dialog.openDetail(1)
  assert.equal(harness.dialog.setDiffError(SEQ, 0, 'stale native failure'), false)
  assert.equal(harness.dialog.setDiffError(SEQ + 1, 1, 'wrong seq'), false)
  assert.equal(harness.dialog.setDiffError(SEQ, 1, 'Native read failed'), true)
  assert.match(harness.text(), /Native read failed/)
  assert.doesNotMatch(harness.text(), /@@/)
})

test('without a load callback the detail action is unavailable and never calls out', () => {
  const harness = create({ loadDiff: undefined })
  const text = harness.text()
  assert.match(text, /Native per-file diffs are unavailable/)
  assert.match(text, /details/, 'the disabled chip keeps its label but advertises no fake key')
  harness.render()
  harness.dialog.openDetail(0)
  assert.deepEqual(harness.requests, [])
  assert.match(harness.text(), /Native per-file diffs are unavailable/)
})

test('keyboard navigation selects, opens, backs out and closes', () => {
  const harness = create()
  harness.render()
  harness.dialog.handleInput(DOWN)
  assert.equal(harness.dialog.selectedIndex, 1)
  harness.dialog.handleInput(UP)
  assert.equal(harness.dialog.selectedIndex, 0)
  harness.dialog.handleInput(UP)
  assert.equal(harness.dialog.selectedIndex, 3, 'Up wraps to the last native row')

  harness.dialog.handleInput(ENTER)
  assert.equal(harness.dialog.detailIndex, 3)
  harness.dialog.handleInput(ENTER)
  assert.equal(harness.requests.length, 1, 'Enter is inert in the read-only detail view')

  harness.dialog.handleInput(ESC)
  assert.equal(harness.dialog.mode, 'list', 'Esc backs out of detail')
  assert.equal(harness.closes(), 0)
  harness.dialog.handleInput(ESC)
  assert.equal(harness.closes(), 1, 'a second Esc closes the list')
})

test('mouse row clicks open the exact native file and detail presses stay selection-safe', () => {
  const harness = create()
  const row = fileRow(harness.dialog, 'assets/logo.png')
  assert.equal(harness.dialog.handleMouse(mouse('press', row))?.handled, true)
  assert.equal(harness.dialog.handleMouse(mouse('click', row))?.handled, true)
  assert.equal(harness.dialog.mode, 'detail')
  assert.equal(harness.dialog.detailIndex, 1)
  assert.deepEqual(harness.requests, [{ seq: SEQ, index: 1 }])

  // The read-only detail body claims a left press without turning it into a
  // jump, and a wheel request scrolls without opening another file.
  const detailRow = fileRow(harness.dialog, 'Reading native diff')
  assert.equal(harness.dialog.handleMouse(mouse('press', detailRow))?.handled, true)
  assert.equal(harness.dialog.handleMouse(mouse('wheel', detailRow))?.handled, true)
  assert.equal(harness.closes(), 0)
})

test('width safety holds in list and detail modes', () => {
  const harness = create()
  assertWidths(harness)
  harness.dialog.openDetail(0)
  assertWidths(harness)
  harness.dialog.setDiff(result(textDiff({ coarse: true }), { index: 0 }))
  assertWidths(harness)
})
// ---------------------------------------------------------------------------
// R2: native row identity is cross-checked, whitespace labels stay visible

test('a returned diff for another native path settles this load as an honest error', () => {
  const harness = create()
  harness.render()
  harness.dialog.openDetail(0)
  assert.equal(harness.dialog.mode, 'detail')
  assert.equal(harness.dialog.isLoading, true)

  // Same session/attachment/seq/index, but the payload identifies another file.
  const accepted = harness.dialog.setDiff(result(textDiff({
    path: '/private/repo/src/other-file.ts',
    display: 'other-file.ts',
  }), { index: 0 }))
  assert.equal(accepted, false)
  assert.equal(harness.dialog.isLoading, false, 'the open load settles, it never sticks')
  assert.equal(harness.dialog.detailIndex, 0, 'the requested row stays open')
  const text = harness.text()
  assert.match(text, /did not match the requested file/i)
  assert.doesNotMatch(text, /other-file\.ts/, 'mismatched bytes are never painted')
  assert.doesNotMatch(text, /@@ -1,3/, 'no diff body is painted for a mismatched payload')

  // A later, matching answer for the still-open row still paints normally.
  assert.equal(harness.dialog.setDiff(result(textDiff(), { index: 0 })), true)
  assert.match(harness.text(), /@@ -1,3 \+1,3 @@/)
  assertWidths(harness)
})

test('binary/oversized payloads are cross-checked by native path too', () => {
  const harness = create()
  harness.render()
  harness.dialog.openDetail(1)
  assert.equal(harness.dialog.setDiff(result({ ...binaryDiff, path: '/private/repo/other.png' }, { index: 1 })), false)
  assert.equal(harness.dialog.isLoading, false)
  assert.match(harness.text(), /did not match the requested file/i)
  assert.equal(harness.dialog.setDiff(result(binaryDiff, { index: 1 })), true)
  assert.match(harness.text(), /binary/)
})

test('a whitespace-only native display is shown visibly and keeps its native index', () => {
  const whitespace: WorkspaceChangesSummary = {
    turn: 1,
    files: [
      { path: ' ', display: ' ', added: 1, deleted: 0 },
      { path: 'a.txt', display: 'a.txt', added: 2, deleted: 1 },
    ],
    total: 2,
    added: 3,
    deleted: 1,
  }
  const harness = create({ summary: whitespace })
  const text = harness.text()
  assert.match(text, /' '/, 'the whitespace row is visible, never a blank list row')
  assert.match(text, /a\.txt/)
  const first = fileRow(harness.dialog, "' '")
  assert.equal(harness.dialog.handleMouse(mouse('press', first))?.handled, true)
  assert.equal(harness.dialog.handleMouse(mouse('click', first))?.handled, true)
  assert.deepEqual(harness.requests, [{ seq: SEQ, index: 0 }], 'the first painted row is native index 0')
  // The answer for native index 0 must carry the whitespace path.
  assert.equal(harness.dialog.setDiff(result({
    kind: 'text',
    path: ' ',
    display: ' ',
    before: true,
    after: true,
    coarse: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+ y'] }],
  }, { index: 0 })), true)
  assert.equal(harness.dialog.setDiff(result({
    kind: 'text',
    path: 'a.txt',
    display: 'a.txt',
    before: true,
    after: true,
    coarse: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }],
  }, { index: 0 })), false, 'a.txt bytes can never be painted for the whitespace row')
  assertWidths(harness)
})
