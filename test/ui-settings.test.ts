// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences } from '#pi-tui'
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
const { SETTINGS_CATEGORIES, SettingsDialog } = await import('../src/ui/settings.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Dialog = InstanceType<typeof SettingsDialog>

const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const DOWN = '\x0e'
const UP = '\x10'
const ENTER = '\r'
const ESC = '\x1b'
const CTRL_C = '\x03'
const CTRL_F = '\x06'
const CTRL_R = '\x12'

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const lines = (dialog: Dialog, width: number): string[] => dialog.render(width)
const text = (dialog: Dialog, width = 80): string => stripTerminalSequences(lines(dialog, width).join('\n'))

const lineOf = (dialog: Dialog, needle: string, width = 80): number => {
  const index = dialog.render(width).findIndex(line => stripTerminalSequences(line).includes(needle))
  assert.ok(index >= 0, `${needle} is rendered`)
  return index
}

interface Harness {
  dialog: Dialog
  patches: Array<Partial<Settings>>
  resets: Array<keyof Settings>
  events: string[]
  renders: () => number
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function harness(options: {
  settings?: Partial<Settings>
  keymap?: CcKeymap
  screen?: 'inline' | 'fullscreen'
  onChange?: (patch: Partial<Settings>) => void | Promise<void | Settings>
  onReset?: (key: keyof Settings) => void | Promise<void | Settings>
  onKeybindings?: () => void
  onCancel?: () => void
  onInterrupt?: () => void
  withInterrupt?: boolean
  nativeEntries?: () => readonly { id: string; label: string; value: string; description?: string; available?: boolean; keywords?: string; onActivate?: () => void }[]
  initialState?: { category: 'general' | 'thinking' | 'tools' | 'agents' | 'images' | 'dsh' | 'keyboard'; rowId?: string; query?: string; scroll?: number }
  maxHeight?: number
  rows?: number
} = {}): Harness {
  const tui = createFakeTui(options.rows ?? 30, 100)
  const patches: Array<Partial<Settings>> = []
  const resets: Array<keyof Settings> = []
  const events: string[] = []
  const dialog = new SettingsDialog(asTui(tui), {
    settings: { ...defaults, ...options.settings },
    onChange: patch => {
      patches.push(patch)
      return options.onChange?.(patch)
    },
    ...(options.onReset === undefined ? {} : { onReset: key => { resets.push(key); return options.onReset?.(key) } }),
    onKeybindings: () => {
      events.push('keybindings')
      options.onKeybindings?.()
    },
    ...(options.nativeEntries === undefined ? {} : { getNativeEntries: options.nativeEntries }),
    ...(options.keymap === undefined ? {} : { keymap: options.keymap }),
    ...(options.screen === undefined ? {} : { screen: options.screen }),
    ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
    ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
    path: '/tmp/temporary/settings.json',
    onCancel: () => {
      events.push('cancel')
      options.onCancel?.()
    },
    ...(options.withInterrupt === true
      ? { onInterrupt: () => { events.push('interrupt'); options.onInterrupt?.() } }
      : {}),
  })
  dialog.focused = true
  return { dialog, patches, resets, events, renders: () => tui.renderRequests }
}

/** Move within the one visible list to `id` (search/query must be empty). */
function selectRow(dialog: Dialog, id: string): void {
  const rows = dialog.getVisibleRows()
  const to = rows.findIndex(row => row.id === id)
  assert.ok(to >= 0, `row ${id} exists in the visible list (${rows.map(row => row.id).join(',')})`)
  const from = rows.findIndex(row => row.id === dialog.activeRowId)
  const step = to >= from ? DOWN : UP
  for (let count = Math.abs(to - from); count > 0; count -= 1) dialog.handleInput(step)
  assert.equal(dialog.activeRowId, id)
}

/** Every visible row of one group, in the same metadata order as the page. */
function sectionRows(dialog: Dialog, category: string): string[] {
  return dialog.getVisibleRows().filter(row => row.category === category).map(row => row.id)
}

/** Section jump (the `settings.next-category` / `previous-category` actions). */
function jumpToSection(dialog: Dialog, category: string): void {
  for (let step = 0; step < SETTINGS_CATEGORIES.length * 2 && dialog.activeCategory !== category; step += 1) {
    dialog.handleInput(RIGHT)
  }
  assert.equal(dialog.activeCategory, category)
}

/** Enter opens the typed picker; down selects the following roster value. */
function cycleOnce(dialog: Dialog): void {
  dialog.handleInput(ENTER)
  dialog.handleInput(DOWN)
  dialog.handleInput(ENTER)
}

// ---------------------------------------------------------------------------
// One continuous page

test('every available section shares one continuous page in metadata order', () => {
  const { dialog } = harness({ rows: 80 })
  assert.equal(dialog.capturesViewportInput, true)
  assert.equal(dialog.modalSize, 'standard')
  assert.deepEqual(SETTINGS_CATEGORIES.map(item => item.id), ['general', 'thinking', 'tools', 'agents', 'images', 'dsh', 'keyboard'])
  assert.deepEqual(SETTINGS_CATEGORIES.map(item => item.label), ['General', 'Thinking', 'Tools & Diff', 'Agents', 'Images', 'DSH', 'Keyboard'])

  const rows = dialog.getVisibleRows()
  assert.deepEqual(rows.map(row => row.id), [
    'screen', 'copyOnSelect', 'queueCollapsed', 'reducedMotion',
    'terminalStatus', 'terminalTitle', 'terminalNotifications',
    'thinking', 'preview', 'timer',
    ...TOOL_SETTING_KEYS,
    'showSubagentProgress', 'groupSubagentMessages',
    'imagePreview',
    'native:none',
    'keys',
  ])
  assert.deepEqual(rows.map(row => row.category), [
    ...new Array(7).fill('general'), ...new Array(3).fill('thinking'),
    ...TOOL_SETTING_KEYS.map(() => 'tools'), ...new Array(2).fill('agents'),
    'images', 'dsh', 'keyboard',
  ])
  assert.deepEqual(dialog.allRows.map(row => row.id), rows.map(row => row.id), 'the unfiltered roster is the same page')
  assert.equal(dialog.activeCategory, 'general')
  assert.equal(dialog.activeTab, 'general', 'the old tab getter stays as a section alias')
  assert.equal(dialog.activeRowIndex, 0, 'row numbers index the continuous roster')

  assert.deepEqual(sectionRows(dialog, 'general'), [
    'screen', 'copyOnSelect', 'queueCollapsed', 'reducedMotion',
    'terminalStatus', 'terminalTitle', 'terminalNotifications',
  ], 'terminal rows come last in General and keep the old row ids first')
  assert.deepEqual(sectionRows(dialog, 'thinking'), ['thinking', 'preview', 'timer'])
  assert.deepEqual(sectionRows(dialog, 'tools'), TOOL_SETTING_KEYS)
  assert.deepEqual(sectionRows(dialog, 'agents'), ['showSubagentProgress', 'groupSubagentMessages'])
  assert.deepEqual(sectionRows(dialog, 'images'), ['imagePreview'])
  assert.equal(sectionRows(dialog, 'images')[0] === 'imagePreview' && dialog.allRows.find(row => row.id === 'imagePreview')?.value, 'Automatic')

  // All sections are painted in one body at once: no page/tab switch required.
  const painted = text(dialog, 100)
  for (const header of ['General', 'Thinking', 'Tools & Diff', 'Agents', 'Images', 'DSH', 'Keyboard']) {
    assert.ok(painted.includes(header), `${header} is a painted group header`)
  }
  assert.match(painted, /Reduced motion/, 'first section rows are painted')
  assert.match(painted, /Keyboard shortcuts/, 'last section rows are painted in the same viewport')

  const ids = dialog.allRows.map(row => row.id)
  assert.equal(new Set(ids).size, ids.length)
  const existingIds = [...TOOL_SETTING_KEYS, 'screen', 'thinking', 'preview', 'timer', 'keys']
  for (const id of existingIds) assert.ok(ids.includes(id), `${id} remains addressable`)
  for (const key of ['showThinking', 'thinkingPreviewLines', 'thinkingLiveTimerMs', 'screen']) {
    assert.equal(dialog.allRows.filter(row => row.key === key).length, 1, `${key} is the key of exactly one row`)
  }
  for (const key of ['showSubagentProgress', 'groupSubagentMessages', 'imagePreview', 'copyOnSelect', 'queueCollapsed', 'reducedMotion']) {
    assert.ok(ids.includes(key), `${key} is present exactly once`)
  }
  assert.equal(dialog.allRows.length, 18 + 6 + 1 + 1, '15 existing + 3 terminal rows + 6 display keys + shortcut row + DSH empty row')
})

test('there is no segmented/tab header: group headers are inert page chrome', () => {
  const { dialog, renders } = harness({ rows: 40 })
  const painted = text(dialog, 100)
  assert.doesNotMatch(painted, /‹|›/, 'no previous/next tab chrome')
  assert.doesNotMatch(painted, /\b1\/7\b/, 'no page counter')
  const rows = lines(dialog, 100)
  const searchRow = rows.findIndex(line => stripTerminalSequences(line).includes('Search settings'))
  assert.ok(searchRow >= 0)
  assert.doesNotMatch(stripTerminalSequences(rows[searchRow + 1] ?? ''), /General|Thinking/, 'the old category chip row is gone')
  // The group header is a separate, non-selectable body line above its rows.
  const paintedLines = rows.map(line => stripTerminalSequences(line))
  const thinkingHeader = paintedLines.findIndex(line => /Thinking ─/.test(line))
  assert.ok(thinkingHeader >= 0, 'group headers separate sections')
  const before = dialog.activeRowId
  const rendersBefore = renders()
  const rowOfHeader = harness({ rows: 40 })
  const headerLine = rowOfHeader.dialog.render(100).findIndex(line => /Thinking ─/.test(stripTerminalSequences(line)))
  assert.ok(headerLine >= 0)
  // Clicking a group header must not select a row, write, or repaint.
  const headerDialog = rowOfHeader.dialog
  const headerRenders = rowOfHeader.renders()
  const headerCol = 4
  for (const type of ['press', 'click'] as const) {
    const result = headerDialog.handleMouse({
      type, button: 'left', x: headerCol, y: headerLine, screenX: headerCol, screenY: headerLine,
      width: 100, height: headerLine + 1, shift: false, alt: false, ctrl: false,
      ...(type === 'click' ? { clickCount: 1 } : {}),
    })
    assert.equal(result?.handled, true, 'the group header claims its own gesture')
    assert.equal(result?.render, false, 'an inert header gesture never repaints')
  }
  assert.equal(headerDialog.activeRowId, 'screen')
  assert.equal(headerDialog.activeCategory, 'general')
  assert.equal(rowOfHeader.renders(), headerRenders)
  assert.equal(dialog.activeRowId, before)
  assert.ok(renders() >= rendersBefore)
})

test('section jumps keep the same roster and preserve search with Tab, Shift+Tab and arrows', () => {
  const { dialog, patches, events } = harness({ initialState: { category: 'tools', rowId: 'groupTools', query: 'group' } })
  const ids = dialog.getVisibleRows().map(row => row.id)
  assert.deepEqual(ids, ['groupTools', 'groupSubagentMessages', 'keys'], 'search includes the grouped shortcut editor description')
  for (const [key, section] of [['\t', 'agents'], ['\x1b[Z', 'tools'], [RIGHT, 'agents'], [LEFT, 'tools']] as const) {
    dialog.handleInput(key)
    assert.equal(dialog.activeCategory, section)
    assert.equal(dialog.query, 'group', 'section navigation must not clear the filter')
    assert.deepEqual(dialog.getVisibleRows().map(row => row.id), ids)
  }
  assert.deepEqual(patches, [])
  assert.deepEqual(events, [])
})

test('one painted frame reads native metadata once and section jumps use the painted snapshot', () => {
  let reads = 0
  const { dialog } = harness({ rows: 80, nativeEntries: () => [{ id: 'state', label: 'Native state', value: String(++reads) }] })
  reads = 0
  dialog.render(100)
  assert.equal(reads, 1, 'measure and paint share one roster projection')
  dialog.handleInput('\t')
  assert.equal(reads, 1, 'navigation has no eager native getter read')
  dialog.render(100)
  assert.equal(reads, 2, 'the next frame refreshes native metadata once')
  assert.equal(dialog.allRows.find(row => row.id === 'native:state')?.value, '2')
  assert.equal(reads, 2)
})

test('every section row keeps one flat patch per write and no duplicated row', () => {
  const { dialog, patches } = harness({ settings: { expandedInputMaxLines: 5 } })
  jumpToSection(dialog, 'tools')
  selectRow(dialog, 'groupTools')
  dialog.handleInput(ENTER)
  assert.deepEqual(patches.at(-1), { groupTools: false })
  assert.equal(dialog.settings.groupTools, false)
  assert.match(text(dialog), /Group tool calls\s+│ off/)
})

// ---------------------------------------------------------------------------
// Typed editing

test('booleans toggle directly, enums open an explicit picker, integers offer custom values', () => {
  const { dialog, patches } = harness()
  // boolean
  selectRow(dialog, 'copyOnSelect')
  dialog.handleInput(ENTER)
  assert.deepEqual(patches.at(-1), { copyOnSelect: false })
  dialog.handleInput(ENTER)
  assert.deepEqual(patches.at(-1), { copyOnSelect: true })
  assert.equal(dialog.settings.copyOnSelect, true)

  // enum: Enter opens a picker instead of cycling blindly
  selectRow(dialog, 'screen')
  dialog.handleInput(ENTER)
  assert.match(text(dialog), /Settings › Default screen/)
  assert.match(text(dialog), /fullscreen\s+· current/)
  dialog.handleInput(DOWN)
  dialog.handleInput(ENTER)
  assert.deepEqual(patches.at(-1), { screen: 'inline' })
  assert.match(text(dialog), /Saved/)

  // integer: the picker lists the roster and a Custom… field; a legal number
  // outside the roster is still accepted.
  jumpToSection(dialog, 'tools')
  selectRow(dialog, 'expandedInputMaxLines')
  dialog.handleInput(ENTER)
  assert.match(text(dialog), /Custom…/)
  for (let step = 0; step < EXPANDED_INPUT_MAX_LINES_VALUES.length; step += 1) dialog.handleInput(DOWN)
  dialog.handleInput(ENTER)
  assert.match(text(dialog), /whole number · 1 to 5000/)
  dialog.handleInput('\x15')
  for (const char of '37') dialog.handleInput(char)
  dialog.handleInput(ENTER)
  assert.deepEqual(patches.at(-1), { expandedInputMaxLines: 37 })
  assert.equal(dialog.settings.expandedInputMaxLines, 37)
  assert.match(text(dialog), /Expanded input lines\s+│ 37/)
})

test('an invalid typed integer is rejected in place without writing', () => {
  const { dialog, patches } = harness()
  jumpToSection(dialog, 'tools')
  selectRow(dialog, 'toolLabelClip')
  dialog.handleInput(ENTER)
  for (let step = 0; step < TOOL_LABEL_CLIP_VALUES.length; step += 1) dialog.handleInput(DOWN)
  dialog.handleInput(ENTER)
  dialog.handleInput('\x15')
  for (const char of '3') dialog.handleInput(char)
  dialog.handleInput(ENTER)
  assert.equal(patches.length, 0)
  assert.match(text(dialog), /must be a whole number \(8 to 500, or 0 for auto\)/)

  dialog.handleInput('\x15')
  for (const char of '0') dialog.handleInput(char)
  dialog.handleInput(ENTER)
  assert.deepEqual(patches.at(-1), { toolLabelClip: 0 }, '0 stays the documented auto value')
  assert.match(text(dialog), /Tool label clip\s+│ auto/)
})

test('every enum roster value is reachable from the picker', () => {
  const { dialog, patches } = harness()
  const cases: Array<{ key: keyof Settings; roster: readonly (string | number | boolean)[]; section: string; id?: string }> = [
    { key: 'diffViewMode', roster: DIFF_VIEW_MODE_VALUES, section: 'tools' },
    { key: 'diffIndicatorMode', roster: DIFF_INDICATOR_MODE_VALUES, section: 'tools' },
    { key: 'thinkingPreviewLines', roster: THINKING_PREVIEW_LINES_VALUES, section: 'thinking', id: 'preview' },
    { key: 'thinkingLiveTimerMs', roster: THINKING_LIVE_TIMER_MS_VALUES, section: 'thinking', id: 'timer' },
  ]
  for (const item of cases) {
    jumpToSection(dialog, item.section)
    selectRow(dialog, item.id ?? item.key)
    const seen: unknown[] = []
    for (let step = 0; step < item.roster.length; step += 1) {
      const current = dialog.settings[item.key] as string | number | boolean
      const index = item.roster.indexOf(current)
      assert.ok(index >= 0, `${String(item.key)} current value is in its roster`)
      dialog.handleInput(ENTER)
      dialog.handleInput(DOWN)
      dialog.handleInput(ENTER)
      seen.push(patches.at(-1)?.[item.key])
      assert.equal(patches.at(-1)?.[item.key], item.roster[(index + 1) % item.roster.length], String(item.key))
    }
    assert.equal(new Set(seen).size, item.roster.length, `${String(item.key)} reaches every documented value`)
  }
})

test('the Tools rosters preserve their exact documented order through the picker', () => {
  const { dialog, patches } = harness()
  jumpToSection(dialog, 'tools')
  const cases: Array<{ id: string; key: keyof Settings; roster: readonly number[] }> = [
    { id: 'expandedInputMaxLines', key: 'expandedInputMaxLines', roster: EXPANDED_INPUT_MAX_LINES_VALUES },
    { id: 'expandedOutputMaxLines', key: 'expandedOutputMaxLines', roster: EXPANDED_OUTPUT_MAX_LINES_VALUES },
    { id: 'toolLabelClip', key: 'toolLabelClip', roster: TOOL_LABEL_CLIP_VALUES },
    { id: 'diffSplitMinWidth', key: 'diffSplitMinWidth', roster: DIFF_SPLIT_MIN_WIDTH_VALUES },
    { id: 'editDiffCollapsedLines', key: 'editDiffCollapsedLines', roster: EDIT_DIFF_COLLAPSED_LINES_VALUES },
    { id: 'writeDiffCollapsedLines', key: 'writeDiffCollapsedLines', roster: WRITE_DIFF_COLLAPSED_LINES_VALUES },
  ]
  for (const item of cases) {
    selectRow(dialog, item.id)
    const start = item.roster.indexOf(dialog.settings[item.key] as number)
    assert.ok(start >= 0, `${item.id} starts inside its roster`)
    for (let step = 0; step < item.roster.length; step += 1) {
      const next = (start + step + 1) % item.roster.length
      dialog.handleInput(ENTER)
      dialog.handleInput(DOWN)
      // Integer pickers append a Custom… row; wrapping past the last roster
      // value passes through it, so one extra Down reaches the first value.
      if (next === 0) dialog.handleInput(DOWN)
      dialog.handleInput(ENTER)
      assert.equal(patches.at(-1)?.[item.key], item.roster[next], item.id)
    }
    assert.equal(dialog.settings[item.key], item.roster[start], `${item.id} wraps back to its start`)
  }
})

// ---------------------------------------------------------------------------
// Persistence / reset state

test('a pending write blocks double submission and adopts the confirmed snapshot', async () => {
  const gate = deferred<void | Settings>()
  const { dialog, patches } = harness({ onChange: () => gate.promise })
  selectRow(dialog, 'copyOnSelect')
  dialog.handleInput(ENTER)
  assert.equal(dialog.isSaving, true)
  assert.match(text(dialog), /Saving…/)
  dialog.handleInput(ENTER)
  assert.equal(patches.length, 1, 'the same row is not submitted twice')
  const confirmed: Settings = { ...defaults, copyOnSelect: false, reducedMotion: true }
  gate.resolve(confirmed)
  await tick()
  assert.equal(dialog.isSaving, false)
  assert.match(text(dialog), /Saved/)
  assert.deepEqual(dialog.settings, confirmed, 'the parent snapshot becomes the new truth')
})

test('a rejected write reverts only that value and reports the failure', async () => {
  const { dialog, patches } = harness({
    settings: { copyOnSelect: true, queueCollapsed: false },
    onChange: patch => (patch.copyOnSelect === undefined ? Promise.resolve() : Promise.reject(new Error('Refusing to overwrite invalid settings file'))),
  })
  selectRow(dialog, 'copyOnSelect')
  dialog.handleInput(ENTER)
  assert.equal(dialog.settings.copyOnSelect, false, 'optimistic value is applied for the frame')
  await tick()
  assert.equal(dialog.settings.copyOnSelect, true, 'a failed write restores the previous value')
  assert.match(text(dialog), /Refusing to overwrite invalid settings file/)

  // A different row still writes successfully.
  selectRow(dialog, 'queueCollapsed')
  dialog.handleInput(ENTER)
  await tick()
  assert.deepEqual(patches.at(-1), { queueCollapsed: true })
  assert.equal(dialog.settings.queueCollapsed, true)
  assert.equal(dialog.settings.copyOnSelect, true)
})

test('a late failure does not overwrite a newer confirmed snapshot', async () => {
  const first = deferred<void | Settings>()
  const second = deferred<void | Settings>()
  let call = 0
  const { dialog } = harness({
    onChange: () => (call++ === 0 ? first.promise : second.promise),
  })
  dialog.handleInput(RIGHT)
  selectRow(dialog, 'thinking')
  dialog.handleInput(ENTER)
  jumpToSection(dialog, 'agents')
  selectRow(dialog, 'showSubagentProgress')
  dialog.handleInput(ENTER)
  second.resolve({ ...defaults, showThinking: true, showSubagentProgress: false })
  await tick()
  first.reject(new Error('stale write failed'))
  await tick()
  assert.equal(dialog.settings.showThinking, true, 'the confirmed snapshot stays authoritative')
  assert.equal(dialog.settings.showSubagentProgress, false)
  assert.doesNotMatch(text(dialog), /stale write failed/)
})

test('reset removes one local override through the parent callback', async () => {
  const { dialog, patches, resets } = harness({ settings: { diffWordWrap: false }, onReset: () => Promise.resolve() })
  jumpToSection(dialog, 'tools')
  selectRow(dialog, 'diffWordWrap')
  dialog.handleInput(CTRL_R)
  assert.deepEqual(resets, ['diffWordWrap'])
  assert.equal(patches.length, 0, 'reset is not turned into a normal set when onReset exists')
  await tick()
  assert.equal(dialog.settings.diffWordWrap, true)
  assert.match(text(dialog), /Default restored/)

  const fallback = harness({ settings: { diffWordWrap: false } })
  jumpToSection(fallback.dialog, 'tools')
  selectRow(fallback.dialog, 'diffWordWrap')
  fallback.dialog.handleInput(CTRL_R)
  assert.deepEqual(fallback.patches.at(-1), { diffWordWrap: defaults.diffWordWrap })
})

test('reset on an action/information row writes nothing', () => {
  const { dialog, patches, resets } = harness()
  jumpToSection(dialog, 'keyboard')
  selectRow(dialog, 'keys')
  dialog.handleInput(CTRL_R)
  assert.equal(patches.length, 0)
  assert.equal(resets.length, 0)
  assert.match(text(dialog), /no local default/)
})

// ---------------------------------------------------------------------------
// Native rows / auto title / keyboard

test('native DSH rows are parent-supplied navigation or information only', () => {
  const events: string[] = []
  const { dialog } = harness({
    nativeEntries: () => [
      { id: 'model', label: 'Current model', value: 'deepseek-chat', description: 'Native session route', onActivate: () => events.push('model') },
      { id: 'permission', label: 'Current permission', value: 'default', description: 'Native preset', available: false },
      { id: 'skills', label: 'Skills', value: '2 available' },
    ],
  })
  jumpToSection(dialog, 'dsh')
  assert.deepEqual(sectionRows(dialog, 'dsh'), ['native:model', 'native:permission', 'native:skills'])
  assert.ok(dialog.getVisibleRows().some(row => row.category === 'general'), 'jumping to DSH does not hide other sections')
  assert.match(text(dialog), /Current model/)
  assert.match(text(dialog), /default · unavailable/)
  assert.match(text(dialog), /Skills/)
  selectRow(dialog, 'native:model')
  dialog.handleInput(ENTER)
  assert.deepEqual(events, ['model'])
  selectRow(dialog, 'native:permission')
  dialog.handleInput(ENTER)
  assert.deepEqual(events, ['model'], 'an unavailable capability is not activated')
  assert.match(text(dialog), /not available in the current DSH runtime/)
  selectRow(dialog, 'native:skills')
  dialog.handleInput(ENTER)
  assert.deepEqual(events, ['model'], 'information rows do not invent an action')
})

test('auto title is a read-only native row with no local write or picker', () => {
  const { dialog, patches, events } = harness({
    nativeEntries: () => [{ id: 'autoTitle', label: 'Auto title', value: 'On · read-only', description: 'DSH profile composition owns it; native titles may use the model' }],
  })
  jumpToSection(dialog, 'dsh')
  selectRow(dialog, 'native:autoTitle')
  assert.match(text(dialog), /On · read-only/)
  assert.match(text(dialog), /may use the model/)
  dialog.handleInput(ENTER)
  assert.doesNotMatch(text(dialog), /Settings › Auto title/)
  assert.equal(dialog.activeCategory, 'dsh')
  assert.deepEqual(patches, [])
  assert.deepEqual(events, [])
})

test('native keyword overrides replace the generic prefix without hiding label/description matches', () => {
  /** Search-field helper: focus it, type the terms, keep the query. */
  const search = (dialog: Dialog, terms: string): void => {
    dialog.handleInput(CTRL_F)
    for (const char of terms) dialog.handleInput(char)
  }
  const entries = () => [
    { id: 'defaultModel', label: 'Default model', value: 'deepseek/deepseek-chat', description: 'Saved for new sessions.', keywords: 'saved provider startup choice' },
    { id: 'autoTitle', label: 'Auto title', value: 'On', description: 'Read-only; profile composition owns it.', keywords: 'title window profile' },
    // No override: the historical synthetic keywords stay in place.
    { id: 'legacy', label: 'Legacy row', value: 'x' },
  ]

  const nativeIds = (dialog: Dialog): string[] =>
    dialog.rows().map(row => row.id).filter(id => id.startsWith('native:'))

  const model = harness({ nativeEntries: entries })
  search(model.dialog, 'model')
  assert.deepEqual(nativeIds(model.dialog), ['native:defaultModel'], 'the label still matches')
  assert.equal(model.dialog.allRows.find(row => row.id === 'native:defaultModel')?.keywords, 'saved provider startup choice')

  const alias = harness({ nativeEntries: entries })
  search(alias.dialog, 'provider')
  assert.deepEqual(nativeIds(alias.dialog), ['native:defaultModel'], 'a keyword alias discovers the row')

  const generic = harness({ nativeEntries: entries })
  search(generic.dialog, 'native')
  assert.deepEqual(nativeIds(generic.dialog), ['native:legacy'],
    'an override drops the synthetic prefix while an unlabelled row keeps it')

  const category = harness({ nativeEntries: entries })
  search(category.dialog, 'dsh')
  assert.deepEqual(nativeIds(category.dialog), ['native:defaultModel', 'native:autoTitle', 'native:legacy'],
    'the DSH category label still makes every native row findable')

  const title = harness({ nativeEntries: entries })
  search(title.dialog, 'title')
  assert.deepEqual(nativeIds(title.dialog), ['native:autoTitle'])
})

test('default model/effort rows keep the supplied order and metadata search order', () => {
  const entries = () => [
    { id: 'model', label: 'Current model', value: 'deepseek-chat', description: 'This session only.', keywords: 'session route provider model in use' },
    { id: 'effort', label: 'Reasoning effort', value: 'high', description: 'This session only.', keywords: 'session effort reasoning level model in use' },
    { id: 'defaultModel', label: 'Default model', value: 'deepseek/deepseek-chat', description: 'Saved default for new sessions.', keywords: 'default model provider startup new sessions' },
    { id: 'defaultEffort', label: 'Default model effort', value: 'high · default', description: 'Levels come from the saved default model.', keywords: 'default effort reasoning level saved model provider' },
  ]
  const { dialog } = harness({ nativeEntries: entries })
  jumpToSection(dialog, 'dsh')
  assert.deepEqual(sectionRows(dialog, 'dsh'), ['native:model', 'native:effort', 'native:defaultModel', 'native:defaultEffort'],
    'the parent order is the page order')
  assert.match(text(dialog), /Default model effort/)
  assert.match(text(dialog), /high · default/)

  dialog.handleInput(CTRL_F)
  for (const char of 'default') dialog.handleInput(char)
  const found = dialog.rows().map(row => row.id)
  assert.equal(found[0], 'screen', 'the local Default screen row still matches (clicking search unchanged)')
  assert.deepEqual(found.filter(id => id.startsWith('native:')), ['native:defaultModel', 'native:defaultEffort'],
    'native search results keep metadata order')
  assert.match(text(dialog), /DSH/, 'the DSH group header is still painted while searching')
})

test('an unavailable native default row is honest, discoverable and inert', () => {
  const activated: string[] = []
  const { dialog, patches, resets } = harness({
    nativeEntries: () => [{
      id: 'defaultModel',
      label: 'Default model',
      value: 'Unavailable',
      description: 'The native default-model service is not mounted in this profile.',
      keywords: 'default model provider startup',
      available: false,
      onActivate: () => activated.push('model'),
    }],
  })
  dialog.handleInput(CTRL_F)
  for (const char of 'default') dialog.handleInput(char)
  assert.ok(dialog.rows().some(row => row.id === 'native:defaultModel'), 'an unavailable default stays discoverable')
  dialog.handleInput(ESC)
  dialog.handleInput(ESC)
  const reopened = harness({
    nativeEntries: () => [{
      id: 'defaultModel', label: 'Default model', value: 'Unavailable',
      description: 'The native default-model service is not mounted in this profile.',
      keywords: 'default model provider startup', available: false,
      onActivate: () => activated.push('model'),
    }],
    initialState: { category: 'dsh', rowId: 'native:defaultModel' },
  })
  assert.equal(reopened.dialog.activeRowId, 'native:defaultModel')
  const rendered = text(reopened.dialog)
  assert.match(rendered, /Unavailable · unavailable/, 'the value never claims a default')
  assert.match(rendered, /not mounted in this profile/, 'the specific native limitation is visible')
  reopened.dialog.handleInput(ENTER)
  assert.deepEqual(activated, [], 'an unavailable default never activates the parent operation')
  assert.match(text(reopened.dialog), /not available in the current DSH runtime/)
  assert.deepEqual(patches, [])
  assert.deepEqual(resets, [])
  reopened.dialog.handleInput(ESC)
  assert.equal(reopened.dialog.isDone, true, 'the panel stays closeable')
})

test('a default row round trip preserves row, query and scroll across a changed value', () => {
  const entries = (value: string) => () => [
    { id: 'model', label: 'Current model', value: 'deepseek-chat', description: 'This session only.' },
    { id: 'defaultModel', label: 'Default model', value, description: 'Saved default for new sessions.', keywords: 'default model provider' },
    { id: 'defaultEffort', label: 'Default model effort', value: 'high · default', description: 'Levels come from the saved default model.', keywords: 'default effort reasoning level' },
  ]
  const source = harness({ maxHeight: 9, nativeEntries: entries('deepseek/deepseek-chat') })
  jumpToSection(source.dialog, 'dsh')
  selectRow(source.dialog, 'native:defaultModel')
  source.dialog.render(64)
  const view = source.dialog.captureView()
  assert.equal(view.category, 'dsh')
  assert.equal(view.rowId, 'native:defaultModel')

  const restored = harness({ maxHeight: 9, nativeEntries: entries('beta/b-two'), initialState: view })
  restored.dialog.render(64)
  assert.equal(restored.dialog.activeCategory, 'dsh')
  assert.equal(restored.dialog.activeRowId, 'native:defaultModel', 'the id is value-independent')
  assert.match(text(restored.dialog), /beta\/b-two/, 'the restored frame paints the new native value')

  // A search query and the selected row survive the same round trip.
  const searched = harness({ nativeEntries: entries('deepseek/deepseek-chat') })
  searched.dialog.handleInput(CTRL_F)
  for (const char of 'default') searched.dialog.handleInput(char)
  selectRow(searched.dialog, 'native:defaultEffort')
  searched.dialog.render(64)
  const searchView = searched.dialog.captureView()
  assert.equal(searchView.query, 'default')
  assert.equal(searchView.rowId, 'native:defaultEffort')
  const searchRestored = harness({ nativeEntries: entries('deepseek/deepseek-chat'), initialState: searchView })
  assert.equal(searchRestored.dialog.query, 'default')
  assert.equal(searchRestored.dialog.activeRowId, 'native:defaultEffort')
  assert.deepEqual(searchRestored.dialog.rows().map(row => row.id).filter(id => id.startsWith('native:')),
    ['native:defaultModel', 'native:defaultEffort'])
})

test('the keyboard category opens the parent shortcut editor', () => {
  const { dialog, events } = harness()
  dialog.handleInput(LEFT)
  assert.equal(dialog.activeCategory, 'keyboard')
  selectRow(dialog, 'keys')
  dialog.handleInput(ENTER)
  assert.deepEqual(events, ['keybindings'])
})

// ---------------------------------------------------------------------------
// Search / remap / cancellation

test('search covers label/description/keywords across categories and preserves the selection', () => {
  const { dialog } = harness()
  dialog.handleInput(CTRL_F)
  assert.equal(dialog.searchFocusedState, true)
  for (const char of 'group agent') dialog.handleInput(char)
  assert.equal(dialog.query, 'group agent')
  assert.deepEqual(dialog.rows().map(row => row.id), ['groupSubagentMessages'])
  assert.match(text(dialog), /Agents/)

  dialog.handleInput(ESC)
  assert.equal(dialog.searchFocusedState, false, 'Esc leaves the field first')
  assert.equal(dialog.isDone, false)
  assert.equal(dialog.query, 'group agent', 'leaving search keeps the query')
  dialog.handleInput(ESC)
  assert.equal(dialog.isDone, true, 'the second Esc closes the surface')

  const keyword = harness()
  keyword.dialog.handleInput(CTRL_F)
  for (const char of 'clipboard') keyword.dialog.handleInput(char)
  assert.ok(keyword.dialog.rows().some(row => row.id === 'copyOnSelect'), 'keywords discover the row')
  keyword.dialog.handleInput(ENTER)
  assert.deepEqual(keyword.patches.at(-1), { copyOnSelect: false })
})

test('no-match search is distinct from an empty category', () => {
  const { dialog } = harness()
  dialog.handleInput(CTRL_F)
  for (const char of 'zzzz') dialog.handleInput(char)
  assert.deepEqual(dialog.rows(), [])
  assert.match(text(dialog), /No settings match “zzzz”/)
  assert.equal(dialog.isDone, false)
})

test('remapped and disabled modal actions are respected; default Ctrl+C is local, explicit interrupt is native', () => {
  const keymap = input.createCcKeymap({
    bindings: {
      'list.next': 'alt+j',
      'list.previous': 'alt+k',
      'settings.next-category': 'alt+]',
      'settings.previous-category': 'alt+[',
      'settings.reset': null,
      'modal.search': null,
    },
  })
  const { dialog, patches, resets, events } = harness({ keymap, withInterrupt: true })
  dialog.handleInput(DOWN)
  assert.equal(dialog.activeRowId, 'screen', 'the default Ctrl+N binding is gone')
  dialog.handleInput('\x1bj')
  assert.equal(dialog.activeRowId, 'copyOnSelect')
  dialog.handleInput(RIGHT)
  assert.equal(dialog.activeCategory, 'general', 'the default right binding is gone')
  dialog.handleInput('\x1b]')
  assert.equal(dialog.activeCategory, 'thinking')

  dialog.handleInput(CTRL_F)
  assert.equal(dialog.searchFocusedState, false, 'a disabled search action does not focus the field')
  dialog.handleInput(CTRL_R)
  assert.equal(resets.length, 0, 'a disabled reset action is inert')
  dialog.handleInput(CTRL_C)
  assert.deepEqual(events, ['cancel'], 'default Ctrl+C is the local cancel, not a native interrupt')
  assert.equal(dialog.isDone, true)
  assert.equal(patches.length, 0)

  // Only an explicit user override makes Ctrl+C a native interrupt again; the
  // surface stays open while the parent cancels the turn.
  const explicit = harness({
    keymap: input.createCcKeymap({ bindings: { 'app.interrupt': 'ctrl+c' } }),
    withInterrupt: true,
  })
  explicit.dialog.handleInput(CTRL_C)
  assert.deepEqual(explicit.events, ['interrupt'])
  assert.equal(explicit.dialog.isDone, false)
})

test('digit selection uses the continuous roster index and stays inert when disabled', () => {
  const defaultsKeymap = harness()
  jumpToSection(defaultsKeymap.dialog, 'tools')
  defaultsKeymap.dialog.handleInput('2')
  assert.equal(defaultsKeymap.dialog.activeRowId, 'copyOnSelect', '2 selects the second row of the page, not the second row of a tab')
  assert.deepEqual(defaultsKeymap.patches.at(-1), { copyOnSelect: false })

  const disabled = harness({ keymap: input.createCcKeymap({ bindings: { 'list.select-digit': null } }) })
  jumpToSection(disabled.dialog, 'tools')
  disabled.dialog.handleInput('2')
  assert.equal(disabled.dialog.activeRowId, 'groupTools')
  assert.equal(disabled.patches.length, 0)
})

// ---------------------------------------------------------------------------
// View state

test('captureView/initialState restore category, row, query and scroll', () => {
  const source = harness({ maxHeight: 11 })
  jumpToSection(source.dialog, 'tools')
  for (let step = 0; step < TOOL_SETTING_KEYS.length - 1; step += 1) source.dialog.handleInput(DOWN)
  source.dialog.render(64)
  const view = source.dialog.captureView()
  assert.equal(view.category, 'tools')
  assert.equal(view.rowId, TOOL_SETTING_KEYS.at(-1))
  assert.equal(view.query, '')
  assert.ok(view.scroll !== undefined && view.scroll > 0, 'a long roster keeps its scroll offset')

  const restored = harness({ maxHeight: 11, initialState: view })
  restored.dialog.render(64)
  assert.equal(restored.dialog.activeCategory, 'tools')
  assert.equal(restored.dialog.activeRowId, view.rowId)
  assert.equal(restored.dialog.captureView().scroll, view.scroll)

  const searched = harness()
  searched.dialog.handleInput(CTRL_F)
  for (const char of 'diff') searched.dialog.handleInput(char)
  searched.dialog.render(64)
  const searchView = searched.dialog.captureView()
  assert.equal(searchView.query, 'diff')
  const searchRestored = harness({ initialState: searchView })
  assert.equal(searchRestored.dialog.query, 'diff')
  assert.deepEqual(searchRestored.dialog.rows().map(row => row.id), searched.dialog.rows().map(row => row.id))
})

test('the parent snapshot refresh updates values and cycles from the new truth', () => {
  const { dialog, renders } = harness()
  jumpToSection(dialog, 'tools')
  const before = renders()
  dialog.setSettings({ ...defaults, expandedInputMaxLines: 40, diffViewMode: 'unified' })
  assert.ok(renders() > before)
  assert.equal(dialog.rows().find(row => row.id === 'expandedInputMaxLines')?.value, '40')
  assert.equal(dialog.rows().find(row => row.id === 'diffViewMode')?.value, 'unified')
})

test('a SettingsDialog works without an explicit keymap and supports dispose', () => {
  const tui = createFakeTui(24, 80)
  const dialog = new SettingsDialog(asTui(tui), {
    settings: { ...defaults },
    onChange: () => {},
    onKeybindings: () => {},
    onCancel: () => {},
  })
  assert.ok(dialog.keymap !== undefined)
  dialog.handleInput(RIGHT)
  assert.equal(dialog.activeCategory, 'thinking')
  dialog.dispose()
  assert.equal(dialog.isDisposed, true)
  dialog.handleInput(RIGHT)
  assert.equal(dialog.activeCategory, 'thinking', 'a disposed dialog consumes input')
})