import test from 'node:test'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

test('native defaults are written only through DSH and the selected route stays native', { timeout: 40_000 }, async () => {
  await runNativeScene(async (scene: NativeScene) => {
    const assert: NativeScene['assert'] = scene.assert
    const { app, backend, ctx, object, events, facts } = scene
    const result = object(await backend.command('model', { id: 'deepseek-official/deepseek-v4-pro' }))
    const state = object(await backend.command('state'))
    assert.equal(state.provider, 'deepseek-official')
    assert.equal(state.model, 'deepseek-v4-pro')
    assert.equal(result.defaultsPersisted, false, 'a fulfilled native setter is not proof of a disk flush')
    assert.ok(['native', 'unavailable'].includes(String(result.defaultPersistence)))
    if (result.defaultPersistence === 'native') {
      const defaults = ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } }
      assert.equal(defaults.currentSelection().provider, 'deepseek-official')
      assert.equal(defaults.currentSelection().model, 'deepseek-v4-pro')
    }
    assert.equal(events.some(event => event.type === 'stream_start'), false)
    assert.equal(facts().some(event => event.type === 'user/message'), false)
    assert.ok(app.session)
  })
})
