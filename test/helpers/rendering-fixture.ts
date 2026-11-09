import type { Backend, BackendEvent, SessionEvent, SessionInfo } from '../../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../../src/demo.ts'

export class RenderingFixture implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly info: SessionInfo
  constructor(cwd: string) {
    let seq = 0
    const event = (type: string, data: unknown, toolPresentation?: SessionEvent['toolPresentation']): SessionEvent => ({
      type, seq: seq++, data, surfaceOp: 'append', ...(toolPresentation ? { toolPresentation } : {}) })
    const call = (id: string, name: string, title: string) => event('tool/call', { turn: 1, step: 1, callId: id, name,
      arguments: name === 'read_image' ? JSON.stringify({ path: '/fixture/image.png' }) : '{}' },
      { call: { card: 'generic', title } })
    const result = (id: string, title?: string) => event('tool/result', { turn: 1, step: 1,
      message: { id: 'result-' + id, role: 'tool', toolCallId: id, source: { kind: 'tool', callId: id },
        content: [{ type: 'text', text: 'line one\nline two\nline three' }] } },
      title ? { result: { card: 'generic', title, content: [{ type: 'text', text: 'line one\nline two\nline three' }] } } : undefined)
    const reasoning = (id: string) => event('assistant/message', { turn: 1, step: 1,
      message: { id, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [{ type: 'reasoning', text: Array.from({ length: 30 }, (_, i) => 'native reasoning ' + i).join('\n') }] }, stream: [] })
    this.info = { sessionId: 'rendering-fixture-root', attachmentId: 'rendering-fixture-attachment', cwd,
      provider: 'fixture', model: 'fixture', capabilities: ['commands'], events: [
        call('first', 'run_code', 'FIRST TOOL TITLE'), result('first'), reasoning('first-thinking'),
        call('image', 'read_image', 'Read image /fixture/image.png'), result('image', 'Read image /fixture/image.png'), reasoning('second-thinking'),
        call('group-a', 'run_code', 'GROUP TOOL A'), result('group-a'), call('group-b', 'run_code', 'GROUP TOOL B'), result('group-b'),
      ] }
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async connect() { return this.info }
  async send() { throw new Error('Offline rendering fixture never sends a prompt') }
  async respond() { throw new Error('No decision in rendering fixture') }
  async cancel() {}
  async close() {}
  async command(name: string): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'state') return { queue: [], queued: 0, pending: { nextTurn: 0, nextStep: 0 } }
    throw new Error('Unknown offline fixture read: ' + name)
  }
}

