import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'
import { imageFixture } from './helpers/images.ts'

const inject = ['jobs', 'goals', 'workingDirectory', 'settings', 'loader', 'commands', 'attachments']
const png = (await imageFixture('image/png', 'native-command.png', 2, 2)).upload.data

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native feature batches: jobs/inventory read-only, goal and effective cwd (${screen})`, { timeout: 60_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, ctx, object, until, paint, terminal, events, cwd } = scene
      const agents = object(ctx.get('agents'))
      const count = (): number => (agents.list as () => unknown[]).call(agents).length
      assert.equal(count(), 0)
      assert.ok(app.session?.capabilities.includes('native-jobs'))
      assert.ok(app.session?.capabilities.includes('native-inventory'), 'helper resolves from the selected native installation')
      await app.submit('/jobs')
      await paint()
      const dialog = (app as unknown as { dialog?: { render(width: number): string[] } }).dialog
      assert.ok(dialog)
      assert.equal(count(), 0, 'opening Jobs never materializes an Agent')
      const jobs = object(ctx.get('jobs'))
      const detach = (jobs.attachController as (name: string) => () => void).call(jobs, 'native-fixture-ui')
      let finish: (value: unknown) => void = () => {}
      let producer: { append(text: string, options?: { channel?: string }): void } | undefined
      const done = new Promise<unknown>(resolve => { finish = resolve })
      try {
        const id = (jobs.start as (spec: unknown) => string).call(jobs, {
          kind: 'fixture', label: 'unowned native fixture job',
          run: (job: typeof producer) => { producer = job; return { cancel: () => finish({ status: 'killed' }), done } },
        })
        await until(() => dialog.render(110).join('\n').includes('unowned native fixture job'), 'native unowned job registration refreshes the open list', 10_000)
        producer!.append('native stdout fixture\n', { channel: 'stdout' })
        producer!.append('native stderr fixture\n', { channel: 'stderr' })
        terminal.type('\r')
        await until(() => dialog.render(110).join('\n').includes('native stderr fixture'), 'native readAt output reaches the view', 10_000)
        const consumed = object((jobs.read as (id: string) => unknown).call(jobs, id))
        assert.ok(Array.isArray(consumed.chunks) && consumed.chunks.length === 2, 'the UI did not consume the model cursor')
        finish({ status: 'completed', result: 'native fixture done' })
        await (jobs.wait as (id: string, ms: number) => Promise<unknown>).call(jobs, id, 2_000)
        await until(() => dialog.render(110).join('\n').includes('completed'), 'terminal native job status refreshes', 10_000)
      } finally { finish({ status: 'completed' }); detach() }
      terminal.type('\x1b'); terminal.type('\x1b')
      await paint()
      const plugins = object(await backend.command('native-inventory'))
      assert.equal(plugins.available, true)
      assert.ok(Array.isArray(plugins.entries) && plugins.entries.length > 0)
      assert.equal(count(), 0)
      await backend.command('input-route', { name: 'fixture-explicit-scope' })
      const id = app.session!.sessionId
      const agent = (agents.get as (id: string) => unknown).call(agents, id)
      const goals = object(ctx.get('goals'))
      ;(goals.create as (agent: unknown, input: unknown) => unknown).call(goals, agent, { objective: 'native goal fixture objective', maxGoalRounds: 2 })
      const created = object((goals.get as (agent: unknown) => unknown).call(goals, agent))
      ;(goals.pause as (agent: unknown, ref: unknown) => unknown).call(goals, agent, { id: created.id, revision: created.revision })
      await until(() => terminal.screen().includes('native goal fixture objective'), 'native Goal projection reaches the fixed dock', 10_000)
      const goal = object(await backend.command('native-goal'))
      assert.equal(object(goal.goal).phase, 'paused')
      const wd = object(ctx.get('workingDirectory'))
      const effective = cwd + '/native-effective'
      const canonical = await (wd.set as (agent: unknown, path: string) => Promise<string>).call(wd, agent, effective)
      await until(() => terminal.screen().includes('effective:'), 'native effective directory gets its own footer field', 10_000)
      assert.equal(app.session?.cwd, cwd, 'immutable workspace identity stays unchanged')
      const directory = object(await backend.command('native-working-directory'))
      assert.equal(directory.effectiveCwd, canonical, 'native directory canonicalization is authoritative')
      const tools = object(await backend.command('native-tools'))
      assert.equal(tools.available, true)
      assert.ok(Array.isArray(tools.tools) && tools.tools.length > 0, 'tool query is the actual current Agent scope')
      assert.ok(events.some(event => event.type === 'native_ui_changed' && event.domain === 'goal'))
    }, {}, { screen, extraInject: inject, timeout: 50_000, prepare: async fixture => { await mkdir(join(fixture.cwd, 'native-effective')) } })
  })

  test(`native feature batches: safe defaults are isolated, revisioned and do not select a session (${screen})`, { timeout: 60_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, ctx, object, terminal, paint, until, events } = scene
      const agents = object(ctx.get('agents'))
      const count = (): number => (agents.list as () => unknown[]).call(agents).length
      const first = object(await backend.command('native-defaults'))
      assert.equal(first.available, true)
      assert.ok(Array.isArray(first.targets))
      const preset = (first.targets as unknown[]).map(object).find(target => target.target === 'agent-preset-default')!
      const permission = (first.targets as unknown[]).map(object).find(target => target.target === 'permission-default-preset')!
      assert.equal(preset.writable, true)
      assert.equal(permission.writable, true)
      assert.notEqual(preset.namespace, 'agent-preset-registry', 'the actual TUI profile namespace is used')
      const attachment = app.session?.attachmentId, session = app.session?.sessionId
      const result = object(await backend.command('native-default-update', {
        target: 'agent-preset-default', value: 'minimal', expectedRevision: preset.revision, attachmentId: attachment,
      }))
      assert.equal(result.ok, true)
      assert.equal(result.changed, true)
      const conflict = object(await backend.command('native-default-update', {
        target: 'agent-preset-default', value: 'standard', expectedRevision: preset.revision, attachmentId: attachment,
      }))
      assert.equal(conflict.ok, false)
      assert.equal(conflict.reason, 'conflict')
      const current = object(await backend.command('native-defaults'))
      assert.equal((current.targets as unknown[]).map(object).find(target => target.target === 'agent-preset-default')?.value, 'minimal')
      terminal.type('safe default draft 中文')
      const editor = app.editor, before = editor.captureDraft()
      await app.submit('/settings')
      terminal.type('\x06') // existing Settings search (Ctrl+F)
      terminal.type('Default agent preset')
      await until(() => terminal.screen().includes('Default agent preset'), 'safe native entries are in the existing Settings page', 10_000)
      await paint()
      assert.equal(app.editor, editor)
      assert.deepEqual(editor.captureDraft(), before)
      assert.equal(app.session?.sessionId, session)
      assert.equal(app.session?.attachmentId, attachment)
      assert.equal(count(), 0, 'safe default reads and writes create no Agent')
      assert.equal(events.some(event => event.type === 'stream_start'), false)
    }, {}, { screen, extraInject: inject, timeout: 50_000 })
  })

  test(`native feature batches: rename and interactive fork remain durable and promptable (${screen})`, { timeout: 75_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, ctx, object, until, paint, events } = scene
      await app.submit('native fork source fixture')
      await until(() => events.some(event => event.type === 'session_event' && event.event.type === 'turn/end'), 'source fixture settles', 10_000)
      await until(() => !app.isBusy, 'source is idle', 10_000)
      await app.submit('/rename Native fork title')
      await until(() => app.session?.title === 'Native fork title', 'native explicit user rename', 10_000)
      const sourceId = app.session!.sessionId, attachmentId = app.session!.attachmentId
      const sessions = object(ctx.get('sessions'))
      const source = object((sessions.get as (id: string) => unknown).call(sessions, sourceId))
      const sourceEvents = (source.snapshotEvents as () => unknown[]).call(source)
      const prefix = sourceEvents.length
      const next = object(await backend.command('session-fork', { sessionId: sourceId, attachmentId }))
      assert.notEqual(next.sessionId, sourceId)
      assert.equal(app.session?.sessionId, next.sessionId)
      const fork = object((sessions.get as (id: string) => unknown).call(sessions, next.sessionId as string))
      assert.equal(object(fork.header).isSeeded, true)
      assert.equal(object(fork.header).origin, undefined)
      assert.equal(object(fork.header).parentSession, undefined)
      assert.equal(fork.inheritedEventCount, prefix)
      const copied = (fork.snapshotEvents as () => unknown[]).call(fork)
      assert.deepEqual(copied.slice(0, prefix), sourceEvents, 'native complete prefix and facts are retained')
      const before = events.length
      await app.submit('continue the native fork fixture')
      await until(() => events.slice(before).some(event => event.type === 'session_event' && event.event.type === 'turn/end' && event.sessionId === next.sessionId), 'fork is a genuine promptable Agent', 10_000)
      await until(() => !app.isBusy, 'fork settles', 10_000)
      await backend.command('new')
      await backend.command('resume', { sessionId: next.sessionId })
      await paint()
      assert.equal(app.session?.sessionId, next.sessionId)
      assert.equal(app.session?.title, 'Native fork title', 'explicit resume restores the native pinned title')
    }, {}, { screen, extraInject: inject, timeout: 65_000 })
  })

  test(`native feature batches: file-only input, recovery and command image refusal keep native facts (${screen})`, { timeout: 75_000 }, async () => {
    await runNativeScene(async (scene: NativeScene, params) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, ctx, cwd, object, until, paint, events } = scene
      const agents = object(ctx.get('agents'))
      const count = (): number => (agents.list as () => unknown[]).call(agents).length
      const empty = await backend.stageFile({ data: '', name: 'empty-native.txt' })
      assert.equal(empty.bytes, 0)
      assert.equal(count(), 0)
      await app.submit('/attach "' + cwd + '/sample file.bin"')
      assert.equal(count(), 0, 'native file storage is independent of Agent creation')
      const content = app.editor.getPromptContent()
      const file = content.find(part => part.type === 'file')
      assert.ok(file?.type === 'file')
      assert.equal(file.attachment.name, 'sample file.bin')
      assert.equal(file.attachment.bytes, 6)
      app.editor.ccSubmit()
      await until(() => events.some(event => event.type === 'session_event' && event.event.type === 'user/message' &&
        Array.isArray(object(event.event.data).content) && (object(event.event.data).content as unknown[]).some(part => object(part).type === 'file')), 'real native file-only user message', 10_000)
      await until(() => !app.isBusy && events.some(event => event.type === 'session_event' && event.event.type === 'turn/end'), 'file-only fixture settles', 10_000)
      const id = app.session!.sessionId
      await backend.command('new'); await backend.command('resume', { sessionId: id })
      await paint()
      assert.ok(app.store.items.some(item => item.kind === 'user' && item.content?.some(part => part.type === 'file')), 'native cold projection keeps file references')
      const commandRows = await backend.command('commands') as unknown[]
      assert.equal(object(commandRows.map(object).find(row => row.name === 'goal')?.input).attachments, true)
      assert.equal(object(commandRows.map(object).find(row => row.name === 'plan')?.input).attachments, true)
      const positive = object(await backend.command('execute', { line: '/goal status', attachments: [{ type: 'image', mediaType: 'image/png', data: params.png, name: 'native-command.png' }] }))
      assert.equal(positive.attachmentOutcome, 'success', 'a declaring native command admits encoded images without a TUI vision gate')
      const beforeMessages = events.filter(event => event.type === 'session_event' && event.event.type === 'user/message').length
      app.editor.replaceDraftText('/permission standard')
      assert.equal(typeof params.png, 'string')
      app.editor.insertImage({ type: 'image', mediaType: 'image/png', data: params.png as string, name: 'fixture.png' })
      const draft = app.editor.captureDraft()
      app.editor.ccSubmit()
      await until(() => app.editor.hasImageAttachments(), 'settled native command refusal restores the image draft', 10_000)
      assert.deepEqual(app.editor.captureDraft(), draft)
      assert.equal(events.filter(event => event.type === 'session_event' && event.event.type === 'user/message').length, beforeMessages)
      app.editor.replaceDraftText('/goal command files unsupported')
      app.editor.insertFile(file)
      const fileDraft = app.editor.captureDraft()
      app.editor.ccSubmit()
      await until(() => app.editor.hasFileAttachments(), 'unmounted command file receipt owner keeps the draft', 10_000)
      assert.deepEqual(app.editor.captureDraft(), fileDraft)
      assert.equal(app.session?.capabilities.includes('command-file-attachments'), false)
    }, { png }, { screen, extraInject: inject, timeout: 65_000, prepare: async fixture => { await writeFile(join(fixture.cwd, 'sample file.bin'), Uint8Array.from([0, 1, 2, 3, 254, 255])) } })
  })
}
