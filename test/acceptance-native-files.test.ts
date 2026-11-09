/** Real native attachment admission/factory receipts; UI projection is live/cold fixture replay, not a remote model. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeDshManifest } from './helpers/native-profile.ts'
import { asFileAttachmentRef, displayContentParts } from '../src/attachments.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import type { SessionEvent, SessionInfo } from '../src/backend/types.ts'

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as RecordValue
}
function invoke(target: RecordValue, name: string, args: unknown[]): unknown {
  const fn = target[name]
  assert.equal(typeof fn, 'function', `public native ${name} is mounted/exported`)
  return Reflect.apply(fn as (...args: unknown[]) => unknown, target, args)
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  for (const child of Object.values(value)) freeze(child)
  Object.freeze(value)
}

test('real native file receipts survive live/cold mixed and file-only projection without altering durable facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-file-receipts-'))
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  // Only non-secret path variables are scoped/restored in this isolated test worker.
  const original = { HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME }
  process.env.HOME = home
  process.env.DSH_HOME = home
  let context: RecordValue | undefined
  try {
    const resolver = createRequire(await nativeDshManifest())
    const load = async (name: string): Promise<RecordValue> => {
      const value: unknown = await import(pathToFileURL(resolver.resolve(name)).href)
      return record(value)
    }
    const cordis = await load('@deepseek-ai/cordis')
    const local = await load('@deepseek-ai/dsh-attachment-local')
    const llm = await load('@deepseek-ai/dsh-llm')
    assert.equal(typeof cordis.Context, 'function')
    context = record(Reflect.construct(cordis.Context as new () => object, []))
    await invoke(context, 'plugin', [local.LocalAttachmentStore, { dshHome: home }, true])
    const attachments = record(invoke(context, 'get', ['attachments']))
    const bytes = new TextEncoder().encode('name,value\nfixture,32\n')
    const saved = await invoke(attachments, 'saveFile', [{ data: bytes, name: 'quarterly.csv' }])
    const ref = asFileAttachmentRef(saved)
    assert.ok(ref)
    assert.equal(ref.name, 'quarterly.csv')
    assert.equal(ref.bytes, bytes.length)
    const content = await invoke(attachments, 'admitPromptContent', [[
      { type: 'text', text: 'before native file' }, { type: 'file', attachment: saved },
      { type: 'text', text: 'after native file' }, { type: 'file', attachment: saved },
    ]])
    assert.deepEqual(displayContentParts(content).map(part => part.type), ['text', 'file', 'text', 'file'])
    const mixed = invoke(llm, 'createUserMessage', [{ content, source: { kind: 'user' } }])
    const onlyFile = invoke(llm, 'createUserMessage', [{ content: [{ type: 'file', attachment: saved }], source: { kind: 'user' } }])
    const events: SessionEvent[] = [
      { type: 'user/message', seq: 0, time: 0, data: mixed, surfaceOp: 'append' },
      { type: 'user/message', seq: 1, time: 1, data: onlyFile, surfaceOp: 'append' },
    ]
    freeze(events)
    const before = JSON.stringify(events)
    const info: SessionInfo = { sessionId: 'native-files', cwd: directory,
      provider: 'fixture', model: 'fixture', capabilities: [], events }
    const cold = new TranscriptStore(), live = new TranscriptStore()
    cold.reset(info)
    live.reset({ ...info, events: [] })
    for (const event of events) live.handle({ type: 'session_event', sessionId: info.sessionId, event })
    for (const store of [cold, live]) {
      const users = store.items.filter(item => item.kind === 'user')
      assert.equal(users.length, 2, 'file-only native prompts remain visible')
      assert.deepEqual(users[0]?.content?.map(part => part.type), ['text', 'file', 'text', 'file'])
      assert.equal(users[1]?.content?.[0]?.type, 'file')
      const files = users.flatMap(item => item.content ?? []).flatMap(part => part.type === 'file' ? [part.attachment] : [])
      assert.equal(files.length, 3)
      assert.ok(files.every(file => file.attachmentId === ref.attachmentId))
      assert.ok(users.every(item => item.imageCount === 0))
      const view = new TranscriptView(store, { showThinking: true, expandTools: false })
      try {
        for (const width of [40, 80, 120]) {
          const rendered = view.render(width).join('\n')
          assert.match(rendered, /File #1/)
          assert.match(rendered, /quarterly\.csv/)
          assert.doesNotMatch(rendered, /ctrl\+i to view/)
        }
      } finally { view.dispose() }
    }
    assert.equal(JSON.stringify(events), before)
    const stream = invoke(attachments, 'readFileStream', [saved])
    assert.ok(stream !== null && typeof stream === 'object' && Symbol.asyncIterator in stream)
    const chunks: Uint8Array[] = []
    for await (const chunk of stream as AsyncIterable<unknown>) {
      assert.ok(chunk instanceof Uint8Array)
      chunks.push(chunk)
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes), 'native byte integrity/read ownership stays unchanged')
  } finally {
    try {
      if (context !== undefined) await invoke(record(context.fiber), 'dispose', [])
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
})
