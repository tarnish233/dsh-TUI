/** Explicit offline PTY fixture for the production App/one-editor renderer. */
import { writeFile } from 'node:fs/promises'
import { App } from '../../src/app.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../../src/demo.ts'
import type { Backend, BackendEvent, EncodedFileInput, FileAttachmentRef, JsonRecord, PromptContentPart, SessionInfo } from '../../src/backend/types.ts'

const cwd = process.argv[2], configDir = process.argv[3], resultPath = process.argv[4]
const screen = process.argv[5] === 'inline' ? 'inline' : 'fullscreen'
if (!cwd || !configDir || !resultPath) throw new Error('owned fixture paths are required')

class FixtureBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private seq = 0
  private readonly info: SessionInfo = { sessionId: 'pty-native-ui-fixture', attachmentId: 'pty-native-ui-attachment', cwd,
    provider: 'fixture-only', model: 'no-model-calls', capabilities: ['commands', 'execute', 'file-input', 'prompt-content', 'demo'] }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  private user(text: string) { this.emit({ type: 'session_event', sessionId: this.info.sessionId,
    event: { type: 'user/message', seq: this.seq++, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } } }) }
  async connect() { return this.info }
  async send(text: string) {
    if (text === 'history') {
      this.emit({ type: 'todos', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId, value: [
        { content: 'PTY FIXED TODO', status: 'in_progress' }, { content: 'PTY pending step', status: 'pending' },
      ] })
      for (let i = 0; i < 90; i++) this.user('PTY history line ' + i)
    } else if (text === 'update') {
      this.emit({ type: 'todos', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId, value: [
        { content: 'PTY FIXED TODO', status: 'completed' }, { content: 'PTY updated step', status: 'in_progress' },
      ] })
    } else if (text === 'clear') this.emit({ type: 'todos', sessionId: this.info.sessionId, value: null })
    else this.user(text)
  }
  async stageFile(input: EncodedFileInput): Promise<FileAttachmentRef> {
    return { attachmentId: 'explicit-fixture-file', name: input.name ?? 'file', bytes: Buffer.from(input.data, 'base64').length }
  }
  async sendContent(content: readonly PromptContentPart[]) {
    await writeFile(resultPath, JSON.stringify({ nativeFixtureOnly: true, content }))
    this.emit({ type: 'session_event', sessionId: this.info.sessionId,
      event: { type: 'user/message', seq: this.seq++, data: { content, source: { kind: 'user' } } } })
  }
  async command(name: string, _args?: JsonRecord): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'state') return { queued: 0, queue: [], pending: { nextTurn: 0, nextStep: 0 } }
    if (name === 'auto-title') return { available: false }
    throw new Error('No native business command in this explicit offline fixture: ' + name)
  }
  async respond() { throw new Error('No native decision in the offline PTY fixture') }
  async cancel() {}
  async close() {}
}
const app = new App({ backend: new FixtureBackend(), cwd, configDir, screen, demo: true })
await app.start()
await app.exited
