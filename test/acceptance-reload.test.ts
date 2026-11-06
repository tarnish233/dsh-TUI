import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

test('native HMR recomposes configuration through DSH without a scratch mirror', { timeout: 45_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-native-reload-source-'))
  const plugin = join(temporary, 'version.mjs')
  await writeFile(plugin, `export const name='parent-native-version';\nexport const inject=['commands'];\nexport function apply(ctx,config){ctx.effect(()=>ctx.commands.register({definitionId:'parent/native-version',name:'fixture-version',description:'Native HMR fixture',handler:()=>({kind:'success',text:String(config.version)})}),'native-version')}\n`)
  try {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { backend, home, object, events, facts, until } = scene
      const first = object(await backend.command('execute', { line: '/fixture-version' }))
      assert.equal(object(first.result).text, '1')
      const { readFile, writeFile } = await import('node:fs/promises')
      const path = home + '/profiles/dsh-tui/cordis.patch.yml'
      const rows = JSON.parse(await readFile(path, 'utf8')) as { insert?: { id: string; config?: { version: number } }[] }[]
      const row = rows.flatMap(value => value.insert ?? []).find(value => value.id === 'native-version')!
      row.config = { version: 2 }
      await writeFile(path, JSON.stringify(rows))
      const result = object(await backend.command('reload'))
      assert.equal(result.available, true)
      const second = object(await backend.command('execute', { line: '/fixture-version' }))
      assert.equal(object(second.result).text, '2')
      assert.equal(events.some(event => event.type === 'stream_start'), false)
      await until(() => facts().filter(event => event.type === 'command/done').length >= 2, 'native commands settle')
    }, {}, { extraPatch: [{ insert: [{ id: 'native-version', name: pathToFileURL(plugin).href, config: { version: 1 } }] }] })
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
