import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'
import type { NativeProfileFixture } from './helpers/native-profile.ts'
import type { JsonRecord } from '../src/backend/types.ts'

const skillsFixture = new URL('./fixtures/skills-stream.mjs', import.meta.url).href
const limitFixture = new URL('./fixtures/audit-limit-stream.mjs', import.meta.url).href

async function prepareReview(fixture: NativeProfileFixture): Promise<void> {
  const directory = join(fixture.cwd, '.agents', 'skills', 'review')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'),
    '---\nname: review\ndescription: Exact native review Skill fixture.\n---\nNATIVE_EXACT_REVIEW_SKILL_BODY\n')
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native audit regression: exact Skill Enter cannot execute a prefix command; commands/change refreshes (${screen})`, { timeout: 60_000 }, async () => {
    await runNativeScene(async (scene: NativeScene, params: JsonRecord) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, ctx, terminal, events, until, paint, object, facts, userText } = scene
      const observer = await import(String(params.streamFixture))
      const observations = observer.observations as Array<{ texts: string[] }>
      const catalog = object(await backend.command('skills'))
      assert.equal(catalog.available, true)
      assert.ok((catalog.entries as JsonRecord[]).some(skill => skill.name === 'review'))
      const commands = object(ctx.get('commands'))
      assert.equal(typeof commands.register, 'function')
      let siblingCalls = 0
      const dispose = (commands.register as (definition: unknown) => () => void).call(commands, {
        definitionId: '@audit-fixture/review-all', name: 'review-all',
        description: 'Harmless native sibling command', input: { hint: '<target>' },
        handler: () => { siblingCalls++; return { kind: 'success', text: 'NATIVE_REVIEW_ALL_CONTROL' } },
      })
      try {
        // No /help or forced TUI refresh: the native invalidation must do this.
        await until(() => events.some(event => event.type === 'commands_changed'), 'native command registration was bridged')
        terminal.type('/review')
        await until(() => app.editor.isShowingAutocomplete() && app.editor.render(110).join('\n').includes('review-all'),
          'fresh mixed command/Skill roster is visible')
        await paint()
        assert.equal(app.editor.getText(), '/review')
        assert.match(app.editor.render(110).join('\n'), /<target>/, 'native hint survives the App/provider contract')
        assert.equal(observations.length, 0, 'metadata discovery is read-only')
        terminal.type('\r')
        await until(() => observations.length > 0 && !app.isBusy, 'content-aware Enter completes an offline native Skill turn', 15_000)
        assert.equal(siblingCalls, 0, 'the different prefix command must never execute')
        assert.ok(facts().some(event => event.type === 'user/message' && userText(event).trim() === '/review'))
        assert.ok(observations.some(request => request.texts.some(text =>
          text.includes('<skill_content name="review">') && text.includes('NATIVE_EXACT_REVIEW_SKILL_BODY'))))
        assert.equal(facts().some(event => event.type === 'command/run' && object(event.data).name === 'review-all'), false)

        // A deliberate command selection remains executable through DSH.
        const before = observations.length
        terminal.type('/review-all')
        await paint()
        terminal.type('\r')
        await until(() => siblingCalls === 1 && !app.isBusy, 'the exact sibling command control executes')
        assert.equal(observations.length, before, 'a native command is not downgraded to a model/Skill prompt')
        assert.ok(facts().some(event => event.type === 'command/run' && object(event.data).name === 'review-all'))
      } finally { dispose() }
    }, { streamFixture: skillsFixture }, { screen, streamFixture: skillsFixture,
      prepare: prepareReview, extraInject: ['commands'], timeout: 50_000 })
  })

  test(`native audit regression: max-tokens is visible live and after explicit resume (${screen})`, { timeout: 45_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, terminal, until, paint, facts, object } = scene
      await app.submit('fixture:native-output-limit')
      await until(() => !app.isBusy && facts().some(event => event.type === 'turn/end' &&
        object(object(event.data).reason).kind === 'max-tokens'), 'the real native loop records max-tokens', 15_000)
      await paint()
      assert.match(terminal.document(), /NATIVE_OUTPUT_LIMIT_REPLY/)
      assert.match(terminal.document(), /Output limit reached/)
      const root = app.session?.sessionId
      assert.ok(root)
      const live = app.store.items.filter(item => item.kind === 'notice' && item.text.includes('Output limit reached'))
      assert.equal(live.length, 1)
      await backend.command('new')
      await backend.command('resume', { sessionId: root })
      await paint()
      const replay = app.store.items.filter(item => item.kind === 'notice' && item.text.includes('Output limit reached'))
      assert.equal(replay.length, 1, 'the durable closer rebuilds exactly one semantic outcome')
      assert.match(terminal.document(), /Output limit reached/)
    }, {}, { screen, streamFixture: limitFixture, timeout: 35_000 })
  })
}
