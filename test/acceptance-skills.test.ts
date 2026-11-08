import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'
import type { NativeProfileFixture } from './helpers/native-profile.ts'
import type { JsonRecord } from '../src/backend/types.ts'

const streamFixture = new URL('./fixtures/skills-stream.mjs', import.meta.url).href
const definitions = [
  { name: 'fixture-review', description: 'Native fixture review metadata.', body: 'NATIVE_REVIEW_BODY_SENTINEL', extra: '' },
  { name: 'fixture-user-only', description: 'Explicit-only native fixture.', body: 'NATIVE_USER_ONLY_BODY_SENTINEL', extra: 'disable-model-invocation: true\n' },
  { name: 'fixture-model-only', description: 'Not a user-invocable menu entry.', body: 'NATIVE_MODEL_ONLY_BODY_SENTINEL', extra: 'user-invocable: false\n' },
]
async function prepareSkills(fixture: NativeProfileFixture): Promise<void> {
  for (const definition of definitions) {
    const directory = join(fixture.cwd, '.agents', 'skills', definition.name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${definition.name}\ndescription: ${definition.description}\n${definition.extra}---\n${definition.body}\n`)
  }
}
async function prepareCollision(fixture: NativeProfileFixture): Promise<void> {
  const directory = join(fixture.cwd, '.agents', 'skills', 'plan')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), '---\nname: plan\ndescription: Native command collision fixture.\n---\nNEVER_LOAD_PLAN_SHADOW_BODY\n')
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native Skills: pending discovery, first literal invocation, user-only policy and invalidation (${screen})`, async () => {
    await runNativeScene(async (scene: NativeScene, params: JsonRecord) => {
      const fixture = await import(String(params.streamFixture))
      const requests = fixture.observations as Array<{ texts: string[] }>
      const definitions = params.definitions as Array<{ name: string; body: string }>
      scene.assert.ok(scene.app.session?.capabilities.includes('skills'))
      const initial = scene.object(await scene.backend.command('skills'))
      scene.assert.equal(initial.available, true, 'native preset lease exposes pending metadata without an Agent')
      scene.assert.equal(initial.complete, true)
      scene.assert.ok((initial.entries as Array<Record<string, unknown>>).some(entry => entry.name === 'fixture-review'))
      await scene.app.submit('/help'); await scene.paint()
      scene.terminal.type('\x1b[F'); await scene.paint()
      scene.assert.match(scene.terminal.screen(), /\/fixture-user-only \[user-only\]/)
      scene.assert.equal(requests.length, 0, 'reading the pending menu never calls a model')
      scene.terminal.type('\x1b')
      await scene.paint()

      const line = '/fixture-review  exact\twhitespace\nsecond line  '
      await scene.app.submit(line)
      await scene.until(() => requests.length >= 1 && !scene.app.isBusy, 'native first skill response', 10_000)
      await scene.paint()
      const first = requests[0]!.texts
      scene.assert.ok(first.includes(line), 'the original user text reaches DSH unchanged')
      scene.assert.ok(first.some(text => text.includes('<skill_content name="fixture-review">') && text.includes('NATIVE_REVIEW_BODY_SENTINEL')), 'DSH pre-step loads the native skill without a model tool call')
      scene.assert.equal(first.filter(text => text.includes('<skill_content name="fixture-review">')).length, 1)
      scene.assert.ok(scene.facts().some(event => event.type === 'user/message' && scene.userText(event) === line))
      scene.assert.equal(scene.facts().some(event => event.type === 'command/run'), false, 'skill invocation is not a synthetic human command')
      scene.assert.equal(scene.facts().some(event => event.type === 'tool/call'), false, 'the offline model never had to call skill')

      const catalog = scene.object(await scene.backend.command('skills'))
      const entries = (catalog.entries as Array<Record<string, unknown>>)
      scene.assert.equal(catalog.available, true)
      scene.assert.equal(catalog.complete, true)
      scene.assert.ok(entries.some(entry => entry.name === 'fixture-review'))
      scene.assert.ok(entries.some(entry => entry.name === 'fixture-user-only' && entry.modelInvocable === false))
      scene.assert.equal(entries.some(entry => entry.name === 'fixture-model-only'), false)
      const encoded = JSON.stringify(catalog)
      for (const definition of definitions) scene.assert.equal(encoded.includes(definition.body), false, 'no skill body crosses metadata query')
      scene.assert.equal(encoded.includes('"path"'), false)
      scene.assert.equal(encoded.includes('"locator"'), false)

      scene.terminal.resize(120, 55)
      await scene.app.submit('/help'); await scene.paint()
      scene.terminal.type('\x1b[F'); await scene.paint()
      scene.assert.match(scene.terminal.screen(), /\/fixture-user-only \[user-only\]/)
      scene.assert.doesNotMatch(scene.terminal.screen(), /\/fixture-model-only/)
      scene.terminal.type('\x1b'); await scene.paint()
      const secondStart = requests.length
      await scene.app.submit('/fixture-user-only explicit native invocation')
      await scene.until(() => requests.length > secondStart && !scene.app.isBusy, 'native user-only skill response')
      scene.assert.ok(requests.at(-1)!.texts.some(text => text.includes('<skill_content name="fixture-user-only">') && text.includes('NATIVE_USER_ONLY_BODY_SENTINEL')))

      const registry = scene.object(scene.ctx.get('skills'))
      scene.assert.equal(typeof registry.register, 'function')
      const changes = scene.events.filter(event => event.type === 'skills_changed').length
      scene.terminal.type('/runtime-probe'); await scene.paint()
      const draft = scene.app.editor.captureDraft()
      const dispose = (registry.register as (definition: unknown) => () => void).call(registry, {
        name: 'runtime-probe', description: 'NATIVE_RUNTIME_METADATA', content: 'NATIVE_RUNTIME_BODY_MUST_NOT_ENTER_MENU', source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: true },
      })
      try {
        await scene.until(() => scene.events.filter(event => event.type === 'skills_changed').length > changes, 'actual Cordis skills/change propagation')
        await scene.until(() => scene.app.editor.isShowingAutocomplete(), 'native metadata invalidation refreshes active slash query')
        await scene.paint()
        scene.assert.match(scene.terminal.screen(), /runtime-probe.*NATIVE_RUNTIME_METADATA/)
        scene.assert.deepEqual(scene.app.editor.captureDraft(), draft)
        scene.assert.doesNotMatch(scene.terminal.screen(), /NATIVE_RUNTIME_BODY/)
      } finally { dispose() }
      await scene.until(() => !scene.app.editor.isShowingAutocomplete(), 'removed native skill loses its menu candidate')
      scene.assert.deepEqual(scene.app.editor.captureDraft(), draft)
    }, { streamFixture, definitions }, { screen, streamFixture, timeout: 40_000, prepare: prepareSkills })
  })

  test(`native Skills: a first-input scoped command wins its same-name skill (${screen})`, async () => {
    await runNativeScene(async (scene: NativeScene, params: JsonRecord) => {
      const fixture = await import(String(params.streamFixture))
      const requests = fixture.observations as Array<{ texts: string[] }>
      const before = await scene.backend.command('commands') as Array<Record<string, unknown>>
      scene.assert.equal(before.some(command => command.name === 'plan'), false, 'the pending global roster does not yet contain the preset command')
      await scene.app.submit('/plan off')
      await scene.paint()
      scene.assert.ok(scene.facts().some(event => event.type === 'command/run' && scene.object(event.data).name === 'plan'))
      scene.assert.ok(scene.facts().some(event => event.type === 'command/done'))
      scene.assert.equal(requests.length, 0, 'a native command is not downgraded to a skill prompt')
      scene.assert.equal(scene.facts().some(event => event.type === 'user/message' && scene.userText(event).includes('/plan off')), false)
      const catalog = scene.object(await scene.backend.command('skills'))
      scene.assert.ok((catalog.entries as Array<Record<string, unknown>>).some(entry => entry.name === 'plan'))
      scene.terminal.type('/plan'); await scene.paint()
      scene.assert.ok(scene.app.editor.isShowingAutocomplete())
      scene.assert.doesNotMatch(scene.terminal.screen(), /Native command collision fixture/)
      scene.assert.equal(scene.app.editor.getText(), '/plan')
    }, { streamFixture }, { screen, streamFixture, timeout: 35_000, prepare: prepareCollision })
  })
}

// The native runner rejects on failure; importing this test never starts a real provider.
assert.ok(streamFixture.endsWith('/skills-stream.mjs'))
