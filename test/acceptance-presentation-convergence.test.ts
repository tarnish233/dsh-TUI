import test from 'node:test'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native presentation: legal durable tool + settlement notice share a display group only (${screen})`, { timeout: 60_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const assert: NativeScene['assert'] = scene.assert
      const { app, backend, ctx, object, terminal, events, until, paint } = scene
      await app.submit('native presentation baseline')
      await until(() => !app.isBusy && events.some(event => event.type === 'session_event' && event.event.type === 'turn/end'),
        'hermetic native baseline settles', 10_000)
      const sessions = object(ctx.get('sessions'))
      const session = object((sessions.get as (id: string) => unknown).call(sessions, app.session!.sessionId))
      const append = (session.append as (type: string, data: unknown, surface?: { surfaceOp: 'append' }) => unknown).bind(session)
      const callId = 'native-presentation-read'
      // Legal synthetic durable facts through the real public Session/codec;
      // this is a rendering boundary probe, not a claim the fixture tool ran.
      append('tool/call', { name: 'fixture_read', callId, arguments: JSON.stringify({ path: 'fixture-only.txt' }) })
      append('tool/result', { message: { id: 'native-presentation-tool-result', role: 'tool', toolCallId: callId,
        source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'line one\nline two\nline three' }] } }, { surfaceOp: 'append' })
      const summary = 'Background fixture-child finished; no real subagent was started.'
      const notice = { id: 'native-presentation-notice', role: 'user', source: { kind: 'subagent-settled',
        form: 'notice', senderSessionId: 'fixture-child', summary },
        content: [{ type: 'text', text: summary + '\n\nNATIVE_NOTICE_BODY_UNCHANGED' }] }
      append('user/message', notice, { surfaceOp: 'append' })
      await paint()
      const tools = app.store.items.filter(item => item.kind === 'tool' && item.callId === callId)
      const updates = app.store.items.filter(item => item.kind === 'subagent-message' && item.senderSessionId === 'fixture-child')
      assert.equal(tools.length, 1, 'notice never becomes a fake tool call')
      assert.equal(updates.length, 1)
      assert.equal(updates[0]?.kind, 'subagent-message')
      if (updates[0]?.kind === 'subagent-message') assert.equal(updates[0].text, summary + '\n\nNATIVE_NOTICE_BODY_UNCHANGED')
      const compact = terminal.screen()
      assert.match(compact, /Activities|Activity/)
      assert.match(compact, /1 tool/)
      assert.match(compact, /1 (?:status )?update/)
      assert.doesNotMatch(compact, /NATIVE_NOTICE_BODY_UNCHANGED/, 'collapsed body, unchanged durable fact')
      terminal.type('native presentation draft 中文')
      const before = app.editor.captureDraft()
      terminal.type('\x0f')
      await paint()
      assert.match(terminal.screen(), /NATIVE_NOTICE_BODY_UNCHANGED/)
      assert.deepEqual(app.editor.captureDraft(), before)
      assert.equal(app.editor.focused, true)
      // An actual child message is a visible boundary, not another status update.
      append('user/message', { id: 'native-presentation-child-message', role: 'user',
        source: { kind: 'agent-message', senderSessionId: 'fixture-child' },
        content: [{ type: 'text', text: 'Agent fixture-child sent a message: NATIVE_ACTUAL_MESSAGE_VISIBLE' }] }, { surfaceOp: 'append' })
      terminal.type('\x0f')
      await paint()
      assert.match(terminal.screen(), /NATIVE_ACTUAL_MESSAGE_VISIBLE/)
      assert.equal(app.store.items.filter(item => item.kind === 'tool' && item.callId === callId).length, 1)
      assert.deepEqual(app.editor.captureDraft(), before)
      const original = scene.facts().filter(event => event.type === 'user/message').find(event => object(event.data).id === notice.id)
      assert.ok(original)
      assert.deepEqual(object(original.data).source, notice.source)
      assert.equal(scene.userText(original), summary + '\n\nNATIVE_NOTICE_BODY_UNCHANGED')
    }, {}, { screen, timeout: 50_000 })
  })
}
