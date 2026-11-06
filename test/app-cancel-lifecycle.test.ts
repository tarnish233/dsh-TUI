import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, DecisionRequest, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { DecisionDialog } from '../src/ui/dialogs.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

/** Control-surface fixture only: transport/event mapping, never an Agent or model. */
class CancelFixtureBackend implements Backend {
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly commands: Array<{ name: string; args: JsonRecord }> = []
  readonly sends: string[] = []
  readonly responses: Array<{ id: string; value: unknown }> = []
  cancels = 0
  closes = 0
  closeGate?: Promise<void>
  sendGate?: Promise<void>
  modelsGate?: Promise<void>
  effortsGate?: Promise<void>
  closeDecisionsOnCancel = true
  queue: string[] = []
  /** Holds the next `state` read so a later refresh can observe the claimed inbox. */
  statePause?: Promise<void>
  pendingContext = 0
  queueAfterCancel?: string[]
  autoTitleEnabled: boolean | undefined = true
  autoTitleAvailable = true
  reloadResult: JsonRecord = { available: true, warnings: [], pending: [] }
  reloadFailure?: Error
  modelDefaultWarning?: string
  modelGates = new Map<string, Promise<void>>()
  staleModelResponses = new Set<string>()
  effortGate?: Promise<void>
  staleEffortResponse = false
  info: SessionInfo
  private decisionIds: string[] = []

  constructor(cwd: string) {
    this.info = {
      sessionId: 'cancel-fixture-session', attachmentId: 'cancel-fixture-attachment-1', cwd,
      provider: 'fixture', model: 'fixture-model',
      capabilities: ['state', 'dequeue', 'models', 'efforts', 'commands', 'execute', 'permissions', 'new', 'resume', 'auto-title', 'reload'],
      events: [],
    }
  }

  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(text: string) { this.sends.push(text); await this.sendGate }
  async cancel() {
    this.cancels += 1
    if (this.queueAfterCancel) this.queue = [...this.queueAfterCancel]
    this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'idle' })
    if (this.closeDecisionsOnCancel) {
      for (const id of this.decisionIds.splice(0)) this.emit({ type: 'decision_closed', sessionId: this.info.sessionId, id })
    }
  }
  async respond(id: string, value: unknown) {
    this.responses.push({ id, value })
    this.emit({ type: 'decision_closed', sessionId: this.info.sessionId, id })
  }
  async close() { this.closes += 1; await this.closeGate }
  async command(name: string, args: JsonRecord = {}) {
    this.commands.push({ name, args })
    switch (name) {
      case 'commands': return []
      case 'state': {
        const pause = this.statePause
        this.statePause = undefined
        if (pause) await pause
        return {
        sessionId: this.info.sessionId,
        pending: { nextTurn: this.queue.length, nextStep: this.pendingContext },
        queued: this.queue.length,
        queue: this.queue.map((text, index) => ({ messageId: 'queued-' + index, text, target: 'next-turn', images: 0 })),
      }
      }
      case 'queue-remove': {
        const index = this.queueIndex(args.messageId)
        this.queue.splice(index, 1)
        return { removed: args.messageId }
      }
      case 'queue-replace': {
        const index = this.queueIndex(args.messageId)
        const text = typeof args.text === 'string' ? args.text : ''
        if (text.trim() === '') throw new Error('queue-replace requires text')
        this.queue[index] = text
        return { messageId: 'queued-' + index }
      }
      case 'queue-send-now': {
        const text = typeof args.text === 'string' ? args.text : undefined
        const messageId = typeof args.messageId === 'string' ? args.messageId : undefined
        let chosen: string | undefined
        if (messageId !== undefined) {
          const index = this.queueIndex(messageId)
          const current = this.queue[index] ?? ''
          this.queue.splice(index, 1)
          chosen = text !== undefined && text.trim() !== '' ? text : current
        } else if (text !== undefined && text.trim() !== '') chosen = text
        if (chosen === undefined) throw new Error('queue-send-now requires text or messageId')
        this.queue.unshift(chosen)
        return { ok: true }
      }
      case 'dequeue': {
        const removed = this.queue.map((text, index) => ({ text, messageId: 'queued-' + index }))
        this.queue.length = 0
        return removed
      }
      case 'models': await this.modelsGate; return [{ id: 'fixture/other-model', provider: 'fixture', model: 'other-model', label: 'Other model' }]
      case 'model': {
        const requested = String(args.id ?? 'fixture-model')
        await this.modelGates.get(requested)
        if (this.staleModelResponses.has(requested)) {
          // Older/late response carrying the route this request started from.
          return { ...this.info, provider: 'fixture', model: requested, ...(this.modelDefaultWarning === undefined ? {} : { defaultWarning: this.modelDefaultWarning }) }
        }
        this.info = { ...this.info, model: requested }
        return { ...this.info, ...(this.modelDefaultWarning === undefined ? {} : { defaultWarning: this.modelDefaultWarning }) }
      }
      case 'efforts': await this.effortsGate; return { available: true, efforts: [{ id: 'low', name: 'Low', description: 'low' }] }
      case 'effort': {
        await this.effortGate
        if (this.staleEffortResponse) return { provider: 'fixture', model: 'old-model', reasoningEffort: 'low', effectiveEffort: 'low' }
        return { provider: this.info.provider, model: this.info.model, reasoningEffort: String(args.id ?? 'low'), effectiveEffort: String(args.id ?? 'low') }
      }
      case 'permissions': return { currentValue: 'workspace-write', options: [{ value: 'workspace-write' }, { value: 'danger-full-access' }] }
      case 'auto-title': {
        if (!this.autoTitleAvailable) throw new Error('native auto-title is unavailable in this fixture')
        if (args.enabled === undefined) return { available: true, enabled: this.autoTitleEnabled === true }
        this.autoTitleEnabled = args.enabled === null ? true : args.enabled === true
        return { available: true, enabled: this.autoTitleEnabled }
      }
      case 'reload': if (this.reloadFailure) throw this.reloadFailure; return this.reloadResult
      case 'new':
      case 'resume': {
        this.info = { ...this.info, sessionId: 'cancel-fixture-session-2', attachmentId: 'cancel-fixture-attachment-2' }
        this.emit({ type: 'ready', info: this.info }); return this.info
      }
      default: return undefined
    }
  }
  private queueIndex(messageId: unknown): number {
    const id = typeof messageId === 'string' ? messageId : ''
    const index = Number(id.slice('queued-'.length))
    if (!id.startsWith('queued-') || !Number.isInteger(index) || index < 0 || index >= this.queue.length) {
      throw new Error('queued message is gone')
    }
    return index
  }

  request(id: string, kind: 'approval' | 'question'): DecisionRequest {
    this.decisionIds.push(id)
    return kind === 'approval'
      ? { id, kind, title: 'Fixture approval', options: [{ label: 'Allow once', value: 'allowed-once' }, { label: 'Reject', value: 'rejected' }] }
      : { id, kind, title: 'Fixture question', questions: [{ question: 'Pick a color', options: [{ label: 'Blue' }, { label: 'Green' }] }] }
  }
}

async function fixture(options: { settings?: JsonRecord; registerSignals?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-cancel-'))
  if (options.settings) await writeFile(join(directory, 'settings.json'), JSON.stringify(options.settings))
  const terminal = new VirtualTerminal(100, 35)
  const backend = new CancelFixtureBackend(directory)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', registerSignals: options.registerSignals === true })
  await app.start()
  await paint(terminal)
  return {
    app, backend, terminal, directory,
    async close() { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) },
  }
}

const paint = async (terminal: VirtualTerminal) => { await delay(25); await terminal.flush() }
function buttonAt(terminal: VirtualTerminal, label: string): { x: number; y: number } {
  const lines = terminal.screen().split('\n')
  for (let y = 0; y < lines.length; y += 1) {
    const x = lines[y]!.indexOf(label)
    if (x >= 0) return { x, y }
  }
  throw new Error(`missing ${label}\n${terminal.screen()}`)
}
async function click(terminal: VirtualTerminal, x: number, y: number): Promise<void> {
  terminal.type(`\x1b[<0;${x + 1};${y + 1}M`)
  await paint(terminal)
  terminal.type(`\x1b[<0;${x + 1};${y + 1}m`)
  await paint(terminal)
}
const notice = (app: App) => app.store.items.filter(item => item.kind === 'notice').at(-1)?.text ?? ''

test('queue badge uses recallable human input, not native permission context or raw inbox length', async () => {
  const f = await fixture()
  try {
    f.backend.pendingContext = 10
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
    await paint(f.terminal)
    assert.equal(f.app.queuedCount, 0, 'an explicit zero human queue must not fall back to raw pending context')
    assert.doesNotMatch(f.terminal.screen(), /queued:/)
    assert.equal(f.app.isBusy, false)

    f.backend.queue = ['real queued input']
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
    await until(() => f.app.queuedCount === 1, 'only one human message is queued')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /real queued input/)
    assert.match(f.terminal.screen(), /\[Send now\]/)
    assert.match(f.terminal.screen(), /\[Edit\]/)
    assert.match(f.terminal.screen(), /\[Cancel\]/)
    assert.doesNotMatch(f.terminal.screen(), /queued:/)
    f.terminal.type('\x1b[A')
    await until(() => f.app.editor.getExpandedText() === 'real queued input', 'Up recalls only the human message')
    await paint(f.terminal)
    assert.equal(f.app.queuedCount, 0)
    assert.equal(f.backend.pendingContext, 10, 'recall does not drop native permission context')
    assert.doesNotMatch(f.terminal.screen(), /queued:/)
  } finally { await f.close() }
})

test('idle Ctrl+C clears+saves the draft and the second press exits; Up restores and disarms', async () => {
  const f = await fixture()
  try {
    f.terminal.type('draft to clear')
    f.terminal.type('\x03')
    assert.equal(f.app.editor.getText(), '')
    assert.equal(f.terminal.stopped, false, 'one idle Ctrl+C only clears and arms')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /again to exit/)
    f.terminal.type('\x03')
    assert.equal(await f.app.exited, 0)
    assert.equal(f.terminal.stopped, true)

    const g = await fixture()
    try {
      g.terminal.type('restore me')
      g.terminal.type('\x03')
      g.terminal.type('\x1b[A')
      assert.equal(g.app.editor.getExpandedText(), 'restore me', 'Up restores the cleared draft')
      g.terminal.type('\x03')
      await delay(20)
      assert.equal(g.terminal.stopped, false, 'restoring cancels the exit arm; this press only clears again')
      g.terminal.type('\x03')
      assert.equal(await g.app.exited, 0)
    } finally { await g.close() }
  } finally { await f.close() }
})

test('empty Ctrl+D/app.exit guard never exits a non-empty draft', async () => {
  const f = await fixture()
  try {
    f.terminal.type('guard me')
    f.terminal.type('\x04')
    await delay(30)
    assert.equal(f.terminal.stopped, false)
    assert.equal(f.app.editor.getText(), 'guard me')
    f.terminal.type('\x04')
    // Ctrl+D on a non-empty draft is forward-delete; still no exit.
    await delay(30)
    assert.equal(f.terminal.stopped, false)
  } finally { await f.close() }
})

test('busy Esc cancels the turn and sends the queue without clearing the draft', async () => {
  const f = await fixture()
  try {
    f.backend.queueAfterCancel = ['retained one', 'retained two']
    f.terminal.type('busy draft')
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
    await until(() => f.app.isBusy, 'fixture turn running')
    f.terminal.type('\x1b')
    await until(() => f.backend.cancels === 1, 'Esc sent native cancel')
    await until(() => f.backend.commands.some(command => command.name === 'queue-send-now'), 'Esc releases the queue')
    const sent = f.backend.commands.find(command => command.name === 'queue-send-now')
    assert.equal(sent?.args.messageId, 'queued-0')
    assert.equal(f.app.editor.getText(), 'busy draft', 'Esc never sends or clears the draft')
    assert.equal(f.backend.sends.length, 0, 'the queue leaves through queue-send-now, not a second prompt send')
    assert.doesNotMatch(notice(f.app), /retained/)
  } finally { await f.close() }
})

test('a message claimed as the turn starts does not stay on the queue', async () => {
  const f = await fixture()
  try {
    let release: () => void = () => {}
    f.backend.statePause = new Promise(resolve => { release = resolve })
    f.backend.queue = ['继续']
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
    await delay(20)
    f.backend.queue = []
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
    release()
    await until(() => f.app.queuedCount === 0, 'claimed message leaves the queue')
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /继续/)
  } finally { await f.close() }
})

test('a message already in the transcript is not shown as queued', async () => {
  const f = await fixture()
  try {
    f.backend.queue = ['你再分析一下 rex 的 tab']
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
    await until(() => f.terminal.screen().includes('[Send now]'), 'stale inbox row is visible')
    f.backend.emit({
      type: 'session_event',
      sessionId: f.backend.info.sessionId,
      event: {
        type: 'user/message',
        seq: 1,
        data: {
          id: 'queued-0',
          role: 'user',
          content: [{ type: 'text', text: '你再分析一下 rex 的 tab' }],
          source: { kind: 'user' },
        },
      },
    })
    await until(() => !f.terminal.screen().includes('[Send now]'), 'admitted message leaves the queue')
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
    await paint(f.terminal)
    assert.equal(f.app.queuedCount, 0)
    assert.doesNotMatch(f.terminal.screen(), /\[Send now\]/)
  } finally { await f.close() }
})

test('idle Esc sends the queued message and leaves an empty draft alone', async () => {
  const f = await fixture()
  try {
    f.backend.queue = ['继续']
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
    await until(() => f.app.queuedCount === 1, 'queued row visible')
    f.terminal.type('\x1b')
    await until(() => f.backend.commands.some(command => command.name === 'queue-send-now'), 'idle Esc sends the queue')
    assert.equal(f.backend.commands.find(command => command.name === 'queue-send-now')?.args.messageId, 'queued-0')
    assert.equal(f.backend.cancels, 0, 'an idle queue does not need another cancel')
    assert.equal(f.app.editor.getText(), '')
  } finally { await f.close() }
})

test('queue row buttons send, edit, and cancel one message', async () => {
  const f = await fixture()
  try {
    f.backend.queue = ['send this', 'keep this']
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
    await until(() => f.app.queuedCount === 2, 'two rows projected')
    await paint(f.terminal)
    const row = f.terminal.screen().split('\n').find(line => line.includes('[Send now]'))
    assert.match(row ?? '', /#1/)
    assert.match(row ?? '', /send this/)
    const send = buttonAt(f.terminal, '[Send now]')
    await click(f.terminal, send.x, send.y)
    await until(() => f.backend.commands.some(command => command.name === 'queue-send-now'), 'Send now calls the native command')
    const sendNow = f.backend.commands.find(command => command.name === 'queue-send-now')
    assert.equal(sendNow?.args.messageId, 'queued-0')
    assert.deepEqual(f.backend.queue, ['send this', 'keep this'])

    f.backend.queue = ['edit this']
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
    await until(() => f.terminal.screen().includes('edit this'), 'edit row is visible')
    await paint(f.terminal)
    const edit = buttonAt(f.terminal, '[Edit]')
    await click(f.terminal, edit.x, edit.y)
    assert.equal(f.app.editor.getText(), 'edit this')
    f.terminal.type('!')
    f.terminal.type('\r')
    await until(() => f.backend.commands.some(command => command.name === 'queue-replace'), 'Enter writes the row back')
    const replaced = f.backend.commands.find(command => command.name === 'queue-replace')
    assert.equal(replaced?.args.text, 'edit this!')
    await until(() => f.app.editor.getText() === '', 'the composer leaves edit mode')
    await paint(f.terminal)

    f.backend.queue = ['drop this']
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
    await until(() => f.terminal.screen().includes('drop this'), 'cancel row is visible')
    await paint(f.terminal)
    const cancel = buttonAt(f.terminal, '[Cancel]')
    await click(f.terminal, cancel.x, cancel.y)
    await until(() => f.backend.queue.length === 0, 'Cancel removes that row')
    assert.equal(f.app.queuedCount, 0)
    assert.doesNotMatch(f.app.store.items.filter(item => item.kind === 'notice').map(item => item.text).join('\n'), /queued message is gone/)
  } finally { await f.close() }
})

test('Up/Ctrl+P recalls the retained queue while idle and never auto-drains it', async () => {
  const f = await fixture()
  try {
    f.backend.queue = ['queued first', 'queued second']
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
    await until(() => f.app.queuedCount === 2, 'idle retained queue visible')
    f.terminal.type('\x1b[A')
    await until(() => f.app.editor.getText().includes('queued first'), 'idle Up dequeues into the editor')
    assert.equal(f.app.editor.getText(), 'queued first\n\nqueued second')
    await until(() => f.app.queuedCount === 0, 'recalled queue is now empty')
    assert.equal(f.backend.commands.filter(command => command.name === 'dequeue').length, 1)
  } finally { await f.close() }
})

test('Ctrl+C is global while Settings owns focus and never converts a decision into a local answer', async () => {
  const f = await fixture()
  try {
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
    await f.app.submit('/settings')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /Settings/)
    f.terminal.type('\x03')
    await until(() => f.backend.cancels === 1, 'global Ctrl+C cancels the native turn')
    assert.equal(f.backend.responses.length, 0)
    f.terminal.type('\x1b')
    await until(() => !f.terminal.screen().includes('Settings ·'), 'settings closes')
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })

    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: f.backend.request('approval-ctrl-c', 'approval') })
    await until(() => f.app.pendingDecisionCount === 1, 'approval visible')
    f.terminal.type('\x03')
    await until(() => f.backend.cancels === 2, 'approval Ctrl+C invokes backend.cancel')
    assert.equal(f.backend.responses.length, 0, 'no pretend {cancelled:true} response')
    await until(() => f.app.pendingDecisionCount === 0, 'native decision closure removes the dialog')
  } finally { await f.close() }
})

test('approval Esc settles with the native rejected option, not cancellation', async () => {
  const f = await fixture()
  try {
    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: f.backend.request('approval-esc', 'approval') })
    await until(() => f.app.pendingDecisionCount === 1, 'approval visible')
    await paint(f.terminal)
    f.terminal.type('\x1b')
    await until(() => f.backend.responses.length === 1, 'approval answered')
    assert.deepEqual(f.backend.responses[0], { id: 'approval-esc', value: 'rejected' })
  } finally { await f.close() }
})

test('question Esc cancels that native request at once and leaves nothing pending', async () => {
  const f = await fixture()
  const originalDispose = DecisionDialog.prototype.dispose
  let disposed = 0
  DecisionDialog.prototype.dispose = function (this: DecisionDialog) { disposed += 1; return originalDispose.call(this) }
  try {
    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: f.backend.request('question-esc', 'question') })
    await until(() => f.app.pendingDecisionCount === 1, 'question visible')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /Esc cancel/, 'the hint names the cancel semantics')
    // Move to the custom-answer row (option count + 1) and type an unconfirmed draft.
    f.terminal.type('3')
    f.terminal.type('my custom answer')
    f.terminal.type('\x1b')
    await until(() => f.backend.responses.length === 1, 'Esc settles the native request')
    assert.deepEqual(f.backend.responses[0], { id: 'question-esc', value: { cancelled: true } },
      'Esc is a native cancel, never the unfinished draft answer')
    assert.equal(f.app.pendingDecisionCount, 0, 'the cancelled question is no longer pending')
    await until(() => f.app.editor.focused, 'the prompt owns the surface again')
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /Fixture question/, 'the dialog is gone')
    assert.doesNotMatch(f.terminal.screen(), /\/questions/, 'the removed reopen command is never advertised')
    assert.doesNotMatch(f.terminal.screen(), /Question pending/, 'no hidden pending-question state exists')
    await until(() => disposed === 1, 'the cancelled dialog disposed once')
  } finally {
    DecisionDialog.prototype.dispose = originalDispose
    await f.close()
  }
})

test('cancelling a question hands the surface to the next pending decision', async () => {
  const f = await fixture()
  try {
    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: f.backend.request('question-first', 'question') })
    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: f.backend.request('approval-second', 'approval') })
    await until(() => f.app.pendingDecisionCount === 2, 'both native requests queued')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /Fixture question/, 'the FIFO head owns the dialog')
    f.terminal.type('\x1b')
    await until(() => f.backend.responses.length === 1, 'the head request settled as cancelled')
    assert.deepEqual(f.backend.responses[0], { id: 'question-first', value: { cancelled: true } })
    await until(() => f.app.pendingDecisionCount === 1, 'only the approval remains pending')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /Fixture approval/, 'the next pending decision shows immediately')
    assert.doesNotMatch(f.terminal.screen(), /Fixture question/)
    f.terminal.type('\x1b')
    await until(() => f.backend.responses.length === 2, 'the approval keeps its own Esc semantics')
    assert.deepEqual(f.backend.responses[1], { id: 'approval-second', value: 'rejected' })
  } finally { await f.close() }
})

test('late send rejection after reattachment cannot overwrite the new editor', async () => {
  const f = await fixture()
  try {
    let rejectSend!: (error: Error) => void
    f.backend.sendGate = new Promise<void>((_, reject) => { rejectSend = reject })
    const sending = f.app.submit('old attachment prompt')
    f.terminal.type('draft on old editor')
    await delay(10)
    f.backend.info = { ...f.backend.info, attachmentId: 'cancel-fixture-attachment-2', events: [] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    await paint(f.terminal)
    assert.equal(f.app.editor.getText(), '', 'new attachment starts with its own editor')
    rejectSend(new Error('late transport rejection'))
    await sending
    assert.equal(f.app.editor.getText(), '', 'stale rejection never restores an old prompt into the new attachment')
  } finally { await f.close() }
})

test('late catalog results after attachment or route change cannot open a stale picker', async () => {
  const f = await fixture()
  try {
    let releaseModels!: () => void
    f.backend.modelsGate = new Promise<void>(resolve => { releaseModels = resolve })
    void f.app.submit('/model')
    await delay(10)
    f.backend.info = { ...f.backend.info, attachmentId: 'cancel-fixture-attachment-2', events: [] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    releaseModels()
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /Choose model/)

    let releaseEfforts!: () => void
    f.backend.effortsGate = new Promise<void>(resolve => { releaseEfforts = resolve })
    void f.app.submit('/effort')
    await delay(10)
    f.backend.info = { ...f.backend.info, model: 'route-changed-model' }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    releaseEfforts()
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /Choose reasoning effort/)
  } finally { await f.close() }
})

test('Settings auto title uses only the native command and preserves inherit at startup', async () => {
  const inherited = await fixture()
  try {
    assert.equal(inherited.backend.commands.some(command => command.name === 'auto-title'), true, 'startup queries the native capability')
    assert.equal(inherited.backend.commands.some(command => command.name === 'auto-title' && command.args.enabled !== undefined), false, 'inherit never forces false/true')
    await inherited.app.submit('/settings')
    await paint(inherited.terminal)
    inherited.terminal.type('\x1b[H'); await paint(inherited.terminal)
    assert.ok(inherited.terminal.screen().split('\n').some(line => line.includes('Auto title') && line.includes('inherit')))
    assert.match(inherited.terminal.screen(), /may use the model/)
    inherited.terminal.type('\x1b')
  } finally { await inherited.close() }

  const f = await fixture()
  try {
    await f.app.submit('/settings')
    await paint(f.terminal)
    f.terminal.type('1')
    await until(() => f.backend.autoTitleEnabled === true, 'native auto-title changed to on')
    const set = f.backend.commands.filter(command => command.name === 'auto-title' && command.args.enabled !== undefined).at(-1)
    assert.deepEqual(set?.args, { enabled: true })
    let persisted = false
    for (let attempt = 0; attempt < 100 && !persisted; attempt++) {
      try { persisted = JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')).autoTitle === true } catch { /* write not yet visible */ }
      if (!persisted) await delay(10)
    }
    assert.equal(persisted, true, 'local preference persisted')
    assert.equal(f.backend.info.attachmentId, 'cancel-fixture-attachment-1', 'title setting never resets the Agent/attachment')
    assert.equal(f.app.editor.getText(), '')
  } finally { await f.close() }
})

test('an explicit local auto-title override is applied at startup through the native command', async () => {
  const f = await fixture({ settings: { autoTitle: false } })
  try {
    await until(() => f.backend.commands.some(command => command.name === 'auto-title' && command.args.enabled === false), 'startup applies the local override')
    assert.equal(f.backend.autoTitleEnabled, false)
    assert.equal(f.backend.info.attachmentId, 'cancel-fixture-attachment-1', 'no Agent reset')
  } finally { await f.close() }
})

test('unsupported native auto-title is reported explicitly and no local preference is written', async () => {
  const f = await fixture()
  try {
    f.backend.autoTitleAvailable = false
    await f.app.submit('/settings')
    await paint(f.terminal)
    f.terminal.type('1')
    await until(() => notice(f.app).includes('Auto title was not changed'), 'unsupported capability reported')
    assert.match(notice(f.app), /unavailable/)
    await assert.rejects(readFile(join(f.directory, 'settings.json'), 'utf8'), /ENOENT/)
  } finally { await f.close() }
})

test('reload never claims every plugin is live when restartReason or pending modules remain', async () => {
  const f = await fixture()
  try {
    f.backend.reloadResult = { available: true, warnings: [], pending: ['module-a'], restartReason: 'module outside the native reload scope' }
    await f.app.submit('/reload')
    let text = notice(f.app)
    assert.match(text, /Restart required: module outside the native reload scope/)
    assert.match(text, /not all native changes are running yet/)
    assert.doesNotMatch(text, /configuration and plugins reconciled/)

    f.backend.reloadResult = { available: true, warnings: [], pending: [] }
    await f.app.submit('/reload')
    text = notice(f.app)
    assert.equal(text, 'Reloaded settings, keybindings and DSH configuration.', 'normal success is one concise line')
  } finally { await f.close() }
})

test('compact reload feedback preserves native warnings, unavailable scope and failures', async () => {
  const f = await fixture()
  try {
    f.backend.reloadResult = { available: true, warnings: ['Native configuration needs attention.'], pending: [] }
    await f.app.submit('/reload')
    assert.equal(notice(f.app), 'Reloaded settings, keybindings and DSH configuration.\nNative configuration needs attention.')

    f.backend.reloadResult = { available: false }
    await f.app.submit('/reload')
    assert.match(notice(f.app), /DSH reload is unavailable.*restart required/)
    assert.doesNotMatch(notice(f.app), /Reloaded settings, keybindings and DSH configuration/)

    f.backend.reloadFailure = new Error('native reconcile failed')
    await f.app.submit('/reload')
    assert.match(notice(f.app), /DSH configuration was not reloaded: native reconcile failed/)
    assert.equal(f.app.store.items.filter(item => item.kind === 'notice').at(-1)?.level, 'error')
    assert.doesNotMatch(notice(f.app), /Reloaded settings, keybindings and DSH configuration/)
  } finally { await f.close() }
})

test('compact reload feedback never claims malformed local settings or keybindings were applied', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, 'settings.json'), '{ INVALID SETTINGS')
    await f.app.submit('/reload')
    assert.match(notice(f.app), /Settings not applied/)
    assert.doesNotMatch(notice(f.app), /Reloaded settings, keybindings and DSH configuration/)

    await writeFile(join(f.directory, 'settings.json'), '{}')
    await writeFile(join(f.directory, 'keybindings.json'), '{ INVALID BINDINGS')
    await f.app.submit('/reload')
    assert.match(notice(f.app), /Keybindings were not applied/)
    assert.doesNotMatch(notice(f.app), /Reloaded settings, keybindings and DSH configuration/)
  } finally { await f.close() }
})

test('shutdown restores the terminal before a slow bounded native close and preserves SIGINT exit 130', async () => {
  const f = await fixture()
  try {
    let releaseClose!: () => void
    f.backend.closeGate = new Promise<void>(resolve => { releaseClose = resolve })
    const closing = f.app.shutdown(130)
    assert.equal(f.terminal.stopped, true, 'Pi terminal was restored synchronously before backend.close')
    const repeated = f.app.shutdown(130)
    releaseClose()
    await closing
    await repeated
    assert.equal(f.backend.closes, 1, 'repeated shutdown is idempotent')
    assert.equal(await f.app.exited, 130)
  } finally { await f.close() }
})

test('an external SIGINT handler exits 130 after restoring the terminal', async () => {
  const f = await fixture({ registerSignals: true })
  try {
    process.emit('SIGINT')
    assert.equal(await f.app.exited, 130)
    assert.equal(f.terminal.stopped, true)
    process.emit('SIGINT')
    assert.equal(f.backend.closes, 1)
  } finally { await f.close() }
})
test('reload reapplies an explicit local auto-title override without resetting the Agent', async () => {
  const f = await fixture({ settings: { autoTitle: false } })
  try {
    await until(() => f.backend.commands.some(command => command.name === 'auto-title' && command.args.enabled === false), 'startup override applied')
    const attachment = f.backend.info.attachmentId
    await writeFile(join(f.directory, 'settings.json'), JSON.stringify({ autoTitle: true }))
    f.backend.autoTitleEnabled = false
    await f.app.submit('/reload')
    await until(() => f.backend.commands.filter(command => command.name === 'auto-title' && command.args.enabled === true).length > 0, 'reload reapplies the new local override')
    assert.equal(f.backend.info.attachmentId, attachment, 'reload never recreates the Agent')
  } finally { await f.close() }
})

test('native model default persistence limitations are reported, never implied as a real profile save', async () => {
  const f = await fixture()
  try {
    f.backend.modelDefaultWarning = 'DSH 0.2.1-rc.5 writes only its private runtime profile; the real profile is unchanged.'
    await f.app.submit('/model')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /Choose model/)
    f.terminal.type('\r')
    await until(() => notice(f.app).includes('real profile is unchanged'), 'native persistence limitation surfaced')
    assert.match(notice(f.app), /runtime profile/)
  } finally { await f.close() }
})

test('overlapping model setters never resurrect a stale provider/model response', async () => {
  const f = await fixture()
  try {
    let releaseStale!: () => void
    f.backend.modelGates.set('stale-model', new Promise<void>(resolve => { releaseStale = resolve }))
    f.backend.staleModelResponses.add('stale-model')
    const stale = f.app.submit('/model stale-model')
    await until(() => f.backend.commands.some(command => command.name === 'model' && command.args.id === 'stale-model'), 'stale setter in flight')
    f.backend.info = { ...f.backend.info, provider: 'other-provider', model: 'new-model' }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    releaseStale()
    await stale
    assert.equal(f.app.session?.provider, 'other-provider')
    assert.equal(f.app.session?.model, 'new-model', 'late response cannot restore the old route after a ready update')

    let releaseFirst!: () => void
    f.backend.modelGates.set('first-model', new Promise<void>(resolve => { releaseFirst = resolve }))
    f.backend.staleModelResponses.add('first-model')
    const first = f.app.submit('/model first-model')
    await until(() => f.backend.commands.some(command => command.name === 'model' && command.args.id === 'first-model'), 'first setter in flight')
    await f.app.submit('/model second-model')
    assert.equal(f.app.session?.model, 'second-model')
    releaseFirst()
    await first
    assert.equal(f.app.session?.model, 'second-model', 'an older overlapping setter response cannot win')
  } finally { await f.close() }
})

test('a late effort response cannot restore the route after a same-attachment ready update', async () => {
  const f = await fixture()
  try {
    let release!: () => void
    f.backend.effortGate = new Promise<void>(resolve => { release = resolve })
    f.backend.staleEffortResponse = true
    const pending = f.app.submit('/effort high')
    await until(() => f.backend.commands.some(command => command.name === 'effort' && command.args.id === 'high'), 'effort setter in flight')
    f.backend.info = { ...f.backend.info, provider: 'next-provider', model: 'next-model' }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    release()
    await pending
    assert.equal(f.app.session?.provider, 'next-provider')
    assert.equal(f.app.session?.model, 'next-model')
  } finally { await f.close() }
})

test('a later local dialog wins over an in-flight model catalog result', async () => {
  const f = await fixture()
  try {
    let release!: () => void
    f.backend.modelsGate = new Promise<void>(resolve => { release = resolve })
    void f.app.submit('/model')
    await until(() => f.backend.commands.some(command => command.name === 'models'), 'model catalog in flight')
    await f.app.submit('/settings')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /Settings/)
    release()
    await delay(50); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Settings/, 'the newer Settings surface stays')
    assert.doesNotMatch(f.terminal.screen(), /Choose model/, 'a stale catalog cannot replace the later dialog')
  } finally { await f.close() }
})
