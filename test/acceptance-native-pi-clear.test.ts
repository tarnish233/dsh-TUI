import test from 'node:test'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'

// Real native DSH composition, with the existing public llm/stream fixture.
// No next(), provider call, credentials, private runtime or synthetic domain services.
for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native Pi clear ${screen}: a live model turn continues after clear, Esc alone interrupts it`, { timeout: 90_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const { app, backend, terminal, until, events, facts, object } = scene
      const nativeCancel = backend.cancel.bind(backend)
      let cancels = 0
      backend.cancel = async () => { cancels++; await nativeCancel() }
      try {
        await app.submit('fixture:slow')
        await until(() => events.filter(event => event.type === 'stream_chunk').length >= 3, 'native partial stream is active', 15_000)
        terminal.type('\x1b[200~' + 'owned waiting draft 中文 '.repeat(100) + '\x1b[201~')
        const editor = app.editor, before = editor.captureDraft(), offset = events.length
        terminal.type('\x03')
        scene.assert.equal(app.editor, editor)
        scene.assert.equal(editor.getText(), '')
        scene.assert.equal(cancels, 0)
        scene.assert.equal(app.isBusy, true)
        await until(() => events.slice(offset).filter(event => event.type === 'stream_chunk').length >= 3, 'genuine native stream continues after main clear', 15_000)
        scene.assert.equal(cancels, 0)
        scene.assert.equal(facts(events.slice(offset)).some(event => event.type === 'turn/end' && object(object(event.data).reason).kind === 'aborted'), false)
        scene.assert.equal(app.queuedCount, 0, 'no queued human input competes with cleared-draft recovery')
        terminal.type('\x1b[A')
        scene.assert.equal(editor.getExpandedText(), before.expandedText, 'Up restores even with the native dequeue capability mounted and a busy Agent')
        scene.assert.deepEqual(editor.captureDraft().pastes, before.pastes)
        terminal.type('\x03')
        scene.assert.equal(editor.getText(), '')
        terminal.type('\x1f')
        scene.assert.equal(editor.getExpandedText(), before.expandedText, 'undo also restores the full native-admitted draft')
        scene.assert.deepEqual(editor.captureDraft().pastes, before.pastes)
        const interrupted = events.length
        terminal.type('\x1b')
        await until(() => !app.isBusy && facts(events.slice(interrupted)).some(event => event.type === 'turn/end'), 'Esc settles the native turn', 15_000)
        scene.assert.equal(cancels, 1)
        scene.assert.ok(facts(events.slice(interrupted)).some(event => event.type === 'turn/end' && object(object(event.data).reason).kind === 'aborted'))
        scene.assert.equal(editor.getExpandedText(), before.expandedText)
      } finally { backend.cancel = nativeCancel }
    }, {}, { screen, timeout: 75_000 })
  })

  test(`native Pi clear ${screen}: pending native command is not cancelled by clearing its next draft`, { timeout: 90_000 }, async () => {
    await runNativeScene(async (scene: NativeScene) => {
      const { app, backend, terminal, until, delay } = scene
      const nativeCancel = backend.cancel.bind(backend)
      let cancels = 0, complete = false
      backend.cancel = async () => { cancels++; await nativeCancel() }
      const work = app.submit('/fixture-wait').then(() => { complete = true })
      try {
        await until(() => app.isBusy, 'native command owns an active operation', 15_000)
        terminal.type('draft while command runs')
        terminal.type('\x03')
        scene.assert.equal(app.editor.getText(), '')
        scene.assert.equal(cancels, 0)
        await delay(60)
        scene.assert.equal(complete, false, 'clearing input does not resolve the native signal wait')
        scene.assert.equal(app.isBusy, true)
        terminal.type('\x1b')
        await work
        await until(() => !app.isBusy, 'Esc cancels the native command', 15_000)
        scene.assert.equal(cancels, 1)
      } finally { backend.cancel = nativeCancel }
    }, {}, { screen, timeout: 75_000 })
  })
}

test('native explicit interrupt override still aborts a pending ask with ASK_ABORTED', { timeout: 90_000 }, async () => {
  await runNativeScene(async (scene: NativeScene) => {
    const { app, terminal, until, events, facts, object } = scene
    app.keymap.setBindings({ 'app.interrupt': 'ctrl+q' })
    await app.submit('fixture:question')
    await until(() => app.pendingDecisionCount === 1, 'native ask is pending', 15_000)
    const offset = events.length
    terminal.type('\x11')
    await until(() => !app.isBusy && app.pendingDecisionCount === 0, 'explicit native interrupt settles', 15_000)
    scene.assert.ok(facts(events.slice(offset)).some(event => event.type === 'turn/end' && object(object(event.data).reason).kind === 'aborted'))
    scene.assert.match(JSON.stringify(facts(events.slice(offset))), /ASK_ABORTED/)
    scene.assert.equal(events.some(event => event.type === 'closed'), false)
  }, {}, { screen: 'fullscreen', timeout: 75_000 })
})
