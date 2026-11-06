import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'
import { nativeProfileFixture } from './helpers/native-profile.ts'
import { VERSION } from '../src/version.ts'

for (const flag of ['--help', '--version']) {
  test(`native DSH profile ${flag} returns without claiming a terminal or creating a session`, { timeout: 35_000 }, async () => {
    const fixture = await nativeProfileFixture()
    try {
      const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
        // DSH owns --version before the app-argument boundary; -- forwards the app's version flag.
        execFile(process.execPath, fixture.args(flag === '--version' ? ['--', flag] : [flag]), { cwd: fixture.cwd, env: fixture.env, timeout: 30_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
      })
      assert.equal(result.error, null, result.stderr)
      assert.ok(flag === '--help' ? result.stdout.includes('CC-style terminal application plugin') : result.stdout.trim() === VERSION)
      assert.equal(result.stdout.includes('\x1b[?2004h'), false)
      assert.equal(result.stdout.includes('\x1b[?1049h'), false)
    } finally { await fixture.cleanup() }
  })
}

test('native profile rejects non-interactive startup before claiming the terminal', { timeout: 35_000 }, async () => {
  const fixture = await nativeProfileFixture()
  try {
    const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, fixture.args(), { cwd: fixture.cwd, env: fixture.env, timeout: 30_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    })
    assert.notEqual(result.error, null)
    assert.match(result.stderr, /interactive terminal/)
    assert.equal(result.stdout.includes('\x1b[?2004h'), false)
  } finally { await fixture.cleanup() }
})

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native same-process App: lazy connect, real stream and native settlement (${screen})`, { timeout: 40_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, terminal, events, ctx, until, facts, userText, paint } = scene
      assert.ok(app.session)
      const registry = ctx.get('agents') as { list(): unknown[] }
      assert.equal(registry.list().length, 0, 'opening the UI must not create an Agent')
      const models = await backend.command('models') as { provider: string; model: string }[]
      assert.ok(models.some(model => model.provider === 'deepseek-official' && model.model === 'deepseek-v4-flash'))
      await app.submit('fixture:normal-native-plugin')
      await until(() => events.some(event => event.type === 'stream_end' && event.outcome === 'committed'), 'native stream settles', 10_000)
      assert.equal(registry.list().length, 1)
      assert.ok(facts().some(event => event.type === 'user/message' && userText(event).includes('fixture:normal-native-plugin')))
      assert.ok(facts().some(event => event.type === 'assistant/message'))
      await paint()
      assert.ok(terminal.screen().includes('fixture-live') || terminal.document().includes('fixture-live'))
      assert.equal(terminal.screen().includes('Could not start DSH'), false)
    }, {}, { screen })
  })
}
