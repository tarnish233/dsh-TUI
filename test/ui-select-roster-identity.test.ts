import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { DecisionOption } from '../src/backend/types.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

// Native preset rosters can be re-delivered after a session/model change: rows
// may be inserted, reordered or re-labelled while the dialog is already open.
// The opt-in identity policy belongs to the real dialog with the real input
// owner's keymap, not to a test double.
const input = await loadInputModule()
const { SelectDialog } = await import('../src/ui/dialogs.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Select = InstanceType<typeof SelectDialog>

function keymap(bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap {
  return input.createCcKeymap({ bindings })
}

function assertWidths(lines: string[], width: number): void {
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
}

interface Harness {
  dialog: Select
  /** Exact opaque values answered through `onSelect`. */
  picked: unknown[]
  /** `onCancel` answers; a roster refresh must never add one. */
  cancels: string[]
}

function harness(items: DecisionOption[], sharedKeymap?: CcKeymap): Harness {
  const picked: unknown[] = []
  const cancels: string[] = []
  const dialog = new SelectDialog(asTui(createFakeTui(30, 80)), {
    title: 'Choose agent preset',
    items,
    ...(sharedKeymap === undefined ? {} : { keymap: sharedKeymap }),
    onSelect: value => { picked.push(value) },
    onCancel: () => { cancels.push('cancelled') },
  })
  dialog.focused = true
  return { dialog, picked, cancels }
}

/** Painted screen row of a label. Body rows are `frame.bodyRow + bodyOffset`. */
function rowAt(lines: string[], label: string): number {
  const row = lines.findIndex(line => stripTerminalSequences(line).includes(label))
  assert.ok(row > 0, `the roster row ${JSON.stringify(label)} is painted`)
  return row
}

/** Ctrl+N moves the highlight; digits would answer immediately. */
function move(dialog: Select, steps: number): void {
  for (let step = 0; step < steps; step += 1) dialog.handleInput('\x0e')
}

function mouse(type: 'press' | 'click', y: number, height: number) {
  return {
    type,
    button: 'left' as const,
    x: 8, y, screenX: 8, screenY: y,
    width: 80, height, shift: false, alt: false, ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  }
}

test('opt-in identity keeps the selected primitive id across a metadata-only refresh', () => {
  const f = harness([
    { label: 'Deny preset', value: false },
    { label: 'Provider default', value: '' },
    { label: 'Zero budget', value: 0 },
    { label: 'Unset effort', value: Number.NaN },
    { label: 'Named preset', value: 'preset-a' },
  ])
  move(f.dialog, 2) // the value `0` row
  assert.equal(f.dialog.selectedIndex, 2)

  // Same native ids, new labels/descriptions, one row inserted before the
  // selection: only the selected id may decide what stays under the cursor.
  f.dialog.setItems([
    { label: 'Deny', description: 'refuse once', value: false },
    { label: 'Inserted', value: 'preset-new' },
    { label: 'Provider default', value: '' },
    { label: 'Zero budget (renamed)', value: 0 },
    { label: 'Unset effort', value: Number.NaN },
  ], { preserveValue: true })

  assert.equal(f.dialog.selectedIndex, 3, 'the exact id row, not the old index')
  assert.deepEqual(f.picked, [], 'a refresh never answers for the user')
  assert.deepEqual(f.cancels, [])
  const rendered = stripTerminalSequences(f.dialog.render(80).join('\n'))
  assert.match(rendered, /Zero budget \(renamed\)/)
  assert.match(rendered, /Zero budget \(renamed\) ✔/, 'the highlight stays on the same id')

  f.dialog.handleInput('\r')
  assert.equal(f.picked.length, 1)
  assert.ok(Object.is(f.picked[0], 0), 'the exact opaque value is returned')
})

test('falsey and non-self-equal ids survive a reorder', () => {
  for (const selected of [false, '', 0, Number.NaN] as const) {
    const f = harness([{ label: 'Selected', value: selected }, { label: 'Other', value: 'other' }])
    f.dialog.setItems([
      { label: 'Other', value: 'other' },
      { label: 'Selected (native order)', value: selected },
    ], { preserveValue: true })
    assert.equal(f.dialog.selectedIndex, 1, `the ${String(selected)} row moves with its id`)
    assert.deepEqual(f.picked, [])
    f.dialog.handleInput('\r')
    assert.equal(f.picked.length, 1)
    assert.ok(Object.is(f.picked[0], selected))
  }
})

test('a removed id clamps the index and never auto-selects, submits or focuses', () => {
  const f = harness([
    { label: 'One', value: 'one' },
    { label: 'Two', value: 'two' },
    { label: 'Three', value: 'three' },
  ])
  move(f.dialog, 2) // 'three'
  assert.equal(f.dialog.selectedIndex, 2)

  f.dialog.setItems([{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }], { preserveValue: true })
  assert.equal(f.dialog.selectedIndex, 1, 'the nearest available row, never a resurrected id')
  assert.deepEqual(f.picked, [], 'attrition does not answer for the user')
  assert.deepEqual(f.cancels, [])
  assert.equal(f.dialog.focused, true, 'a refresh does not move focus')

  f.dialog.setItems([], { preserveValue: true })
  assert.equal(f.dialog.selectedIndex, 0)
  const empty = stripTerminalSequences(f.dialog.render(80).join('\n'))
  assert.match(empty, /No options are available\./)
  assert.deepEqual(f.picked, [])

  // The next catalog is a plain first-catalog load again: index 0, no answer.
  f.dialog.setItems([{ label: 'Fresh', value: 'fresh' }], { preserveValue: true })
  assert.equal(f.dialog.selectedIndex, 0)
  assert.deepEqual(f.picked, [])
  f.dialog.handleInput('\r')
  assert.deepEqual(f.picked, ['fresh'])
})

test('opaque object ids survive by reference and never by deep equality', () => {
  const routeA = { provider: 'deepseek', model: 'a' }
  const routeB = { provider: 'deepseek', model: 'b' }
  const same = harness([{ label: 'a', value: routeA }, { label: 'b', value: routeB }])
  move(same.dialog, 1) // 'b'
  same.dialog.setItems([{ label: 'b', value: routeB }, { label: 'a', value: routeA }], { preserveValue: true })
  assert.equal(same.dialog.selectedIndex, 0, 'the identical reference keeps its exact row')
  assert.deepEqual(same.picked, [])
  same.dialog.handleInput('\r')
  assert.equal(same.picked.length, 1)
  assert.equal(same.picked[0], routeB, 'the exact opaque object is returned, not a copy')

  // A structurally equal but newly built object is a different native option:
  // no deep inference, so the old row counts as removed and the index clamps.
  const deep = harness([{ label: 'a', value: routeA }, { label: 'b', value: { provider: 'deepseek', model: 'b' } }])
  move(deep.dialog, 1) // 'b'
  deep.dialog.setItems([
    { label: 'b', value: { provider: 'deepseek', model: 'b' } },
    { label: 'a', value: routeA },
  ], { preserveValue: true })
  assert.equal(deep.dialog.selectedIndex, 1, 'a deep-equal copy is not the same native row')
  assert.deepEqual(deep.picked, [])
  deep.dialog.handleInput('\r')
  assert.equal(deep.picked.length, 1)
  assert.equal(deep.picked[0], routeA)
})

test('the default setItems policy remains index-based for unrelated dialogs', () => {
  const f = harness([
    { label: 'One', value: 'one' },
    { label: 'Two', value: 'two' },
    { label: 'Three', value: 'three' },
  ])
  move(f.dialog, 1) // 'two' at index 1
  f.dialog.setItems([
    { label: 'Zero', value: 'zero' },
    { label: 'One', value: 'one' },
    { label: 'Two', value: 'two' },
    { label: 'Three', value: 'three' },
  ])
  assert.equal(f.dialog.selectedIndex, 1, 'without opt-in the raw index survives')
  assert.deepEqual(f.picked, [])
  f.dialog.handleInput('\r')
  assert.deepEqual(f.picked, ['one'], 'the row now under the index is answered, as before')

  // An explicit `false` is the same policy, including the shrink clamp.
  const g = harness([{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }])
  move(g.dialog, 1) // 'two'
  g.dialog.setItems([{ label: 'One', value: 'one' }], { preserveValue: false })
  assert.equal(g.dialog.selectedIndex, 0)
  assert.deepEqual(g.picked, [], 'shrinking a roster never selects')
  g.dialog.setItems([])
  assert.equal(g.dialog.selectedIndex, 0)
  assert.deepEqual(g.picked, [])
  assert.deepEqual(g.cancels, [])
})

test('the first catalog after loading keeps the index-0 baseline under both policies', () => {
  for (const preserveValue of [false, true]) {
    const picked: unknown[] = []
    const dialog = new SelectDialog(asTui(createFakeTui(30, 80)), {
      title: 'Choose agent preset',
      items: [],
      loading: true,
      onSelect: value => { picked.push(value) },
      onCancel: () => { picked.push('cancelled') },
    })
    dialog.focused = true
    assert.match(stripTerminalSequences(dialog.render(70).join('\n')), /Loading options…/)

    dialog.setItems([{ label: 'Only preset', value: 'only' }], { preserveValue })
    assert.equal(dialog.selectedIndex, 0)
    const first = stripTerminalSequences(dialog.render(70).join('\n'))
    assert.match(first, /Only preset/)
    assert.doesNotMatch(first, /Loading options/)

    dialog.setItems([{ label: 'First', value: 'first' }, { label: 'Second', value: 'second' }], { preserveValue })
    assert.equal(dialog.selectedIndex, 0)
    assert.deepEqual(picked, [], 'arriving data never answers for the user')
    dialog.handleInput('\r')
    assert.deepEqual(picked, ['first'])
  }
})

test('a press recorded before the refresh cannot answer the reordered roster', () => {
  const f = harness([
    { label: 'One', value: 'one' },
    { label: 'Two', value: 'two' },
    { label: 'Three', value: 'three' },
  ])
  move(f.dialog, 1) // 'two'
  const before = f.dialog.render(80)
  const pressedRow = rowAt(before, 'Two')
  const pressed = f.dialog.handleMouse(mouse('press', pressedRow, before.length))
  assert.equal(pressed?.handled, true)
  assert.equal(pressed?.render, false, 'the painted window stays stable between press and click')

  // A native insert moves the preserved id down one row; the pressed row now
  // holds a different native option.
  f.dialog.setItems([
    { label: 'Zero', value: 'zero' },
    { label: 'One', value: 'one' },
    { label: 'Two', value: 'two' },
    { label: 'Three', value: 'three' },
  ], { preserveValue: true })
  assert.equal(f.dialog.selectedIndex, 2, 'the id survives, only its row moved')
  const after = f.dialog.render(80)
  const stale = f.dialog.handleMouse(mouse('click', pressedRow, after.length))
  assert.equal(stale?.render, false, 'the stale click is swallowed')
  assert.deepEqual(f.picked, [], 'a press on the old roster cannot activate a new row')

  // A fresh press/click pair on the painted row still works.
  const target = rowAt(after, 'One')
  const fresh = f.dialog.handleMouse(mouse('press', target, after.length))
  assert.equal(fresh?.handled, true)
  const click = f.dialog.handleMouse(mouse('click', target, after.length))
  assert.equal(click?.handled, true)
  assert.deepEqual(f.picked, ['one'])
  assert.deepEqual(f.cancels, [])
})

test('identity preservation keeps focus, shared keymap, frame and width safety', () => {
  const remapped = keymap({ 'list.next': 'alt+j', 'list.previous': 'alt+k' })
  const f = harness([{ label: 'Alpha', value: 'a' }, { label: 'Beta', value: 'b' }], remapped)
  assert.equal(f.dialog.keymap, remapped)
  assert.equal(f.dialog.focused, true)
  assert.equal(f.dialog.capturesViewportInput, true)
  assert.equal(f.dialog.modalSize, 'compact')

  // Default Ctrl+N was remapped away for list.next; the shared binding moves.
  f.dialog.handleInput('\x0e')
  assert.equal(f.dialog.selectedIndex, 0)
  f.dialog.handleInput('\x1bj') // alt+j -> next
  assert.equal(f.dialog.selectedIndex, 1)

  f.dialog.setItems([
    { label: 'Gamma', value: 'g' },
    { label: 'Beta (renamed)', description: 'native detail stays', value: 'b' },
    { label: 'Alpha', value: 'a' },
  ], { preserveValue: true })
  assert.equal(f.dialog.selectedIndex, 1, 'the selected id keeps its exact row in native order')
  assert.equal(f.dialog.keymap, remapped, 'the shared keymap instance is untouched')
  assert.equal(f.dialog.focused, true, 'a roster refresh does not move focus')
  assert.equal(f.dialog.capturesViewportInput, true)
  assert.equal(f.dialog.modalSize, 'compact')
  // No active chord is invented or cancelled by the refresh.
  f.dialog.handleInput('\x1bk') // alt+k -> previous still works
  assert.equal(f.dialog.selectedIndex, 0)
  f.dialog.handleInput('\x1bj')
  assert.equal(f.dialog.selectedIndex, 1)

  const wide = f.dialog.render(80)
  for (const width of [24, 40, 60, 80, 120]) {
    const lines = f.dialog.render(width)
    assertWidths(lines, width)
  }
  const rendered = stripTerminalSequences(wide.join('\n'))
  assert.match(rendered, /Beta \(renamed\) ✔/)
  assert.match(rendered, /native detail stays/)
  const order = ['Gamma', 'Beta (renamed)', 'Alpha'].map(label => rowAt(wide, label))
  assert.deepEqual([...order].sort((left, right) => left - right), order, 'native order is painted, never re-sorted')
  assert.match(rendered, /\[enter Select\]/)
  assert.match(rendered, /\[escape Cancel\]/)

  assert.deepEqual(f.picked, [])
  assert.deepEqual(f.cancels, [])
  f.dialog.handleInput('\r')
  assert.deepEqual(f.picked, ['b'], 'Enter still answers the preserved row')
})
test('a default-effort roster keeps the empty native reset id across a metadata refresh', () => {
  // The default-effort chooser carries the native "use the model/provider
  // default" row as the empty string, then the model's own level ids. A
  // metadata refresh must keep that reset row selected by exact id and submit
  // the empty string, never re-map it to a level id.
  const f = harness([
    { label: 'Default', description: 'Native/provider default', value: '' },
    { label: 'Low', value: 'low' },
    { label: 'High', value: 'high' },
  ])
  move(f.dialog, 2)
  assert.equal(f.dialog.selectedIndex, 2)
  f.dialog.setItems([
    { label: 'Default (refreshed)', description: 'Native/provider default', value: '' },
    { label: 'High (refreshed)', value: 'high' },
    { label: 'Low (refreshed)', value: 'low' },
  ], { preserveValue: true })
  assert.equal(f.dialog.selectedIndex, 1, 'the High row moves with its exact id')
  assert.deepEqual(f.picked, [])
  move(f.dialog, 1)
  assert.equal(f.dialog.selectedIndex, 2, 'list navigation wraps through the reordered roster')
  f.dialog.handleInput('\r')
  assert.deepEqual(f.picked, ['low'], 'exactly one native id is submitted')
  const reset = harness([
    { label: 'Default', description: 'Native/provider default', value: '' },
    { label: 'Low', value: 'low' },
  ])
  reset.dialog.setItems([
    { label: 'Low (refreshed)', value: 'low' },
    { label: 'Default (refreshed)', description: 'Native/provider default', value: '' },
  ], { preserveValue: true })
  assert.equal(reset.dialog.selectedIndex, 1, 'the reset row survives by its empty id')
  reset.dialog.handleInput('\r')
  assert.deepEqual(reset.picked, [''], 'the empty reset id is submitted unchanged')
})
