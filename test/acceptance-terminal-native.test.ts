import test from 'node:test'
import { runNativeScene } from './helpers/native-scenario.ts'

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`Native DSH terminal metadata (${screen}): durable outcome/title projection, explicit resume and unchanged composition`, { timeout: 50_000 }, async () => {
    await runNativeScene(async scene => {
      const { app, backend, terminal, ctx, home, object, until, facts } = scene
      const assert: typeof scene.assert = scene.assert
      const context = object(ctx)
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const patchPath = join(home, 'profiles/dsh-tui/cordis.patch.yml')
      const before = await readFile(patchPath, 'utf8')
      assert.equal(terminal.statusRecords.get('')?.state, 'idle')
      assert.equal(terminal.statusRecords.get('')?.app, 'terminal', 'only Rex presentation uses the generic icon classification')
      await app.submit('native terminal acceptance fixture')
      await until(() => !app.isBusy && facts().some(event => event.type === 'turn/end'), 'native durable turn settled', 12_000)
      const end = facts().filter(event => event.type === 'turn/end').at(-1)
      assert.equal(object(object(end?.data).reason).kind, 'completed')
      assert.equal(terminal.statusRecords.get('')?.state, 'done')
      assert.equal(terminal.statusRecords.get('')?.message, 'Turn complete')
      assert.equal(terminal.statusRecords.get('')?.app, 'terminal')
      const sessionId = app.session?.sessionId
      assert.ok(sessionId)
      const sessions = object(context.sessions)
      const get = sessions.get
      if (typeof get !== 'function') throw new Error('Native public SessionStore.get unavailable')
      const nativeSession: unknown = get.call(context.sessions, sessionId)
      assert.ok(nativeSession)
      const titleService = object(context.sessionTitle)
      const rename = titleService.rename
      if (typeof rename !== 'function') throw new Error('Native public SessionTitleService.rename unavailable')
      // A deliberate native operation in the synthetic fixture, not a frontend
      // title generator, provider enablement or an actual user's session.
      rename.call(context.sessionTitle, nativeSession, 'Native terminal fixture 中文')
      await until(() => app.session?.title === 'Native terminal fixture 中文', 'native title projection reached App')
      assert.equal(terminal.title, '🐳 Native terminal fixture 中文 — dsh-tui')
      assert.ok(scene.events.some(event => event.type === 'title' && event.sessionId === sessionId && event.value === 'Native terminal fixture 中文'))
      assert.ok(terminal.writes.some(data => data.includes(']7;file://')))
      const prompts = facts().filter(event => event.type === 'user/message').length
      const titleState = object(await backend.command('auto-title'))
      assert.equal(titleState.enabled, false, 'the synthetic provider remains composition-disabled')
      assert.equal(titleState.editable, false, 'terminal title presentation adds no provider toggle')
      assert.equal(facts().filter(event => event.type === 'user/message').length, prompts)
      await app.submit('/new')
      assert.equal(terminal.statusRecords.get('')?.state, 'idle')
      await app.submit('/resume ' + sessionId)
      await until(() => app.session?.sessionId === sessionId && app.session?.title === 'Native terminal fixture 中文', 'explicit native resume title baseline')
      assert.equal(terminal.title, '🐳 Native terminal fixture 中文 — dsh-tui')
      assert.equal(terminal.statusRecords.get('')?.state, 'idle', 'restored history is not fresh completion attention')
      assert.equal(await readFile(patchPath, 'utf8'), before, 'read-only terminal adaptation cannot rewrite DSH composition')
      assert.equal(facts().filter(event => event.type === 'user/message').length, prompts, 'metadata/recovery never creates a model prompt')
    }, {}, { screen, timeout: 40_000, extraInject: ['sessionTitle'] })
  })
}
