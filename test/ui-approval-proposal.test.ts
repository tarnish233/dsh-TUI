// Forces truecolor before any src module snapshots the terminal color mode, so
// the diff bands and their plain text are deterministic in this file.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { DecisionRequest } from '../src/backend/types.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'
import {
  highlightRuntimeSubscriberCount,
  resetHighlightRuntimeForTests,
  setHighlightRuntimeLoaderForTests,
  whenHighlightRuntimeReady,
} from '../src/ui/highlight.ts'

// The dialog uses the real input owner's CcEditor, so the app-owned seam must be
// installed before the UI module is imported. Nothing here spawns a backend,
// reads a profile or writes stdout.
const input = await loadInputModule()
const { DecisionDialog } = await import('../src/ui/dialogs.ts')

function fakeTui(rows = 30, columns = 80) {
  return asTui(createFakeTui(rows, columns))
}

function keymap() {
  return input.createCcKeymap()
}

const strip = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))
const text = (dialog: { render(width: number): string[] }, width = 80): string => strip(dialog.render(width)).join('\n')

function assertWidths(lines: readonly string[], width: number): void {
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
  }
}

// ---------------------------------------------------------------------------
// Synthetic native fixtures (no provider, no profile, no file)

/** A write-like `presentCall`: a whole new file, no previous text. */
const WRITE_CALL = {
  card: 'diff',
  title: 'Write src/new-file.ts',
  diffs: [{
    path: 'src/new-file.ts',
    oldText: null,
    newText: 'export const answer = 42\nexport const label = "written"\n',
  }],
} as const

/** An edit-like `presentCall`: one statement replaced in an existing file. */
const EDIT_CALL = {
  card: 'diff',
  diffs: [{
    path: 'src/greet.ts',
    oldText: 'export const greeting = "hi"\nconst keep = 1\n',
    newText: 'export const greeting = "hello"\nconst keep = 1\n',
  }],
} as const

/** An apply_patch-like `presentCall`: two files in one request. */
const PATCH_CALL = {
  card: 'diff',
  diffs: [
    { path: 'src/a.ts', oldText: 'export const a = 1\n', newText: 'export const a = 2\n' },
    { path: 'src/b.ts', oldText: null, newText: 'export const b = 3\n' },
  ],
} as const

const OPTIONS = [
  { label: 'Allow once', value: 'allowed-once' },
  { label: 'Reject', value: 'rejected' },
]

function approval(extra: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    id: 'approval-1',
    kind: 'approval',
    title: 'Allow this change?',
    message: 'The model asked to change a file in this workspace.',
    options: OPTIONS.map(option => ({ ...option })),
    ...extra,
  }
}

interface Durations {
  submitted: unknown[]
  cancelled: number
  interrupted: number
}

function make(request: DecisionRequest, tui = fakeTui()) {
  const seen: Durations = { submitted: [], cancelled: 0, interrupted: 0 }
  const dialog = new DecisionDialog(tui, {
    request,
    keymap: keymap(),
    onSubmit: value => { seen.submitted.push(value) },
    onCancel: () => { seen.cancelled += 1 },
    onInterrupt: () => { seen.interrupted += 1 },
  })
  dialog.focused = true
  return { dialog, seen }
}

// ---------------------------------------------------------------------------
// A validated native diff call view paints a bounded proposal

test('a write-like native diff call view paints a width-safe proposal preview', () => {
  const { dialog } = make(approval({ toolPresentation: { call: WRITE_CALL } }))
  for (const width of [24, 32, 40, 60, 80, 120, 160]) {
    const lines = dialog.render(width)
    assertWidths(lines, width)
    const painted = strip(lines).join('\n')
    assert.match(painted, /Proposal/, `width ${width} keeps the proposal label`)
    // The not-run wording sits right next to the label, so it survives every
    // width that still has room for the label itself.
    if (width >= 40) assert.match(painted, /not run yet/, `width ${width} keeps the not-run wording`)
    // The new file's content is previewed as an addition, never as a done deal.
    assert.match(painted, /export const/)
    assert.match(painted, /answer = 42/)
    // The opaque native options are still painted below the preview.
    assert.match(painted, /1\. Allow once/)
    assert.match(painted, /2\. Reject/)
    if (width >= 60) assert.match(painted, /Esc to reject/)
  }
})

test('an edit-like diff view is labeled as a proposal and never as an applied result', () => {
  const { dialog } = make(approval({ toolPresentation: { call: EDIT_CALL } }))
  const painted = text(dialog, 100)
  assert.match(painted, /Proposal/)
  assert.match(painted, /not run yet/)
  // Both sides of the hunk are legible without color (classic indicators).
  assert.match(painted, /- export const greeting = "hi"/)
  assert.match(painted, /\+ export const greeting = "hello"/)
  assert.match(painted, /const keep = 1/)
  // No row may claim an applied change or an executed result.
  assert.doesNotMatch(painted, /applied/i, 'the preview never claims an applied change')
  assert.doesNotMatch(painted, /executed/i, 'the preview never claims an executed call')
  assert.doesNotMatch(painted, /\bresult\b/i, 'the preview never claims a result')
  assert.doesNotMatch(painted, /\bupdated\b/i, 'the preview never claims the file was updated')
  assert.doesNotMatch(painted, /\bcreated\b/i, 'the preview never claims the file was created')
})

test('a flat presentCall and a { call } envelope are the same validated intent', () => {
  const flat = text(make(approval({ toolPresentation: { ...EDIT_CALL } })).dialog, 100)
  const wrapped = text(make(approval({ toolPresentation: { call: { ...EDIT_CALL } } })).dialog, 100)
  for (const painted of [flat, wrapped]) {
    assert.match(painted, /Proposal/)
    assert.match(painted, /src\/greet\.ts/)
    assert.match(painted, /\+1 -1 lines/)
  }
})

test('an apply_patch-like multi-file intent aggregates counts and keeps file identity', () => {
  const { dialog } = make(approval({ toolPresentation: { call: PATCH_CALL } }), fakeTui(40, 120))
  const painted = text(dialog, 120)
  assert.match(painted, /Proposal/)
  assert.match(painted, /2 files \(src\/a\.ts, src\/b\.ts\)/)
  assert.match(painted, /\+2 -1 lines/)
  // Two hunks keep their own headings instead of one anonymous block.
  assert.match(painted, /▸ src\/a\.ts/)
  assert.match(painted, /▸ src\/b\.ts/)
  assertWidths(dialog.render(120), 120)
})

// ---------------------------------------------------------------------------
// No seam, no preview — and never an error

test('missing or malformed native presentation keeps today\'s approval body exactly', () => {
  const baseline = strip(make(approval()).dialog.render(80))
  const malformed: unknown[] = [
    null,
    'text',
    42,
    [],
    {},
    { call: null },
    { call: {} },
    { call: 'diff' },
    { call: { card: 'diff' } },
    { call: { card: 'diff', diffs: 'not-an-array' } },
    { call: { card: 'diff', diffs: [] } },
    { call: { card: 'diff', diffs: [null] } },
    { call: { card: 'diff', diffs: [{ path: 'src/a.ts' }] } },
    { call: { card: 'diff', diffs: [{ path: 'src/a.ts', oldText: 1, newText: 2 }] } },
    { call: { card: 'diff', diffs: [{ path: 1, oldText: null, newText: 'x' }] } },
    // A different native card is not a diff, even when it carries diffs.
    { call: { card: 'generic', diffs: EDIT_CALL.diffs } },
    { call: { card: 'terminal', output: 'ls\n' } },
    // A result half is never read as an approval proposal, not even next to a
    // well-formed call half: a decided request is no longer a pending intent.
    { result: { card: 'diff', diffs: EDIT_CALL.diffs } },
    { call: { card: 'diff', diffs: EDIT_CALL.diffs }, result: { card: 'diff', diffs: [] } },
    { call: { card: 'diff', diffs: EDIT_CALL.diffs }, result: undefined, status: 'done' },
  ]
  for (const raw of malformed) {
    const request = approval({ toolPresentation: raw as DecisionRequest['toolPresentation'] })
    const dialog = make(request).dialog
    const rendered = strip(dialog.render(80))
    assert.deepEqual(rendered, baseline, `no preview and no error for ${JSON.stringify(raw)}`)
    assert.doesNotMatch(rendered.join('\n'), /Proposal/)
    assertWidths(dialog.render(80), 80)
  }
  // The plain body is the historical message + options + hint, not an error box.
  const painted = baseline.join('\n')
  assert.match(painted, /The model asked to change a file in this workspace\./)
  assert.match(painted, /1\. Allow once/)
  assert.match(painted, /2\. Reject/)
  assert.doesNotMatch(painted, /No approval options are available\./)
})

test('a callId is identity, never evidence of a diff', () => {
  for (const extra of [{ callId: 'call-42' }, { callId: 'call-42', toolPresentation: {} }]) {
    const dialog = make(approval(extra)).dialog
    assert.doesNotMatch(text(dialog, 80), /Proposal/, `callId alone paints no preview: ${JSON.stringify(extra)}`)
  }
})

// ---------------------------------------------------------------------------
// Bounded, honest and never starving the decision

test('a large proposal is bounded with an honest marker and never hides the options', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index}`)
  const big = {
    card: 'diff',
    diffs: [{ path: 'src/big.ts', oldText: lines.join('\n') + '\n', newText: lines.map(line => `${line} + 1`).join('\n') + '\n' }],
  }
  const tui = fakeTui(16, 40)
  const { dialog } = make(approval({ message: '', toolPresentation: { call: big } }), tui)
  const rendered = dialog.render(40)
  assertWidths(rendered, 40)
  const painted = strip(rendered).join('\n')
  assert.match(painted, /Proposal/)
  // A short body clips the preview explicitly instead of cutting it silently.
  assert.match(painted, /more proposal line/)
  assert.match(painted, /1\. Allow once/)
  assert.match(painted, /2\. Reject/)
  // The whole patch never reaches the body.
  assert.ok(strip(rendered).filter(line => line.includes('const value')).length <= 12, 'the preview stays bounded')

  // A roomy body keeps the same bounded preview plus its full label and counts.
  const roomy = make(approval({ message: '', toolPresentation: { call: big } }), fakeTui(40, 80)).dialog
  const roomyPainted = text(roomy, 80)
  assert.match(roomyPainted, /Proposal · not run yet · src\/big\.ts · \+40 -40 lines/)
  assert.match(roomyPainted, /… \d+ more lines/)
  assert.equal(roomyPainted.match(/\+\d+ -\d+ lines/g)?.length, 1, 'counts are stated once')

  // No room at all: no preview, and the decision surface is still complete.
  const tight = make(approval({ message: '', toolPresentation: { call: big } }), fakeTui(10, 40)).dialog
  const tightText = strip(tight.render(40)).join('\n')
  assert.doesNotMatch(tightText, /Proposal/)
  assert.match(tightText, /1\. Allow once/)
  assert.match(tightText, /2\. Reject/)
  assertWidths(tight.render(40), 40)
})

// ---------------------------------------------------------------------------
// The decision contract is untouched by the preview

test('Esc rejects, default Ctrl+C rejects locally, and only an explicit override interrupts', () => {
  const esc = make(approval({ toolPresentation: { call: EDIT_CALL } }))
  esc.dialog.handleInput('\x1b')
  assert.deepEqual(esc.seen.submitted, ['rejected'], 'Esc settles the native rejected option')
  assert.equal(esc.seen.cancelled, 0, 'a rejection is not a turn cancellation')
  assert.equal(esc.seen.interrupted, 0)

  // The shipped keymap has no app.interrupt default: Ctrl+C is the local
  // cancel/reject path of the focused surface, not a backend turn abort.
  const local = make(approval({ toolPresentation: { call: EDIT_CALL } }))
  local.dialog.handleInput('\x03')
  assert.deepEqual(local.seen.submitted, ['rejected'], 'Ctrl+C settles the native rejected option')
  assert.equal(local.seen.cancelled, 0)
  assert.equal(local.seen.interrupted, 0)

  // An explicitly configured interrupt keeps its priority and the proposal.
  const seen: Durations = { submitted: [], cancelled: 0, interrupted: 0 }
  const interrupt = new DecisionDialog(fakeTui(), {
    request: approval({ toolPresentation: { call: EDIT_CALL } }),
    keymap: input.createCcKeymap({ bindings: { 'app.interrupt': 'ctrl+c' } }),
    onSubmit: value => { seen.submitted.push(value) },
    onCancel: () => { seen.cancelled += 1 },
    onInterrupt: () => { seen.interrupted += 1 },
  })
  interrupt.focused = true
  interrupt.handleInput('\x03')
  assert.equal(seen.interrupted, 1)
  assert.deepEqual(seen.submitted, [], 'a global interrupt never answers the request')
  assert.equal(seen.cancelled, 0)
  // The surface stays usable and the proposal stays painted.
  assert.match(text(interrupt, 80), /Proposal/)
  interrupt.handleInput('\r')
  assert.deepEqual(seen.submitted, ['allowed-once'])
})

test('approval mouse ownership is unchanged: preview rows are not click targets', () => {
  const tui = fakeTui()
  const { dialog, seen } = make(approval({ toolPresentation: { call: EDIT_CALL } }), tui)
  const lines = dialog.render(80)
  const headingRow = lines.findIndex(line => stripTerminalSequences(line).includes('Proposal'))
  const rejectRow = lines.findIndex(line => stripTerminalSequences(line).includes('2. Reject'))
  assert.ok(headingRow > 0 && rejectRow > headingRow)
  const event = (type: 'press' | 'click', y: number) => ({
    type, button: 'left' as const, x: 8, y, screenX: 8, screenY: y,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  })
  // A press/click on the preview paints nothing and answers nothing.
  dialog.handleMouse(event('press', headingRow))
  dialog.handleMouse(event('click', headingRow))
  assert.deepEqual(seen.submitted, [], 'the preview is not an option row')
  // The option rows still answer through the same press+release ownership.
  dialog.handleMouse(event('press', rejectRow))
  dialog.handleMouse(event('click', rejectRow))
  assert.deepEqual(seen.submitted, ['rejected'])
  assert.equal(seen.cancelled, 0)
})

test('question dialogs ignore the approval presentation and keep custom answers', () => {
  const request: DecisionRequest = {
    id: 'q1',
    kind: 'question',
    title: 'Question',
    // Even an attached diff intent belongs to approvals only.
    toolPresentation: { call: EDIT_CALL },
    questions: [{ question: 'Type or pick.', options: [{ label: 'A' }, { label: 'B' }] }],
  }
  const seen: unknown[] = []
  const dialog = new DecisionDialog(fakeTui(), {
    request,
    keymap: keymap(),
    onSubmit: value => { seen.push(value) },
    onCancel: () => { seen.push('cancelled') },
  })
  dialog.focused = true
  const painted = text(dialog, 80)
  assert.doesNotMatch(painted, /Proposal/)
  assert.match(painted, /Type or pick\./)
  dialog.handleInput('3')
  for (const char of 'typed answer') dialog.handleInput(char)
  dialog.handleInput('\r')
  assert.deepEqual(seen, [{ answers: ['typed answer'] }])
})

test('invalidate() rebuilds the proposal rows without changing their text', () => {
  const { dialog } = make(approval({ toolPresentation: { call: EDIT_CALL } }))
  const before = strip(dialog.render(80))
  assert.match(before.join('\n'), /Proposal/)
  dialog.invalidate()
  const after = strip(dialog.render(80))
  assert.deepEqual(after, before, 'the repaint after invalidate is byte-identical')
  assert.equal(after.filter(line => line.includes('Proposal')).length, 1, 'the preview is never duplicated')
})

// ---------------------------------------------------------------------------
// The lazy highlight edge and disposal are preserved

test('the proposal preview keeps the lazy highlight subscription and disposal semantics', async () => {
  resetHighlightRuntimeForTests()
  const fakeRuntime = { highlight: (code: string) => code.split('\n') }
  setHighlightRuntimeLoaderForTests(async () => fakeRuntime)
  const fake = createFakeTui()
  const tui = asTui(fake)
  const before = highlightRuntimeSubscriberCount()
  const { dialog } = make(approval({ toolPresentation: { call: EDIT_CALL } }), tui)
  assert.equal(highlightRuntimeSubscriberCount(), before + 1, 'the live dialog subscribes once')
  assert.match(text(dialog, 80), /Proposal/)

  const requestsBefore = fake.renderRequests
  await whenHighlightRuntimeReady()
  assert.equal(fake.renderRequests, requestsBefore + 1, 'the ready edge still asks for exactly one repaint')
  assert.match(text(dialog, 80), /Proposal/, 'the preview survives the ready invalidation')

  dialog.dispose()
  assert.equal(dialog.isDisposed, true)
  assert.equal(highlightRuntimeSubscriberCount(), before, 'dispose releases the dialog subscription itself')
  // A later readiness neither invalidates nor paints this dead dialog.
  resetHighlightRuntimeForTests()
  setHighlightRuntimeLoaderForTests(async () => fakeRuntime)
  const requestsAtDispose = fake.renderRequests
  await whenHighlightRuntimeReady()
  assert.equal(fake.renderRequests, requestsAtDispose, 'a disposed dialog never repaints')
  dialog.dispose()
  assert.equal(dialog.isDisposed, true, 'dispose stays idempotent')
  // A disposed approval ignores input instead of answering a stale request.
  const late = make(approval({ toolPresentation: { call: EDIT_CALL } }), tui)
  late.dialog.dispose()
  late.dialog.handleInput('\r')
  assert.deepEqual(late.seen.submitted, [])
})