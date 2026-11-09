import test from 'node:test'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`settled native settings reload refreshes an existing preset picker without selection or Agent creation (${screen})`, { timeout: 50_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, ctx, object, until, paint, terminal, events } = scene
      const loader = object(ctx.get('loader'))
      assert.equal(typeof loader.entries, 'function')
      const entries = Array.from((loader.entries as () => Iterable<unknown>).call(loader)).map(object)
      const registry = entries.find(entry => object(entry.options).name === '@deepseek-ai/dsh-agent-preset-registry')
      const namespace = object(registry?.options).id
      assert.equal(typeof namespace, 'string', 'the actual profile entry owns the native settings namespace')
      const settings = object(ctx.get('settings'))
      assert.equal(typeof settings.update, 'function')
      const agentRegistry = object(ctx.get('agents'))
      const count = (): number => (agentRegistry.list as () => unknown[]).call(agentRegistry).length
      assert.equal(count(), 0)
      terminal.type('retained preset draft 中文')
      const editor = app.editor, draft = editor.captureDraft()
      await app.submit('/preset')
      await paint()
      const dialog = (app as unknown as { dialog?: { selectedIndex: number; items: Array<{ value: unknown; label: string }>; focused: boolean; render(width: number): string[] } }).dialog
      assert.ok(dialog)
      assert.ok(dialog.items.some(item => item.value === 'minimal'))
      terminal.type('\x1b[B')
      const selected = dialog.items[dialog.selectedIndex]?.value
      const root = app.session?.sessionId, attachment = app.session?.attachmentId
      const invalidations = events.filter(event => event.type === 'presets_changed').length
      await (settings.update as (ns: unknown, patch: unknown) => Promise<void>).call(settings, namespace, { selectedDefault: 'minimal' })
      await until(() => events.filter(event => event.type === 'presets_changed').length > invalidations,
        'the real ConfigEditor/Loader settled event is bridged', 10_000)
      await until(() => dialog.items.some(item => item.value === 'minimal' && item.label.includes('default')),
        'the open picker shows the native deployment default', 10_000)
      assert.equal((app as unknown as { dialog?: unknown }).dialog, dialog)
      assert.equal(dialog.items[dialog.selectedIndex]?.value, selected, 'default metadata never reselects a preset')
      assert.equal(dialog.focused, true)
      assert.equal(app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(app.session?.sessionId, root)
      assert.equal(app.session?.attachmentId, attachment)
      assert.equal(count(), 0, 'native metadata reload creates no Agent')
      assert.equal(events.some(event => event.type === 'stream_start'), false)
      terminal.type('\x1b')
      await until(() => editor.focused, 'the same composer regains focus')
      assert.deepEqual(editor.captureDraft(), draft)
      const closedReads = events.filter(event => event.type === 'presets_changed').length
      await (settings.update as (ns: unknown, patch: unknown) => Promise<void>).call(settings, namespace, { selectedDefault: 'standard' })
      await until(() => events.filter(event => event.type === 'presets_changed').length > closedReads, 'later native update is still observed')
      assert.equal((app as unknown as { dialog?: unknown }).dialog, undefined, 'native invalidation never opens or revives a picker')
      const final = object(await backend.command('presets'))
      assert.equal(final.default, 'standard')
      assert.equal(count(), 0)
    }, {}, { screen, extraInject: ['settings', 'loader'], timeout: 40_000 })
  })
}
