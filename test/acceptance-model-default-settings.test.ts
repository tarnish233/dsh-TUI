import test from 'node:test'
import { nativeProfileFixture } from './helpers/native-profile.ts'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

// Model definitions are native DSH fixture configuration, not imported Pi
// catalogs. No request is sent; every declared provider points at closed
// loopback and uses only the owned fixture's synthetic key environment.
const provider = (models: unknown[]) => ({ api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'DSH_NATIVE_TEST_KEY', models })
const providers = {
  'defaults-alpha': provider([{ id: 'saved', name: 'Alpha Saved', reasoningEfforts: { low: 'low', high: 'high' } }]),
  'defaults-beta': provider([{ id: 'needle', name: 'Beta Needle', reasoningEfforts: { low: 'low' } }]),
  'defaults-session': provider([{ id: 'pinned', name: 'Pinned Session', reasoningEfforts: { high: 'high' } }]),
}
const inject = ['settings', 'loader', 'configEditor', 'agentDefaultModel']

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native Settings default model/effort persist across fresh DSH launches and reset natively (${screen})`, { timeout: 120_000 }, async () => {
    const fixture = await nativeProfileFixture()
    try {
      await runNativeScene(async (scene: NativeScene) => {
        const assert: NativeScene['assert'] = scene.assert
        const { app, backend, ctx, object, terminal, paint, until, facts, directory } = scene
        type SettingsView = { activeRowId?: string; allRows: Array<{ id: string; value: string; available?: boolean }>; getVisibleRows(): Array<{ id: string }>; captureView(): unknown }
        const active = (): { render(width: number): string[] } | undefined => (app as unknown as { dialog?: { render(width: number): string[] } }).dialog
        const settings = (): SettingsView => (app as unknown as { dialog: SettingsView }).dialog
        const openRow = async (id: string, query: string): Promise<void> => {
          await app.submit('/settings')
          await until(() => settings().allRows.some(row => row.id === id && row.available === true), 'real native default row is writable', 10_000)
            .catch(async error => {
              const llm = object(ctx.get('llm'))
              let metadata: unknown
              try { metadata = await (llm.resolveModelInfo as (provider: string, model: string) => Promise<unknown>).call(llm, 'defaults-alpha', 'saved') }
              catch (reason) { metadata = String(reason) }
              throw new Error(String(error) + '\n' + JSON.stringify(await backend.command('native-defaults')) + '\n' + JSON.stringify(settings().allRows.filter(row => row.id.includes('default'))) + '\n' + JSON.stringify(metadata))
            })
          terminal.type('\x06')
          for (const char of query) terminal.type(char)
          await paint()
          const view = settings()
          assert.ok(view.getVisibleRows().some(row => row.id === id))
          for (let i = 0; i < view.getVisibleRows().length && view.activeRowId !== id; i++) terminal.type('\x1b[B')
          assert.equal(view.activeRowId, id)
          terminal.type('\r')
          await paint()
        }
        const agents = object(ctx.get('agents'))
        const count = (): number => (agents.list as () => unknown[]).call(agents).length
        const defaults = (): Record<string, unknown> => {
          const service = object(ctx.get('agentDefaultModel'))
          return object((service.currentSelection as () => unknown).call(service))
        }
        const beforePatch = await (await import('node:fs/promises')).readFile(directory + '/home/profiles/dsh-tui/cordis.patch.yml', 'utf8')
        assert.equal(app.session?.provider, 'defaults-session')
        assert.equal(app.session?.model, 'pinned')
        assert.equal(count(), 0)
        terminal.type('native startup defaults retained draft 中文')
        const editor = app.editor, draft = editor.captureDraft(), transcript = [...app.store.items]
        const attachment = app.session?.attachmentId
        await openRow('native:native.defaultModel', 'default model')
        await until(() => active()?.render(110).join('\n').includes('Alpha Saved') === true, 'saved default provider/model highlights its own picker', 10_000)
        assert.match(active()!.render(110).join('\n'), /Choose default model|default defaults-alpha\/saved/)
        terminal.type('needle')
        for (let i = 0; i < 20 && !active()?.render(110).join('\n').includes('Beta Needle'); i++) terminal.type('\t')
        await paint()
        assert.match(active()!.render(110).join('\n'), /Beta Needle/)
        assert.equal(defaults().provider, 'defaults-alpha', 'provider navigation has not saved anything')
        assert.equal(app.session?.model, 'pinned')
        terminal.type('\r')
        await until(() => defaults().provider === 'defaults-beta' && defaults().model === 'needle', 'Settings performs the real revisioned native profile write', 10_000)
        await until(() => active()?.render(110).join('\n').includes('Settings') === true, 'native save returns to Settings', 10_000)
        assert.equal(defaults().reasoningEffort, undefined, 'unsupported stored effort is removed on the native model change')
        assert.equal(app.session?.provider, 'defaults-session', 'an explicit current route is not selected by default editing')
        assert.equal(app.session?.model, 'pinned')
        assert.equal(app.session?.attachmentId, attachment)
        assert.equal(app.editor, editor)
        assert.deepEqual(editor.captureDraft(), draft)
        await openRow('native:native.defaultEffort', 'default effort')
        await until(() => active()?.render(110).join('\n').includes('low') === true, 'levels are from the saved beta model, not pinned current session', 10_000)
        assert.doesNotMatch(active()!.render(110).join('\n'), /\bHigh\b|\bhigh\b/)
        terminal.type('2') // Default, low: only the beta model's native roster.
        await until(() => defaults().reasoningEffort === 'low', 'Settings saves the real native effort field', 10_000)
        await until(() => active()?.render(110).join('\n').includes('Settings') === true, 'effort save returns to Settings', 10_000)
        assert.equal(app.session?.reasoningEffort, undefined, 'the CLI-pinned current route keeps its own choice')
        assert.deepEqual(editor.captureDraft(), draft)
        assert.deepEqual(app.store.items, transcript, 'model/effort default confirmations remain Settings metadata')
        assert.equal(count(), 0, 'listing/editing defaults never creates an Agent')
        assert.equal(facts().some(event => ['request/header', 'model/selection', 'turn/start', 'command/run', 'user/message'].includes(event.type)), false)
        const afterPatch = await (await import('node:fs/promises')).readFile(directory + '/home/profiles/dsh-tui/cordis.patch.yml', 'utf8')
        for (const marker of ['defaults-alpha', 'defaults-beta', 'Alpha Saved', 'Beta Needle', '127.0.0.1:9/v1']) {
          assert.ok(beforePatch.includes(marker) && afterPatch.includes(marker), 'native provider declarations are not rewritten by the TUI')
        }
        assert.ok(afterPatch.includes('reasoningEffort'), 'native ConfigEditor committed the effort to this owned profile')
        const read = object(await backend.command('native-defaults'))
        const field = (read.targets as unknown[]).map(object).find(row => row.target === 'agent-default-model')!
        assert.equal(field.provider, 'defaults-beta')
        assert.equal(field.model, 'needle')
        assert.equal(field.reasoningEffort, 'low')
        assert.deepEqual((field.reasoningEfforts as Array<{ id: string }>).map(level => level.id), ['low'], 'native beta metadata, not current session levels')
      }, {}, { fixture, screen, extraInject: inject, timeout: 35_000, explicitRoute: { provider: 'defaults-session', model: 'pinned' }, extraPatch: [
        { id: 'llm-pi-ai', config: { providers } },
        { id: 'agent-default-model', config: { provider: 'defaults-alpha', model: 'saved', reasoningEffort: 'high' } },
      ] })

      // A completely new native process reads the previous real profile edit.
      // The helper preserves the owned patch and deletes the old result marker;
      // neither a fake setter nor a retained runtime cache can pass this check.
      await runNativeScene(async (scene: NativeScene) => {
        const assert: NativeScene['assert'] = scene.assert
        const { app, backend, ctx, object, terminal, paint, until, facts } = scene
        const defaults = object(ctx.get('agentDefaultModel'))
        const selection = (): Record<string, unknown> => object((defaults.currentSelection as () => unknown).call(defaults))
        assert.equal(selection().provider, 'defaults-beta')
        assert.equal(selection().model, 'needle')
        assert.equal(selection().reasoningEffort, 'low', 'effort survives a fresh native launcher')
        assert.equal(app.session?.provider, 'defaults-beta')
        assert.equal(app.session?.model, 'needle')
        assert.equal(app.session?.reasoningEffort, 'low', 'an unselected new session follows the persisted native default')
        const read = object(await backend.command('native-defaults'))
        const field = (read.targets as unknown[]).map(object).find(row => row.target === 'agent-default-model')!
        assert.equal(field.reasoningEffort, 'low')
        assert.ok(typeof field.revision === 'number', 'revision comes from this fresh process, not a saved UI revision')
        await app.submit('/settings')
        type SettingsView = { activeRowId?: string; allRows: Array<{ id: string; available?: boolean }>; getVisibleRows(): unknown[] }
        const settings = (): SettingsView => (app as unknown as { dialog: SettingsView }).dialog
        const active = (): { render(width: number): string[] } | undefined => (app as unknown as { dialog?: { render(width: number): string[] } }).dialog
        await until(() => settings().allRows.some(row => row.id === 'native:native.defaultEffort' && row.available === true), 'fresh native default effort row', 10_000)
        terminal.type('\x06')
        for (const char of 'default effort') terminal.type(char)
        await paint()
        for (let i = 0; i < settings().getVisibleRows().length && settings().activeRowId !== 'native:native.defaultEffort'; i++) terminal.type('\x1b[B')
        assert.equal(settings().activeRowId, 'native:native.defaultEffort')
        terminal.type('\r'); await paint()
        await until(() => active()?.render(110).join('\n').includes('low') === true, 'fresh native effort picker')
        terminal.type('1') // Default -> native unset, not storing an effective level.
        await until(() => selection().reasoningEffort === undefined, 'native effort override removed', 10_000)
        await until(() => active()?.render(110).join('\n').includes('Settings') === true, 'reset native write settles', 10_000)
        const after = object(await backend.command('native-defaults'))
        const reset = (after.targets as unknown[]).map(object).find(row => row.target === 'agent-default-model')!
        assert.equal(reset.reasoningEffort, undefined)
        assert.equal(reset.provider, 'defaults-beta')
        assert.equal(reset.model, 'needle')
        assert.equal((object(ctx.get('agents')).list as () => unknown[]).call(ctx.get('agents')).length, 0)
        assert.equal(facts().some(event => ['request/header', 'model/selection', 'turn/start', 'user/message'].includes(event.type)), false)
      }, {}, { fixture, preserveProfilePatch: true, screen, extraInject: inject, explicitRoute: false, timeout: 30_000 })

      await runNativeScene(async (scene: NativeScene) => {
        const assert: NativeScene['assert'] = scene.assert
        const { app, backend, ctx, object, facts } = scene
        const defaults = object(ctx.get('agentDefaultModel'))
        const selection = object((defaults.currentSelection as () => unknown).call(defaults))
        assert.equal(selection.provider, 'defaults-beta')
        assert.equal(selection.model, 'needle')
        assert.equal(selection.reasoningEffort, undefined, 'the native unset survives another fresh DSH process')
        assert.equal(app.session?.reasoningEffort, undefined, 'an effective adapter default is not promoted into an explicit route field')
        const read = object(await backend.command('native-defaults'))
        const field = (read.targets as unknown[]).map(object).find(row => row.target === 'agent-default-model')!
        assert.equal(field.reasoningEffort, undefined)
        assert.equal(field.reasoningAvailable, true)
        assert.equal(field.reasoningSupported, true)
        assert.equal(facts().some(event => event.type === 'request/header'), false)
      }, {}, { fixture, preserveProfilePatch: true, screen, extraInject: inject, explicitRoute: false, timeout: 25_000 })
    } finally { await fixture.cleanup() }
  })
}

test('native Default model can repair an unregistered saved route without selecting the CLI-pinned session', { timeout: 45_000 }, async () => {
  await runNativeScene(async (scene: NativeScene) => {
    const assert: NativeScene['assert'] = scene.assert
    const { app, backend, ctx, object, terminal, paint, until, facts } = scene
    const read = object(await backend.command('native-defaults'))
    const field = (read.targets as unknown[]).map(object).find(row => row.target === 'agent-default-model')!
    assert.equal(field.provider, 'unregistered-default-provider')
    assert.equal(field.reasoningAvailable, false, 'the old route metadata failure stays honest')
    assert.equal(field.writable, true, 'the native Settings namespace/revision still allows a model repair')
    terminal.type('repair retained native draft')
    const editor = app.editor, draft = editor.captureDraft()
    await app.submit('/settings')
    type SettingsView = { activeRowId?: string; allRows: Array<{ id: string; available?: boolean }>; getVisibleRows(): unknown[] }
    const settings = (): SettingsView => (app as unknown as { dialog: SettingsView }).dialog
    const active = (): { render(width: number): string[] } | undefined => (app as unknown as { dialog?: { render(width: number): string[] } }).dialog
    await until(() => settings().allRows.some(row => row.id === 'native:native.defaultModel' && row.available === true), 'repair row is enabled', 10_000)
    assert.equal(settings().allRows.find(row => row.id === 'native:native.defaultEffort')?.available, false)
    terminal.type('\x06')
    for (const char of 'default model') terminal.type(char)
    await paint()
    for (let i = 0; i < settings().getVisibleRows().length && settings().activeRowId !== 'native:native.defaultModel'; i++) terminal.type('\x1b[B')
    assert.equal(settings().activeRowId, 'native:native.defaultModel')
    terminal.type('\r'); await paint()
    await until(() => /provider \d+\//.test(active()?.render(110).join('\n') ?? ''), 'native repair catalog arrives', 10_000)
    terminal.type('needle')
    for (let i = 0; i < 20 && !active()?.render(110).join('\n').includes('Beta Needle'); i++) terminal.type('\t')
    await paint()
    assert.match(active()!.render(110).join('\n'), /Beta Needle/)
    terminal.type('\r')
    const selection = (): Record<string, unknown> => {
      const service = object(ctx.get('agentDefaultModel'))
      return object((service.currentSelection as () => unknown).call(service))
    }
    await until(() => selection().provider === 'defaults-beta' && selection().model === 'needle', 'native default repair is committed', 10_000)
    assert.equal(selection().reasoningEffort, undefined, 'the old unsupported level is removed using the new model native metadata')
    assert.equal(app.session?.provider, 'defaults-session')
    assert.equal(app.session?.model, 'pinned')
    assert.equal(app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
    assert.equal((object(ctx.get('agents')).list as () => unknown[]).call(ctx.get('agents')).length, 0)
    assert.equal(facts().some(event => ['request/header', 'model/selection', 'turn/start', 'user/message'].includes(event.type)), false)
  }, {}, { screen: 'fullscreen', extraInject: inject, explicitRoute: { provider: 'defaults-session', model: 'pinned' }, timeout: 35_000, extraPatch: [
    { id: 'llm-pi-ai', config: { providers } },
    { id: 'agent-default-model', config: { provider: 'unregistered-default-provider', model: 'missing-model', reasoningEffort: 'high' } },
  ] })
})
