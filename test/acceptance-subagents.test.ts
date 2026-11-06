import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeScene } from './helpers/native-scenario.ts'
import type { JsonRecord } from '../src/backend/types.ts'
import { runNativeScene } from './helpers/native-scenario.ts'

const streamFixture = new URL('./fixtures/subagent-stream.mjs', import.meta.url).href

// Independent parent-owned acceptance through real DSH Agents, native catalogs,
// child persistence and approval ownership. No provider/network calls occur.
for (const screen of ['inline', 'fullscreen'] as const) {
  test(`real native parallel subagents, child approval, continuation and read-only session (${screen})`, { timeout: 90_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const { app, terminal, cwd, until, paint } = scene
      const { writeFile } = await import('node:fs/promises')
      await writeFile(`${cwd}/native-output.txt`, 'native child read fixture\n', 'utf8')

      await app.submit('fixture:subagents')
      try {
        await until(() => app.pendingDecisionCount > 0, 'native child approval arrives', 20_000)
      } catch (error) {
        const notices = app.store.items.map(item => ({ kind: item.kind, text: 'text' in item ? item.text : undefined }))
        const eventTypes = scene.events.map(event => event.type === 'session_event' ? `${event.sessionId}:${event.event.type}` : event.type === 'warning' ? `warning:${event.message}` : event.type)
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nITEMS:${JSON.stringify(notices)}\nSUBAGENTS:${JSON.stringify(app.store.subagentEntries)}\nEVENTS:${JSON.stringify(eventTypes.slice(-120))}\nSCREEN:${terminal.screen()}`)
      }
      await paint()
      scene.assert.match(terminal.screen(), /Child approval › Approve fixture-child-gate/, 'child decision carries native provenance')

      terminal.type('\r')
      await until(() => app.pendingDecisionCount === 0 && app.store.subagentEntries.length === 2, 'native child approval settles and catalog is ready', 20_000)
      const direct = app.store.subagentEntries
      scene.assert.deepEqual(direct.map(entry => entry.label), ['Child complete', 'Child approval'])
      scene.assert.ok(direct.every(entry => entry.catalogSeq !== undefined))
      scene.assert.equal(app.store.items.filter(item => item.kind === 'subagent').length, 2)

      // Open the approved child before its delayed final chunk. This proves
      // follow + buffered snapshot + live stream routing, not only cold replay.
      terminal.type('\x18'); terminal.type('\x01')
      await until(() => terminal.screen().includes('Agents') && terminal.screen().includes('Child complete'), 'native Agents overlay')
      terminal.type('\x1b[B')
      terminal.type('\r')
      await until(() => terminal.screen().includes('child approval completed'), 'approved child live transcript')
      scene.assert.ok(scene.events.some(event => event.type === 'stream_chunk' && event.sessionId === direct[1]!.id), 'followed child stream chunks use the child session id')
      scene.assert.equal(app.store.items.some(item => (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'attempt') && JSON.stringify(item).includes('child approval completed')), false)
      const childRead = scene.object(await scene.backend.command('subagent-session', { sessionId: direct[1]!.id }))
      const childEvents = Array.isArray(childRead.events) ? childRead.events : []
      scene.assert.ok(childEvents.some(event => scene.object(event).type === 'tool/call' && scene.object(scene.object(event).data).name === 'read'), 'the native child read path includes its tool fact')

      terminal.type('\x1b')
      await until(() => terminal.screen().includes('Agents'), 'return to native Agents')
      terminal.type('\x1b[A')
      terminal.type('\r')
      await until(() => terminal.screen().includes('native child completed'), 'first cold child transcript')
      scene.assert.equal(app.store.items.some(item => (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'attempt') && JSON.stringify(item).includes('native child completed')), false, 'child stream creates no independent root user/assistant/attempt item; native settlement remains allowed')
      await until(() => app.store.subagentEntries.every(entry => entry.status === 'idle' && entry.lastStopReason === 'completed') && !app.isBusy, 'both native children and parent settle', 30_000)
      scene.assert.ok(app.store.items.some(item => item.kind === 'subagent-message'), 'durable child settlement is visible in the root transcript')

      terminal.type('\x1b')
      await until(() => terminal.screen().includes('Agents'), 'second return to Agents')
      terminal.type('\x1b')
      await paint()
      scene.assert.equal(app.store.subagentEntries.length, 2)

      // Continue the first durable child through the single root Editor. The
      // native receipt is acceptance only; the next activation and transcript
      // must come from DSH rather than an optimistic root/child projection.
      const previousRunId = direct[0]!.lastRunId
      terminal.type('\x18'); terminal.type('\x01')
      await until(() => terminal.screen().includes('Agents'), 'Agents before native reply')
      terminal.type('r')
      try {
        await until(() => app.replyTargetSessionId === direct[0]!.id, 'main Editor targets the continuable child')
      } catch (error) {
        const native = scene.object(scene.ctx.get('subagents'))
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nCAPABILITIES:${JSON.stringify(app.session?.capabilities)}\nNATIVE:${JSON.stringify({ interrupt: typeof native.interrupt, prompt: typeof native.prompt })}\nENTRIES:${JSON.stringify(app.store.subagentEntries)}\nSCREEN:${terminal.screen()}`)
      }
      await paint()
      scene.assert.match(terminal.screen(), /Replying to Child complete/)
      terminal.type('fixture:child-followup')
      terminal.type('\r')
      await until(() => {
        const current = app.store.subagentEntry(direct[0]!.id)
        return current?.lastRunId !== undefined && current.lastRunId !== previousRunId &&
          current.status === 'idle' && current.lastStopReason === 'completed'
      }, 'native continuation activation settles', 30_000)
      scene.assert.equal(app.replyTargetSessionId, direct[0]!.id, 'accepted reply keeps the explicit target')
      scene.assert.equal(app.editor.getExpandedText(), '', 'accepted native prompt consumes the draft')
      scene.assert.equal(app.store.items.some(item => (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'attempt') && JSON.stringify(item).includes('fixture:child-followup')), false, 'child reply creates no root prompt/response')

      terminal.type('\x18'); terminal.type('\x01')
      await until(() => terminal.screen().includes('Agents'), 'Agents after native reply')
      terminal.type('\r')
      await until(() => terminal.screen().includes('native child followup completed'), 'continued child durable/live transcript', 20_000)
      const continued = scene.object(await scene.backend.command('subagent-session', { sessionId: direct[0]!.id }))
      const continuedEvents = Array.isArray(continued.events) ? continued.events : []
      scene.assert.ok(continuedEvents.some(event => scene.object(event).type === 'user/message' && scene.userText(event).includes('fixture:child-followup')), 'native prompt receipt is backed by the exact child durable user fact')
      terminal.type('\x1b')
      await until(() => terminal.screen().includes('Agents'), 'return from continued child')
      terminal.type('\x1b')
      await paint()
      terminal.type('\x1b')
      await until(() => app.replyTargetSessionId === undefined, 'Esc returns the main Editor to the root')
    }, {}, { screen, streamFixture, timeout: 75_000 })
  })

  test(`real native running child interrupt (${screen})`, { timeout: 90_000 }, async () => {
    await runNativeScene(async (scene: NativeScene, params: JsonRecord) => {
      const { app, terminal, until, paint } = scene
      await app.submit('fixture:subagent-stop')
      await until(() => app.store.subagentEntries.length === 1 && app.store.subagentEntries[0]!.status === 'running', 'long-running native child', 20_000)
      const child = app.store.subagentEntries[0]!
      terminal.type('\x18'); terminal.type('\x01')
      await until(() => terminal.screen().includes('Agents'), 'Agents before native interrupt')
      terminal.type(params.screen === 'inline' ? 's' : '\x03')
      try {
        await until(() => app.store.subagentEntry(child.id)?.lastStopReason === 'aborted' && app.store.subagentEntry(child.id)?.status === 'stopped', 'native interrupt lifecycle settles', 20_000)
      } catch (error) {
        const native = scene.object(scene.ctx.get('subagents'))
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nNATIVE:${JSON.stringify({ interrupt: typeof native.interrupt, prompt: typeof native.prompt })}\nNOTICES:${JSON.stringify(app.store.items.filter(item => item.kind === 'notice'))}\nENTRY:${JSON.stringify(app.store.subagentEntry(child.id))}\nSCREEN:${terminal.screen()}`)
      }
      await until(() => !app.isBusy, 'parent settles after child interrupt', 20_000)
      scene.assert.equal(app.replyTargetSessionId, undefined)
      const childRead = scene.object(await scene.backend.command('subagent-session', { sessionId: child.id }))
      scene.assert.ok(!JSON.stringify(childRead.events).includes('native child should have been interrupted'), 'aborted child never commits its delayed answer')
      await paint()
      scene.assert.match(terminal.screen(), /stopped/)
    }, { screen }, { screen, streamFixture, timeout: 75_000 })
  })
}
