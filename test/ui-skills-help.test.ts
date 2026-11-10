import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { SkillCatalogEntry, SkillCatalogSnapshot } from '../src/backend/types.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'
import type { HelpCommand } from '../src/ui/help.ts'

const input = await loadInputModule()
const { HelpPanel } = await import('../src/ui/help.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Panel = InstanceType<typeof HelpPanel>

const fakeTui = (rows = 30, columns = 80) => asTui(createFakeTui(rows, columns))
const keymap = (bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap =>
  input.createCcKeymap({ bindings })

const commands = (): HelpCommand[] => [
  { name: 'help', description: 'Commands and shortcuts' },
  { name: 'model', description: 'Choose a DSH model', inputHint: '[provider/model]' },
]

const customCommands = (): HelpCommand[] => [
  { name: 'deploy', description: 'Deploy with 中文 and emoji 🚀', inputHint: '<env>' },
]

const skill = (name: string, description: string, extra: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry => ({
  name,
  description,
  modelInvocable: true,
  ...extra,
})

const snapshot = (entries: readonly SkillCatalogEntry[], available = true, complete = true): SkillCatalogSnapshot =>
  ({ entries, available, complete })

const skillCatalog = (): SkillCatalogSnapshot => snapshot([
  skill('code-review', 'Review the current diff for regressions.', { whenToUse: 'Use before handing off a change.' }),
  skill('release-notes', 'User-only fixture skill.', { whenToUse: 'Only when you explicitly invoke it.', modelInvocable: false }),
  skill('compact', 'Fixture skill reusing a mounted native command name.'),
])

function makePanel(options: {
  commands?: readonly HelpCommand[]
  customCommands?: readonly HelpCommand[]
  skills?: SkillCatalogSnapshot
  keymap?: CcKeymap
  rows?: number
  onInterrupt?: boolean
} = {}): Panel {
  return new HelpPanel(fakeTui(options.rows ?? 30, 80), {
    commands: options.commands ?? commands(),
    customCommands: options.customCommands ?? customCommands(),
    keymap: options.keymap ?? keymap(),
    onClose: () => {},
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.onInterrupt === false ? {} : { onInterrupt: () => {} }),
  })
}

const plain = (panel: Panel, width: number): string[] =>
  panel.render(width).map(line => stripTerminalSequences(line))

const text = (panel: Panel, width: number): string => plain(panel, width).join('\n')

function assertWidths(panel: Panel, widths: readonly number[] = [4, 10, 20, 40, 80, 120]): void {
  for (const width of widths) {
    for (const line of panel.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`)
    }
  }
}

/** Frame body rows: border columns removed, chrome rules/title/footer dropped. */
const bodyOf = (lines: readonly string[]): string[] =>
  lines
    .filter(line => !/^[┌├└]/.test(line))
    .map(line => line.replace(/^│\s?/, '').replace(/\s*│$/, ''))

// ---------------------------------------------------------------------------
// Omitted snapshot keeps the historical body

test('omitting skills keeps the exact historical two-section body, including its row count', () => {
  const omitted = makePanel()
  const explicit = makePanel({ skills: undefined })
  assert.deepEqual(omitted.render(80), explicit.render(80))
  assert.deepEqual(omitted.render(40), explicit.render(40))

  const lines = plain(omitted, 80)
  assert.ok(!lines.some(line => /Skills/.test(line)), 'no Skills section without a snapshot')
  const body = bodyOf(lines).filter(line => line.trim() !== '')
  assert.match(body[0] ?? '', /Commands/)
  assert.match(body[0] ?? '', /Custom commands/)
  assert.equal(omitted.scrollTop, 0)

  const stacked = bodyOf(plain(omitted, 40))
  assert.ok(!stacked.some(line => /Commands/.test(line) && /Custom commands/.test(line)))
  // Exactly one structural blank row separates the sections (frame padding
  // below the body is not a section separator).
  const commandsAt = stacked.findIndex(line => /^\s*Commands\b/.test(line))
  const customAt = stacked.findIndex(line => /^\s*Custom commands\b/.test(line))
  assert.ok(commandsAt >= 0 && customAt > commandsAt)
  const between = stacked.slice(commandsAt, customAt)
  assert.equal(between.filter(line => /^\s*$/.test(line)).length, 1, 'stacked body keeps exactly one separator')
  assert.equal((stacked[customAt - 1] ?? '').trim(), '', 'and it sits directly above the second heading')
})

// ---------------------------------------------------------------------------
// Populated snapshot

test('a full-width Skills section follows the two command columns', () => {
  for (const width of [80, 120]) {
    const panel = makePanel({ skills: skillCatalog() })
    const lines = plain(panel, width)
    assert.ok(lines.some(line => /Commands/.test(line) && /Custom commands/.test(line)), 'columns stay side by side')
    const skillsAt = bodyOf(lines).findIndex(line => /^\s*Skills\b/.test(line))
    const columnsAt = bodyOf(lines).findIndex(line => /Commands/.test(line) && /Custom commands/.test(line))
    assert.ok(skillsAt > columnsAt, 'Skills follows the command columns')

    const body = bodyOf(lines)
    const skillsRow = body.findIndex(line => /^\s*Skills\b/.test(line))
    assert.ok(skillsRow > 0)
    assert.equal((body[skillsRow - 1] ?? '').trim(), '', 'the Skills section is separated from the columns by one blank row')
    assert.doesNotMatch(body[skillsRow] ?? '', /Commands|Custom commands/, 'Skills is full width')

    const rendered = text(panel, width)
    assert.match(rendered, /\/code-review/)
    assert.match(rendered, /Review the current diff for regressions\./)
    assert.match(rendered, /when: Use before handing off a change\./)
    assert.match(rendered, /\/release-notes \[user-only\]/)
    assert.match(rendered, /\/compact/)
    assert.equal((rendered.match(/\[user-only\]/g) ?? []).length, 1, 'only a modelInvocable:false entry is marked')
    assert.doesNotMatch(rendered, /skill:/, 'native /name metadata, never a Pi skill: alias')
    const skillsText = rendered.slice(rendered.indexOf('Skills '))
    assert.doesNotMatch(skillsText, /❯|Enter|select|choose/i, 'the section has no selection or execution affordance')
    assertWidths(panel)
  }
})

test('the Skills section stacks after the stacked command sections on narrow terminals', () => {
  const panel = makePanel({ skills: skillCatalog() })
  const lines = plain(panel, 40)
  const stackedBody = bodyOf(lines)
  const customAt = stackedBody.findIndex(line => /^\s*Custom commands\b/.test(line))
  const skillsAt = stackedBody.findIndex(line => /^\s*Skills\b/.test(line))
  assert.ok(customAt >= 0 && skillsAt > customAt)
  assertWidths(panel, [20, 40])
})

test('skill metadata is sanitized and stays width-safe with CJK, emoji and long text', () => {
  const entries = [
    skill(
      `very-long-skill-name-${'x'.repeat(40)}`,
      `中文描述 👨‍👩‍👧‍👦 \x1b[31mred\x1b[0m \x1b]0;pwned\x07 ${'word '.repeat(80)}`,
      { whenToUse: `什么时候用 🚀 ${'more '.repeat(60)}` },
    ),
    skill('部署/中文', 'CJK skill name and description 空 格'),
    skill('', ''),
  ]
  const panel = makePanel({ skills: snapshot(entries) })
  assertWidths(panel)

  const joined = [20, 40, 80, 120].map(width => panel.render(width).join('\n')).join('\n')
  assert.ok(!joined.includes('pwned'), 'OSC payload must be stripped')
  assert.ok(!joined.includes('\x07'), 'control bytes must be stripped')
  const rendered = text(panel, 120)
  assert.match(rendered, /\/?部署\/中文/)
  assert.match(rendered, /\/\?/, 'an unnamed entry stays display-only instead of disappearing')
  assert.match(rendered, /🚀/)
})

test('a verbose descriptor is bounded per entry instead of flooding the body window', () => {
  const panel = makePanel({
    skills: snapshot([
      skill('long-entry', 'description '.repeat(120), { whenToUse: 'when '.repeat(120) }),
      skill('short-entry', 'Short and bounded.'),
    ]),
    rows: 30,
  })
  const body = bodyOf(plain(panel, 80))
  const headAt = body.findIndex(line => /^\s*\/long-entry/.test(line))
  assert.ok(headAt >= 0)
  const nextHead = body.findIndex((line, index) => index > headAt && /^\s*\/short-entry/.test(line))
  assert.ok(nextHead > headAt, 'the next skill keeps its own row')
  const following = body.slice(headAt + 1, nextHead)
  const descriptionLines = following.filter(line => /^ {4}\S/.test(line) && !/^ {4}when:/.test(line))
  assert.equal(descriptionLines.length, 3, 'the description is capped at three display rows')
  assert.match(descriptionLines.at(-1) ?? '', /…$/)
  const whenLines = following.filter(line => /^ {4}when:|^ {10}\S/.test(line))
  assert.ok(whenLines.length >= 1 && whenLines.length <= 2, 'whenToUse is capped at two display rows')
  assert.match(whenLines.at(-1) ?? '', /…$/)
  assert.ok(body.some(line => /\/short-entry/.test(line)), 'the next skill is still reachable')
  assertWidths(panel, [20, 80])
})

// ---------------------------------------------------------------------------
// Honest availability / completeness / empty states

test('an unavailable catalog says so and never claims there are no skills', () => {
  for (const complete of [false, true]) {
    const panel = makePanel({ skills: snapshot([], false, complete) })
    const rendered = text(panel, 80)
    const flat = bodyOf(plain(panel, 80)).join(' ').replace(/\s+/g, ' ')
    assert.match(bodyOf(plain(panel, 80)).join('\n'), /Skills \?/)
    assert.match(flat, /No skill catalog is available from this DSH composition yet/)
    assert.match(flat, /native registry and preset scope/)
    assert.match(flat, /never starts an Agent or loads skill instructions/)
    assert.match(flat, /not proof that no skills are installed/)
    assert.doesNotMatch(flat, /has no attached Agent|after its Agent starts/,
      'a native metadata scope lease can be read without an Agent or visible model tool')
    assert.doesNotMatch(rendered, /No user-invocable skills/)
    assert.doesNotMatch(rendered, /incomplete/)
  }
  // Entries from an unavailable observation are not painted as a catalog.
  const withEntries = makePanel({ skills: snapshot([skill('code-review', 'body')], false, false) })
  assert.doesNotMatch(text(withEntries, 80), /\/code-review/)
})

test('an incomplete catalog is marked and is not reported as empty', () => {
  const emptyIncomplete = makePanel({ skills: snapshot([], true, false) })
  const emptyRendered = text(emptyIncomplete, 80)
  assert.match(bodyOf(plain(emptyIncomplete, 80)).join('\n'), /Skills 0 incomplete/)
  assert.match(emptyRendered, /Catalog incomplete/)
  assert.doesNotMatch(emptyRendered, /No user-invocable skills/)

  const partial = makePanel({ skills: snapshot([skill('code-review', 'Review the diff.')], true, false) })
  const partialRendered = text(partial, 80)
  assert.match(bodyOf(plain(partial, 80)).join('\n'), /Skills 1 incomplete/)
  assert.match(partialRendered, /\/code-review/)
  assert.doesNotMatch(partialRendered, /No user-invocable skills/)
})

test('only an available, complete and empty catalog reports no user-invocable skills', () => {
  const empty = makePanel({ skills: snapshot([]) })
  const rendered = text(empty, 80)
  assert.match(bodyOf(plain(empty, 80)).join('\n'), /Skills 0/)
  assert.match(rendered, /No user-invocable skills\./)
  assert.doesNotMatch(rendered, /No skill catalog yet|Catalog incomplete/)
  assertWidths(empty)
})

test('a malformed snapshot degrades to safe rows instead of throwing', () => {
  const brokenEntries = { entries: undefined, available: true, complete: true } as unknown as SkillCatalogSnapshot
  const broken = makePanel({ skills: brokenEntries })
  assert.match(text(broken, 80), /No user-invocable skills\./)

  const odd = makePanel({
    skills: snapshot([null, { name: 42, description: null }] as unknown as SkillCatalogEntry[]),
  })
  assertWidths(odd)
  assert.match(text(odd, 80), /Skills/)
})

// ---------------------------------------------------------------------------
// Read-only: no execution, selection, prompt filling or click navigation

test('Enter, digits, printable keys and clicks never execute or select a skill', () => {
  const panel = makePanel({ skills: skillCatalog(), rows: 20 })
  const before = text(panel, 80)
  const scrollBefore = panel.scrollTop
  for (const key of ['\r', '\n', '1', '0', 'x', ' ', '\t', '\x0f']) panel.handleInput(key)
  assert.equal(panel.scrollTop, scrollBefore)
  assert.equal(text(panel, 80), before, 'browse keys stay inert: no filter, no scroll, no execution')
  assert.equal(panel.searching, false, 'printables never auto-activate the search field')
  // The frame owns only its own chrome (close/search chips). A press on a skill
  // row is not claimed by anything: skill rows are inert text, not targets.
  // A taller panel keeps the Skills rows inside the measured body.
  const tall = makePanel({ skills: skillCatalog(), rows: 40 })
  const bodyRow = plain(tall, 80).findIndex(line => /\/code-review/.test(line))
  assert.ok(bodyRow > 0, 'the skill row is painted in a body that can hold it')
  const panelWithRow = tall
  const tallBefore = text(tall, 80)
  const claimed = tall.handleMouse({
    type: 'press', button: 'left', x: 8, y: bodyRow, screenX: 8, screenY: bodyRow,
    width: 80, height: tall.render(80).length, shift: false, alt: false, ctrl: false,
  })
  assert.equal(claimed, undefined, 'a skill row press stays native text selection')
  tall.handleMouse({
    type: 'click', button: 'left', x: 8, y: bodyRow, screenX: 8, screenY: bodyRow,
    width: 80, height: tall.render(80).length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.equal(text(tall, 80), tallBefore, 'a click never executes, selects or fills anything')
  void panelWithRow
})

// ---------------------------------------------------------------------------
// Height budget and scrolling reach the Skills section

test('many skills stay inside the row budget and scroll with the shared list keys', () => {
  const entries = Array.from({ length: 30 }, (_, index) =>
    skill(`demo-skill-${String(index).padStart(2, '0')}`, `Fixture skill number ${index} description text.`))
  const panel = makePanel({ skills: snapshot(entries), rows: 12 })
  const first = plain(panel, 80)
  assert.ok(first.length <= 12, `rendered ${first.length} lines for a 12-row terminal`)
  assert.equal(panel.scrollTop, 0)
  assert.doesNotMatch(first.join('\n'), /\/demo-skill-29/)

  panel.handleInput('\x1b[F') // End
  assert.ok(panel.scrollTop > 0)
  const last = plain(panel, 80)
  assert.ok(last.length <= 12)
  assert.match(last.join('\n'), /\/demo-skill-29/)

  panel.handleInput('\x1b[H') // Home
  assert.equal(panel.scrollTop, 0)
  assert.match(plain(panel, 80).join('\n'), /Commands/)

  panel.handleInput('\x1b[6~') // PageDown
  assert.ok(panel.scrollTop > 0)
  assert.ok(panel.render(80).length <= 12)

  const narrow = makePanel({ skills: snapshot(entries), rows: 12 })
  assertWidths(narrow, [20, 40])
  for (const line of narrow.render(20)) assert.ok(visibleWidth(line) <= 20)
  assert.ok(narrow.render(20).length <= 12)
})

test('the Skills section keeps the local close; only an explicit interrupt override is native', () => {
  let closes = 0
  let interrupts = 0
  const local = new HelpPanel(fakeTui(30, 80), {
    commands: commands(),
    customCommands: customCommands(),
    skills: skillCatalog(),
    keymap: keymap(),
    onClose: () => { closes += 1 },
    onInterrupt: () => { interrupts += 1 },
  })
  local.handleInput('\x03')
  assert.equal(interrupts, 0, 'default Ctrl+C is the local close, not a native interrupt')
  assert.equal(closes, 1)
  local.handleInput('\x1b')
  assert.equal(closes, 1, 'close stays idempotent')

  closes = 0
  const explicit = new HelpPanel(fakeTui(30, 80), {
    commands: commands(),
    customCommands: customCommands(),
    skills: skillCatalog(),
    keymap: keymap({ 'app.interrupt': 'ctrl+c' }),
    onClose: () => { closes += 1 },
    onInterrupt: () => { interrupts += 1 },
  })
  explicit.handleInput('\x03')
  assert.equal(interrupts, 1)
  assert.equal(closes, 0)
  explicit.handleInput('\x1b')
  assert.equal(closes, 1)
})
// ---------------------------------------------------------------------------
// Shared frame geometry + search over the read-only Skills catalog

test('the Skills body is painted inside a closed frame at 40/60/80/120 columns and short heights', () => {
  for (const rows of [10, 18, 24, 40]) {
    for (const width of [40, 60, 80, 120]) {
      const panel = new HelpPanel(fakeTui(rows, width), {
        commands: commands(),
        customCommands: customCommands(),
        skills: skillCatalog(),
        keymap: keymap(),
        onClose: () => {},
        onInterrupt: () => {},
      })
      const lines = panel.render(width)
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
      const rendered = stripTerminalSequences(lines.join('\n'))
      assert.match(rendered.split('\n')[0] ?? '', /^┌─ Help/, `top border at ${width}x${rows}`)
      assert.match(rendered.split('\n').at(-1) ?? '', /^└─+┘$/, `bottom border at ${width}x${rows}`)
      assert.ok(lines.length <= Math.min(rows - 2, Math.floor(rows * 0.9)), `${lines.length} lines for ${rows} rows`)
      // The smallest frame keeps a readable body (the catalog is scrollable) and
      // the footer keeps a real close binding.
      assert.match(bodyOf(plain(panel, width)).join('\n'), /Commands|Skills/)
      assert.match(rendered, /Close|close/, `close affordance at ${width}x${rows}`)
    }
  }
})

test('modal.search filters the Skills catalog without executing or filling anything', () => {
  const panel = makePanel({ skills: skillCatalog(), rows: 30 })
  // Browse layer: printable keys stay inert, so the full catalog is listed.
  panel.handleInput('z')
  assert.match(text(panel, 80), /\/code-review/)

  // Ctrl+F focuses the one CC field; typing filters commands and skills.
  panel.handleInput('\x06')
  assert.equal(panel.searching, true)
  for (const char of 'review') panel.handleInput(char)
  const filtered = text(panel, 80)
  assert.match(filtered, /\/code-review/)
  assert.match(filtered, /Review the current diff for regressions\./)
  assert.doesNotMatch(filtered, /\/release-notes/, 'a non-matching skill is filtered out')
  assert.match(filtered, /1 skill/, 'the status line reports the filtered count')

  // Enter never executes or selects; a digit is query text, not a shortcut.
  panel.handleInput('\r')
  assert.match(text(panel, 80), /\/code-review/, 'Enter selects nothing and runs nothing')
  panel.handleInput('1')
  assert.match(text(panel, 80), /Find review1/, 'digits are field text while searching')
  panel.handleInput('\x7f')
  assert.match(text(panel, 80), /\/code-review/)

  // Esc leaves the search layer (query cleared) and the full catalog returns;
  // a second Esc closes the panel.
  let closes = 0
  const closesPanel = new HelpPanel(fakeTui(30, 80), {
    commands: commands(),
    customCommands: customCommands(),
    skills: skillCatalog(),
    keymap: keymap(),
    onClose: () => { closes += 1 },
    onInterrupt: () => {},
  })
  closesPanel.handleInput('\x06')
  for (const char of 'review') closesPanel.handleInput(char)
  closesPanel.handleInput('\x1b')
  assert.equal(closesPanel.searching, false, 'Esc leaves the search layer, not the surface')
  assert.equal(closes, 0)
  assert.match(text(closesPanel, 80), /\/release-notes/, 'the full catalog is listed again')
  closesPanel.handleInput('\x1b')
  assert.equal(closes, 1, 'the second Esc closes the panel')

  // A query that matches no skill is a search result, never an unavailable or
  // empty native catalog.
  const noMatch = makePanel({ skills: skillCatalog() })
  noMatch.handleInput('\x06')
  for (const char of 'zzzz') noMatch.handleInput(char)
  const none = text(noMatch, 80)
  assert.match(none, /Nothing matches "zzzz"/)
  assert.doesNotMatch(none, /No user-invocable skills/)
  assert.doesNotMatch(none, /No skill catalog is available/)
})

test('isPasting exposes the existing search-field paste state for the App', () => {
  const panel = makePanel({ skills: skillCatalog() })
  assert.equal(panel.isPasting, false)
  panel.handleInput('\x06')
  panel.handleInput('\x1b[200~partial')
  assert.equal(panel.isPasting, true, 'a fragmented paste is reported to the App')
  panel.handleInput('\x1b[201~')
  assert.equal(panel.isPasting, false)
})
