import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import type { BackendEvent, JsonRecord, SessionEvent } from '../src/backend/types.ts'
import { DemoBackend } from '../src/demo.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'
import { imageFixture } from './helpers/images.ts'

class RecordingDemoBackend extends DemoBackend {
  readonly calls: Array<{ name: string; args: JsonRecord }> = []
  beforeFollow?: () => void
  failPrompt = false

  override async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (name === 'subagent-follow' && args.follow === true) this.beforeFollow?.()
    if (name === 'subagent-prompt' && this.failPrompt) throw new Error('synthetic native refusal')
    return super.command(name, args)
  }

  emitFixture(event: BackendEvent): void {
    ;(this as unknown as { emit(event: BackendEvent): void }).emit(event)
  }
}

async function fixture(screen: 'inline' | 'fullscreen') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-app-subagents-'))
  const backend = new RecordingDemoBackend({ cwd: directory, delayMs: 0 })
  const terminal = new VirtualTerminal(110, 38)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, demo: true, registerSignals: false })
  await app.start()
  await paint(terminal)
  return { app, backend, terminal, directory, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}

async function paint(terminal: VirtualTerminal): Promise<void> { await delay(35); await terminal.flush() }

// A persistent “● Agents · …” progress header is not the temporary modal.
const agentsOverlayVisible = (terminal: VirtualTerminal): boolean => terminal.screen().split('\n').some(line => /┌─ Agents[─ ]/.test(line))

function childMessage(text: string, seq = 100): SessionEvent {
  return {
    type: 'user/message', seq, time: 1_750_000_100_000,
    data: {
      id: `live-child-${seq}`, role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`App subagent surface: catalog → Agents → followed child → return (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      await f.app.submit('subagent')
      await until(() => f.app.store.subagentEntries.length === 5 && !f.app.isBusy, 'demo subagent catalog')
      await paint(f.terminal)
      f.terminal.type('keep the parent draft')
      const before = f.app.editor.captureDraft()
      const mainCount = f.app.store.items.length

      f.backend.beforeFollow = () => {
        f.backend.emitFixture({ type: 'session_event', sessionId: 'demo-child-explore', event: childMessage('Buffered live child fact') })
      }
      f.terminal.type('\x18'); f.terminal.type('\x01')
      await until(() => agentsOverlayVisible(f.terminal) && f.terminal.screen().includes('Explore repository'), 'Agents overlay')
      await paint(f.terminal)
      f.terminal.type('\r')
      try {
        await until(() => f.terminal.screen().includes('I mapped the transcript projection'), 'child native snapshot')
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nSCREEN:\n${f.terminal.screen()}\nCALLS:${JSON.stringify(f.backend.calls)}\nITEMS:${JSON.stringify(f.app.store.items)}`)
      }
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Buffered live child fact/, 'frame admitted between follow and snapshot was replayed')
      assert.equal(f.app.store.items.some(item => JSON.stringify(item).includes('Buffered live child fact')), false, 'child facts never enter the root transcript')
      assert.equal(f.app.store.items.length, mainCount, 'opening read-only surfaces adds no root notices')

      const followIndex = f.backend.calls.findIndex(call => call.name === 'subagent-follow' && call.args.follow === true)
      const snapshotIndex = f.backend.calls.findIndex(call => call.name === 'subagent-session')
      assert.ok(followIndex >= 0 && snapshotIndex > followIndex, 'follow starts before the native snapshot read')

      // Parent-only tool/model actions cannot replace the read-only child view.
      f.terminal.type('\x18'); f.terminal.type('\x0f')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /I mapped the transcript projection/)
      assert.deepEqual(f.app.editor.captureDraft(), before)

      f.terminal.type('\x1b')
      await until(() => f.backend.calls.some(call => call.name === 'subagent-follow' && call.args.follow === false), 'child unfollow')
      await until(() => agentsOverlayVisible(f.terminal), 'return to Agents overlay')
      f.terminal.type('\x1b')
      await paint(f.terminal)
      assert.deepEqual(f.app.editor.captureDraft(), before, 'both overlays preserve the one root editor state')

      const itemsAfterClose = f.app.store.items.length
      f.backend.emitFixture({ type: 'session_event', sessionId: 'demo-child-explore', event: childMessage('Must not leak after close', 101) })
      await paint(f.terminal)
      assert.equal(f.app.store.items.length, itemsAfterClose)
      assert.equal(f.app.store.items.some(item => JSON.stringify(item).includes('Must not leak after close')), false)
    } finally { await f.close() }
    assert.equal(f.terminal.stopped, true)
  })
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`App native reply uses the one main Editor and preserves failure drafts (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      await f.app.submit('subagent')
      await until(() => f.app.store.subagentEntries.length === 5 && !f.app.isBusy, 'demo subagent catalog')
      f.terminal.type('reply through the native child')
      const before = f.app.editor.captureDraft()
      f.terminal.type('\x18'); f.terminal.type('\x01')
      await until(() => agentsOverlayVisible(f.terminal), 'Agents before reply')
      f.terminal.type('r')
      await until(() => f.app.replyTargetSessionId === 'demo-child-explore', 'reply target selected')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Replying to Explore repository/)
      assert.deepEqual(f.app.editor.captureDraft(), before, 'target switching does not rewrite the root draft')
      assert.equal(agentsOverlayVisible(f.terminal), false, 'reply leaves the overlay surface')

      f.terminal.type('\r')
      await until(() => f.backend.calls.some(call => call.name === 'subagent-prompt'), 'native child prompt command')
      const prompt = f.backend.calls.find(call => call.name === 'subagent-prompt')!
      assert.equal(prompt.args.sessionId, 'demo-child-explore')
      assert.equal(prompt.args.delivery, 'queue')
      assert.equal(typeof prompt.args.requestId, 'string')
      assert.deepEqual(prompt.args.content, [{ type: 'text', text: 'reply through the native child' }])
      assert.equal(f.app.store.items.some(item => (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'attempt') && JSON.stringify(item).includes('reply through the native child')), false)
      assert.equal(f.app.replyTargetSessionId, 'demo-child-explore')
      assert.equal(f.app.editor.getExpandedText(), '')

      // Esc only changes the destination. It neither sends nor interrupts.
      f.terminal.type('\x1b')
      await until(() => f.app.replyTargetSessionId === undefined, 'Esc restores root destination')
      assert.equal(f.backend.calls.some(call => call.name === 'subagent-interrupt'), false)

      f.terminal.type('keep this draft after native refusal')
      f.terminal.type('\x18'); f.terminal.type('\x01')
      await until(() => agentsOverlayVisible(f.terminal), 'Agents before refused reply')
      f.terminal.type('r')
      await until(() => f.app.replyTargetSessionId === 'demo-child-explore', 'reply target before refusal')
      f.backend.failPrompt = true
      f.terminal.type('\r')
      await until(() => f.terminal.screen().includes('Subagent reply not accepted'), 'native refusal notice')
      assert.equal(f.app.editor.getExpandedText(), 'keep this draft after native refusal')
      assert.equal(f.app.replyTargetSessionId, 'demo-child-explore', 'failed target remains explicit for retry or Esc')
    } finally { await f.close() }
  })
}

test('App child steer is native, while send-now fails closed without cancelling the root', async () => {
  const f = await fixture('fullscreen')
  try {
    await f.app.submit('subagent')
    await until(() => f.app.store.subagentEntries.length === 5 && !f.app.isBusy, 'demo subagent catalog')
    f.terminal.type('\x18'); f.terminal.type('\x01')
    await until(() => agentsOverlayVisible(f.terminal), 'Agents before steer')
    f.terminal.type('r')
    await until(() => f.app.replyTargetSessionId === 'demo-child-explore', 'reply target for steer')
    f.terminal.type('steer the child')
    f.terminal.type('\x18'); f.terminal.type('\x13')
    await until(() => f.backend.calls.some(call => call.name === 'subagent-prompt'), 'native steer command')
    assert.equal(f.backend.calls.find(call => call.name === 'subagent-prompt')?.args.delivery, 'steer')
    assert.equal(f.backend.calls.some(call => call.name === 'queue-send-now'), false)

    // A targeted slash is child text, never a root human command.
    f.terminal.type('/compact')
    f.terminal.type('\r')
    await until(() => f.backend.calls.filter(call => call.name === 'subagent-prompt').length === 2, 'targeted slash remains child text')
    const slash = f.backend.calls.filter(call => call.name === 'subagent-prompt')[1]!
    assert.deepEqual(slash.args.content, [{ type: 'text', text: '/compact' }])
    assert.equal(f.backend.calls.some(call => call.name === 'execute'), false)

    f.terminal.type('do not send-now to a child')
    f.terminal.type('\x1b[13;5u')
    await until(() => f.terminal.screen().includes('Send-now is unavailable for a subagent reply'), 'child send-now refusal')
    assert.equal(f.app.editor.getExpandedText(), 'do not send-now to a child')
    assert.equal(f.backend.calls.filter(call => call.name === 'subagent-prompt').length, 2)
    assert.equal(f.backend.calls.some(call => call.name === 'queue-send-now'), false)
  } finally { await f.close() }
})

test('App subagent reply preserves native image prompt parts', async () => {
  const f = await fixture('fullscreen')
  try {
    await f.app.submit('subagent')
    await until(() => f.app.store.subagentEntries.length === 5 && !f.app.isBusy, 'demo subagent catalog')
    const image = await imageFixture()
    f.app.editor.handleInput('image for child')
    f.app.editor.insertImage(image.upload)
    f.terminal.type('\x18'); f.terminal.type('\x01')
    await until(() => agentsOverlayVisible(f.terminal), 'Agents before image reply')
    f.terminal.type('r')
    await until(() => f.app.replyTargetSessionId === 'demo-child-explore', 'image reply target')
    f.terminal.type('\r')
    await until(() => f.backend.calls.some(call => call.name === 'subagent-prompt'), 'native image prompt command')
    const prompt = f.backend.calls.find(call => call.name === 'subagent-prompt')!
    const content = Array.isArray(prompt.args.content) ? prompt.args.content : []
    assert.equal(content.some(part => typeof part === 'object' && part !== null && (part as JsonRecord).type === 'image' && (part as JsonRecord).data === image.upload.data), true)
    assert.equal(content.some(part => typeof part === 'object' && part !== null && (part as JsonRecord).type === 'text' && typeof (part as JsonRecord).text === 'string' && ((part as JsonRecord).text as string).includes('image for child')), true)
  } finally { await f.close() }
})

test('App stops only the selected native child and renders the later native status', async () => {
  const f = await fixture('inline')
  try {
    await f.app.submit('subagent')
    await until(() => f.app.store.subagentEntries.length === 5 && !f.app.isBusy, 'demo subagent catalog')
    f.terminal.type('\x18'); f.terminal.type('\x01')
    await until(() => agentsOverlayVisible(f.terminal), 'Agents before child interrupt')
    f.terminal.type('s')
    await until(() => f.backend.calls.some(call => call.name === 'subagent-interrupt'), 'native child interrupt command')
    const interrupt = f.backend.calls.find(call => call.name === 'subagent-interrupt')!
    assert.deepEqual(interrupt.args, { sessionId: 'demo-child-explore' })
    await until(() => f.app.store.subagentEntry('demo-child-explore')?.status === 'stopped', 'demo native status projection')
    assert.equal(f.app.replyTargetSessionId, undefined)
    await until(() => f.app.store.items.some(item => item.kind === 'notice' && item.text.includes('Interrupt admitted for Explore repository')), 'interrupt admitted notice')
  } finally { await f.close() }
})

test('App renders the exact child provenance on a native decision without mutating the request', async () => {
  const f = await fixture('fullscreen')
  try {
    const request = {
      id: 'child-approval', kind: 'approval' as const, title: 'Approve read',
      message: 'Read a synthetic fixture file.',
      options: [{ label: 'Allow once', value: 'allowed-once' }, { label: 'Reject', value: 'rejected' }],
      origin: {
        rootSessionId: f.app.session!.sessionId,
        childSessionId: 'demo-child-explore', parentSessionId: f.app.session!.sessionId,
        label: 'Explore repository',
      },
    }
    f.backend.emitFixture({ type: 'decision', sessionId: f.app.session!.sessionId, request })
    await until(() => f.app.pendingDecisionCount === 1, 'child decision queued')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /Explore repository › Approve read/)
    assert.equal(request.title, 'Approve read', 'native request object remains unchanged')
    f.backend.emitFixture({ type: 'decision_closed', sessionId: f.app.session!.sessionId, id: request.id })
    await until(() => f.app.pendingDecisionCount === 0, 'child decision closed')
  } finally { await f.close() }
})

test('Agents overlay preserves the global empty-draft exit path', async () => {
  const f = await fixture('inline')
  try {
    await f.app.submit('subagent')
    await until(() => f.app.store.subagentEntries.length === 5 && !f.app.isBusy, 'demo subagent catalog')
    f.terminal.type('\x18'); f.terminal.type('\x01')
    await until(() => agentsOverlayVisible(f.terminal), 'Agents overlay before exit')
    f.terminal.type('\x04')
    await delay(20)
    f.terminal.type('\x04')
    const code = await f.app.exited
    assert.equal(code, 0)
  } finally { await f.close() }
  assert.equal(f.terminal.stopped, true)
})
