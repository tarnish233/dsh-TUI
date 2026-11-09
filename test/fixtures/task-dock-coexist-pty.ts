/** Explicit offline PTY projection fixture; it is not a native DSH backend. */
import { App } from '../../src/app.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../../src/demo.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo, SubagentEntry } from '../../src/backend/types.ts'
import type { GoalRead, GoalStateView } from '../../src/backend/native-inspection.ts'

const cwd = process.argv[2], configDir = process.argv[3]
const screen = process.argv[5] === 'inline' ? 'inline' : 'fullscreen'
if (!cwd || !configDir) throw new Error('Owned fixture paths are required')

class CoexistFixture implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private seq = 0
  private stage = 0
  private goal: GoalStateView | null = null
  private readonly info: SessionInfo = { sessionId: 'pty-coexist-root', attachmentId: 'pty-coexist-attachment', cwd,
    provider: 'fixture-only', model: 'no-model-calls', capabilities: ['commands', 'native-goal', 'demo'] }
  onEvent(listener: (event: BackendEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { return this.info }
  async send(text: string) {
    if (text === 'presentation') {
      await this.send('history')
      this.advance(); this.advance(); this.advance()
      this.fact('tool/call', { turn: 1, step: 1, callId: 'pty-presentation-read', name: 'fixture_read', arguments: '{}' })
      this.fact('tool/result', { turn: 1, step: 1, message: { id: 'pty-presentation-result', role: 'tool',
        toolCallId: 'pty-presentation-read', source: { kind: 'tool', callId: 'pty-presentation-read' },
        content: [{ type: 'text', text: 'line one\nline two\nline three' }] } })
      const summary = 'Fixture child completed; this is a status update, not a tool.'
      this.fact('user/message', { id: 'pty-presentation-notice', role: 'user', source: { kind: 'subagent-settled',
        form: 'notice', senderSessionId: 'pty-coexist-child', summary },
        content: [{ type: 'text', text: summary + '\n\nPTY PRESENTATION NOTICE BODY' }] })
      return
    }
    if (text === 'message') {
      this.fact('user/message', { id: 'pty-presentation-message', role: 'user', source: { kind: 'agent-message',
        senderSessionId: 'pty-coexist-child' }, content: [{ type: 'text', text: 'Agent pty-coexist-child sent a message: PTY ACTUAL MESSAGE VISIBLE' }] })
      return
    }
    if (text !== 'history') throw new Error('Offline PTY fixture only accepts explicit scene controls')
    this.emit({ type: 'todos', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId,
      value: Array.from({ length: 6 }, (_, index) => ({ content: index === 0 ? 'PTY COEXIST TODO' : `PTY step ${index}`,
        status: index === 0 ? 'in_progress' as const : 'pending' as const })) })
    for (let index = 0; index < 70; index++) this.emit({ type: 'session_event', sessionId: this.info.sessionId,
      event: { type: 'user/message', seq: this.seq++, data: { content: [{ type: 'text', text: 'PTY stable history ' + index }], source: { kind: 'user' } } } })
  }
  private fact(type: string, data: unknown): void {
    this.emit({ type: 'session_event', sessionId: this.info.sessionId,
      event: { type, seq: this.seq++, data, surfaceOp: 'append' } })
  }
  /** Test-owned signal advances projection facts without touching the draft. */
  advance(): void {
    this.stage++
    const running = this.stage === 1 || this.stage === 3
    const child: SubagentEntry = { id: 'pty-coexist-child', parentSessionId: this.info.sessionId,
      mode: 'one-shot', status: running ? 'running' : 'completed', label: 'PTY CHILD LABEL', local: true,
      lastActivity: running ? 'PTY native current activity' : undefined }
    this.emit({ type: 'subagents', sessionId: this.info.sessionId, value: { entries: [child] } })
    if (this.stage === 3) {
      this.goal = { id: 'pty-coexist-goal', revision: 1, objective: 'PTY GOAL OBJECTIVE', phase: 'active',
        roundsStarted: 2, maxGoalRounds: 6, activation: 'armed' }
      this.emit({ type: 'native_ui_changed', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId, domain: 'goal' })
    }
  }
  async command(name: string, _args?: JsonRecord): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'state') return { queued: 0, queue: [], pending: { nextTurn: 0, nextStep: 0 } }
    if (name === 'auto-title') return { available: false }
    if (name === 'native-goal') return { available: true, complete: true, sessionId: this.info.sessionId, goal: this.goal } satisfies GoalRead
    throw new Error('No native business command in the offline PTY fixture: ' + name)
  }
  async respond() { throw new Error('No native decision in the offline PTY fixture') }
  async cancel() {}
  async close() {}
}

const backend = new CoexistFixture()
const advance = () => { backend.advance() }
process.on('SIGUSR2', advance)
const app = new App({ backend, cwd, configDir, screen, demo: true })
try {
  await app.start()
  await app.exited
} finally {
  process.off('SIGUSR2', advance)
}
