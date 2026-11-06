import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { NativeScene } from './helpers/native-scenario.ts'
import { runNativeScene } from './helpers/native-scenario.ts'

// Parent-owned, independent end-to-end Help acceptance. The App, the adapter
// and these assertions share one real DSH process (no IPC backend, no spawned
// bridge). A temporary home mounts the native command registry plus one custom
// plugin command, and the hermetic llm/stream fixture never reaches a provider.
for (const screen of ['inline', 'fullscreen'] as const) {
  test(`parent native Help acceptance (${screen}): effective custom descriptors are displayed but no command/model is executed`, { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-native-help-'))
    const marker = join(directory, 'unexpected-help-execution')
    const plugin = join(directory, 'help-command.mjs')
    await writeFile(plugin, `import { writeFileSync } from 'node:fs'
export const name = 'parent-help-command'
export const inject = ['commands']
export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    definitionId: 'parent-fixture/help-native-custom',
    name: 'help-native-custom',
    description: 'Custom registration from the real native registry',
    input: { hint: '<native-argument>' },
    handler: () => {
      writeFileSync(${JSON.stringify(marker)}, 'unexpected execution')
      return { kind: 'success', text: 'This must never execute from Help.' }
    },
  }), 'parent readonly help fixture')
}
`)
    try {
      await runNativeScene(async (scene: NativeScene) => {
        const { app, backend, terminal, events, object, until, paint } = scene
        // The shared native terminal is smaller than this viewport-sensitive
        // acceptance needs; the App owns its own re-layout on resize.
        terminal.resize(130, 54)
        await paint()
        scene.assert.ok(app.session)
        scene.assert.ok(app.session.attachmentId)
        const catalog = await backend.command('commands')
        scene.assert.ok(Array.isArray(catalog))
        const custom = catalog.map(object).find(command => command.name === 'help-native-custom')
        scene.assert.equal(custom?.definitionId, 'parent-fixture/help-native-custom')
        scene.assert.equal(object(custom?.input).hint, '<native-argument>')
        const permission = catalog.map(object).find(command => command.name === 'permission')
        scene.assert.equal(permission?.definitionId, '@deepseek-ai/dsh-permission-presets')
        const state = object(await backend.command('state'))
        const attachment = app.session.attachmentId
        scene.assert.equal(typeof attachment, 'string')
        const before = [...app.store.items]
        await app.submit('/help')
        await paint()
        const view = terminal.screen()
        scene.assert.match(view, /Commands.*Custom commands/)
        scene.assert.match(view, /\/help-native-custom/)
        scene.assert.match(view, /<native-argument>/)
        scene.assert.match(view, /\/permission/)
        scene.assert.doesNotMatch(view, /Enter choose|Enter to select|This must never execute/)
        for (const key of ['\r', '1', '9', '\t', '\x1b[Z']) terminal.type(key)
        await paint()
        scene.assert.equal(app.editor.focused, false, 'inert keys leave the display panel open')
        scene.assert.deepEqual(app.store.items, before)
        scene.assert.deepEqual(object(object(await backend.command('state')).pending), object(state.pending))
        scene.assert.equal(app.session.attachmentId, attachment)
        scene.assert.equal(events.some(event => event.type === 'stream_start'), false)
        scene.assert.equal(events.some(event => event.type === 'session_event' && ['command/run', 'command/done', 'turn/start'].includes(event.event.type)), false, 'Help uses only read-only native discovery')
        terminal.type('\x1b')
        await paint()
        await until(() => app.editor.focused, 'Esc closes the display-only panel', 5_000)
        scene.assert.deepEqual(app.store.items, before)
      }, {}, {
        screen,
        extraPatch: [{ insert: [{ id: 'parent-help-custom-command', name: pathToFileURL(plugin).href }] }],
      })
      await assert.rejects(access(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT', 'the displayed custom command is never executed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}