// Must stay the FIRST import: forces truecolor before src/ui/theme.ts snapshots
// getTerminalColorMode() at import time.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import { defaults } from '../src/config.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'
import { palette, t } from '../src/ui/theme.ts'
import { ModalFrame, type ModalFrameOptions } from '../src/ui/modal.ts'

/**
 * Rendered-surface contract for every modal in the app (Settings, Keybindings,
 * pickers, tool details share `ModalFrame`/`ModalListSurface`).
 *
 * Regression: Settings used to paint a private near-black plate while the main
 * UI paints nothing, so it looked black instead of matching the transcript.
 * A modal must now be a transparent plate over the terminal background, fill
 * its width exactly, and keep focus/error/status foregrounds semantic.
 */

const input = await loadInputModule()
const { SettingsDialog } = await import('../src/ui/settings.ts')
const { KeybindingsDialog } = await import('../src/ui/keybindings.ts')

const BACKGROUND_SGR = /\x1b\[(?:4[0-7]|10[0-7]|48;|49m)/
const TRAILING_RESET = /\x1b\[0m$/

type Dialog = InstanceType<typeof SettingsDialog>

function settingsDialog(options: { rows?: number; width?: number } = {}): Dialog {
  const tui = createFakeTui(options.rows ?? 30, options.width ?? 100)
  return new SettingsDialog(asTui(tui), {
    settings: { ...defaults },
    keymap: input.createCcKeymap(),
    onChange: () => {},
    onKeybindings: () => {},
    path: '/tmp/temporary/settings.json',
    onCancel: () => {},
  })
}

function rgb(hex: string): { r: number; g: number; b: number } {
  assert.match(hex, /^#[0-9a-f]{6}$/i)
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

function luminance(hex: string): number {
  const { r, g, b } = rgb(hex)
  const channel = (value: number): number => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((left, right) => right - left) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

const plain = (line: string): string => stripTerminalSequences(line)

test('Settings paints no background at all: it inherits the main surface', () => {
  for (const width of [40, 60, 80, 120]) {
    const dialog = settingsDialog()
    const lines = dialog.render(width)
    assert.ok(lines.length > 0)
    for (const line of lines) {
      assert.equal(BACKGROUND_SGR.test(line), false, `no modal plate at width ${width}: ${JSON.stringify(line)}`)
      assert.equal(TRAILING_RESET.test(line), false, 'no dangling clip reset past the right edge')
      assert.equal(visibleWidth(line), width, `every row is exactly ${width} columns`)
    }
    // The frame is still drawn: it must be readable without a plate.
    assert.match(plain(lines[0] ?? ''), /^┌─ .*┐$/)
    assert.match(plain(lines.at(-1) ?? ''), /^└─*┘$/)
    assert.match(plain(lines.join('\n')), /Settings/)
    assert.match(plain(lines.join('\n')), /Search settings/)
    dialog.dispose?.()
  }
})

test('the Keybindings pane shares the same transparent plate', () => {
  const dialog = new KeybindingsDialog(asTui(createFakeTui(30, 100)), {
    keymap: input.createCcKeymap(),
    path: '/tmp/temporary/keybindings.json',
    onChange: async () => {},
    onBack: () => {},
  })
  for (const width of [40, 80, 120]) {
    const lines = dialog.render(width)
    for (const line of lines) {
      assert.equal(BACKGROUND_SGR.test(line), false)
      assert.equal(visibleWidth(line), width)
    }
    assert.match(plain(lines.join('\n')), /Keyboard|Shortcut|keybindings|Keys/i)
  }
  dialog.dispose?.()
})

test('every framed modal row keeps its plate, padding and right border aligned', () => {
  const frame = new ModalFrame()
  const options: ModalFrameOptions = {
    title: 'Tool details 中文', before: ['A header'], after: ['Saving…'],
    actions: [{ id: 'copy', label: 'Copy', action: 'tool.details.copy', onActivate: () => {} }],
    maxHeight: 12, onClose: () => {}, keymap: input.createCcKeymap(),
  }
  for (const width of [8, 9, 10, 14, 27, 40, 73, 100]) {
    const body = ['short', 'x'.repeat(width * 3), '中文'.repeat(width)]
    const lines = frame.render(width, body, options)
    for (const line of lines) {
      assert.equal(BACKGROUND_SGR.test(line), false)
      assert.equal(visibleWidth(line), width)
      assert.equal(TRAILING_RESET.test(line), false)
    }
    const rendered = lines.map(plain)
    assert.match(rendered[0] ?? '', /^┌─ .*┐$/)
    assert.match(rendered.at(-1) ?? '', /^└─*┘$/)
    // A clipped row still ends in its border, after the surface padding.
    for (const line of rendered.slice(1, -1)) {
      if (line.startsWith('│')) assert.ok(line.endsWith('│'), `right border: ${JSON.stringify(line)}`)
    }
  }
})

test('focus, unfocused and error/status rows keep semantic foregrounds on the inherited surface', () => {
  const dialog = settingsDialog()
  const focusedWidth = 80
  const focused = dialog.render(focusedWidth)
  const focusedRow = focused.find(line => plain(line).includes('❯'))
  assert.ok(focusedRow !== undefined, 'one focused row is marked')
  assert.ok(focusedRow.includes(t.accentBright('❯')), 'the focused marker is the bright brand tier')
  assert.equal(BACKGROUND_SGR.test(focusedRow), false, 'focus is text, not a private band')

  const plainRows = focused.map(plain)
  assert.equal(plainRows.filter(line => line.includes('❯')).length, 1, 'exactly one focused marker row')
  const unfocused = focused.find(line => plain(line).includes('Show thinking'))
  assert.ok(unfocused !== undefined, 'an unfocused label is rendered')
  assert.ok(unfocused.includes(t.text('Show thinking')), 'unfocused labels use body text')
  assert.equal(unfocused.includes(t.accentBright('Show thinking')), false, 'unfocused labels are not the focus color')

  dialog.setMessage('Native settings write failed', true)
  const failedLines = dialog.render(focusedWidth)
  const errorLine = failedLines.find(line => plain(line).includes('Native settings write failed')) ?? ''
  assert.ok(errorLine.includes(t.redSoft('Native settings write failed')), 'failures use the semantic red')
  assert.equal(BACKGROUND_SGR.test(errorLine), false, 'an error row is not painted as a private band')

  dialog.setMessage('Saved')
  const savedLine = dialog.render(focusedWidth).find(line => plain(line).includes('Saved')) ?? ''
  assert.ok(savedLine.includes(t.green('Saved')), 'success uses the semantic green')
  assert.equal(BACKGROUND_SGR.test(savedLine), false)

  // A transparent plate means contrast is judged against the nominal dark
  // canvas the app is designed for (the same bet the fixed light fg makes).
  for (const role of ['fg', 'muted', 'accent', 'accentBright', 'redSoft', 'green', 'yellow'] as const) {
    const ratio = contrast(palette[role], palette.canvas)
    assert.ok(ratio >= 4.5, `${role} contrast ${ratio.toFixed(2)} on the inherited canvas`)
  }
  dialog.dispose?.()
})

test('narrow and short terminals still paint an unstyled, width-exact modal', () => {
  for (const rows of [8, 12, 24]) {
    for (const width of [1, 7, 20, 44]) {
      const dialog = settingsDialog({ rows })
      const lines = dialog.render(width)
      for (const line of lines) {
        assert.equal(BACKGROUND_SGR.test(line), false)
        assert.ok(visibleWidth(line) <= width, `row wider than ${width} at rows=${rows}`)
      }
      dialog.dispose?.()
    }
  }
})

test('settings input/navigation keep the surface transparent and width-exact', () => {
  const dialog = settingsDialog()
  const assertSurface = (stage: string): void => {
    const lines = dialog.render(80)
    for (const line of lines) {
      assert.equal(BACKGROUND_SGR.test(line), false, `${stage}: no plate`)
      assert.equal(TRAILING_RESET.test(line), false, `${stage}: no dangling reset`)
      assert.equal(visibleWidth(line), 80, `${stage}: width-exact`)
    }
  }
  // Search focus + typing + leaving the field, category jumps, row navigation
  // and an activation round trip. Native semantics are unchanged (focus is a
  // field, not a band; leaving search keeps the query); only the plate is.
  dialog.handleInput('\x06') // Ctrl+F focuses the search field.
  assert.equal(dialog.searchFocusedState, true)
  for (const char of 'terminal') dialog.handleInput(char)
  assert.equal(dialog.query, 'terminal')
  assertSurface('typing in search')
  dialog.handleInput('\x1b') // Esc leaves the field; the native query survives.
  assert.equal(dialog.searchFocusedState, false)
  assert.equal(dialog.query, 'terminal')
  assertSurface('leaving search')
  dialog.handleInput('\x06')
  for (let index = 0; index < 'terminal'.length; index += 1) dialog.handleInput('\x7f')
  assert.equal(dialog.query, '')
  dialog.handleInput('\x1b')
  assertSurface('clearing search')
  for (let index = 0; index < 3; index += 1) dialog.handleInput('\x1b[C')
  assertSurface('category jumps')
  dialog.handleInput('\x0e') // Ctrl+N moves to the next row.
  assertSurface('row navigation')
  dialog.handleInput('\r') // Activate the focused row (toggle or picker).
  assertSurface('row activation')
  dialog.dispose?.()
})
