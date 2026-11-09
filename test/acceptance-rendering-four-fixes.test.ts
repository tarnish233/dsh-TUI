import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

const streamFixture = new URL('./fixtures/render-handoff-stream.mjs', import.meta.url).href
const captureModule = new URL('../lib/backend/terminal-output.js', import.meta.url).href
const diagnosticsModule = new URL('../lib/ui/native-diagnostics.js', import.meta.url).href
const thinkingModule = new URL('../lib/ui/thinking-block.js', import.meta.url).href

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native rendering: expanded thinking survives PTC tool handoff and exact Node noise is log-only (${screen})`, { timeout: 80_000 }, async () => {
    await runNativeScene(async (scene: NativeScene, params) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, events, until, paint } = scene
      const mock = await import(String(params.streamFixture))
      const capture = await import(String(params.captureModule))
      const diagnostics = await import(String(params.diagnosticsModule))
      const thinking = await import(String(params.thinkingModule))
      const records: Array<{ kind: string; channel: string; text: string }> = []
      const projection = diagnostics.createNativeDiagnosticProjection((message: string, level: 'info' | 'error') => app.reportNativeDiagnostic(message, level))
      const lease = await capture.createTerminalOutputLease({ directory: scene.directory + '/render-native-log',
        onRecord: (record: { kind: string; channel: string; text: string }) => { records.push(record); projection.handle(record) } })
      lease.install()
      const view = (app as unknown as { transcript: { render(width: number): string[]; expandedDisclosureCount: number } }).transcript
      try {
        await backend.command('preset', { id: 'ptc' })
        await app.submit('fixture:render-handoff')
        await until(() => mock.state.ready === true && app.store.items.some(item => item.kind === 'attempt' && item.status === 'streaming'),
          'long native thinking is live', 15_000)
        const live = app.store.items.find(item => item.kind === 'attempt' && item.status === 'streaming')!
        thinking.setThinkingExpanded(thinking.thinkingExpansionKey(live.id, 0), true)
        await paint()
        assert.equal(view.expandedDisclosureCount, 1)
        assert.ok(view.render(110).length > 1400)
        mock.release()
        await until(() => events.some(event => event.type === 'session_event' && event.event.type === 'tool/call') && !app.isBusy,
          'native PTC constant finishes and reasoning settles', 30_000)
        // Read before a forced paint as well: viewport anchoring must not see a
        // temporary collapse while the durable block adopts the old live key.
        assert.ok(view.expandedDisclosureCount >= 1)
        await paint()
        const body = view.render(110).join('\n')
        assert.match(body, /NATIVE_THINKING_0\b/)
        assert.match(body, /NATIVE_THINKING_1399\b/)
        assert.match(body, /NATIVE_RENDER_HANDOFF_COMPLETE/)
        const nativeTool = app.store.items.filter(item => item.kind === 'tool' && item.callId === 'render-handoff-call')
        assert.equal(nativeTool.length, 1)
        assert.equal(nativeTool[0]?.kind, 'tool')
        if (nativeTool[0]?.kind === 'tool') {
          assert.equal(nativeTool[0].status, 'done')
          assert.match(nativeTool[0].resultText, /42/)
        }
        const settled = app.store.items.find(item => item.kind === 'assistant' && item.thinkingKey === live.id)
        assert.ok(settled && settled.kind === 'assistant')
        assert.equal(settled.id, 'assistant:' + settled.seq, 'native durable display id remains seq-derived')
        assert.doesNotMatch(body, /requested: run_code/)
        await scene.delay(40)
        const warning = records.filter(record => record.text.includes('ExperimentalWarning: stripTypeScriptTypes'))
        assert.equal(warning.length, 1, 'real host PTC strip API emits once')
        assert.equal(warning[0]?.kind, 'routine')
        assert.ok(records.some(record => record.kind === 'routine' && record.text.includes('Use `node --trace-warnings')))
        assert.equal(app.store.items.filter(item => item.kind === 'notice' && /stripTypeScriptTypes|Use `node --trace-warnings/.test(item.text)).length, 0)
        const fs = await import('node:fs/promises')
        lease.restore()
        await lease.close()
        const log = await fs.readFile(lease.logPath, 'utf8')
        assert.match(log, /ExperimentalWarning: stripTypeScriptTypes/)
        assert.match(log, /Use `node --trace-warnings/)
      } finally {
        mock.release()
        projection.dispose()
        lease.restore()
        await lease.close()
      }
    }, { streamFixture, captureModule, diagnosticsModule, thinkingModule }, { screen, streamFixture, timeout: 70_000,
      prepare: async fixture => {
        const directory = join(fixture.directory, 'tui')
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'settings.json'), JSON.stringify({ showThinking: true, thinkingPreviewLines: 3 }))
      } })
  })
}
