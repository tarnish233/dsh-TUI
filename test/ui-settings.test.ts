// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import {
  defaults,
  DIFF_INDICATOR_MODE_VALUES,
  DIFF_SPLIT_MIN_WIDTH_VALUES,
  DIFF_VIEW_MODE_VALUES,
  EDIT_DIFF_COLLAPSED_LINES_VALUES,
  EXPANDED_INPUT_MAX_LINES_VALUES,
  EXPANDED_OUTPUT_MAX_LINES_VALUES,
  THINKING_LIVE_TIMER_MS_VALUES,
  THINKING_PREVIEW_LINES_VALUES,
  TOOL_LABEL_CLIP_VALUES,
  TOOL_SETTING_KEYS,
  WRITE_DIFF_COLLAPSED_LINES_VALUES,
  type Settings,
} from '../src/config.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

const input = await loadInputModule()
const { SETTINGS_TABS, SettingsDialog } = await import('../src/ui/settings.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>

const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const DOWN = '\x0e'
const UP = '\x10'
const ENTER = '\r'
const ESC = '\x1b'
const CTRL_C = '\x03'

interface Harness {
  dialog: InstanceType<typeof SettingsDialog>
  patches: Array<Partial<Settings>>
  events: string[]
  renders: () => number
}

function harness(options: {
  settings?: Partial<Settings>
  keymap?: CcKeymap
  screen?: 'inline' | 'fullscreen'
  autoTitleLabel?: string
  onChange?: (patch: Partial<Settings>) => void | Promise<void>
  onAutoTitle?: () => void
  onKeybindings?: () => void
  onCancel?: () => void
  onInterrupt?: () => void
  withInterrupt?: boolean
  rows?: number
} = {}): Harness {
  const tui = createFakeTui(options.rows ?? 30, 100)
  const patches: Array<Partial<Settings>> = []
  const events: string[] = []
  const dialog = new SettingsDialog(asTui(tui), {
    settings: { ...defaults, ...options.settings },
    ...(options.autoTitleLabel === undefined ? {} : { autoTitleLabel: options.autoTitleLabel }),
    onChange: patch => {
      patches.push(patch)
      return options.onChange?.(patch)
    },
    onAutoTitle: () => {
      events.push('autoTitle')
      options.onAutoTitle?.()
    },
    onKeybindings: () => {
      events.push('keybindings')
      options.onKeybindings?.()
    },
    ...(options.keymap === undefined ? {} : { keymap: options.keymap }),
    ...(options.screen === undefined ? {} : { screen: options.screen }),
    path: '/tmp/settings.json',
    onCancel: () => {
      events.push('cancel')
      options.onCancel?.()
    },
    ...(options.withInterrupt === true
      ? { onInterrupt: () => { events.push('interrupt'); options.onInterrupt?.() } }
      : {}),
  })
  dialog.focused = true
  return { dialog, patches, events, renders: () => tui.renderRequests }
}

const text = (dialog: InstanceType<typeof SettingsDialog>, width = 72): string =>
  stripTerminalSequences(dialog.render(width).join('\n'))

const rowIndex = (dialog: InstanceType<typeof SettingsDialog>, id: string): number => {
  const index = dialog.rows().findIndex((row: { id: string }) => row.id === id)
  assert.ok(index >= 0, `row ${id} exists on the active tab`)
  return index
}

/** Move the selection to `id` on the active tab. */
function selectRow(dialog: InstanceType<typeof SettingsDialog>, id: string): void {
  const from = rowIndex(dialog, dialog.activeRowId ?? '')
  const to = rowIndex(dialog, id)
  const step = to >= from ? DOWN : UP
  for (let count = Math.abs(to - from); count > 0; count -= 1) dialog.handleInput(step)
  assert.equal(dialog.activeRowId, id)
}

// ---------------------------------------------------------------------------

test('settings expose three tabs with the documented roster and current values', () => {
  const { dialog } = harness({ settings: { expandTools: true, thinkingPreviewLines: 5, thinkingLiveTimerMs: 90 }, screen: 'inline' })
  assert.equal(dialog.capturesViewportInput, true)
  assert.deepEqual(SETTINGS_TABS.map((tab: { id: string }) => tab.id), ['general', 'thinking', 'tools'])
  assert.deepEqual(SETTINGS_TABS.map((tab: { label: string }) => tab.label), ['General', 'Thinking', 'Tools'])
  assert.equal(dialog.activeTab, 'general')
  // General has no duplicate tool-display row anymore; shortcuts stay last.
  assert.deepEqual(dialog.rows().map((row: { id: string }) => row.id), ['autoTitle', 'screen', 'keys'])
  assert.deepEqual(dialog.rows().map((row: { label: string }) => row.label), ['Auto title', 'Default screen', 'Keyboard shortcuts'])
  assert.deepEqual(dialog.rows().map((row: { value: string }) => row.value), ['inherit', 'fullscreen (next launch) · running inline', 'edit'])

  dialog.handleInput(RIGHT)
  assert.equal(dialog.activeTab, 'thinking')
  assert.deepEqual(dialog.rows().map((row: { id: string }) => row.id), ['thinking', 'preview', 'timer'])
  assert.deepEqual(dialog.rows().map((row: { value: string }) => row.value), ['off', '5', '90ms'])

  dialog.handleInput(RIGHT)
  assert.equal(dialog.activeTab, 'tools')
  assert.deepEqual(dialog.rows().map((row: { id: string }) => row.id), TOOL_SETTING_KEYS)
  assert.deepEqual(dialog.rows().map((row: { label: string }) => row.label), [
    'Group tool calls', 'Expand tool details', 'Expanded input lines', 'Expanded output lines',
    'Tool label clip', 'Diff layout', 'Diff indicator', 'Split min width',
    'Edit collapsed lines', 'Write collapsed lines', 'Diff word wrap',
  ])
  assert.deepEqual(dialog.rows().map((row: { value: string }) => row.value), [
    'on', 'on', '5', '10', 'auto', 'auto', 'bars', '120 cols', '24', '0', 'on',
  ])

  // The flat roster order is preserved tab by tab, with no duplicated key.
  assert.deepEqual(dialog.allRows.map((row: { id: string }) => row.id), [
    'autoTitle', 'screen', 'keys', 'thinking', 'preview', 'timer', ...TOOL_SETTING_KEYS,
  ])
  assert.equal(new Set(dialog.allRows.map((row: { id: string }) => row.id)).size, dialog.allRows.length)

  const rendered = text(dialog)
  assert.match(rendered, /Settings · \/tmp\/settings\.json/)
  assert.match(rendered, /General/)
  assert.match(rendered, /Thinking/)
  assert.match(rendered, /Tools/)
  assert.match(rendered, /Diff word wrap/)
  assert.match(rendered, /←\/→ switch tab/)
})

test('arrows, Tab and Shift+Tab switch tabs and keep a valid row selection', () => {
  const { dialog, renders } = harness()
  dialog.handleInput(DOWN)
  dialog.handleInput(DOWN)
  const before = renders()
  dialog.handleInput(RIGHT)
  assert.equal(dialog.activeTab, 'thinking')
  assert.ok(renders() > before, 'switching tabs asks for a repaint')
  assert.ok(dialog.activeRowId === 'timer', 'the row index is clamped into the new tab')

  dialog.handleInput(RIGHT)
  assert.equal(dialog.activeTab, 'tools', 'right on the second tab moves to Tools')
  dialog.handleInput(RIGHT)
  assert.equal(dialog.activeTab, 'general', 'right on the last tab wraps to the first')
  dialog.handleInput(LEFT)
  assert.equal(dialog.activeTab, 'tools', 'left on the first tab wraps to the last')
  dialog.handleInput('\t')
  assert.equal(dialog.activeTab, 'general')
  dialog.handleInput('\x1b[Z')
  assert.equal(dialog.activeTab, 'tools')
  assert.match(text(dialog), /Diff word wrap/)
})

test('Enter cycles Preview lines through the documented values', () => {
  const { dialog, patches } = harness()
  dialog.handleInput(RIGHT)
  selectRow(dialog, 'preview')
  const seen: number[] = []
  for (let step = 0; step < THINKING_PREVIEW_LINES_VALUES.length; step += 1) {
    dialog.handleInput(ENTER)
    seen.push(patches.at(-1)?.thinkingPreviewLines ?? -1)
  }
  // Starting at 3, the roster is 5, 10, 0, 1 and wraps back to 3.
  assert.deepEqual(seen, [5, 10, 0, 1, 3])
  assert.deepEqual(patches.map(patch => patch.thinkingPreviewLines), [5, 10, 0, 1, 3])
  assert.equal(dialog.settings.thinkingPreviewLines, 3)
  assert.equal(dialog.rows().find((row: { id: string }) => row.id === 'preview')?.value, '3')
})

test('Live timer cycles 90/250/500ms and off, and Show thinking toggles', () => {
  const { dialog, patches } = harness({ settings: { thinkingLiveTimerMs: 250 } })
  dialog.handleInput(RIGHT)
  selectRow(dialog, 'timer')
  const values: string[] = []
  for (let step = 0; step < THINKING_LIVE_TIMER_MS_VALUES.length; step += 1) {
    dialog.handleInput(ENTER)
    values.push(dialog.rows().find((row: { id: string }) => row.id === 'timer')?.value ?? '')
  }
  assert.deepEqual(values, ['500ms', 'off', '90ms', '250ms'])
  assert.deepEqual(patches.map(patch => patch.thinkingLiveTimerMs), [500, 0, 90, 250])

  selectRow(dialog, 'thinking')
  dialog.handleInput(ENTER)
  assert.deepEqual(patches.at(-1), { showThinking: true })
  assert.equal(dialog.rows().find((row: { id: string }) => row.id === 'thinking')?.value, 'on')
  dialog.handleInput(ENTER)
  assert.deepEqual(patches.at(-1), { showThinking: false })
})

test('General rows change local preferences and defer native surfaces to the parent', () => {
  const { dialog, patches, events } = harness({ settings: { screen: 'inline' } })
  selectRow(dialog, 'screen')
  dialog.handleInput(ENTER)
  assert.deepEqual(patches.at(-1), { screen: 'fullscreen' })
  assert.match(text(dialog), /fullscreen \(next launch\)/)
  dialog.handleInput(ENTER)
  assert.deepEqual(patches.at(-1), { screen: 'inline' })

  selectRow(dialog, 'autoTitle')
  dialog.handleInput(ENTER)
  assert.deepEqual(events, ['autoTitle'], 'the native auto-title round trip stays parent-owned')
  assert.equal(patches.length, 2, 'the native command is not turned into a local preference write')

  selectRow(dialog, 'keys')
  dialog.handleInput(ENTER)
  assert.deepEqual(events, ['autoTitle', 'keybindings'])
})

test('the native auto-title label and refreshed snapshots are shown verbatim', () => {
  const { dialog } = harness({ autoTitleLabel: 'inherit · native on' })
  assert.equal(dialog.rows().find((row: { id: string }) => row.id === 'autoTitle')?.value, 'inherit · native on')
  dialog.setSettings({ ...defaults, thinkingPreviewLines: 10, thinkingLiveTimerMs: 0 })
  dialog.handleInput(RIGHT)
  assert.deepEqual(dialog.rows().map((row: { value: string }) => row.value), ['off', '10', 'off'])
})

test('list navigation and cancellation follow the shared keymap', () => {
  const keymap = input.createCcKeymap({ bindings: { 'list.next': 'alt+j', 'list.previous': 'alt+k' } })
  const { dialog, events } = harness({ keymap })
  assert.equal(dialog.keymap, keymap)
  // The default Ctrl+N no longer moves once list.next is remapped.
  dialog.handleInput(DOWN)
  assert.equal(dialog.activeRowId, 'autoTitle', 'the default binding is gone')
  dialog.handleInput('\x1bj')
  assert.equal(dialog.activeRowId, 'screen')

  dialog.handleInput(ESC)
  assert.equal(dialog.isDone, true)
  assert.deepEqual(events, ['cancel'])
})

test('Ctrl+C interrupts the turn instead of closing the surface', () => {
  const { dialog, events } = harness({ withInterrupt: true })
  dialog.handleInput(CTRL_C)
  assert.deepEqual(events, ['interrupt'])
  assert.equal(dialog.isDone, false, 'an interrupt is not a local close')

  const local = harness()
  local.dialog.handleInput(CTRL_C)
  assert.deepEqual(local.events, ['cancel'], 'without a handler the surface still closes')
})

test('a rejected write is reported instead of silently pretending it saved', async () => {
  const { dialog } = harness({
    onChange: () => Promise.reject(new Error('Refusing to overwrite invalid settings file')),
  })
  dialog.handleInput(RIGHT)
  selectRow(dialog, 'preview')
  dialog.handleInput(ENTER)
  await new Promise(resolve => setImmediate(resolve))
  assert.match(text(dialog), /Refusing to overwrite invalid settings file/)
})

test('every line stays inside the render width, including the narrow stacked layout', () => {
  const { dialog } = harness({ screen: 'fullscreen', rows: 48 })
  const tabs = ['general', 'thinking', 'tools']
  for (const [index, tab] of tabs.entries()) {
    assert.equal(dialog.activeTab, tab)
    for (const width of [1, 20, 24, 32, 46, 60, 80, 120]) {
      for (const line of dialog.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
      }
    }
    const narrow = stripTerminalSequences(dialog.render(24).join('\n'))
    assert.ok(narrow.includes('General') || narrow.includes('Thinking') || narrow.includes('Tools'), `${tab} tab header is visible at width 24`)
    if (index < tabs.length - 1) dialog.handleInput(RIGHT)
  }
})

test('the Tools tab cycles every shared tool preference through one patch', () => {
  const { dialog, patches } = harness()
  dialog.handleInput(RIGHT)
  dialog.handleInput(RIGHT)
  assert.equal(dialog.activeTab, 'tools')

  const seen: Array<Record<string, unknown>> = []
  const cycle = (id: string, times: number): void => {
    selectRow(dialog, id)
    for (let step = 0; step < times; step += 1) {
      dialog.handleInput(ENTER)
      seen.push({ ...patches.at(-1) })
    }
  }

  cycle('groupTools', 1)
  cycle('expandTools', 1)
  cycle('expandedInputMaxLines', EXPANDED_INPUT_MAX_LINES_VALUES.length)
  cycle('expandedOutputMaxLines', EXPANDED_OUTPUT_MAX_LINES_VALUES.length)
  cycle('toolLabelClip', TOOL_LABEL_CLIP_VALUES.length)
  cycle('diffViewMode', DIFF_VIEW_MODE_VALUES.length)
  cycle('diffIndicatorMode', DIFF_INDICATOR_MODE_VALUES.length)
  cycle('diffSplitMinWidth', DIFF_SPLIT_MIN_WIDTH_VALUES.length)
  cycle('editDiffCollapsedLines', EDIT_DIFF_COLLAPSED_LINES_VALUES.length)
  cycle('writeDiffCollapsedLines', WRITE_DIFF_COLLAPSED_LINES_VALUES.length)
  cycle('diffWordWrap', 1)

  // Each write stays one flat settings object with exactly one changed key.
  for (const patch of seen) assert.equal(Object.keys(patch).length, 1)
  assert.deepEqual(seen[0], { groupTools: false })
  assert.deepEqual(seen[1], { expandTools: true })
  assert.deepEqual(seen.filter(patch => 'expandedInputMaxLines' in patch).map(patch => patch.expandedInputMaxLines), [10, 20, 40, 80, 5])
  assert.deepEqual(seen.filter(patch => 'expandedOutputMaxLines' in patch).map(patch => patch.expandedOutputMaxLines), [20, 40, 80, 120, 10])
  assert.deepEqual(seen.filter(patch => 'toolLabelClip' in patch).map(patch => patch.toolLabelClip), [40, 60, 80, 100, 120, 160, 0])
  assert.deepEqual(seen.filter(patch => 'diffViewMode' in patch).map(patch => patch.diffViewMode), ['split', 'unified', 'auto'])
  assert.deepEqual(seen.filter(patch => 'diffIndicatorMode' in patch).map(patch => patch.diffIndicatorMode), ['classic', 'none', 'bars'])
  assert.deepEqual(seen.filter(patch => 'diffSplitMinWidth' in patch).map(patch => patch.diffSplitMinWidth), [140, 160, 180, 80, 100, 120])
  assert.deepEqual(seen.filter(patch => 'editDiffCollapsedLines' in patch).map(patch => patch.editDiffCollapsedLines), [36, 48, 80, 120, 0, 12, 24])
  assert.deepEqual(seen.filter(patch => 'writeDiffCollapsedLines' in patch).map(patch => patch.writeDiffCollapsedLines), [4, 8, 12, 24, 36, 0])
  assert.deepEqual(seen.at(-1), { diffWordWrap: false })

  // The local snapshot and rendered values follow every accepted cycle.
  assert.equal(dialog.settings.writeDiffCollapsedLines, 0)
  assert.equal(dialog.settings.diffWordWrap, false)
  assert.equal(dialog.rows().find((row: { id: string }) => row.id === 'toolLabelClip')?.value, 'auto')
})

test('Tools values and rosters follow a hot-refreshed snapshot', () => {
  const { dialog, renders } = harness({
    settings: {
      groupTools: false, expandTools: true, expandedInputMaxLines: 20, expandedOutputMaxLines: 40,
      toolLabelClip: 60, diffViewMode: 'split', diffIndicatorMode: 'none', diffSplitMinWidth: 160,
      editDiffCollapsedLines: 48, writeDiffCollapsedLines: 12, diffWordWrap: false,
    },
  })
  dialog.handleInput(RIGHT)
  dialog.handleInput(RIGHT)
  assert.deepEqual(dialog.rows().map((row: { value: string }) => row.value), [
    'off', 'on', '20', '40', '60 cols', 'split', 'none', '160 cols', '48', '12', 'off',
  ])

  const before = renders()
  dialog.setSettings({
    ...defaults,
    groupTools: true, expandTools: false, expandedInputMaxLines: 10, expandedOutputMaxLines: 20,
    toolLabelClip: 0, diffViewMode: 'unified', diffIndicatorMode: 'classic', diffSplitMinWidth: 100,
    editDiffCollapsedLines: 12, writeDiffCollapsedLines: 4, diffWordWrap: true,
  })
  assert.ok(renders() > before)
  assert.deepEqual(dialog.rows().map((row: { value: string }) => row.value), [
    'on', 'off', '10', '20', 'auto', 'unified', 'classic', '100 cols', '12', '4', 'on',
  ])
  // The cycle continues from the refreshed value, not the old snapshot.
  selectRow(dialog, 'toolLabelClip')
  dialog.handleInput(ENTER)
  assert.equal(dialog.settings.toolLabelClip, 40)
})

test('digit selection activates a Tools row and disabled navigation stays inert', () => {
  const keymap = input.createCcKeymap({ bindings: { 'list.select-digit': null } })
  const { dialog, patches } = harness({ keymap })
  dialog.handleInput(RIGHT)
  dialog.handleInput(RIGHT)
  dialog.handleInput('2')
  assert.equal(dialog.activeRowId, 'groupTools', 'digit shortcuts are disabled with the shared action')
  assert.equal(patches.length, 0)

  const defaultsKeymap = harness()
  defaultsKeymap.dialog.handleInput(RIGHT)
  defaultsKeymap.dialog.handleInput(RIGHT)
  defaultsKeymap.dialog.handleInput('2')
  assert.equal(defaultsKeymap.dialog.activeRowId, 'expandTools')
  assert.deepEqual(defaultsKeymap.patches.at(-1), { expandTools: true }, 'digit 2 activates the second Tools row directly')
  defaultsKeymap.dialog.handleInput(ENTER)
  assert.deepEqual(defaultsKeymap.patches.at(-1), { expandTools: false })
})

test('Tools rows respect shared keymap remaps for navigation and activation', () => {
  const keymap = input.createCcKeymap({
    bindings: { 'list.next': 'alt+j', 'list.previous': 'alt+k', 'list.select': null, 'dialog.confirm': 'alt+enter' },
  })
  const { dialog, patches } = harness({ keymap })
  dialog.handleInput(RIGHT)
  dialog.handleInput(RIGHT)
  dialog.handleInput(DOWN)
  assert.equal(dialog.activeRowId, 'groupTools', 'default Ctrl+N is disabled by the remap')
  dialog.handleInput('\x1bj')
  assert.equal(dialog.activeRowId, 'expandTools')
  dialog.handleInput(ENTER)
  assert.equal(patches.length, 0, 'Enter no longer activates once list/dialog select is remapped away')
})

test('a SettingsDialog works without an explicit keymap', () => {
  const tui = createFakeTui(24, 80)
  const dialog = new SettingsDialog(asTui(tui), {
    settings: { ...defaults },
    onChange: () => {},
    onAutoTitle: () => {},
    onKeybindings: () => {},
    onCancel: () => {},
  })
  dialog.handleInput(RIGHT)
  assert.equal(dialog.activeTab, 'thinking')
  assert.ok(dialog.keymap !== undefined)
})