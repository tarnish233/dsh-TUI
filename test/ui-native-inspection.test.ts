// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type {
  PluginInventorySnapshot,
  PluginInventoryRead,
  ToolCatalogRead,
  ToolCatalogSnapshot,
} from '../src/backend/native-inspection.ts'
import { asTui, createFakeTui } from '../src/input/testing/harness.ts'
import { createCcKeymap } from '../src/input/keymap.ts'
import { NativeInspectionDialog } from '../src/ui/native-inspection-dialog.ts'

/**
 * Read-only native inventory summary: presentation-only projection of the
 * backend `PluginInventoryRead` / `ToolCatalogRead` DTOs plus the session's
 * capability names. No DSH runtime, no model, no timer, no stdout, no mutation.
 */

const SESSION = 'session-inventory'

const DOWN = '\x0e'
const UP = '\x10'
const ENTER = '\r'
const ESC = '\x1b'
const HOME = '\x1b[H'
const END = '\x1b[F'
const CTRL_C = '\x03'

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

function plugins(over: Partial<PluginInventorySnapshot> = {}): PluginInventorySnapshot {
  return {
    available: true,
    complete: true,
    entries: [
      { entryId: 'entry-app', moduleName: '@deepseek-ai/dsh-app-boot', enabled: true, fiberPhase: 'active' },
      { entryId: 'entry-bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: false, fiberPhase: null },
      { entryId: 'entry-broken', moduleName: '@deepseek-ai/dsh-tool-broken', enabled: true, fiberPhase: 'failed' },
    ],
    summary: { total: 3, enabled: 2, disabled: 1, active: 1, failed: 1, pending: 0, malformed: 0 },
    diagnostics: [],
    diagnosticsTruncated: false,
    ...over,
  }
}

function tools(over: Partial<ToolCatalogSnapshot> = {}): ToolCatalogSnapshot {
  return {
    available: true,
    complete: true,
    sessionId: SESSION,
    tools: [
      { name: 'bash', description: 'Run a shell command in the workspace.', executable: true, deferredLoading: false, presenter: { call: true, result: true } },
      { name: 'skill', description: 'Load one native skill declaration.', executable: true, deferredLoading: true, presenter: { call: false, result: true } },
    ],
    summary: { total: 2, executable: 2, deferred: 1 },
    ...over,
  }
}

interface Harness {
  dialog: NativeInspectionDialog
  events: string[]
  refreshes: number
  readonly lines: (width?: number) => string[]
  readonly text: (width?: number) => string
}

function harness(options: {
  reads?: { plugins?: PluginInventoryRead; tools?: ToolCatalogRead; capabilities?: readonly string[] }
  loading?: boolean
  initialState?: { selectedKey?: string; scroll: number }
  onInterrupt?: () => void
  rows?: number
} = {}): Harness {
  const tui = createFakeTui(options.rows ?? 30, 100)
  const events: string[] = []
  const dialog = new NativeInspectionDialog(asTui(tui), {
    ...(options.reads === undefined ? {} : { reads: options.reads }),
    ...(options.loading === undefined ? {} : { loading: options.loading }),
    ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
    keymap: createCcKeymap(),
    ...(options.onInterrupt === undefined ? {} : { onInterrupt: options.onInterrupt }),
    onClose: () => { events.push('close') },
  })
  dialog.focused = true
  return {
    dialog,
    events,
    refreshes: 0,
    lines: (width = 100) => dialog.render(width),
    text: (width = 100) => plain(dialog.render(width)).join('\n'),
  }
}

function assertWidths(lines: readonly string[], width: number, label: string): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `${label}: width ${width} got ${visibleWidth(line)} :: ${JSON.stringify(stripTerminalSequences(line))}`,
    )
  }
}

const FULL = {
  plugins: plugins(),
  tools: tools(),
  capabilities: ['images', 'skills'] as const,
}

// ---------------------------------------------------------------------------
// Honest states

test('unread, loading and unavailable sections are never an empty authoritative list', () => {
  const unread = harness()
  assert.match(unread.text(), /Native inventory has not been read in this session/)
  assert.doesNotMatch(unread.text(), /No native plugins, capabilities or tools are mounted/)

  const loading = harness({ loading: true, reads: FULL })
  assert.match(loading.text(), /Reading native inventory/)

  const unavailable = harness({
    reads: {
      plugins: { available: false, reason: 'missing-service' },
      tools: { available: false, reason: 'no-agent' },
      capabilities: undefined,
    },
  })
  const text = unavailable.text()
  assert.match(text, /Native plugin inventory is unavailable \(missing-service\)/)
  assert.match(text, /native tool catalog is unavailable \(no-agent\)/)
  assert.doesNotMatch(text, /No native plugins, capabilities or tools are mounted/)
  // An unavailable read never contributes a zero count to the header.
  assert.doesNotMatch(text, /plugins 0/)
  assert.doesNotMatch(text, /tools 0/)
})

test('every available read with no rows says so once', () => {
  const empty = harness({
    reads: {
      plugins: plugins({ entries: [], summary: { total: 0, enabled: 0, disabled: 0, active: 0, failed: 0, pending: 0, malformed: 0 } }),
      tools: tools({ tools: [], summary: { total: 0, executable: 0, deferred: 0 } }),
      capabilities: [],
    },
  })
  assert.match(empty.text(), /No native plugins, capabilities or tools are mounted/)
  assert.match(empty.text(), /Native inventory · plugins 0 · tools 0 · capabilities 0/)
})

// ---------------------------------------------------------------------------
// Whitelisted rows only

test('plugin rows paint only entry/module/enabled/phase in native order', () => {
  const f = harness({ reads: FULL })
  const text = f.text()
  const first = text.indexOf('dsh-app-boot')
  const second = text.indexOf('dsh-tool-bash')
  const third = text.indexOf('dsh-tool-broken')
  assert.ok(first >= 0 && second > first && third > second, 'native Loader order is preserved')
  assert.match(text, /☑ .*dsh-app-boot · active/)
  assert.match(text, /☐ .*dsh-tool-bash · no fiber/)
  assert.match(text, /☑ .*dsh-tool-broken · failed/)
  assert.match(text, /Plugins · 3 · 1 failed · 1 disabled/)
  // The selected row shows its exact native entry id; Package metadata,
  // conditions, diagnostics, credentials and config are never painted.
  assert.match(text, /entry entry-app/)
})

test('an unavailable plugin section shows its reason, and a failed phase is not an exception', () => {
  const hostile = plugins({
    entries: [
      {
        entryId: 'entry-secret',
        moduleName: '@deepseek-ai/dsh-tool-secret',
        enabled: true,
        fiberPhase: 'failed',
        // Hostile extra fields that must never reach the surface.
        meta: { name: 'SEKRIT', description: 'API_KEY=abc123' },
        diagnostic: 'Error: connect ECONNREFUSED with Authorization: Bearer abc123',
        condition: '!!js process.env.SECRET_TOKEN',
      } as unknown as PluginInventorySnapshot['entries'][number],
    ],
    diagnostics: [{ entryId: 'entry-secret', message: 'credential=abc123' }],
  })
  const f = harness({ reads: { plugins: hostile, tools: tools(), capabilities: [] } })
  const text = f.text(140)
  assert.match(text, /failed/)
  for (const leaked of ['SEKRIT', 'API_KEY', 'abc123', 'ECONNREFUSED', 'SECRET_TOKEN', 'credential=']) {
    assert.equal(text.includes(leaked), false, `${leaked} is not painted`)
  }
})

test('tool rows paint name + deferred, and the description only on the selected row', () => {
  const f = harness({ reads: FULL })
  const overview = f.text()
  assert.match(overview, /· bash/)
  assert.match(overview, /· skill · deferred/)
  assert.doesNotMatch(overview, /Run a shell command in the workspace\./, 'no tool description without selection')
  // Row order: 3 plugins, 2 capabilities, then tools (bash, skill).
  f.dialog.handleInput(END) // last row = the skill tool
  const skillText = f.text()
  assert.match(skillText, /❯ · skill · deferred/)
  assert.match(skillText, /Load one native skill declaration\./)
  assert.doesNotMatch(skillText, /Run a shell command in the workspace\./)
  f.dialog.handleInput(UP) // bash tool
  assert.match(f.text(), /❯ · bash/)
  assert.match(f.text(), /Run a shell command in the workspace\./)
  assert.doesNotMatch(f.text(), /Load one native skill declaration\./)
})

test('sections follow Plugins → Capabilities → Tools and incomplete markers stay per section', () => {
  const f = harness({
    reads: {
      plugins: plugins({ complete: false }),
      tools: tools({ complete: false }),
      capabilities: ['images'],
    },
  })
  const text = f.text()
  const pluginIndex = text.indexOf('Plugins · 3')
  const capabilityIndex = text.indexOf('Capabilities · 1')
  const toolIndex = text.indexOf('Tools · 2')
  assert.ok(pluginIndex >= 0 && capabilityIndex > pluginIndex && toolIndex > capabilityIndex)
  assert.match(text, /Plugins · 3 .*incomplete/)
  assert.match(text, /Tools · 2 · incomplete/)
  assert.doesNotMatch(text, /Capabilities · 1 · incomplete/)
})

// ---------------------------------------------------------------------------
// Input and navigation

test('list navigation crosses sections, Enter and printables are inert, Esc closes', () => {
  const f = harness({ reads: FULL, onInterrupt: () => { f.events.push('interrupt') } })
  // Flattened row order: 3 plugins, 2 capabilities, 2 tools.
  f.dialog.handleInput(DOWN)
  f.dialog.handleInput(DOWN)
  f.dialog.handleInput(DOWN) // first capability
  assert.match(f.text(), /❯ · images/)
  f.dialog.handleInput(DOWN) // second capability
  assert.match(f.text(), /❯ · skills/)
  f.dialog.handleInput(DOWN) // first tool: navigation crosses the section boundary
  assert.match(f.text(), /❯ · bash/)
  f.dialog.handleInput(UP)
  assert.match(f.text(), /❯ · skills/)
  f.dialog.handleInput(END)
  assert.match(f.text(), /❯ · skill · deferred/)
  f.dialog.handleInput(HOME)
  assert.match(f.text(), /❯ ☑ .*dsh-app-boot/)

  f.dialog.handleInput(ENTER)
  f.dialog.handleInput('x')
  assert.deepEqual(f.events, [], 'read-only rows cannot be executed or typed into')
  assert.equal(f.dialog.isDone, false)

  f.dialog.handleInput(CTRL_C)
  assert.deepEqual(f.events, ['interrupt'])
  assert.equal(f.dialog.isDone, false)
  f.dialog.handleInput(ESC)
  assert.deepEqual(f.events, ['interrupt', 'close'])
  assert.deepEqual(f.dialog.render(80), [])
})

test('a refresh keeps the selected native row key and retires a vanished key', () => {
  const f = harness({ reads: { plugins: plugins(), tools: tools(), capabilities: ['images'] } })
  f.dialog.handleInput(DOWN) // entry-bash
  assert.equal(f.dialog.captureView().selectedKey, 'plugin:entry-bash')

  // Reorder with the same identities.
  f.dialog.setReads({
    plugins: plugins({ entries: [plugins().entries[2]!, plugins().entries[0]!, plugins().entries[1]!] }),
    tools: tools(),
    capabilities: ['images'],
  })
  assert.equal(f.dialog.captureView().selectedKey, 'plugin:entry-bash', 'identity survives a reorder')

  // The selected row disappears: the nearest still-listed row is selected
  // (the old row index 2 now holds the skill tool), never a resurrection of
  // the vanished key.
  f.dialog.setReads({ plugins: plugins({ entries: [plugins().entries[0]!] }), tools: tools(), capabilities: [] })
  assert.equal(f.dialog.captureView().selectedKey, 'tool:skill')
  f.dialog.setReads({ plugins: plugins({ entries: [plugins().entries[0]!] }), tools: tools({ tools: [] }), capabilities: [] })
  assert.equal(f.dialog.captureView().selectedKey, 'plugin:entry-app')
})

test('a closed or disposed dialog ignores late reads', () => {
  const f = harness({ reads: FULL })
  f.dialog.handleInput(ESC)
  f.dialog.setReads({ plugins: plugins(), tools: tools(), capabilities: ['late'] })
  f.dialog.setLoading(true)
  assert.deepEqual(f.dialog.render(80), [])
  f.dialog.dispose()
  assert.deepEqual(f.dialog.render(80), [])
})

// ---------------------------------------------------------------------------
// Mouse

test('mouse selects a painted row by its native key', () => {
  const f = harness({ reads: FULL })
  const rendered = f.lines()
  const row = rendered.findIndex(line => stripTerminalSequences(line).includes('dsh-tool-bash'))
  assert.ok(row >= 0)
  f.dialog.handleMouse({
    type: 'click', button: 'left', x: 10, y: row, screenX: 10, screenY: row,
    width: 100, height: rendered.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.equal(f.dialog.captureView().selectedKey, 'plugin:entry-bash')
  assert.match(f.text(), /entry entry-bash/)
})

// ---------------------------------------------------------------------------
// Width safety

test('the inventory is width-safe with CJK, emoji and hostile module names', () => {
  const f = harness({
    reads: {
      plugins: plugins({
        entries: [
          { entryId: 'entry-中文', moduleName: '\x1b[31m@deepseek-ai/dsh-工具 🚀\x1b[0m', enabled: true, fiberPhase: 'active' },
        ],
        summary: { total: 1, enabled: 1, disabled: 0, active: 1, failed: 0, pending: 0, malformed: 0 },
      }),
      tools: tools({ tools: [{ name: '工具-tool-🚀', description: '说明 \x07 description', executable: true, deferredLoading: false, presenter: { call: false, result: false } }] }),
      capabilities: ['技能-capability'],
    },
  })
  for (const width of [8, 12, 16, 24, 33, 40, 57, 80, 120]) {
    const lines = f.lines(width)
    assertWidths(lines, width, `inventory at ${width}`)
    for (const line of lines) {
      assert.ok(!stripTerminalSequences(line).includes('\x1b'), 'native escape sequences are sanitized')
    }
  }
  assert.match(f.text(120), /工具 🚀/)
  assert.match(f.text(120), /技能-capability/)
  assert.match(f.text(120), /entry entry-中文/)
})