// Must stay FIRST: forces truecolor before any src module snapshots terminal mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences } from '#pi-tui'
import {
  defaults,
  EXPANDED_INPUT_MAX_LINES_VALUES,
  type Settings,
} from '../src/config.ts'
import type { QueueEntry, WorkspaceChangeDiffResult, WorkspaceChangesSummary } from '../src/backend/types.ts'
import { asTui, createFakeTui } from '../src/input/testing/harness.ts'
import { createCcKeymap } from '../src/input/keymap.ts'
import { SettingsDialog } from '../src/ui/settings.ts'
import { KeybindingsDialog } from '../src/ui/keybindings.ts'
import { HelpPanel } from '../src/ui/help.ts'
import { QueueDialog } from '../src/ui/queue-dialog.ts'
import { WorkspaceChangesDialog } from '../src/ui/workspace-changes-dialog.ts'

/**
 * Compact formal cancel matrix for the independent workspace surfaces.
 *
 * Pi-style Ctrl+C: `app.clear` ships on Ctrl+C, `app.interrupt` ships unbound,
 * and `list.cancel`/`dialog.cancel` keep Ctrl+C as a *local* cancel. These
 * surfaces stay workspace/centered and never own the root draft, so every row
 * below asserts the same three facts:
 *
 * 1. default Ctrl+C cancels the focused local layer (search, entry, detail,
 *    busy surface or the surface itself) and never calls the native interrupt;
 * 2. an explicit user `app.interrupt` override keeps its priority and is never
 *    folded into a local close/cancel;
 * 3. fully disabled cancel rows — and cancel rows remapped *away* from Ctrl+C —
 *    never turn the default `app.clear` key into a phantom close or cancel.
 *
 * The last section pins idempotency and late native reads: a closed surface
 * ignores late payloads and a repeated/retried press never doubles a close.
 */

type CcKeymap = ReturnType<typeof createCcKeymap>

const CTRL_C = '\x03'
const ESC = '\x1b'
const ENTER = '\r'
const DOWN = '\x0e'
const RIGHT = '\x1b[C'

const keymap = (bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap =>
  createCcKeymap({ bindings })

/** Local cancellation is off: every cancel row is explicitly disabled. */
const DISABLED_CANCELS = Object.freeze({ 'list.cancel': null, 'dialog.cancel': null, 'app.cancel': null })
/** Local cancellation exists, but no local cancel key is Ctrl+C any more. */
const REMAPPED_AWAY = Object.freeze({ 'list.cancel': 'ctrl+q', 'dialog.cancel': 'ctrl+w', 'app.cancel': 'ctrl+e' })

// ---------------------------------------------------------------------------
// Settings: browse list + the one embedded numeric-entry field

interface SettingsHarness {
  dialog: SettingsDialog
  events: string[]
  patches: Array<Partial<Settings>>
}

function settingsHarness(options: { keymap?: CcKeymap; onInterrupt?: boolean } = {}): SettingsHarness {
  const events: string[] = []
  const patches: Array<Partial<Settings>> = []
  const dialog = new SettingsDialog(asTui(createFakeTui(30, 100)), {
    settings: { ...defaults },
    onChange: patch => { patches.push(patch) },
    onKeybindings: () => {},
    path: '/temporary/settings.json',
    ...(options.keymap === undefined ? {} : { keymap: options.keymap }),
    onCancel: () => { events.push('cancel') },
    ...(options.onInterrupt === true ? { onInterrupt: () => { events.push('interrupt') } } : {}),
  })
  dialog.focused = true
  return { dialog, events, patches }
}

const settingsText = (dialog: SettingsDialog, width = 100): string =>
  stripTerminalSequences(dialog.render(width).join('\n'))

/** Open the Custom… numeric field of one integer setting through the picker. */
function openNumericEntry(dialog: SettingsDialog, rowId: string): void {
  const jump = (): void => {
    for (let step = 0; step < 20 && dialog.activeCategory !== 'tools'; step += 1) dialog.handleInput(RIGHT)
  }
  jump()
  let index = dialog.getVisibleRows().findIndex(row => row.id === rowId)
  assert.ok(index >= 0, `row ${rowId} exists`)
  while (dialog.activeRowIndex !== index) dialog.handleInput(DOWN)
  dialog.handleInput(ENTER) // enum-style picker with the integer roster
  for (let step = 0; step < EXPANDED_INPUT_MAX_LINES_VALUES.length; step += 1) dialog.handleInput(DOWN)
  dialog.handleInput(ENTER) // Custom… opens the one embedded editor field
  assert.match(settingsText(dialog), /whole number · 1 to 5000/)
}

test('Settings: default Ctrl+C is local for the browse list and the numeric entry field', () => {
  const browse = settingsHarness({ onInterrupt: true })
  browse.dialog.handleInput(CTRL_C)
  assert.deepEqual(browse.events, ['cancel'], 'default Ctrl+C closes Settings locally')
  assert.equal(browse.dialog.isDone, true)

  const entry = settingsHarness({ onInterrupt: true })
  openNumericEntry(entry.dialog, 'expandedInputMaxLines')
  entry.dialog.handleInput(CTRL_C)
  assert.deepEqual(entry.events, [], 'the entry layer never reaches the native interrupt hook')
  assert.equal(entry.dialog.isDone, false, 'Settings stays open after the entry cancel')
  assert.deepEqual(entry.patches, [], 'an abandoned entry writes nothing')
  assert.doesNotMatch(settingsText(entry.dialog), /whole number · 1 to 5000/, 'the entry layer was left')
  assert.match(settingsText(entry.dialog), /Expanded input lines/, 'the browse list is back')

  // Architecture: the abandoned value is unchanged and the list still works.
  entry.dialog.handleInput(DOWN)
  assert.equal(entry.dialog.isDone, false)
})

test('Settings: only an explicit app.interrupt override is native, in the list and in the entry field', () => {
  const explicit: CcKeymap = keymap({ 'app.interrupt': 'ctrl+c' })
  const browse = settingsHarness({ keymap: explicit, onInterrupt: true })
  browse.dialog.handleInput(CTRL_C)
  assert.deepEqual(browse.events, ['interrupt'])
  assert.equal(browse.dialog.isDone, false, 'a native interrupt leaves Settings open')

  const entry = settingsHarness({ keymap: explicit, onInterrupt: true })
  openNumericEntry(entry.dialog, 'expandedInputMaxLines')
  entry.dialog.handleInput(CTRL_C)
  assert.deepEqual(entry.events, ['interrupt'], 'an explicit override keeps priority over the entry cancel')
  assert.equal(entry.dialog.isDone, false)
  assert.match(settingsText(entry.dialog), /whole number · 1 to 5000/, 'the explicit interrupt never cancels the entry')

  // Esc still abandons the entry locally, exactly once.
  entry.dialog.handleInput(ESC)
  assert.deepEqual(entry.events, ['interrupt'])
  assert.doesNotMatch(settingsText(entry.dialog), /whole number · 1 to 5000/)
})

test('Settings: disabled and remapped-away cancel rows give default Ctrl+C no phantom fallback', () => {
  for (const [name, bindings] of [['disabled', DISABLED_CANCELS], ['remapped away', REMAPPED_AWAY]] as const) {
    const browse = settingsHarness({ keymap: keymap(bindings), onInterrupt: true })
    browse.dialog.handleInput(CTRL_C)
    assert.deepEqual(browse.events, [], `${name}: no invented close`)
    assert.equal(browse.dialog.isDone, false, `${name}: Settings stays open`)

    const entry = settingsHarness({ keymap: keymap(bindings), onInterrupt: true })
    openNumericEntry(entry.dialog, 'expandedInputMaxLines')
    entry.dialog.handleInput(CTRL_C)
    assert.deepEqual(entry.events, [], `${name}: the entry cancel is not invented either`)
    assert.match(settingsText(entry.dialog), /whole number · 1 to 5000/, `${name}: the field stays open`)
  }
})

// ---------------------------------------------------------------------------
// Keyboard shortcuts: the binding text-edit layer

function keybindingsHarness(options: { keymap?: CcKeymap; onInterrupt?: boolean } = {}) {
  const events: string[] = []
  const dialog = new KeybindingsDialog(asTui(createFakeTui(20, 90)), {
    keymap: options.keymap ?? keymap(),
    path: '/temporary/keybindings.json',
    onChange: async () => {},
    onBack: () => { events.push('back') },
    ...(options.onInterrupt === true ? { onInterrupt: () => { events.push('interrupt') } } : {}),
  })
  dialog.focused = true
  return { dialog, events }
}

test('Keyboard: default Ctrl+C abandons only the binding edit; explicit interrupt and remaps stay honest', () => {
  const local = keybindingsHarness({ onInterrupt: true })
  local.dialog.handleInput(ENTER)
  assert.equal(local.dialog.isEditing, true)
  const draft = local.dialog.bindingText
  local.dialog.handleInput(CTRL_C)
  assert.deepEqual(local.events, [])
  assert.equal(local.dialog.isEditing, false, 'default Ctrl+C cancels the embedded editor layer')
  assert.equal(local.dialog.bindingText, draft, 'the abandoned draft is never applied or rewritten')
  local.dialog.handleInput(CTRL_C)
  assert.deepEqual(local.events, ['back'], 'the next press is the browse-layer local cancel')

  const explicit = keybindingsHarness({ keymap: keymap({ 'app.interrupt': 'ctrl+c' }), onInterrupt: true })
  explicit.dialog.handleInput(ENTER)
  explicit.dialog.handleInput(CTRL_C)
  assert.deepEqual(explicit.events, ['interrupt'])
  assert.equal(explicit.dialog.isEditing, true, 'the explicit interrupt never cancels the edit')

  for (const [name, bindings] of [['disabled', DISABLED_CANCELS], ['remapped away', REMAPPED_AWAY]] as const) {
    const f = keybindingsHarness({ keymap: keymap(bindings), onInterrupt: true })
    f.dialog.handleInput(ENTER)
    const before = f.dialog.bindingText
    f.dialog.handleInput(CTRL_C)
    assert.deepEqual(f.events, [], `${name}: no phantom back/cancel`)
    assert.equal(f.dialog.isEditing, true, `${name}: the edit stays open`)
    assert.equal(f.dialog.bindingText, before, `${name}: the dropped app.clear never edits the field`)
  }
})

// ---------------------------------------------------------------------------
// Help: the search sublayer versus the browse list

const helpOpen = (panel: HelpPanel): boolean => panel.render(80).length > 0

function helpHarness(options: { keymap?: CcKeymap; onInterrupt?: boolean } = {}) {
  const events: string[] = []
  const panel = new HelpPanel(asTui(createFakeTui(24, 90)), {
    commands: [{ name: 'model', description: 'Choose a DSH model' }],
    customCommands: [],
    keymap: options.keymap ?? keymap(),
    onClose: () => { events.push('close') },
    ...(options.onInterrupt === true ? { onInterrupt: () => { events.push('interrupt') } } : {}),
  })
  panel.focused = true
  panel.render(80)
  return { panel, events }
}

test('Help: default Ctrl+C restores the search layer, then closes the browse list locally', () => {
  const f = helpHarness({ onInterrupt: true })
  f.panel.handleInput('\x06') // modal.search
  f.panel.handleInput('m')
  assert.equal(f.panel.searching, true)
  f.panel.handleInput(CTRL_C)
  assert.deepEqual(f.events, [], 'default Ctrl+C never reaches the native interrupt hook')
  assert.equal(f.panel.searching, false, 'the search layer is cancelled locally')
  assert.equal(helpOpen(f.panel), true, 'Help stays open')
  f.panel.handleInput(CTRL_C)
  assert.deepEqual(f.events, ['close'], 'the browse layer then closes locally')
  f.panel.handleInput(CTRL_C)
  assert.deepEqual(f.events, ['close'], 'idempotent: a repeated press never doubles the close')

  const explicit = helpHarness({ keymap: keymap({ 'app.interrupt': 'ctrl+c' }), onInterrupt: true })
  explicit.panel.handleInput(CTRL_C)
  assert.deepEqual(explicit.events, ['interrupt'])
  assert.equal(helpOpen(explicit.panel), true)

  for (const [name, bindings] of [['disabled', DISABLED_CANCELS], ['remapped away', REMAPPED_AWAY]] as const) {
    const browse = helpHarness({ keymap: keymap(bindings), onInterrupt: true })
    browse.panel.handleInput(CTRL_C)
    assert.deepEqual(browse.events, [], `${name}: no phantom close`)
    assert.equal(helpOpen(browse.panel), true)
    const search = helpHarness({ keymap: keymap(bindings), onInterrupt: true })
    search.panel.handleInput('\x06')
    search.panel.handleInput('m')
    search.panel.handleInput(CTRL_C)
    assert.deepEqual(search.events, [], `${name}: no phantom search cancel`)
    assert.equal(search.panel.searching, true)
  }
})

// ---------------------------------------------------------------------------
// Queue: the local cancel must stay available while a parent request is pending

const QUEUE_ENTRIES: readonly QueueEntry[] = [
  { messageId: 'msg-1', text: 'first queued message', target: 'next-turn', images: 0 },
]

function queueHarness(options: { keymap?: CcKeymap; onInterrupt?: boolean; pending?: boolean } = {}) {
  const events: string[] = []
  let release: (() => void) | undefined
  const dialog = new QueueDialog(asTui(createFakeTui(24, 90)), {
    entries: QUEUE_ENTRIES,
    keymap: options.keymap ?? keymap(),
    onEdit: options.pending === true ? () => new Promise<void>(resolve => { release = resolve }) : () => {},
    onClose: () => { events.push('close') },
    ...(options.onInterrupt === true ? { onInterrupt: () => { events.push('interrupt') } } : {}),
  })
  dialog.focused = true
  return { dialog, events, release: () => release?.() }
}

test('Queue: default Ctrl+C cancels the local surface (search, busy, list) without a native interrupt', async () => {
  const busy = queueHarness({ onInterrupt: true, pending: true })
  busy.dialog.handleInput('e') // queue.edit -> parent request pending
  assert.equal(busy.dialog.isBusy, true)
  busy.dialog.handleInput(CTRL_C)
  assert.deepEqual(busy.events, ['close'], 'a pending parent request never traps the local cancel')
  busy.release()

  const search = queueHarness({ onInterrupt: true })
  search.dialog.handleInput('\x06') // modal.search
  search.dialog.handleInput('f')
  search.dialog.handleInput(CTRL_C)
  assert.deepEqual(search.events, [], 'default Ctrl+C never interrupts natively')
  assert.equal(search.dialog.isDone, false, 'the search layer is restored before the surface closes')

  const explicit = queueHarness({ keymap: keymap({ 'app.interrupt': 'ctrl+c' }), onInterrupt: true })
  explicit.dialog.handleInput(CTRL_C)
  assert.deepEqual(explicit.events, ['interrupt'])

  for (const [name, bindings] of [['disabled', DISABLED_CANCELS], ['remapped away', REMAPPED_AWAY]] as const) {
    const f = queueHarness({ keymap: keymap(bindings), onInterrupt: true })
    f.dialog.handleInput(CTRL_C)
    assert.deepEqual(f.events, [], `${name}: no phantom close`)
    assert.equal(f.dialog.isDone, false)
  }
})

// ---------------------------------------------------------------------------
// Workspace changes: read-only detail sublayer + late native reads

const WORKSPACE_SUMMARY: WorkspaceChangesSummary = {
  turn: 1,
  files: [
    { path: '/repo/src/a.ts', display: 'src/a.ts', added: 2, deleted: 1 },
    { path: '/repo/src/b.ts', display: 'src/b.ts', added: 1, deleted: 0 },
  ],
  total: 2,
  added: 3,
  deleted: 1,
}

const DIFF_RESULT: WorkspaceChangeDiffResult = {
  sessionId: 'session-cancel',
  attachmentId: 'attach-cancel',
  seq: 4,
  index: 0,
  diff: {
    kind: 'text',
    path: '/repo/src/a.ts',
    display: 'src/a.ts',
    before: true,
    after: true,
    coarse: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+x'] }],
  },
}

function workspaceHarness(options: { keymap?: CcKeymap; onInterrupt?: boolean } = {}) {
  const requests: number[] = []
  const events: string[] = []
  const dialog = new WorkspaceChangesDialog(asTui(createFakeTui(30, 90)), {
    seq: 4,
    summary: WORKSPACE_SUMMARY,
    sessionId: 'session-cancel',
    attachmentId: 'attach-cancel',
    keymap: options.keymap ?? keymap(),
    loadDiff: (_seq, index) => { requests.push(index) },
    onClose: () => { events.push('close') },
    ...(options.onInterrupt === true ? { onInterrupt: () => { events.push('interrupt') } } : {}),
  })
  dialog.focused = true
  return { dialog, requests, events }
}

test('Workspace changes: default Ctrl+C cancels the detail layer first, then closes; late reads are dropped', () => {
  const f = workspaceHarness({ onInterrupt: true })
  f.dialog.openDetail(0)
  assert.equal(f.dialog.mode, 'detail')
  f.dialog.handleInput(CTRL_C)
  assert.deepEqual(f.events, [], 'default Ctrl+C never reaches the native interrupt hook')
  assert.equal(f.dialog.mode, 'list', 'Ctrl+C backs out of the read-only detail view like Esc')
  assert.equal(f.requests.length, 1, 'cancelling never re-requests a native read')
  f.dialog.handleInput(CTRL_C)
  assert.deepEqual(f.events, ['close'])
  assert.equal(f.dialog.isDone, true)
  // Late native payload after the close: dropped, no repaint revival.
  assert.equal(f.dialog.setDiff(DIFF_RESULT), false)
  assert.deepEqual(f.dialog.render(90), [])
  f.dialog.handleInput(CTRL_C)
  assert.deepEqual(f.events, ['close'], 'idempotent: a closed view never closes twice')

  const explicit = workspaceHarness({ keymap: keymap({ 'app.interrupt': 'ctrl+c' }), onInterrupt: true })
  explicit.dialog.handleInput(CTRL_C)
  assert.deepEqual(explicit.events, ['interrupt'])
  assert.equal(explicit.dialog.isDone, false)

  for (const [name, bindings] of [['disabled', DISABLED_CANCELS], ['remapped away', REMAPPED_AWAY]] as const) {
    const browse = workspaceHarness({ keymap: keymap(bindings), onInterrupt: true })
    browse.dialog.handleInput(CTRL_C)
    assert.deepEqual(browse.events, [], `${name}: no phantom close`)
    assert.equal(browse.dialog.isDone, false)
    const detail = workspaceHarness({ keymap: keymap(bindings), onInterrupt: true })
    detail.dialog.openDetail(0)
    detail.dialog.handleInput(CTRL_C)
    assert.equal(detail.dialog.mode, 'detail', `${name}: no phantom back`)
    assert.deepEqual(detail.events, [])
  }
})