import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeScene } from './helpers/native-scenario.ts'
import { runNativeScene } from './helpers/native-scenario.ts'

// Two declared pi-ai routes (unknown to the installed catalog, so both name
// their wire protocol and endpoint). Requests never leave the process: the
// live provider points at a closed loopback port and this acceptance only
// lists/selects routes, never sends a prompt.
const model = (id: string, name: string) => ({ id, name, reasoningEfforts: { low: 'low', high: 'high' } })
const providers = {
  'picker-alpha': {
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    apiKeyEnv: 'DSH_NATIVE_TEST_KEY',
    models: [model('shared', 'Shared Alpha'), model('needle', 'Alpha Needle')],
  },
  'picker-beta': {
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    apiKeyEnv: 'DSH_NATIVE_TEST_KEY',
    models: [model('shared', 'Shared Beta'), model('needle', 'Beta Needle')],
  },
}

// Parent-owned, independent end-to-end model-picker acceptance. The model
// catalog comes from the public native `llm` service inside the same real DSH
// process as the App and adapter; the picker's provider tabs/search are pure UI
// projections, and a selection is one native route change with no prompt.
for (const screen of ['inline', 'fullscreen'] as const) {
  test(`parent native model picker (${screen}): provider search/tabs select through DSH without prompts or provider configuration changes`, { timeout: 60_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const { app, backend, terminal, events, object, until, paint, directory } = scene
      const patchPath = directory + '/home/profiles/dsh-tui/cordis.patch.yml'
      const { readFile } = await import('node:fs/promises')
      const patchText = await readFile(patchPath, 'utf8')

      terminal.resize(110, 42)
      await paint()
      scene.assert.ok(app.session)
      const attachment = app.session.attachmentId
      scene.assert.equal(typeof attachment, 'string')
      const catalog = await backend.command('models')
      scene.assert.ok(Array.isArray(catalog))
      scene.assert.ok(catalog.some(value => object(value).id === 'picker-alpha/needle'), 'the public llm service lists the declared alpha route')
      scene.assert.ok(catalog.some(value => object(value).id === 'picker-beta/needle'), 'the public llm service lists the declared beta route')

      // A confirmed native route/session baseline; this never sends a prompt.
      await app.submit('/model picker-alpha/shared')
      await until(() => app.session?.provider === 'picker-alpha' && app.session.model === 'shared', 'native baseline route', 15_000)
      await app.submit('/effort low')
      await until(() => app.session?.reasoningEffort === 'low', 'native baseline reasoning effort', 15_000)
      await paint()

      const before = [...app.store.items]
      const editor = app.editor
      terminal.type('native model picker retained draft')
      const draft = editor.captureDraft()
      await app.submit('/model')
      await paint()
      scene.assert.match(terminal.screen(), /Shared Alpha/)
      scene.assert.doesNotMatch(terminal.screen(), /Shared Beta/)
      terminal.type('nEeDlE')
      await paint()
      scene.assert.match(terminal.screen(), /Alpha Needle/)
      scene.assert.doesNotMatch(terminal.screen(), /Shared Alpha/)
      terminal.type('\t')
      await paint()
      scene.assert.match(terminal.screen(), /Beta Needle/)
      scene.assert.doesNotMatch(terminal.screen(), /Shared Beta/)
      scene.assert.equal(app.session.provider, 'picker-alpha', 'browse/search do not mutate the native selection')
      terminal.type('\r')
      await until(() => app.session?.provider === 'picker-beta' && app.session.model === 'needle', 'Enter applies the exact native provider/model route', 15_000)
      await paint()
      scene.assert.equal(app.session.reasoningEffort, 'low', 'the explicit native reasoning effort survives a route change that still offers it')
      scene.assert.equal(app.session.attachmentId, attachment)
      scene.assert.equal(app.editor, editor)
      scene.assert.deepEqual(editor.captureDraft(), draft)
      scene.assert.deepEqual(app.store.items, before, 'successful selection remains quiet and is not a conversation prompt')
      const state = object(await backend.command('state'))
      scene.assert.equal(state.provider, 'picker-beta')
      scene.assert.equal(state.model, 'needle')
      scene.assert.equal(state.reasoningEffort, 'low')
      scene.assert.equal(events.some(event => event.type === 'stream_start'), false)
      scene.assert.equal(events.some(event => event.type === 'session_event' && ['turn/start', 'command/run'].includes(event.event.type)), false)
      // Native default saving now targets this real temporary profile, not a
      // TUI mirror. It may change the default row, never the provider definitions.
      const after = await readFile(patchPath, 'utf8')
      for (const marker of ['picker-alpha', 'picker-beta', 'Alpha Needle', 'Beta Needle']) {
        scene.assert.ok(patchText.includes(marker) && after.includes(marker), 'native provider declarations remain intact')
      }
    }, {}, { screen, extraPatch: [{ id: 'llm-pi-ai', config: { providers } }] })
  })
}