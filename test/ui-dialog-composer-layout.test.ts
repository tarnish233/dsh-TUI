// Composer placement for the dialogs: pure measurement, natural bounded height,
// presentation-only layout, retired pins, local keys vs transcript paging.
//
// The shared seam is docs/COMPOSER-INTERACTION-CONTRACT.md +
// src/ui/interaction.ts. The parent (ComposerInteractionHost) calls
// setInteractionLayout and then measureRows/render; these tests call the same
// pair directly, so the component contract is pinned without a parent harness.
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { DecisionOption, DecisionRequest } from '../src/backend/types.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

// The dialogs use the real input owner's CcEditor/seam. No patched fallback.
const input = await loadInputModule()
const { DecisionDialog, SelectDialog } = await import('../src/ui/dialogs.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Select = InstanceType<typeof SelectDialog>
type Decision = InstanceType<typeof DecisionDialog>

const fakeTui = (rows = 30, columns = 80) => createFakeTui(rows, columns)
const tui = (rows = 30, columns = 80) => asTui(fakeTui(rows, columns))
const keymap = (bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap =>
  input.createCcKeymap({ bindings })
const text = (surface: { render(width: number): string[] }, width = 80): string =>
  stripTerminalSequences(surface.render(width).join('\n'))

function assertWidths(lines: string[], width: number): void {
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
}

const ROSTER = [
  { label: 'Allow once', description: 'Permit exactly this action.', value: 'allow' },
  { label: 'Reject', description: 'Decline the action.', value: 'rejected' },
]

function chooser(maxHeight: number, items: readonly DecisionOption[] = ROSTER, map?: CcKeymap): Select {
  const dialog = new SelectDialog(tui(), {
    title: 'Choose',
    items: [...items],
    onSelect: () => {},
    onCancel: () => {},
    ...(map === undefined ? {} : { keymap: map }),
  })
  dialog.setInteractionLayout({ placement: 'composer', maxHeight })
  return dialog
}

function approvalRequest(options: DecisionRequest['options']): DecisionRequest {
  return {
    id: 'a-composer',
    kind: 'approval',
    title: 'Allow tool?',
    message: 'No tool runs in this fixture.',
    options,
  }
}

function approval(maxHeight: number): Decision {
  const dialog = new DecisionDialog(tui(), {
    request: approvalRequest([
      { label: 'Allow once', description: 'Opaque value.', value: { allow: true } },
      { label: 'Reject', description: 'Decline.', value: { allow: false } },
    ]),
    onSubmit: () => {},
    onCancel: () => {},
  })
  dialog.setInteractionLayout({ placement: 'composer', maxHeight })
  return dialog
}

const mouse = (type: 'press' | 'click', y: number, height: number, x = 8) => ({
  type, button: 'left' as const, x, y, screenX: x, screenY: y,
  width: 80, height, shift: false, alt: false, ctrl: false,
  ...(type === 'click' ? { clickCount: 1 } : {}),
})

function rowAt(lines: string[], label: string): number {
  const row = lines.findIndex(line => stripTerminalSequences(line).includes(label))
  assert.ok(row > 0, `row ${JSON.stringify(label)} is painted`)
  return row
}

// ---------------------------------------------------------------------------
// Pure measurement and hard bounds

test('composer measurement equals render for every size and never exceeds the budget', () => {
  for (const height of [3, 6, 8, 12, 18, 24, 40]) {
    for (const width of [40, 80, 120]) {
      const select = chooser(height)
      const first = select.measureRows(width)
      const lines = select.render(width)
      assert.equal(first, lines.length, `select measure/render ${width}x${height}`)
      assert.equal(select.measureRows(width), lines.length, `select repeat measure ${width}x${height}`)
      assert.ok(lines.length <= height, `select over budget ${width}x${height}: ${lines.length}`)
      assertWidths(lines, width)

      const decision = approval(height)
      const measured = decision.measureRows(width)
      const painted = decision.render(width)
      assert.equal(measured, painted.length, `decision measure/render ${width}x${height}`)
      assert.equal(decision.measureRows(width), painted.length, `decision repeat measure ${width}x${height}`)
      assert.ok(painted.length <= height, `decision over budget ${width}x${height}: ${painted.length}`)
      assertWidths(painted, width)
    }
  }
})

test('the parent budget is a cap, not padding: short content stays short and options stay visible', () => {
  const single = chooser(24, [{ label: 'Only', value: 'only' }])
  const singleLines = single.render(80)
  assert.ok(singleLines.length < 24, 'a one-row roster is not stretched into a tall panel')
  assert.match(text(single), /1\. Only/, 'the only native row is painted')
  assert.match(text(single), /\[enter Select\]/, 'the action footer is painted')

  // A genuinely short viewport still wins over any natural floor.
  const tiny = chooser(4)
  const tinyLines = tiny.render(80)
  assert.equal(tinyLines.length, 4)
  assertWidths(tinyLines, 80)

  // A small budget keeps both native options when they are one row each...
  const tight = new DecisionDialog(tui(), {
    request: approvalRequest([{ label: 'Allow once', value: 'allow' }, { label: 'Reject', value: 'rejected' }]),
    onSubmit: () => {},
    onCancel: () => {},
  })
  tight.setInteractionLayout({ placement: 'composer', maxHeight: 9 })
  const tightText = text(tight)
  assert.match(tightText, /1\. Allow once/)
  assert.match(tightText, /2\. Reject/, 'the rejection option survives a small budget')
  assert.match(tightText, /\[escape Reject\]/, 'the cancel/reject action survives a small budget')

  // ...and a taller option block is windowed around the focused row: the
  // hidden option is still reachable with the local key and the reject action
  // never leaves the footer.
  const windowed = approval(9)
  assert.match(text(windowed), /1\. Allow once/, 'the focused option keeps its rows')
  windowed.handleInput('\x0e')
  assert.match(text(windowed), /2\. Reject/, 'the hidden option is reachable with the local key')
  assert.match(text(windowed), /\[escape Reject\]/, 'the cancel/reject action survives a small budget')
})

test('an explicit workspace layout is bounded too, and the default workspace stays historical', () => {
  const fake = fakeTui(30, 80)
  const base = new SelectDialog(asTui(fake), {
    title: 'Choose',
    items: [...ROSTER],
    onSelect: () => {},
    onCancel: () => {},
  })
  // Default: the historical bounded overlay height (rows - 6 for a tall terminal).
  assert.equal(base.render(80).length, 18)
  assert.equal(base.measureRows(80), 18)
  assert.equal(base.capturesViewportInput, true, 'a workspace surface keeps claiming the viewport')

  const explicit = new SelectDialog(asTui(fake), {
    title: 'Choose',
    items: [...ROSTER],
    onSelect: () => {},
    onCancel: () => {},
  })
  explicit.setInteractionLayout({ placement: 'workspace', maxHeight: 12 })
  const lines = explicit.render(80)
  assert.ok(lines.length <= 12)
  assert.equal(explicit.measureRows(80), lines.length)
  assert.equal(explicit.capturesViewportInput, true, 'workspace placement still owns the viewport')
})

test('a workspace-resize still follows modalHeight; an explicit dock does not', () => {
  const fake = fakeTui(30, 80)
  const base = new SelectDialog(asTui(fake), {
    title: 'Choose',
    items: [...ROSTER],
    onSelect: () => {},
    onCancel: () => {},
  })
  assert.equal(base.render(80).length, 18, 'rows 30 -> rows - 6')
  fake.terminal.rows = 14 // short terminal: rows - 2 instead of rows - 6
  assert.equal(base.render(80).length, 12, 'the historical resize behaviour is preserved')
  assert.equal(base.measureRows(80), 12)

  // A composer mount is owned by the parent's budget, not by the terminal.
  const docked = chooser(12)
  fake.terminal.rows = 40
  assert.equal(docked.render(80).length, docked.measureRows(80))
  assert.ok(docked.render(80).length <= 12, 'the explicit budget still caps the height')
})

// ---------------------------------------------------------------------------
// Presentation-only layout

test('setInteractionLayout is idempotent, side-effect free and retires old pins on reflow', () => {
  const fake = fakeTui()
  const picked: unknown[] = []
  const dialog = new SelectDialog(asTui(fake), {
    title: 'Pin',
    items: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }],
    onSelect: value => { picked.push(value) },
    onCancel: () => { picked.push('cancelled') },
  })
  dialog.focused = true
  dialog.handleInput('\x0e') // local selection move
  assert.equal(dialog.selectedIndex, 1)

  const layout = { placement: 'composer' as const, maxHeight: 24 }
  dialog.setInteractionLayout(layout)
  const focusedBefore = dialog.focused
  const indexBefore = dialog.selectedIndex
  const requestsBefore = fake.renderRequests
  dialog.setInteractionLayout({ ...layout }) // identical values: a no-op
  assert.equal(dialog.focused, focusedBefore, 'layout never moves focus')
  assert.equal(dialog.selectedIndex, indexBefore, 'layout never selects')
  assert.deepEqual(picked, [], 'layout never answers or dismisses')
  assert.equal(fake.renderRequests, requestsBefore, 'layout never requests a frame')

  // A press recorded before a reflow cannot answer after it.
  let lines = dialog.render(80)
  const row = rowAt(lines, '2. Two')
  assert.equal(dialog.handleMouse(mouse('press', row, lines.length))?.render, false)
  dialog.setInteractionLayout({ placement: 'composer', maxHeight: 9 })
  lines = dialog.render(80)
  assert.equal(dialog.handleMouse(mouse('click', row, lines.length))?.render, false, 'stale press is retired')
  assert.deepEqual(picked, [], 'a retired pin never answers')

  // A fresh press/click pair on the same painted row still answers.
  const freshRow = rowAt(lines, '2. Two')
  assert.equal(dialog.handleMouse(mouse('press', freshRow, lines.length))?.handled, true)
  assert.equal(dialog.handleMouse(mouse('click', freshRow, lines.length))?.handled, true)
  assert.deepEqual(picked, ['two'])
})

test('measureRows is pure: it neither syncs mouse targets nor disturbs a pending press', () => {
  const dialog = chooser(24)
  const lines = dialog.render(80)
  const row = rowAt(lines, '2. Reject')
  assert.equal(dialog.handleMouse(mouse('press', row, lines.length))?.handled, true)
  // Measuring between a press and its release must not move the frame it
  // describes (hitboxes, hover, pins and geometry all stay).
  const measured = dialog.measureRows(80)
  assert.equal(measured, lines.length)
  const picked: boolean[] = []
  const spy = new SelectDialog(tui(), {
    title: 'Choose',
    items: [...ROSTER],
    onSelect: () => { picked.push(true) },
    onCancel: () => {},
  })
  spy.setInteractionLayout({ placement: 'composer', maxHeight: 24 })
  const spyLines = spy.render(80)
  const spyRow = rowAt(spyLines, '2. Reject')
  spy.handleMouse(mouse('press', spyRow, spyLines.length))
  spy.measureRows(80)
  spy.handleMouse(mouse('click', spyRow, spyLines.length))
  assert.deepEqual(picked, [true], 'the press survives measurements that report the same geometry')
})

// ---------------------------------------------------------------------------
// Transcript paging versus local selection keys

test('a composer decision leaves transcript paging alone while its own keys stay local', () => {
  const items = Array.from({ length: 8 }, (_, index) => ({ label: `Row ${index + 1}`, value: index + 1 }))
  const picked: unknown[] = []
  const composer = new SelectDialog(tui(), {
    title: 'Rows',
    items,
    onSelect: value => { picked.push(value) },
    onCancel: () => {},
  })
  composer.setInteractionLayout({ placement: 'composer', maxHeight: 24 })
  assert.equal(composer.capturesViewportInput, false, 'composer does not claim the viewport')
  composer.handleInput('\x1b[6~') // PageDown: transcript paging, not list paging
  composer.handleInput('\x1b[5~') // PageUp
  assert.equal(composer.selectedIndex, 0, 'page keys are left to the transcript')
  composer.handleInput('\x0e') // Ctrl+N: local selection
  assert.equal(composer.selectedIndex, 1)
  composer.handleInput('j') // local
  assert.equal(composer.selectedIndex, 2)
  composer.handleInput('6') // local digit pick
  assert.deepEqual(picked, [6])

  // The same surface in workspace placement keeps paging its own list.
  const workspace = new SelectDialog(tui(), {
    title: 'Rows',
    items,
    onSelect: () => {},
    onCancel: () => {},
  })
  assert.equal(workspace.capturesViewportInput, true)
  workspace.handleInput('\x1b[6~')
  assert.equal(workspace.selectedIndex, 5, 'workspace paging stays local')
})

test('composer decision keeps its own option/submit keys local and never leaks to the root editor', () => {
  const submitted: unknown[] = []
  const dialog = new DecisionDialog(tui(), {
    request: approvalRequest([
      { label: 'Allow once', value: 'allow' },
      { label: 'Reject', value: 'rejected' },
    ]),
    onSubmit: value => { submitted.push(value) },
    onCancel: () => {},
  })
  dialog.setInteractionLayout({ placement: 'composer', maxHeight: 24 })
  assert.equal(dialog.capturesViewportInput, false)
  dialog.handleInput('\x1b[6~') // PageDown left to the transcript
  dialog.handleInput('\x0e') // Ctrl+N: local option navigation
  dialog.handleInput('\r')
  assert.deepEqual(submitted, ['rejected'])
})