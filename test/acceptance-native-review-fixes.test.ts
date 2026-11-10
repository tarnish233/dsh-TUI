import test from 'node:test'
import type { TuiMouseEvent } from '#pi-tui'
import type { HistoryDialog } from '../src/ui/history-dialog.ts'
import type { TranscriptView } from '../src/ui/transcript.ts'
import type { WorkspaceChangesDialog } from '../src/ui/workspace-changes-dialog.ts'
import { runNativeScene } from './helpers/native-scenario.ts'

// Real same-process DSH composition, owned temporary HOME/workspace, and the
// shared hermetic llm/stream fixture. No native service is replaced here.
for (const screen of ['inline', 'fullscreen'] as const) {
  for (const windowLimit of [0, 1, 20]) {
    test(`native history uses the configured readWindowMax=${windowLimit} without false completion (${screen})`, { timeout: 60_000 }, async () => {
      await runNativeScene(async (scene, params) => {
        const { app, backend, events, object, until, terminal, paint } = scene
        const assert: typeof import('node:assert/strict') = scene.assert
        const limit = params.windowLimit
        assert.ok(typeof limit === 'number')
        await app.submit('fixture:history-window-limit')
        await until(() => events.some(event => event.type === 'session_event' && event.event.type === 'turn/end') && !app.isBusy,
          'owned native turn completes', 15_000)
        const outline = object(await backend.command('history-turns'))
        assert.equal(outline.available, true)
        const entries = Array.isArray(outline.entries) ? outline.entries.map(object) : []
        assert.equal(entries.length, 1)
        const seq = entries[0]?.seq
        assert.ok(typeof seq === 'number')
        const end = events.findLast(event => event.type === 'session_event' && event.sessionId === app.session?.sessionId && event.event.type === 'turn/end')
        assert.ok(end && end.type === 'session_event')
        assert.ok(end.event.seq > seq, 'the outline anchor does not itself prove a complete turn')
        const liveStore = app.store, liveItems = [...app.store.items]
        const window = object(await backend.command('history-window', { seq, before: 50, after: 50 }))
        assert.equal(window.sessionId, app.session?.sessionId)
        assert.equal(window.targetSeq, seq)
        assert.ok(typeof window.startSeq === 'number' && window.startSeq >= Math.max(0, seq - limit))
        assert.ok(typeof window.endSeq === 'number' && window.endSeq <= seq + limit)
        assert.ok(Array.isArray(window.events) && window.events.length <= 2 * limit + 1)
        terminal.type('retained bounded history draft')
        const editor = app.editor, draft = editor.captureDraft()
        await app.submit('/history')
        const dialog = (app as unknown as { dialog?: HistoryDialog }).dialog
        assert.ok(dialog)
        await until(() => dialog.turnsStatus === 'ready', 'native bounded outline opens')
        terminal.type('\r')
        await until(() => dialog.detailMessage !== '' || (dialog.detailEventCount > 0 && !dialog.detailHasNewer),
          'native bounded pages settle', 10_000)
        assert.equal(dialog.detailMessage, '', 'a supported native bound is not a transport failure')
        if (limit === 0) {
          assert.deepEqual(dialog.detailEventSeqs, [seq])
          assert.equal(dialog.detailIsTruncated, true, 'a valid anchor-only reader cannot claim the known turn is complete')
          const text = dialog.render(110).join('\n')
          assert.match(text, /Partial turn/)
          assert.match(text, /no forward progress/)
        } else {
          const expected = Array.from({ length: end.event.seq - seq + 1 }, (_, index) => seq + index)
          assert.deepEqual(dialog.detailEventSeqs, expected, 'overlapping bounded native pages yield each real turn seq exactly once')
          assert.equal(dialog.detailIsTruncated, false)
        }
        assert.equal(app.store, liveStore)
        assert.deepEqual(app.store.items, liveItems, 'history reads and successful bound adaptation add no live facts or diagnostics')
        terminal.type('\x1b'); terminal.type('\x1b'); await paint()
        assert.equal(app.editor, editor)
        assert.deepEqual(editor.captureDraft(), draft)
      }, { windowLimit }, {
        screen,
        extraInject: ['sessionProjections', 'sessionQuery'],
        extraPatch: [{ id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'never', readWindowMax: windowLimit } }],
        timeout: 50_000,
      })
    })
  }
}

test('native workspace pointer and keyboard paths preserve whitespace-file indices and actual diff identity', { timeout: 60_000 }, async () => {
  await runNativeScene(async scene => {
    const { app, backend, events, until, terminal, paint, cwd } = scene
    const assert: typeof import('node:assert/strict') = scene.assert
    await app.submit('fixture:workspace-files')
    await until(() => events.some(event => event.type === 'session_event' && event.event.type === 'turn/end') && !app.isBusy,
      'two owned native writes finish', 15_000)
    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(cwd + '/ ', 'utf8'), 'contents of the whitespace-named file\n')
    assert.equal(await readFile(cwd + '/a.txt', 'utf8'), 'contents of normal a.txt\n')
    const announced = events.find(event => event.type === 'session_event' && event.event.workspaceChanges !== undefined)
    assert.ok(announced && announced.type === 'session_event')
    const summary = announced.event.workspaceChanges!
    assert.deepEqual(summary.files.map(file => file.display), [' ', 'a.txt'])
    const card = app.store.items.find(item => item.kind === 'workspace-changes')
    assert.ok(card && card.kind === 'workspace-changes')
    assert.deepEqual(card.files.map(file => file.display), [' ', 'a.txt'], 'UI rows keep native indices, including a whitespace-only display')
    assert.equal(card.sessionId, app.session?.sessionId)
    assert.equal(card.attachmentId, app.session?.attachmentId)
    assert.equal(card.seq, announced.event.seq)
    terminal.type('retained native workspace draft')
    const editor = app.editor, draft = editor.captureDraft()
    const view = (app as unknown as { transcript: TranscriptView }).transcript
    view.render(110)
    const span = view.rowSpans.find(span => span.itemId === card.id)
    assert.ok(span)
    const mouse = (type: 'press' | 'click'): TuiMouseEvent => ({ type, button: 'left', x: 4, y: span.startRow + 1,
      screenX: 4, screenY: span.startRow + 1, width: 110, height: 35, shift: false, alt: false, ctrl: false,
      ...(type === 'click' ? { clickCount: 1 } : {}) })
    // Actual transcript block -> App callback -> scoped adapter -> official diff.
    view.handleMouse(mouse('press')); view.handleMouse(mouse('click'))
    const dialog = (app as unknown as { dialog?: WorkspaceChangesDialog }).dialog
    assert.ok(dialog)
    await until(() => dialog.render(110).join('\n').includes('contents of the whitespace-named file'), 'native index 0 diff painted')
    assert.match(dialog.render(110).join('\n'), /file 1 of 2/)
    terminal.type('\x1b') // detail -> list
    terminal.type('\x1b[B'); terminal.type('\r') // native index 1 through the shared keyboard context
    await until(() => dialog.render(110).join('\n').includes('contents of normal a.txt'), 'native index 1 diff painted')
    const second = dialog.render(110).join('\n')
    assert.match(second, /a\.txt/)
    assert.match(second, /file 2 of 2/)
    assert.doesNotMatch(second, /contents of the whitespace-named file/)
    terminal.type('\x1b'); terminal.type('\x1b'); await paint()
    assert.equal(app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
    assert.equal(events.some(event => event.type === 'decision'), false, 'safe native workspace writes need no synthetic approval owner')
    assert.equal(backend === scene.backend, true, 'one supplied native backend owns every read and write')
  }, {}, { screen: 'fullscreen', extraInject: ['workspaceChanges'], timeout: 50_000 })
})
