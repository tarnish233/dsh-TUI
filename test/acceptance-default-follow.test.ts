import test from 'node:test'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

const streamFixture = new URL('./fixtures/mock-stream.mjs', import.meta.url).href

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native defaults follow before selection/request and logged route pins after explicit resume (${screen})`, { timeout: 60_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, ctx, object, facts, until } = scene
      const defaults = object(ctx.get('agentDefaultModel'))
      assert.equal(typeof defaults.saveSelection, 'function')
      const save = async (model: string): Promise<void> => {
        await (defaults.saveSelection as (selection: unknown) => Promise<unknown>).call(defaults, {
          provider: 'deepseek-official', model,
        })
      }
      await save('deepseek-v4-flash')
      await backend.command('new')
      const pendingRoot = app.session?.sessionId
      assert.ok(pendingRoot)
      await save('deepseek-v4-pro')
      const pending = object(await backend.command('state'))
      assert.equal(pending.model, 'deepseek-v4-pro', 'unselected pending state follows the public native default')
      await until(() => app.session?.model === 'deepseek-v4-pro', 'settled native config signal updates the unselected footer route')
      const agents = object(ctx.get('agents'))
      assert.equal((agents.list as () => unknown[]).call(agents).length, 0, 'following metadata creates no Agent')

      await backend.command('input-route', { name: 'fixture-no-command' })
      const root = app.session?.sessionId
      assert.equal(root, pendingRoot, 'native materialization keeps the explicit pending identity')
      const agent = object((agents.get as (id: string) => unknown).call(agents, String(root)))
      const model = object(agent.model)
      const current = (): Record<string, unknown> => object((model.current as () => unknown).call(model))
      assert.equal(current().model, 'deepseek-v4-pro')
      assert.equal(facts().some(event => event.type === 'request/header'), false, 'the Agent has not prepared a request')
      await save('deepseek-v4-flash')
      assert.equal(current().model, 'deepseek-v4-flash', 'native AgentOptions live accessors follow another default before a request')
      await until(() => app.session?.model === 'deepseek-v4-flash', 'materialized-but-unrequested footer follows native route metadata')

      await app.submit('fixture:follow-native-default')
      await until(() => !app.isBusy && facts().some(event => event.type === 'request/header'), 'a real native request header is committed', 15_000)
      const header = facts().filter(event => event.type === 'request/header').at(-1)
      const config = object(object(object(header?.data).header).config)
      assert.equal(config.model, 'deepseek-v4-flash')
      await save('deepseek-v4-pro')
      assert.equal(current().model, 'deepseek-v4-flash', 'native logged request state wins over later defaults')
      const live = object(await backend.command('state'))
      assert.equal(live.model, 'deepseek-v4-flash')
      assert.equal(app.session?.model, 'deepseek-v4-flash', 'metadata invalidation never replaces the logged current route with a default')

      await backend.command('new')
      assert.equal(object(await backend.command('state')).model, 'deepseek-v4-pro', 'the next unselected pending session follows the new default')
      await backend.command('resume', { sessionId: root })
      assert.equal(object(await backend.command('state')).model, 'deepseek-v4-flash', 'explicit resume never replaces a logged route with a default')
    }, {}, { screen, streamFixture, explicitRoute: false, timeout: 50_000 })
  })

  test(`native explicit CLI and per-session selections do not re-follow a later default (${screen})`, { timeout: 45_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, ctx, object, facts } = scene
      const defaults = object(ctx.get('agentDefaultModel'))
      const save = async (model: string): Promise<void> => {
        await (defaults.saveSelection as (selection: unknown) => Promise<unknown>).call(defaults, {
          provider: 'deepseek-official', model,
        })
      }
      await save('deepseek-v4-pro')
      assert.equal(object(await backend.command('state')).model, 'deepseek-v4-flash', 'the fixture explicit CLI route stays pinned')
      await backend.command('input-route', { name: 'fixture-no-command' })
      const agents = object(ctx.get('agents'))
      const agent = object((agents.get as (id: string) => unknown).call(agents, String(app.session?.sessionId)))
      const model = object(agent.model)
      assert.equal(object((model.current as () => unknown).call(model)).model, 'deepseek-v4-flash')
      await backend.command('model', { id: 'deepseek-official/deepseek-v4-pro' })
      await save('deepseek-v4-flash')
      assert.equal(object((model.current as () => unknown).call(model)).model, 'deepseek-v4-pro', 'native explicit selection beats future defaults')
      assert.equal(facts().some(event => event.type === 'request/header'), false, 'the selection control needed no model request')
    }, {}, { screen, streamFixture, timeout: 35_000 })
  })
}
