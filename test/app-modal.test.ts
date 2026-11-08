import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TuiAltScreen, TuiMainScreen } from '#pi-tui'
import { App } from '../src/app.ts'
import type { JsonRecord } from '../src/backend/types.ts'
import { defaults, SETTINGS_FORMAT_VERSION, SettingsStore } from '../src/config.ts'
import { DemoBackend } from '../src/demo.ts'
import { imageFixture } from './helpers/images.ts'
import { SETTINGS_CATEGORIES, SettingsDialog } from '../src/ui/settings.ts'
import { delay, modalScreen, until, VirtualTerminal } from './helpers/terminal.ts'

class ModalBackend extends DemoBackend {
  readonly calls: Array<{ name: string; args: JsonRecord }> = []
  readonly failures = new Map<string, Error>()
  modelsGate?: Promise<void>
  override async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (this.failures.has(name)) throw this.failures.get(name)
    if (name === 'models') await this.modelsGate
    return await super.command(name, args)
  }
}

async function fixture(screen: 'inline' | 'fullscreen', preferences?: JsonRecord) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-modal-parent-'))
  if (preferences !== undefined) await writeFile(join(directory, 'settings.json'), JSON.stringify(preferences))
  const backend = new ModalBackend({ cwd: directory, delayMs: 0 })
  const terminal = new VirtualTerminal(120, 40)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, demo: true, registerSignals: false })
  await app.start(); await paint(terminal)
  return { directory, backend, terminal, app, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}
async function paint(terminal: VirtualTerminal) { await delay(35); await terminal.flush() }
const header = (terminal: VirtualTerminal, title: string) => terminal.screen().includes('┌─ ' + title)
async function category(terminal: VirtualTerminal, steps: number) {
  for (let index = 0; index < steps; index++) terminal.type('\x1b[C')
  await paint(terminal)
}
function focusedSettings(app: App): SettingsDialog {
  const tui = app.tui
  assert.ok(tui instanceof TuiAltScreen || tui instanceof TuiMainScreen)
  const dialog = tui.getFocusedComponent()
  assert.ok(dialog instanceof SettingsDialog)
  return dialog
}
async function clickClose(terminal: VirtualTerminal, title: string) {
  const rows = terminal.screen().split('\n')
  const y = rows.findIndex(row => row.includes('┌─ ' + title))
  assert.ok(y >= 0)
  const x = rows[y]!.indexOf('[×]')
  assert.ok(x >= 0)
  terminal.type(`\x1b[<0;${x + 1};${y + 1}M`)
  terminal.type(`\x1b[<0;${x + 1};${y + 1}m`)
  await paint(terminal)
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`Settings is one continuous grouped page with working Tab/Shift+Tab section jumps (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.resize(120, 80); await paint(f.terminal)
      f.terminal.type('single-page draft 中文')
      const before = f.app.editor.captureDraft()
      await f.app.submit('/settings'); await paint(f.terminal)
      const dialog = focusedSettings(f.app)
      const roster = dialog.allRows.map(row => row.id)
      assert.deepEqual(dialog.rows().map(row => row.id), roster, 'the unfiltered list contains every section, not one tab page')
      const painted = modalScreen(f.terminal, 'Settings')
      for (const section of SETTINGS_CATEGORIES) {
        assert.ok(painted.split('\n').some(line => line.includes(section.label) && SETTINGS_CATEGORIES.filter(other => other.id !== section.id).every(other => !line.includes(other.label))), `${section.label} has its own group heading`)
      }
      const requests = f.backend.calls.length
      f.terminal.type('\t'); await paint(f.terminal)
      assert.equal(dialog.activeCategory, 'thinking')
      assert.deepEqual(dialog.rows().map(row => row.id), roster, 'section navigation does not filter the page')
      f.terminal.type('\x1b[Z'); await paint(f.terminal)
      assert.equal(dialog.activeCategory, 'general')
      f.terminal.type('\x1b[C'); await paint(f.terminal)
      assert.equal(dialog.activeCategory, 'thinking', 'Right remains a section jump')
      f.terminal.type('\x1b[D'); await paint(f.terminal)
      assert.equal(dialog.activeCategory, 'general')
      for (let index = 0; index < dialog.rows().filter(row => row.category === 'general').length; index++) f.terminal.type('\x1b[B')
      await paint(f.terminal)
      assert.equal(dialog.activeCategory, 'thinking', 'Down crosses the group boundary in the same list')
      assert.equal(dialog.activeRowId, 'thinking')
      assert.equal(f.backend.calls.length, requests, 'section jumps do not fetch native state or run native commands')
      await assert.rejects(readFile(join(f.directory, 'settings.json'), 'utf8'), /ENOENT/, 'navigation cannot save a preference')
      f.terminal.resize(40, 20); await paint(f.terminal)
      f.terminal.type('\x1b[F'); await paint(f.terminal)
      assert.equal(dialog.activeCategory, 'keyboard')
      assert.match(modalScreen(f.terminal, 'Settings'), /Keyboard shortcuts/, 'the final section is reachable in a short viewport')
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.deepEqual(f.app.editor.captureDraft(), before)
    } finally { await f.close() }
  })

  test(`Settings -> Keyboard -> Back retains section and the one image/undo draft (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('retained modal draft 中文 ')
      f.app.editor.insertImage((await imageFixture()).upload)
      f.terminal.type('\x1b[200~' + 'long draft line\n'.repeat(14) + '\x1b[201~')
      const editor = f.app.editor, before = editor.captureDraft()
      await f.app.submit('/settings'); await category(f.terminal, 6)
      assert.equal(header(f.terminal, 'Settings'), true)
      assert.match(f.terminal.screen(), /Keyboard shortcuts/)
      f.terminal.type('\r'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Keyboard shortcuts/)
      assert.equal(header(f.terminal, 'Settings'), false)
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.equal(header(f.terminal, 'Settings'), true)
      assert.match(f.terminal.screen(), /Keyboard shortcuts/, 'back restores the Keyboard section and its scroll position')
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), before)
      assert.equal(editor.focused, true)
      assert.equal(f.backend.calls.some(call => call.name === 'execute'), false)
    } finally { await f.close() }
  })

  test(`native model entry returns to the original Settings section without sending a prompt (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('model navigation draft')
      const before = f.app.editor.captureDraft()
      await f.app.submit('/settings'); await category(f.terminal, 5)
      assert.match(f.terminal.screen(), /Current model/)
      f.terminal.type('\r'); await paint(f.terminal)
      assert.equal(header(f.terminal, 'Choose model'), true)
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.equal(header(f.terminal, 'Settings'), true)
      assert.match(f.terminal.screen(), /Current model/, 'DSH section returns with its native state')
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.deepEqual(f.app.editor.captureDraft(), before)
      assert.equal(f.backend.info.events?.some(event => event.type === 'turn/start'), false)
    } finally { await f.close() }
  })

  test(`pending model catalog renders immediately; Escape and late data never revive it (${screen})`, async () => {
    const f = await fixture(screen)
    let release!: () => void
    try {
      f.backend.modelsGate = new Promise(resolve => { release = resolve })
      f.terminal.type('pending draft')
      const before = f.app.editor.captureDraft()
      const opening = f.app.submit('/model')
      await until(() => f.backend.calls.some(call => call.name === 'models'), 'native catalog request is pending')
      await paint(f.terminal)
      assert.equal(header(f.terminal, 'Choose model'), true)
      assert.match(f.terminal.screen(), /Loading/)
      f.terminal.type('\x1b'); await paint(f.terminal)
      release(); await opening; await paint(f.terminal)
      assert.equal(header(f.terminal, 'Choose model'), false)
      assert.deepEqual(f.app.editor.captureDraft(), before)
    } finally { release?.(); await f.close() }
  })

  test(`native permission navigation requires an explicit second confirmation (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      const permission = f.app.session?.permissions?.currentValue
      await f.app.submit('/settings'); await category(f.terminal, 5)
      // DSH rows are now part of the one continuous list, not local tab indexes.
      for (let index = 0; index < 3; index++) f.terminal.type('\x1b[B')
      f.terminal.type('\r'); await paint(f.terminal)
      assert.equal(header(f.terminal, 'Native permission preset'), true)
      f.terminal.type('\r'); await paint(f.terminal)
      assert.equal(header(f.terminal, 'Confirm native permission change'), true)
      assert.equal(f.backend.calls.some(call => call.name === 'execute'), false)
      f.terminal.type('\r'); await paint(f.terminal)
      assert.equal(f.app.session?.permissions?.currentValue, permission, 'the default confirmation choice keeps native permissions')
      assert.equal(f.backend.calls.some(call => call.name === 'execute'), false)
      assert.equal(header(f.terminal, 'Settings'), true)
    } finally { await f.close() }
  })
}

test('actual fullscreen close chip dismisses Settings without rewriting the root draft', async () => {
  const f = await fixture('fullscreen')
  try {
    f.terminal.type('mouse modal draft')
    const before = f.app.editor.captureDraft()
    await f.app.submit('/settings'); await paint(f.terminal)
    await clickClose(f.terminal, 'Settings')
    assert.equal(header(f.terminal, 'Settings'), false)
    assert.deepEqual(f.app.editor.captureDraft(), before)
    assert.equal(f.app.editor.focused, true)
  } finally { await f.close() }
})

test('fullscreen Settings pins mouse presses without redundant frames and opens an enum picker once', async () => {
  const f = await fixture('fullscreen')
  try {
    f.terminal.type('mouse frame draft')
    const before = f.app.editor.captureDraft()
    await f.app.submit('/settings'); await paint(f.terminal)
    const dialog = focusedSettings(f.app)
    const lines = f.terminal.screen().split('\n')
    const y = lines.findIndex(line => line.includes('Default screen'))
    assert.ok(y >= 0)
    const x = lines[y]!.indexOf('Default screen') + 1
    const originalRender = dialog.render.bind(dialog)
    let frames = 0
    dialog.render = width => { frames++; return originalRender(width) }
    f.terminal.type(`\x1b[<0;${x + 1};${y + 1}M`); await paint(f.terminal)
    assert.equal(frames, 0, 'press only pins identity; it must not redraw an unchanged modal')
    f.terminal.type(`\x1b[<0;${x + 1};${y + 1}m`); await paint(f.terminal)
    assert.equal(frames, 1, 'release opens the picker with one frame')
    assert.match(modalScreen(f.terminal, 'Settings'), /Settings › Default screen/, 'the enum picker is open')
    await assert.rejects(readFile(join(f.directory, 'settings.json'), 'utf8'), /ENOENT/, 'opening the picker does not save')
    assert.deepEqual(f.app.editor.captureDraft(), before)
  } finally { await f.close() }
})

test('display preferences are applied at startup, with no native policy/default writes', async () => {
  const f = await fixture('fullscreen', { formatVersion: SETTINGS_FORMAT_VERSION, showSubagentProgress: false, reducedMotion: true, copyOnSelect: false, queueCollapsed: true })
  try {
    assert.ok(f.app.tui instanceof TuiAltScreen)
    assert.equal(f.app.tui.getCopyOnSelect(), false)
    await f.app.submit('subagent')
    await until(() => f.app.store.subagentEntries.length === 5 && !f.app.isBusy, 'native fixture catalog')
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /● Agents/, 'hidden progress is presentation only; catalog still exists')
    assert.equal(f.app.store.subagentEntries.length, 5)
    assert.equal(f.backend.calls.some(call => ['preset', 'model', 'effort', 'execute', 'subagent-interrupt'].includes(call.name)), false)
    const settings = new SettingsStore(f.directory).get()
    assert.equal(settings.reducedMotion, true)
    assert.equal(settings.groupSubagentMessages, defaults.groupSubagentMessages)
  } finally { await f.close() }
})

test('queue modal reports a native failure and preserves the composer instead of claiming removal', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.failures.set('queue-remove', new Error('synthetic native removal failure'))
    // Supply only a native state projection; no local scheduling/model loop.
    const command = f.backend.command.bind(f.backend)
    f.backend.command = async (name, args = {}) => name === 'state'
      ? { queued: 1, pending: { nextTurn: 1, nextStep: 0 }, queue: [{ messageId: 'native-queue-1', text: 'native queued text', images: 0, target: 'next-turn' }] }
      : await command(name, args)
    f.terminal.type('queue root draft')
    const before = f.app.editor.captureDraft()
    f.terminal.type('\x18'); f.terminal.type('\x11'); await paint(f.terminal)
    assert.equal(header(f.terminal, 'Queue'), true, 'the operational modal is visible, not only the persistent queue panel')
    f.terminal.type('d')
    await until(() => f.terminal.screen().includes('synthetic native removal failure'), 'native queue failure shown inside modal')
    assert.deepEqual(f.app.editor.captureDraft(), before)
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.deepEqual(f.app.editor.captureDraft(), before)
  } finally { await f.close() }
})

test('Settings display boolean writes stay sparse, reset deletes the one override', async () => {
  const f = await fixture('fullscreen')
  try {
    await f.app.submit('/settings'); await category(f.terminal, 3)
    assert.match(f.terminal.screen(), /Progress above input/)
    f.terminal.type('\r')
    await until(() => new SettingsStore(f.directory).get().showSubagentProgress === false, 'display preference saved')
    f.terminal.type('\x12')
    await until(() => new SettingsStore(f.directory).get().showSubagentProgress === true, 'display preference reset')
    const data = JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8'))
    assert.equal(Object.hasOwn(data, 'showSubagentProgress'), false)
    assert.equal(data.formatVersion, SETTINGS_FORMAT_VERSION)
    assert.equal(f.backend.calls.some(call => call.name === 'subagent-interrupt'), false)
  } finally { await f.close() }
})
