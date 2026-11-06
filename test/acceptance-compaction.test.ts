import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeScene } from './helpers/native-scenario.ts'
import { runNativeScene } from './helpers/native-scenario.ts'

const streamFixture = new URL('./fixtures/compaction-stream.mjs', import.meta.url).href

// Real native DSH + the production listener + a hermetic provider that rejects
// compaction unless the ordinary turn's explicit effort reaches the summarizer.
for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native /compact inherits the durable route effort (${screen})`, { timeout: 60_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const { app, ctx, object, events } = scene
      await app.submit('/effort high')
      const turnOffset = events.length
      await app.submit(`fixture:compaction ${'long-history-'.repeat(1200)}`)
      await scene.until(() => events.slice(turnOffset).some(event => event.type === 'status' && event.status === 'idle') && !app.isBusy, 'ordinary turn reaches native idle', 15_000)

      const fixture = object(ctx.get('compactionFixture'))
      const requests = fixture.requests
      scene.assert.ok(Array.isArray(requests))
      scene.assert.equal(requests.filter(options => object(options).purpose === 'compaction').length, 0)

      await app.submit('/compact')

      const compaction = requests.map(options => object(options)).filter(options => options.purpose === 'compaction')
      const notices = app.store.items.flatMap(item => item.kind === 'notice' ? [item.text] : [])
      scene.assert.equal(compaction.length, 1, JSON.stringify({ notices, requests: requests.map(options => ({ purpose: object(options).purpose, effort: object(options).reasoningEffort })) }))
      const request = compaction[0]!
      scene.assert.equal(request.reasoningEffort, 'high')
      scene.assert.equal(request.provider, 'deepseek-official')
      scene.assert.equal(request.model, 'deepseek-v4-flash')
      scene.assert.equal(request.maxTokens, 65_536, 'the native compaction output budget is unchanged')
      scene.assert.equal(request.sessionId, app.session?.sessionId)
      scene.assert.ok(Array.isArray(request.messages))
      scene.assert.ok(Array.isArray(request.tools))

      scene.assert.ok(notices.some(text => /Compacted \d+ history items/.test(text)), notices.join('\n'))
      scene.assert.equal(notices.some(text => text.includes('Native cause:')), false)
      const summary = events.find(event => event.type === 'session_event' && event.event.type === 'compaction/summary')
      scene.assert.ok(summary, 'DSH durably committed the generated checkpoint')
      const failed = events.some(event => event.type === 'session_event' && event.event.type === 'compaction/end' && typeof object(event.event.data).error === 'string')
      scene.assert.equal(failed, false)
    }, {}, {
      screen,
      streamFixture,
      extraPatch: [{ id: 'llm-deepseek', config: {
        baseURL: 'http://127.0.0.1:9/anthropic', apiKeyEnv: 'DSH_NATIVE_TEST_KEY',
        models: [{ id: 'deepseek-v4-flash', reasoningEfforts: { low: 'low', high: 'high' } }],
      } }],
    })
  })
}
