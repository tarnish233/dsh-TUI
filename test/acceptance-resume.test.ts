import test from 'node:test'
import type { JsonRecord } from '../src/backend/types.ts'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

/** Public service boundary, patched only inside a disposable native test root. */
interface NativeRegistry {
  get(sessionId: string): unknown
  list(): unknown[]
  resume(options: JsonRecord): Promise<unknown>
}

// DSH owns one Agent/writer per session. Resolving an already-current id must
// reuse it; demanding a parallel same-id candidate and the same old Agent after
// candidate setup contradicts that native ownership contract. Actual resume
// and setup faults are therefore injected while switching to a distinct id.
for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native resume of the current staged/live session is idempotent (${screen})`, { timeout: 50_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const { app, backend, ctx, events, object, until, facts, terminal, paint } = scene
      const staged = app.session
      scene.assert.ok(staged)
      const registry = ctx.get('agents') as NativeRegistry
      const resume = registry.resume
      let calls = 0
      registry.resume = async () => { calls++; throw new Error('synthetic persistent native resume fault') }
      try {
        const pending = object(await backend.command('resume', { sessionId: staged.sessionId }))
        scene.assert.equal(pending.attachmentId, staged.attachmentId)
        scene.assert.equal(registry.list().length, 0, 'an unmaterialized current id is not resumed or created')
        await app.submit('fixture:normal-before-current-resume')
        await until(() => events.some(event => event.type === 'stream_end' && event.outcome === 'committed') && !app.isBusy, 'initial native turn settles', 15_000)
        const before = app.session
        scene.assert.ok(before)
        const original = registry.get(before.sessionId)
        scene.assert.ok(original)
        terminal.type('current resume retained draft')
        await paint()
        const snapshot = app.editor.captureDraft()
        const offset = events.length
        for (let index = 0; index < 3; index++) {
          const resolved = object(await backend.command('resume', { sessionId: before.sessionId }))
          scene.assert.equal(resolved.sessionId, before.sessionId)
          scene.assert.equal(resolved.attachmentId, before.attachmentId)
          const history = Array.isArray(resolved.events) ? resolved.events : []
          scene.assert.ok(history.some(event => object(event).type === 'assistant/message'), 'history still comes from the native durable query')
        }
        scene.assert.equal(calls, 0, 'current-id resolution never relinquishes native single-writer ownership')
        scene.assert.equal(registry.get(before.sessionId), original)
        scene.assert.equal(registry.list().length, 1)
        scene.assert.deepEqual(app.editor.captureDraft(), snapshot)
        scene.assert.equal(events.slice(offset).some(event => event.type === 'stream_end' || event.type === 'closed'), false)
        const sending = events.length
        await app.submit('fixture:normal-after-current-resume')
        await until(() => events.slice(sending).some(event => event.type === 'stream_end' && event.outcome === 'committed') && !app.isBusy, 'the unchanged native attachment accepts another turn', 15_000)
        scene.assert.ok(facts(events.slice(sending)).some(event => event.type === 'assistant/message'))
        scene.assert.equal(app.session?.sessionId, before.sessionId)
      } finally { registry.resume = resume }
    }, {}, { screen, timeout: 40_000 })
  })

  test(`native current-id resume does not interrupt a live stream or either inbox lane (${screen})`, { timeout: 50_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const { app, backend, ctx, events, object, until, facts } = scene
      await backend.send('fixture:slow')
      await until(() => events.filter(event => event.type === 'stream_chunk').length >= 3 && app.isBusy, 'native partial stream is visible', 15_000)
      const before = app.session
      scene.assert.ok(before)
      const registry = ctx.get('agents') as NativeRegistry
      const original = registry.get(before.sessionId)
      const resume = registry.resume
      let calls = 0
      registry.resume = async () => { calls++; throw new Error('synthetic persistent native resume fault') }
      try {
        await backend.send('fixture:normal-queued-before-current-resume')
        await backend.send('fixture:normal-steering-before-current-resume', 'steer')
        const state = object(await backend.command('state'))
        scene.assert.deepEqual(object(state.pending), { nextTurn: 1, nextStep: 1 })
        const offset = events.length
        const resolved = object(await backend.command('resume', { sessionId: before.sessionId }))
        scene.assert.equal(resolved.attachmentId, before.attachmentId)
        scene.assert.equal(calls, 0)
        scene.assert.equal(registry.get(before.sessionId), original)
        const after = object(await backend.command('state'))
        scene.assert.deepEqual(object(after.pending), { nextTurn: 1, nextStep: 1 })
        scene.assert.equal(after.status, 'running')
        scene.assert.equal(events.slice(offset).some(event => event.type === 'stream_end' && event.outcome === 'abandoned'), false)
        scene.assert.equal(facts(events.slice(offset)).some(event => event.type === 'turn/end'), false)
      } finally { registry.resume = resume }
      await backend.cancel()
      await until(() => !app.isBusy, 'explicit cancellation settles the held native turn', 15_000)
      scene.assert.deepEqual(object(object(await backend.command('state')).pending), { nextTurn: 1, nextStep: 1 }, 'only the explicit cancel ran; it retains native inboxes')
    }, {}, { screen, timeout: 40_000 })
  })

  test(`native current-id resume keeps a pending approval open (${screen})`, { timeout: 50_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const { app, backend, ctx, events, until, facts, object, terminal } = scene
      await app.submit('fixture:approval')
      await until(() => events.some(event => event.type === 'decision' && event.request.kind === 'approval'), 'native approval is pending', 15_000)
      const before = app.session
      scene.assert.ok(before)
      const decision = events.findLast(event => event.type === 'decision' && event.request.kind === 'approval')
      scene.assert.ok(decision?.type === 'decision')
      const registry = ctx.get('agents') as NativeRegistry
      const original = registry.get(before.sessionId)
      const resume = registry.resume
      let calls = 0
      registry.resume = async () => { calls++; throw new Error('synthetic persistent native resume fault') }
      try {
        const resolved = object(await backend.command('resume', { sessionId: before.sessionId }))
        scene.assert.equal(resolved.attachmentId, before.attachmentId)
        scene.assert.equal(registry.get(before.sessionId), original)
        scene.assert.equal(calls, 0)
        scene.assert.equal(events.some(event => event.type === 'decision_closed' && event.id === decision.request.id), false, 'the approval is neither rejected nor aborted by repeated resume')
        scene.assert.equal(events.some(event => event.type === 'stream_end'), false)
      } finally { registry.resume = resume }
      terminal.type('\x1b')
      await until(() => events.some(event => event.type === 'stream_end' && event.outcome === 'committed') && !app.isBusy, 'explicit approval rejection settles normally', 15_000)
      scene.assert.ok(events.some(event => event.type === 'decision_closed' && event.id === decision.request.id))
      scene.assert.equal(facts(events).some(event => event.type === 'turn/end' && object(object(event.data).reason).kind === 'aborted'), false)
    }, {}, { screen, timeout: 40_000 })
  })

  for (const failureAt of ['resume', 'setup'] as const) {
    test(`native different-id ${failureAt} failure preserves the current attachment (${screen})`, { timeout: 60_000 }, async () => {
      await runNativeScene(async (scene: NativeScene, params) => {
        const { app, backend, ctx, events, object, until, facts, terminal, paint } = scene
        const settle = async (offset: number) => {
          await until(() => events.slice(offset).some(event => event.type === 'stream_end' && event.outcome === 'committed') && !app.isBusy, 'native turn settles', 15_000)
        }
        let offset = events.length
        await app.submit('fixture:normal-original-session')
        await settle(offset)
        const originalId = app.session?.sessionId
        scene.assert.ok(originalId)
        await backend.command('new')
        offset = events.length
        await app.submit('fixture:normal-target-session')
        await settle(offset)
        const targetId = app.session?.sessionId
        scene.assert.ok(targetId && targetId !== originalId)
        await backend.command('resume', { sessionId: originalId })
        const before = app.session
        scene.assert.ok(before)
        scene.assert.equal(before.sessionId, originalId)
        const registry = ctx.get('agents') as NativeRegistry
        const original = registry.get(originalId)
        scene.assert.ok(original)
        scene.assert.equal(registry.list().length, 1)
        terminal.type('failed native switch retained draft')
        await paint()
        const snapshot = app.editor.captureDraft()
        const resume = registry.resume
        let reached = false
        registry.resume = async options => {
          if (options.resumeSessionId !== targetId) return await resume.call(registry, options)
          if (params.failureAt === 'resume') {
            reached = true
            throw new Error('synthetic native resume failure api_key=TEST_ONLY_RESUME_KEY')
          }
          const setup = options.setup
          return await resume.call(registry, {
            ...options,
            setup: async (...args: unknown[]) => {
              if (typeof setup === 'function') await setup(...args)
              reached = true
              throw new Error('synthetic native setup failure api_key=TEST_ONLY_SETUP_KEY')
            },
          })
        }
        let failure: unknown
        try {
          try { await backend.command('resume', { sessionId: targetId }) }
          catch (error: unknown) { failure = error }
        } finally { registry.resume = resume }
        scene.assert.ok(reached, 'the actual native failure boundary was exercised')
        scene.assert.ok(failure)
        scene.assert.equal(object(failure).code, 'RUNTIME_REQUEST_FAILED')
        const message = String(object(failure).message)
        scene.assert.match(message, /\[redacted\]/)
        scene.assert.doesNotMatch(message, /TEST_ONLY_RESUME_KEY|TEST_ONLY_SETUP_KEY/)
        scene.assert.equal(object(await backend.command('state')).sessionId, originalId)
        scene.assert.equal(registry.get(originalId), original)
        scene.assert.equal(registry.list().length, 1, 'the failed candidate was cleaned up by DSH')
        scene.assert.equal(app.session?.attachmentId, before.attachmentId)
        scene.assert.deepEqual(app.editor.captureDraft(), snapshot)
        offset = events.length
        await app.submit('fixture:normal-after-failed-native-switch')
        await settle(offset)
        scene.assert.ok(facts(events.slice(offset)).some(event => event.type === 'assistant/message'))
        const recovered = object(await backend.command('resume', { sessionId: targetId }))
        scene.assert.equal(recovered.sessionId, targetId, 'a failed candidate did not retain the native writer claim')
        scene.assert.notEqual(recovered.attachmentId, before.attachmentId)
        scene.assert.equal(registry.list().length, 1)
      }, { failureAt }, { screen, timeout: 50_000 })
    })
  }
}
