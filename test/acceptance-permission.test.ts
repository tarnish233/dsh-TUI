import test from 'node:test'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native permission switching keeps draft and does not queue a prompt (${screen})`, { timeout: 40_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, terminal, events, until, facts, object, paint } = scene
      terminal.type('native permission retained draft')
      await paint()
      const text = app.editor.getText()
      const runs = () => facts().filter(event => event.type === 'command/run' && object(event.data).name === 'permission')
      for (let index = 0; index < 3; index += 1) {
        const before = runs().length
        terminal.type('\x1b[Z')
        await until(() => runs().length === before + 1, 'one native permission command')
        const commandId = object(runs().at(-1)!.data).commandId
        await until(() => facts().some(event => event.type === 'command/done' && object(event.data).commandId === commandId), 'native permission audit settles')
        const state = object(await backend.command('state'))
        assert.equal(state.queued, 0)
        assert.equal(app.editor.getText(), text)
      }
      const humanMessages = () => facts().filter(event => event.type === 'user/message' && object(object(event.data).source).kind === 'user')
      assert.equal(humanMessages().length, 0)
      assert.equal(events.some(event => event.type === 'stream_start'), false)
      terminal.type('\x15')
      await app.submit('fixture:normal-after-native-permission')
      await until(() => events.some(event => event.type === 'stream_end' && event.outcome === 'committed'), 'ordinary input starts normally')
      assert.equal(humanMessages().length, 1, 'native context/approval notices are not submitted human prompts')
    }, {}, { screen })
  })
}

test('native permission changes do not delete genuine queued input', { timeout: 45_000 }, async () => {
  await runNativeScene(async (scene: NativeScene) => {
    const assert: NativeScene['assert'] = scene.assert
    const { app, backend, terminal, events, until, object } = scene
    await app.submit('fixture:slow-permission-queue')
    await until(() => events.some(event => event.type === 'stream_chunk'), 'native stream begins')
    await backend.send('fixture:normal-genuine-queued-followup')
    const before = object(await backend.command('state'))
    assert.ok(Number(before.queued) >= 1)
    terminal.type('\x1b[Z')
    await until(() => events.some(event => event.type === 'permissions'), 'native permission changes')
    await backend.cancel()
    const recalled = await backend.command('dequeue') as { text: string }[]
    assert.ok(recalled.some(message => message.text === 'fixture:normal-genuine-queued-followup'))
  })
})
