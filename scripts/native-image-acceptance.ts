/** Renderer-only native-terminal acceptance. Synthetic bytes, no DSH/model/user clipboard. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import type { Backend, BackendEvent, ImageAttachmentRef, ImageAttachmentValue, SessionInfo } from '../src/backend/types.ts'
import { imageFixture } from '../test/helpers/images.ts'

const screen = process.argv.includes('--inline') ? 'inline' : 'fullscreen'
const image = await imageFixture('image/png', 'native-four-quadrants.png', 720, 360)
const directory = await mkdtemp(join(tmpdir(), 'dsh-native-image-acceptance-'))
const info: SessionInfo = {
  sessionId: 'native-image-fixture', attachmentId: 'native-image-fixture-attachment', cwd: process.cwd(),
  provider: 'OFFLINE FIXTURE', model: 'NO MODEL CALLED', capabilities: ['images', 'state', 'commands'],
  events: [{ type: 'user/message', seq: 1, surfaceOp: 'append', data: {
    content: [{ type: 'text', text: 'Native terminal image acceptance: red / green / blue / yellow quadrants. Fixture only.' },
      { type: 'image', attachment: image.attachment }], source: { kind: 'user' },
  } }],
}
const listeners = new Set<(event: BackendEvent) => void>()
const backend: Backend = {
  transcriptCodec: DEMO_TRANSCRIPT_CODEC,
  onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  async connect() { return info },
  async send() { throw new Error('This renderer acceptance fixture never submits prompts.') },
  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<ImageAttachmentValue> {
    if (signal?.aborted) throw signal.reason
    if (ref.attachmentId !== image.attachment.attachmentId) throw new Error('Unknown fixture image')
    return image.value
  },
  async cancel() {},
  async command(name) { return name === 'commands' ? [] : name === 'state' ? { queued: 0, pending: { nextStep: 0, nextTurn: 0 } } : { available: false } },
  async respond() {},
  async close() { listeners.clear() },
}
const app = new App({ backend, cwd: process.cwd(), configDir: directory, screen, demo: true })
try {
  await app.start()
  // Use the public editor/keymap seam; only Pi's renderer writes escape sequences.
  app.editor.handleInput('\x18')
  app.editor.handleInput('\t')
  process.exitCode = await app.exited
} finally {
  await app.shutdown().catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
