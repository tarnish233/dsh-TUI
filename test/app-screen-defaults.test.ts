import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import { DemoBackend } from '../src/demo.ts'
import { optionsFromFlags, tuiCommand, type TuiFlags } from '../src/plugin/options.ts'
import { VirtualTerminal } from './helpers/terminal.ts'

const cases: Array<{
  name: string
  settings?: Record<string, unknown>
  args: string[]
  expected: 'inline' | 'fullscreen'
}> = [
  { name: 'no flags or preferences', args: [], expected: 'fullscreen' },
  { name: 'preferences without a screen choice', settings: { showThinking: true }, args: [], expected: 'fullscreen' },
  { name: 'an explicitly saved inline preference', settings: { screen: 'inline' }, args: [], expected: 'inline' },
  { name: 'an explicit inline flag', settings: { screen: 'fullscreen' }, args: ['--inline'], expected: 'inline' },
  { name: 'an explicit fullscreen flag', settings: { screen: 'inline' }, args: ['--fullscreen'], expected: 'fullscreen' },
]

for (const item of cases) {
  test(`actual App screen selection: ${item.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-screen-default-'))
    const terminal = new VirtualTerminal(100, 32)
    let app: App | undefined
    try {
      if (item.settings !== undefined) await writeFile(join(directory, 'settings.json'), JSON.stringify(item.settings))
      const command = tuiCommand().exitOverride().configureOutput({ writeOut() {}, writeErr() {} })
      let screen: 'inline' | 'fullscreen' | undefined
      command.action((prompt: string[]) => {
        screen = optionsFromFlags(command.opts<TuiFlags>(), prompt, command).screen
      })
      command.parse(item.args, { from: 'user' })
      app = new App({
        backend: new DemoBackend({ cwd: directory, delayMs: 0 }),
        cwd: directory, configDir: directory, terminal, screen, demo: true, registerSignals: false,
      })
      await app.start()
      await terminal.flush()
      assert.equal(terminal.writes.join('').includes('\x1b[?1049h'), item.expected === 'fullscreen', 'the selected renderer actually enters the expected terminal screen')
      await app.shutdown()
      assert.equal(terminal.stopped, true)
      if (item.expected === 'fullscreen') assert.ok(terminal.writes.join('').includes('\x1b[?1049l'), 'default fullscreen restores the terminal on exit')
    } finally {
      try { await app?.shutdown() }
      finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
    }
  })
}
