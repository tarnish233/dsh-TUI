/** Native @file discovery through the mounted DSH provider; no model turn or file admission. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { JsonRecord } from '../src/backend/types.ts'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'
import type { NativeProfileFixture } from './helpers/native-profile.ts'

async function prepareWorkspace(fixture: NativeProfileFixture): Promise<void> {
  await mkdir(join(fixture.cwd, 'src'), { recursive: true })
  await writeFile(join(fixture.cwd, 'src', 'reference-target.ts'), 'export const nativeReferenceFixture = true\n')
  await writeFile(join(fixture.cwd, 'notes with spaces.md'), 'native path-only reference fixture\n')
  await mkdir(join(fixture.cwd, 'node_modules', 'ignored-native-reference'), { recursive: true })
  await writeFile(join(fixture.cwd, 'node_modules', 'ignored-native-reference', 'index.ts'), 'never listed\n')
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native @file completion materializes only the DSH Agent and accepts a path without sending (${screen})`, async () => {
    await runNativeScene(async (scene: NativeScene, _params: JsonRecord) => {
      const sessionId = String(scene.app.session?.sessionId)
      scene.assert.ok(scene.app.session?.capabilities.includes('file-references'), 'mounted native provider is advertised')
      const provider = scene.object(scene.ctx.get('fileReferences'))
      scene.assert.equal(typeof provider.list, 'function', 'the bundle mounts DSH fileReferences, not a TUI scanner')
      const agents = scene.object(scene.ctx.get('agents'))
      scene.assert.equal(typeof agents.get, 'function')
      const get = agents.get as (id: string) => unknown
      scene.assert.equal(get.call(agents, sessionId), undefined, 'blank startup keeps the Agent lazy')

      const editor = scene.app.editor
      scene.terminal.type('@reference-t')
      await scene.until(() => editor.isShowingAutocomplete(), 'native file-reference menu', 10_000)
      await scene.paint()

      scene.assert.equal(scene.app.editor, editor, 'same attachment keeps the one Editor while the Agent materializes')
      scene.assert.ok(get.call(agents, sessionId), 'the Agent-scoped native provider materializes the pending Agent')
      scene.assert.match(scene.terminal.screen(), /reference-target\.ts/)
      scene.assert.equal(editor.getText(), '@reference-t')
      scene.assert.equal(scene.facts().some(event => event.type === 'user/message'), false, 'candidate discovery sends no prompt')
      scene.assert.equal(scene.app.isBusy, false, 'candidate discovery starts no model turn')

      scene.terminal.type('\r')
      await scene.paint()
      scene.assert.equal(editor.getText(), '@src/reference-target.ts ')
      scene.assert.equal(editor.isShowingAutocomplete(), false)
      scene.assert.equal(editor.hasFileAttachments(), false, '@path is not /attach and stages no FileBlock')
      scene.assert.equal(scene.facts().some(event => event.type === 'user/message'), false, 'accepting a candidate is fill-only')
      scene.assert.equal(scene.app.isBusy, false)
      scene.assert.deepEqual(await scene.backend.listFileReferences('ignored-native'), [], 'native provider exclusions remain authoritative')
    }, {}, { screen, timeout: 30_000, prepare: prepareWorkspace })
  })
}

test('a user-disabled native file-reference row stays unavailable without a Pi/local fallback', async () => {
  await runNativeScene(async (scene: NativeScene, _params: JsonRecord) => {
    const sessionId = String(scene.app.session?.sessionId)
    const agents = scene.object(scene.ctx.get('agents'))
    const get = agents.get as (id: string) => unknown
    scene.assert.equal(scene.app.session?.capabilities.includes('file-references'), false)
    scene.assert.equal(scene.ctx.get('fileReferences'), undefined)

    scene.terminal.type('@reference-t')
    await scene.delay(120); await scene.paint()
    scene.assert.equal(scene.app.editor.isShowingAutocomplete(), false)
    scene.assert.equal(scene.app.editor.getText(), '@reference-t')
    scene.assert.equal(get.call(agents, sessionId), undefined, 'an unavailable candidate domain never materializes the Agent')
    scene.assert.equal(scene.facts().some(event => event.type === 'user/message'), false)
  }, {}, {
    screen: 'fullscreen', timeout: 30_000, prepare: prepareWorkspace,
    extraPatch: [{ id: 'file-reference-local', disabled: true }],
  })
})
