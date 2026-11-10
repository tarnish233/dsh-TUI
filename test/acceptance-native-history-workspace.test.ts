import test from 'node:test'
import { runNativeScene } from './helpers/native-scenario.ts'

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native history/workspace/approval composition uses real DSH services (${screen})`, { timeout: 60_000 }, async () => {
    await runNativeScene(async scene => {
      const { app, backend, ctx, object, until, terminal, paint, events, cwd } = scene
      const assert: typeof import('node:assert/strict') = scene.assert
      assert.ok(app.session?.capabilities.includes('history-turns'))
      assert.ok(app.session?.capabilities.includes('history-window'))
      assert.ok(app.session?.capabilities.includes('workspace-changes'))
      assert.ok(app.session?.capabilities.includes('workspace-change-diff'))
      const workspace = object(ctx.get('workspaceChanges'))
      assert.equal(typeof workspace.summary, 'function')
      assert.equal(typeof workspace.diff, 'function')
      await backend.command('input-route', { name: 'fixture-native-materialize' })
      const permission = object(await backend.command('execute', { line: '/permission read-only' }))
      assert.equal(object(permission.result).kind, 'success')

      await app.submit('fixture:write')
      await until(() => app.pendingDecisionCount > 0, 'native write approval arrives', 10_000).catch(error => {
        const tail = events.slice(-12).map(event => ({ type: event.type, event: event.type === 'session_event' ? event.event : event }))
        throw new Error(String(error) + '\nSCREEN:\n' + terminal.screen() + '\nLAST:\n' + JSON.stringify(tail).slice(-7000))
      })
      await paint()
      const decisionIndex = events.findIndex(event => event.type === 'decision' && event.request.kind === 'approval')
      const decision = events[decisionIndex]
      assert.ok(decision && decision.type === 'decision')
      assert.equal(typeof decision.request.callId, 'string')
      const callIndex = events.findIndex(event => event.type === 'session_event' && event.event.type === 'tool/call' &&
        object(event.event.data).callId === decision.request.callId)
      assert.ok(callIndex >= 0 && callIndex < decisionIndex, 'native tool/call logs admission before approval, not execution')
      const { access } = await import('node:fs/promises')
      await assert.rejects(access(cwd + '/native-write.txt'), error => object(error).code === 'ENOENT', 'a durable call and its Proposal have not written the file')
      const approval = (app as unknown as { dialog?: { render(width: number): string[] } }).dialog
      assert.ok(approval)
      const proposal = approval.render(110).join('\n')
      assert.match(proposal, /Proposal/)
      assert.match(proposal, /not run yet/)
      assert.match(proposal, /native new line/)
      assert.doesNotMatch(proposal, /Applied|applied result/)
      terminal.type('\r') // allow once through the existing native decision owner
      await until(() => !app.isBusy && app.pendingDecisionCount === 0, 'native write completes', 15_000)
      const { readFile } = await import('node:fs/promises')
      assert.equal(await readFile(cwd + '/native-write.txt', 'utf8'), 'native new line\n')

      const changed = events.find(event => event.type === 'session_event' && event.event.type === 'workspace/changes' && event.event.workspaceChanges !== undefined)
      assert.ok(changed && changed.type === 'session_event')
      const summary = changed.event.workspaceChanges!
      assert.equal(summary.total, 1)
      assert.equal(summary.files[0]?.display, 'native-write.txt')
      assert.equal(summary.added, 1)
      assert.equal(summary.deleted, 0)
      assert.equal('cwd' in summary, false)
      assert.equal('snapshot' in summary, false)
      assert.equal(app.store.items.some(item => item.kind === 'workspace-changes'), true)
      const diff = object(await backend.command('workspace-change-diff', { seq: changed.event.seq, index: 0 }))
      assert.equal(diff.sessionId, app.session?.sessionId)
      const file = object(diff.diff)
      assert.equal(file.kind, 'text')
      assert.ok(JSON.stringify(file.hunks).includes('native new line'))

      const outline = object(await backend.command('history-turns'))
      assert.equal(outline.available, true)
      const rows = Array.isArray(outline.entries) ? outline.entries.map(object) : []
      assert.equal(rows.length, 1)
      const seq = rows[0]?.seq
      assert.equal(typeof seq, 'number')
      const window = object(await backend.command('history-window', { seq, before: 0, after: 50 }))
      assert.equal(window.sessionId, app.session?.sessionId)
      assert.equal(window.targetSeq, seq)
      assert.ok(Array.isArray(window.events) && window.events.length > 0)
      assert.equal(window.hasOlder, true, 'the native permission events precede this turn anchor')
      const older = object(await backend.command('history-window', { seq, before: 50, after: 0 }))
      assert.equal(older.hasOlder, false, 'the older page reaches the start of this temporary log')
      const currentSeqs = (window.events as unknown[]).map(object).map(event => event.seq)
      const olderSeqs = (Array.isArray(older.events) ? older.events : []).map(object).map(event => event.seq)
      assert.deepEqual(olderSeqs.filter(value => currentSeqs.includes(value)), [seq], 'two native pages share only their anchor')

      await app.submit('/history')
      await until(() => {
        const dialog = (app as unknown as { dialog?: { render(width: number): string[] } }).dialog
        const text = dialog?.render(100).join('\n') ?? ''
        return text.includes('History') && text.includes('fixture:write')
      }, 'real native outline reaches /history', 10_000)
      terminal.type('\x1b')
      await paint()
    }, {}, {
      screen,
      extraInject: ['tools', 'approval', 'workspaceChanges', 'sessionProjections', 'sessionQuery'],
      timeout: 50_000,
    })
  })
}
