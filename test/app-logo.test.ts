import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences } from '#pi-tui'
import { App } from '../src/app.ts'
import { DemoBackend } from '../src/demo.ts'
import { LOGO_BLOCK_GLYPHS } from '../src/ui/logo.ts'
import { VirtualTerminal, delay } from './helpers/terminal.ts'

for (const screen of ['inline', 'fullscreen'] as const) {
  test('static character logo works on image-capable terminals and keeps input/modal/exit state (' + screen + ')', async context => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
    const timeout = context.mock.method(globalThis, 'setTimeout')
    const interval = context.mock.method(globalThis, 'setInterval')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-static-logo-'))
    const terminal = new VirtualTerminal(90, 28)
    const app = new App({ backend: new DemoBackend({ cwd: directory, delayMs: 0 }), cwd: directory,
      configDir: directory, terminal, screen, demo: true, registerSignals: false })
    const paint = async () => { await delay(40); await terminal.flush() }
    try {
      await app.start(); await paint()
      assert.match(terminal.screen(), /DeepSeek Harness/)
      assert.match(terminal.screen(), /DEMO \/ NO MODEL CALLS/)
      const lines = terminal.screen().split('\n')
      const lastLogoRow = lines.map(line => /[▖-▟]/.test(stripTerminalSequences(line))).lastIndexOf(true)
      assert.ok(lastLogoRow >= 0, 'the logo is painted')
      assert.equal(stripTerminalSequences(lines[lastLogoRow + 1] ?? '').trim(), '', 'a blank line keeps the first conversation below the logo')
      assert.match(terminal.writes.join(''), new RegExp(`[${LOGO_BLOCK_GLYPHS}]`, 'u'))
      assert.match(terminal.writes.join(''), /\x1b\[(?:38|48);2;255;255;255m/)
      const raw = terminal.writes.join('')
      assert.doesNotMatch(raw, /\x1b\]1337;File=|[\u2800-\u28ff]/u)
      // Pi fullscreen can erase pre-existing terminal images. Cleanup a=d is
      // not a logo upload/placement and must not require a vendor change.
      for (const command of raw.matchAll(/\x1b_G(.*?)\x1b\\/gs)) {
        assert.match(command[1], /(?:^|,)a=d(?:,|$)/, 'no image data/placement is emitted for the logo')
      }
      const writes = [...terminal.writes]
      await delay(550); await terminal.flush()
      assert.deepEqual(terminal.writes, writes, 'idle startup does not animate or periodically redraw')
      // The 10s read-only git-stats poll is the app's only long interval; the
      // startup surface itself must not animate.
      assert.ok(interval.mock.calls.every(call => (call.arguments[1] ?? 0) >= 10_000), 'no animation interval (only the 10s git poll)')
      assert.ok(timeout.mock.calls.every(call => call.arguments[0]?.name !== 'advanceWelcomeStep'), 'no startup frame timeout')
      terminal.type('static logo retained draft')
      terminal.type('\x1b[200~paste one\npaste two\x1b[201~'); terminal.type('\x02')
      const editor = app.editor, draft = editor.captureDraft(), items = [...app.store.items]
      await app.submit('/help'); await paint()
      assert.match(terminal.screen(), /Help/)
      terminal.type('\r12'); terminal.type('\x1b'); await paint()
      terminal.resize(40, 22); await paint(); terminal.resize(90, 28); await paint()
      assert.equal(app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.deepEqual(app.store.items, items)
      assert.equal(editor.focused, true)
      await app.shutdown(); await terminal.flush()
      assert.equal(terminal.stopped, true)
      assert.match(terminal.writes.join(''), /\x1b\[\?25h/)
    } finally {
      await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true })
      resetCapabilitiesCache()
    }
  })
}

test('startup animation is deleted from App, not left disabled or paused', () => {
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /WELCOME_ANIMATION|WELCOME_STATIC_FRAME|welcomeTimer|welcomeStep|welcomeFinished|startWelcomeAnimation|scheduleWelcomeStep|stopWelcomeAnimation|setAnimationFrame/)
})
