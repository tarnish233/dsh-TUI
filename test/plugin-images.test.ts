import test from 'node:test'
import { imageFixture } from './helpers/images.ts'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native image-only prompt keeps durable refs and reads bytes through DSH (${screen})`, { timeout: 40_000 }, async () => {
    const image = await imageFixture()
    await runNativeScene(async (scene: NativeScene, params) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, terminal, events, until, facts, object } = scene
      const upload = params.upload as { type: 'image'; mediaType: 'image/png'; data: string; name?: string }
      app.editor.insertImage(upload)
      terminal.type('\r')
      await until(() => events.some(event => event.type === 'stream_end' && event.outcome === 'committed'), 'native image prompt settles', 10_000)
      const message = facts().find(event => event.type === 'user/message' && object(object(event.data).source).kind === 'user')!
      const content = object(message.data).content as { type: string; attachment?: unknown }[]
      const block = content.find(value => value.type === 'image')!
      assert.ok(block.attachment, 'DSH admitted and stored a canonical reference')
      assert.equal(JSON.stringify(message).includes(upload.data), false, 'the durable event never stores inline bytes')
      const value = await backend.readImage(block.attachment as Parameters<NonNullable<typeof backend.readImage>>[0])
      assert.ok(value.data.length > 0)
      assert.equal(value.attachment.mediaType, 'image/png')
      assert.equal(app.editor.hasImageAttachments(), false, 'the accepted draft was submitted once')
      assert.equal(content.some(value => value.type === 'text' && JSON.stringify(value).includes('[Image #')), false, 'no phantom marker text reaches DSH')
    }, { upload: image.upload }, { screen })
  })
}
