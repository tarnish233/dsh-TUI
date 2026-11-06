import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import { DemoBackend } from '../src/demo.ts'
import { createTerminalOutputLease } from '../src/backend/terminal-output.ts'
import { createNativeDiagnosticProjection } from '../src/ui/native-diagnostics.ts'
import { VirtualTerminal } from './helpers/terminal.ts'

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`app diagnostic routing preserves editor and native facts: ${screen}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-app-diagnostics-'))
    const terminal = new VirtualTerminal(100, 30)
    const app = new App({ backend: new DemoBackend({ cwd: directory }), cwd: directory, configDir: directory, terminal, screen, registerSignals: false })
    const projection = createNativeDiagnosticProjection((message, level) => app.reportNativeDiagnostic(message, level))
    const output = await createTerminalOutputLease({ directory: join(directory, 'logs'), onRecord: record => projection.handle(record) })
    try {
      output.install()
      await app.start()
      app.editor.setText('only this draft may be submitted')
      const draft = app.editor.captureDraft()
      const facts = app.store.items.slice()
      const queued = app.queuedCount
      const routine = '[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)'
      console.error(routine)
      console.log('ordinary native fixture chatter')
      await output.flush()
      assert.deepEqual(app.editor.captureDraft(), draft)
      assert.equal(app.queuedCount, queued)
      assert.deepEqual(app.store.items, facts)
      assert.doesNotMatch(terminal.writes.join(''), /model listing from|ordinary native fixture chatter/)
      console.warn('warning: synthetic native failure')
      console.warn('warning: synthetic native failure')
      await output.flush()
      assert.deepEqual(app.editor.captureDraft(), draft)
      assert.equal(app.queuedCount, queued)
      assert.deepEqual(app.store.items.slice(0, facts.length), facts)
      const warnings = app.store.items.filter(item => item.kind === 'notice' && item.text.includes('synthetic native failure'))
      assert.equal(warnings.length, 1)
      const recorded = await readFile(output.logPath, 'utf8')
      assert.match(recorded, /model listing from/)
      assert.match(recorded, /ordinary native fixture chatter/)
      assert.match(recorded, /synthetic native failure/)
      await app.shutdown()
      assert.equal(terminal.stopped, true)
    } finally {
      await app.shutdown().catch(() => {})
      projection.dispose()
      output.restore()
      await output.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
