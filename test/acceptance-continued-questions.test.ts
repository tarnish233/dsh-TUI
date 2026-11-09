import test from 'node:test'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native continued question replay uses the real projection/inbox/answer service (${screen})`, { timeout: 65_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, ctx, object, events, until, paint, terminal } = scene
      await app.submit('native question replay baseline')
      await until(() => events.some(event => event.type === 'session_event' && event.event.type === 'turn/end') && !app.isBusy, 'baseline settles', 10_000)
      const sessions = object(ctx.get('sessions'))
      const session = object((sessions.get as (id: string) => unknown).call(sessions, app.session!.sessionId))
      const header = object((session.requestHeader as () => unknown).call(session))
      const append = (session.append as (type: string, data: unknown, surface?: { surfaceOp: 'append' }) => unknown).bind(session)
      // Synthetic durable timed facts through the REAL native Session/projection;
      // the default tool remains legacy and no timed wait/controller is invented.
      append('request/header', { header: { ...header, tools: [{ name: 'ask_user_question',
        parameters: { type: 'object', properties: { timeout: { type: 'integer' }, questions: { type: 'array' } } } }] }, reason: 'initial' })
      const callId = 'native-continued-fixture'
      const questions = [
        { id: 'choice', question: 'Native continued choice', options: [{ label: 'Keep' }, { label: 'Switch' }] },
        { id: 'note', question: 'Native continued freeform note' },
      ]
      append('tool/call', { name: 'ask_user_question', callId, arguments: JSON.stringify({ questions }) })
      append('tool/result', { message: { id: 'native-timed-result-fixture', role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
        content: [{ type: 'text', text: JSON.stringify({ pending: true, callId, message: 'Continue natively.' }) }] } }, { surfaceOp: 'append' })
      const read = object(await backend.command('native-questions'))
      assert.equal(read.available, true)
      assert.ok(Array.isArray(read.active))
      const row = (read.active as unknown[]).map(object).find(row => row.callId === callId)
      assert.equal(row?.state, 'continued')
      terminal.type('retained main question draft 中文')
      const editor = app.editor, before = editor.captureDraft()
      await app.submit('/questions')
      await paint()
      assert.ok((app as unknown as { dialog?: unknown }).dialog)
      terminal.type('\x1b')
      await paint()
      assert.deepEqual(editor.captureDraft(), before)
      const stillPending = object(await backend.command('native-questions'))
      assert.ok((stillPending.active as unknown[]).map(object).some(row => row.callId === callId), 'local close sends no cancellation')
      await app.submit('/questions')
      await paint()
      terminal.type('\r')
      await until(() => {
        const dialog = (app as unknown as { dialog?: { request?: { id?: string }; options?: unknown } }).dialog
        return dialog?.request?.id === 'continued:' + callId
      }, 'existing question dialog opens for the native call', 10_000)
      const dialog = (app as unknown as { dialog: { options: { onSubmit(value: unknown): void } } }).dialog
      const firstReply = events.length
      dialog.options.onSubmit({ answers: [['Keep'], 'native freeform answer'] })
      await until(() => events.slice(firstReply).some(event => event.type === 'session_event' && event.event.type === 'user/message' &&
        object(object(event.event.data).source).kind === 'user-question-reply'), 'real native answer enters its inbox and log', 10_000)
      await paint()
      assert.equal(app.editor, editor)
      assert.deepEqual(editor.captureDraft(), before, 'late answer never rewrites the main draft')
      const final = object(await backend.command('native-questions'))
      assert.ok(Array.isArray(final.settled))
      const settled = (final.settled as unknown[]).map(object).find(row => row.callId === callId)
      assert.ok(settled)
      assert.deepEqual(settled.answers, [{ id: 'choice', selected: ['Keep'] }, { id: 'note', selected: [], custom: 'native freeform answer' }])
      const again = object(await backend.command('native-question-answer', { callId, answer: { answers: [['Keep'], 'duplicate'] } }))
      assert.ok(again.outcome === 'queued' || again.outcome === 'unavailable', 'native service refuses a duplicate reply')
    }, {}, { screen, extraInject: ['userQuestions', 'sessionProjections', 'commands'], timeout: 55_000 })
  })
}
