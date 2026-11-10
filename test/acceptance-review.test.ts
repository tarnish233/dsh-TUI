import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeScene } from './helpers/native-scenario.ts'
import { runNativeScene } from './helpers/native-scenario.ts'

// Parent-owned, independent end-to-end review acceptance. The App, the adapter
// and these assertions run inside one real DSH process; the public native
// stream fixture intercepts llm/stream and never calls next(), so no request
// reaches a remote provider and no credential is used.
const TIMEOUT = 90_000

test('parent native acceptance: invalid resume leaves the old attachment usable', { timeout: TIMEOUT }, async () => {
  await runNativeScene(async (scene: NativeScene) => {
    const { app, backend, events, object, until, facts } = scene
    const idle = async (offset = 0) => {
      await until(() => events.slice(offset).some(event => event.type === 'status' && event.status === 'idle') && !app.isBusy, 'native turn reaches idle', 15_000)
    }
    scene.assert.ok(app.session)
    scene.assert.notEqual(app.session.provider, 'demo (offline)')
    // DSH owns the Agent lifecycle and creates one lazily on real input, so a
    // live attachment is established before the failed resume is attempted.
    await app.submit('fixture:normal-before-invalid-resume')
    await idle()
    const session = app.session
    scene.assert.ok(session)
    await scene.assert.rejects(backend.command('resume', { sessionId: 'parent-deliberately-missing-session' }))
    const state = object(await backend.command('state'))
    scene.assert.equal(state.sessionId, session.sessionId)
    scene.assert.equal(app.session?.sessionId, session.sessionId)
    scene.assert.equal(app.session?.attachmentId, session.attachmentId)
    scene.assert.equal(events.some(event => event.type === 'closed'), false)
    const offset = events.length
    await app.submit('fixture:normal-after-invalid-resume')
    await idle(offset)
    scene.assert.ok(facts(events.slice(offset)).some(event => event.type === 'assistant/message'))
  })
})

test('parent native acceptance: both inbox lanes survive cancellation, remain parked, then wake in FIFO order', { timeout: TIMEOUT }, async () => {
  await runNativeScene(async (scene: NativeScene) => {
    const { app, backend, events, object, until, delay, facts, userText } = scene
    const idle = async (offset = 0) => {
      await until(() => events.slice(offset).some(event => event.type === 'status' && event.status === 'idle') && !app.isBusy, 'native turn reaches idle', 15_000)
    }
    const pending = async () => object(object(await backend.command('state')).pending)
    scene.assert.ok(app.session)
    await backend.send('fixture:slow')
    await until(() => events.filter(event => event.type === 'stream_chunk').length >= 3, 'real partial live stream', 15_000)
    await backend.send('fixture:normal-old-followup')
    await backend.send('fixture:normal-old-steering', 'steer')
    scene.assert.deepEqual(await pending(), { nextTurn: 1, nextStep: 1 })
    const offset = events.length
    await backend.cancel()
    await idle(offset)
    scene.assert.deepEqual(await pending(), { nextTurn: 1, nextStep: 1 })
    const turns = facts(events).filter(event => event.type === 'turn/start').length
    await delay(150)
    scene.assert.equal(facts(events).filter(event => event.type === 'turn/start').length, turns, 'preserving inbox must not invent an automatic wake')
    scene.assert.ok(facts(events.slice(offset)).some(event => event.type === 'turn/end' && object(object(event.data).reason).kind === 'aborted'))
    scene.assert.ok(facts(events.slice(offset)).some(event => event.type === 'assistant/message' && object(event.data).interrupted === true), 'the partial reply is a durable interrupted message')
    scene.assert.equal(facts(events.slice(offset)).some(event => event.type === 'agent/inbox/spliced' && object(event.data).outcome === 'canceled'), false)
    const resumed = events.length
    await backend.send('fixture:normal-new-wake')
    await until(() => facts(events.slice(resumed)).some(event => event.type === 'user/message' && userText(event).includes('fixture:normal-new-wake')), 'native driver consumes the new waking input', 15_000)
    await idle(resumed)
    const messages = facts(events.slice(resumed)).filter(event => event.type === 'user/message').map(userText)
    const oldIndex = messages.findIndex(text => text.includes('fixture:normal-old-followup'))
    const newIndex = messages.findIndex(text => text.includes('fixture:normal-new-wake'))
    scene.assert.ok(oldIndex >= 0 && newIndex > oldIndex, JSON.stringify(messages))
    scene.assert.deepEqual(await pending(), { nextTurn: 0, nextStep: 0 })
  })
})

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`parent native acceptance (${screen}): approval Esc rejects only the tool`, { timeout: TIMEOUT }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const { app, events, terminal, object, until, facts } = scene
      const idle = async (offset = 0) => {
        await until(() => events.slice(offset).some(event => event.type === 'status' && event.status === 'idle') && !app.isBusy, 'native turn reaches idle', 15_000)
      }
      scene.assert.ok(app.session)
      await app.submit('fixture:approval')
      await until(() => app.pendingDecisionCount === 1, 'native approval appears', 15_000)
      const offset = events.length
      terminal.type('\x1b')
      await idle(offset)
      scene.assert.equal(app.pendingDecisionCount, 0)
      scene.assert.equal(facts(events.slice(offset)).some(event => event.type === 'turn/end' && object(object(event.data).reason).kind === 'aborted'), false, 'approval rejection is not a whole-turn abort')
      scene.assert.ok(JSON.stringify(facts(events.slice(offset))).includes('approval-rejected'))
    }, {}, { screen })
  })

  test(`parent native acceptance (${screen}): Pi approval Ctrl+C rejects locally and preserves draft`, { timeout: TIMEOUT }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const { app, events, terminal, object, until, facts } = scene
      const idle = async (offset = 0) => {
        await until(() => events.slice(offset).some(event => event.type === 'status' && event.status === 'idle') && !app.isBusy, 'native turn reaches idle', 15_000)
      }
      scene.assert.ok(app.session)
      const draft = 'unsubmitted busy draft\n' + '中文 paste draft '.repeat(100)
      terminal.type('\x1b[200~' + draft + '\x1b[201~')
      const before = app.editor.captureDraft()
      await app.submit('fixture:approval')
      await until(() => app.pendingDecisionCount === 1, 'native approval appears', 15_000)
      const offset = events.length
      terminal.type('\x03')
      await idle(offset)
      scene.assert.equal(facts(events.slice(offset)).some(event => event.type === 'turn/end' && object(object(event.data).reason).kind === 'aborted'), false, 'focused approval Ctrl+C does not abort the native turn')
      scene.assert.match(JSON.stringify(facts(events.slice(offset))), /approval-rejected/)
      scene.assert.equal(app.pendingDecisionCount, 0)
      scene.assert.equal(app.editor.getExpandedText(), before.expandedText)
      scene.assert.deepEqual(app.editor.captureDraft().pastes, before.pastes)
      scene.assert.equal(events.some(event => event.type === 'closed'), false)
    }, {}, { screen })
  })
}

test('parent native acceptance: question Esc cancels only that ask (ASK_CANCELLED) and the turn continues', { timeout: TIMEOUT }, async () => {
  await runNativeScene(async (scene: NativeScene) => {
    const { app, events, terminal, object, until, delay, paint, facts } = scene
    const idle = async (offset = 0) => {
      await until(() => events.slice(offset).some(event => event.type === 'status' && event.status === 'idle') && !app.isBusy, 'native turn reaches idle', 15_000)
    }
    scene.assert.ok(app.session)
    await app.submit('fixture:question')
    await until(() => app.pendingDecisionCount === 1, 'native question appears', 15_000)
    // A single-question digit is immediate submit by design. Enter an
    // unconfirmed custom draft instead: Esc must cancel, never answer it.
    terminal.type('\x0e'); terminal.type('\x0e')
    terminal.type('pending custom answer draft')
    await delay(40); await paint()
    scene.assert.doesNotMatch(terminal.screen(), /\/questions/, 'the removed reopen command is never advertised')
    const offset = events.length
    terminal.type('\x1b')
    await idle(offset)
    scene.assert.equal(app.pendingDecisionCount, 0, 'the cancelled question leaves nothing pending')
    const closed = facts(events.slice(offset))
    const result = closed.find(event => event.type === 'tool/result')
    scene.assert.deepEqual(object(object(result?.data).error), { name: 'UserQuestionError', code: 'ASK_CANCELLED' },
      'the human cancel reaches DSH as its own code, not the turn-abort one')
    scene.assert.equal(closed.some(event => event.type === 'turn/end' && object(object(event.data).reason).kind === 'aborted'), false, 'cancelling one question is not a whole-turn abort')
    scene.assert.ok(closed.some(event => event.type === 'turn/end' && object(object(event.data).reason).kind === 'completed'),
      'the native turn completes after the cancelled ask')
    scene.assert.match(JSON.stringify(closed), /question-complete/, 'the loop fed the cancellation back to the model')
    scene.assert.equal(JSON.stringify(closed).includes('pending custom answer draft'), false, 'the dismissed draft is never sent as an answer')
    scene.assert.equal(events.some(event => event.type === 'closed'), false)
  })
})

test('parent native acceptance: Pi question Ctrl+C cancels only that ask (ASK_CANCELLED)', { timeout: TIMEOUT }, async () => {
  await runNativeScene(async (scene: NativeScene) => {
    const { app, events, terminal, object, until, facts } = scene
    const idle = async (offset = 0) => {
      await until(() => events.slice(offset).some(event => event.type === 'status' && event.status === 'idle') && !app.isBusy, 'native turn reaches idle', 15_000)
    }
    scene.assert.ok(app.session)
    await app.submit('fixture:question')
    await until(() => app.pendingDecisionCount === 1, 'native question appears', 15_000)
    const offset = events.length
    terminal.type('\x03')
    await idle(offset)
    scene.assert.equal(app.pendingDecisionCount, 0)
    scene.assert.equal(facts(events.slice(offset)).some(event => event.type === 'turn/end' && object(object(event.data).reason).kind === 'aborted'), false, 'focused question Ctrl+C is local to the native request')
    scene.assert.match(JSON.stringify(facts(events.slice(offset))), /ASK_CANCELLED/)
    scene.assert.match(JSON.stringify(facts(events.slice(offset))), /question-complete/)
    scene.assert.equal(events.some(event => event.type === 'closed'), false)
  })
})