/**
 * Native general-file input: prompt admission over the public attachment
 * store, file-aware queue recall, and the exact native command attachment
 * boundary. Synthetic stores model the public shapes; one offline test runs
 * against the installed native LocalAttachmentStore in a temporary home.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  NativeFileInput,
  admittedPromptContent,
  commandDeclaresAttachments,
  commandOutcome,
  commandSettlesAsError,
  contentCounts,
  encodeFileBytes,
  isCanonicalBase64,
  normalizeCommandAttachments,
  normalizeFileInput,
  normalizePromptContent,
  queueReplacementContent,
  recallableParts,
} from '../src/backend/native-files.ts'
import { backendError } from '../src/backend/errors.ts'
import { nativeDshManifest } from './helpers/native-profile.ts'
import type { CommandAttachmentPart, DisplayContentPart, FileAttachmentRef, PromptContentPart } from '../src/backend/types.ts'
import type { NativeUiAccess, NativeUiScope } from '../src/backend/native-ui-scope.ts'

type RecordValue = Record<string, unknown>

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function digest(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function leafName(name: string | undefined): string {
  if (name === undefined) return 'file'
  const leaf = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).trim()
  return leaf === '' ? 'file' : leaf
}

interface StoreCalls {
  encoded: unknown[]
  saved: unknown[]
  admitted: unknown[]
  /** Argument count per native admission call; the public method takes exactly one. */
  admittedArity: number[]
  readImage: unknown[]
  readFileStream: unknown[]
}

function fakeStore(overrides: Record<string, unknown> = {}): { store: RecordValue; calls: StoreCalls } {
  const calls: StoreCalls = { encoded: [], saved: [], admitted: [], admittedArity: [], readImage: [], readFileStream: [] }
  const store: RecordValue = {
    admitEncodedFile: async (input: { data: string; name?: string }) => {
      calls.encoded.push(input)
      const bytes = Buffer.from(input.data, 'base64')
      return { attachmentId: `sha256:${digest(bytes)}`, name: leafName(input.name), bytes: bytes.length }
    },
    saveFile: async (input: { data: Uint8Array; name?: string }) => {
      calls.saved.push(input)
      return { attachmentId: `sha256:${digest(input.data)}`, name: leafName(input.name), bytes: input.data.length }
    },
    admitPromptContent: async (content: readonly RecordValue[], ...rest: unknown[]) => {
      calls.admitted.push(content)
      calls.admittedArity.push(1 + rest.length)
      return content.map((part) => {
        if (part.type === 'text') return { type: 'text', text: part.text }
        if (part.type === 'file') return { type: 'file', attachment: part.attachment }
        const bytes = Buffer.from(String(part.data), 'base64')
        return {
          type: 'image',
          attachment: {
            attachmentId: `sha256:${digest(bytes)}`,
            mediaType: part.mediaType,
            bytes: bytes.length,
            width: 1,
            height: 1,
            ...(typeof part.name === 'string' ? { name: part.name } : {}),
          },
        }
      })
    },
    readImage: async (ref: unknown) => {
      calls.readImage.push(ref)
      throw new Error('a file input must never read image bytes')
    },
    readFileStream: (ref: unknown) => {
      calls.readFileStream.push(ref)
      throw new Error('a READY file reference must never be re-read')
    },
    ...overrides,
  }
  return { store, calls }
}

interface Host {
  readonly access: NativeUiAccess
  readonly services: Map<string, unknown>
  /** Every service this adapter asked for, in order; discovery must stay small. */
  readonly reads: string[]
  invalidate(): void
}

function fakeHost(services: Record<string, unknown>, scope: NativeUiScope = { sessionId: 's1', attachmentId: 'a1' }): Host {
  const current: { scope: NativeUiScope } = { scope }
  const host: Host = {
    services: new Map(Object.entries(services)),
    reads: [],
    access: {
      host: {},
      service(name: string) {
        host.reads.push(name)
        return host.services.get(name)
      },
      current() { return current.scope },
      isCurrent(candidate: NativeUiScope) { return candidate === current.scope },
      warn() { /* diagnostics are not stdout */ },
    },
    invalidate() {
      current.scope = { sessionId: 's2', attachmentId: 'a2' }
    },
  }
  return host
}

function fileRef(name = 'notes.txt', bytes = 5): FileAttachmentRef {
  return { attachmentId: 'sha256:' + 'a'.repeat(64), name, bytes }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

test('canonical base64 is exactly the native file wire fact, including the empty file', () => {
  assert.equal(isCanonicalBase64(''), true)
  assert.equal(isCanonicalBase64('AAEC'), true)
  assert.equal(isCanonicalBase64('AA=='), true)
  assert.equal(isCanonicalBase64('AB=='), false, 're-encoding must be byte-identical')
  assert.equal(isCanonicalBase64(' AAA='), false)
  assert.equal(isCanonicalBase64('AAA'), false)
  assert.equal(isCanonicalBase64('AAA='), true)
  assert.equal(isCanonicalBase64(1), false)
  assert.equal(encodeFileBytes(new Uint8Array([0, 1, 2])), 'AAEC')
  assert.throws(() => encodeFileBytes('AAEC' as unknown as Uint8Array), /Uint8Array/)
  assert.deepEqual(normalizeFileInput({ data: '' }), { data: '' })
  assert.deepEqual(normalizeFileInput({ data: 'AAEC', name: 'a.bin' }), { data: 'AAEC', name: 'a.bin' })
  assert.throws(() => normalizeFileInput({ data: 'AAA' }), /canonical base64/)
  assert.throws(() => normalizeFileInput({ data: 'AAEC', name: '' }), /non-empty string/)
  assert.throws(() => normalizeFileInput(null), /canonical base64/)
})

test('prompt normalization keeps mixed order, repeats and the durable file identity', () => {
  const ref = fileRef('quarterly.csv', 9)
  const parts = normalizePromptContent([
    { type: 'text', text: 'before' },
    { type: 'image', mediaType: 'image/png', data: PNG_1PX, name: 'shot.png' },
    { type: 'file', attachment: ref },
    { type: 'text', text: 'after' },
    { type: 'file', attachment: ref },
  ])
  assert.deepEqual(parts.map(part => part.type), ['text', 'image', 'file', 'text', 'file'])
  assert.deepEqual(parts[2], { type: 'file', attachment: ref })
  assert.equal((parts[1] as { name?: string }).name, 'shot.png')

  assert.throws(() => normalizePromptContent([]), /non-empty ordered/)
  assert.throws(() => normalizePromptContent('text'), /non-empty ordered/)
  assert.throws(() => normalizePromptContent([{ type: 'tool-call' }]), /unsupported prompt content/)
  assert.throws(() => normalizePromptContent([{ type: 'text', text: 1 }]), /text string/)
  assert.throws(() => normalizePromptContent([{ type: 'image', mediaType: 'image/tiff', data: PNG_1PX }]), /mediaType/)
  assert.throws(() => normalizePromptContent([{ type: 'image', mediaType: 'image/png', data: '' }]), /non-empty canonical base64/)
  assert.throws(() => normalizePromptContent([{ type: 'image', mediaType: 'image/png', data: 'AAA' }]), /non-empty canonical base64/)
  assert.throws(() => normalizePromptContent([{ type: 'image', mediaType: 'image/png', data: PNG_1PX, name: 2 }]), /name must be a string/)
  assert.throws(
    () => normalizePromptContent([{ type: 'image', attachment: { attachmentId: 'x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }]),
    /native upload byte count/,
  )
  assert.throws(() => normalizePromptContent([{ type: 'file', receiptId: 'r1' }]), /receipt id/)
  assert.throws(() => normalizePromptContent([{ type: 'file', attachment: { attachmentId: '', name: 'a', bytes: 1 } }]), /native \{ attachmentId/)
  assert.throws(() => normalizePromptContent([{ type: 'file', attachment: { attachmentId: 'x', name: 'a', bytes: -1 } }]), /native \{ attachmentId/)
})

test('admitted content validation preserves native order and rejects any substitution', () => {
  const ref = fileRef()
  const submitted: PromptContentPart[] = [
    { type: 'text', text: 'before' },
    { type: 'file', attachment: ref },
    { type: 'file', attachment: ref },
  ]
  const admitted = admittedPromptContent([
    { type: 'text', text: 'before' },
    { type: 'file', attachment: { ...ref } },
    { type: 'file', attachment: { ...ref } },
  ], submitted)
  assert.deepEqual(admitted.map(part => part.type), ['text', 'file', 'file'])

  assert.throws(() => admittedPromptContent([{ type: 'text', text: 'before' }], submitted), /length/)
  assert.throws(() => admittedPromptContent([
    { type: 'text', text: 'changed' },
    { type: 'file', attachment: ref },
    { type: 'file', attachment: ref },
  ], submitted), /altered admitted prompt text/)
  assert.throws(() => admittedPromptContent([
    { type: 'text', text: 'before' },
    { type: 'file', attachment: { ...ref, name: 'other.txt' } },
    { type: 'file', attachment: ref },
  ], submitted), /altered the admitted file reference/)
  assert.throws(() => admittedPromptContent([{ type: 'text', text: 'x' }, { type: 'image', attachment: {} }], [
    { type: 'text', text: 'x' },
    { type: 'image', mediaType: 'image/png', data: PNG_1PX },
  ]), /invalid admitted image reference/)
})

test('stageFile uses the exact native staging entry, canonical bytes and no invented limits', async () => {
  const { store, calls } = fakeStore()
  const host = fakeHost({ attachments: store })
  const staged = new NativeFileInput(host.access)
  const ref = await staged.stageFile({ data: 'AAEC', name: 'quarterly.csv' })
  assert.deepEqual(host.reads, ['attachments'], 'staging asks only the attachment service; no Agent, model or catalog')
  assert.deepEqual(calls.encoded, [{ data: 'AAEC', name: 'quarterly.csv' }])
  assert.equal(ref.bytes, 3)
  assert.equal(ref.name, 'quarterly.csv')

  const empty = await staged.stageFile({ data: '' })
  assert.equal(empty.bytes, 0)
  assert.equal(empty.name, 'file', 'native defaults the leaf name; the adapter does not invent one')

  const { store: saveOnly, calls: saveCalls } = fakeStore({ admitEncodedFile: undefined })
  const saveHost = fakeHost({ attachments: saveOnly })
  const saved = await new NativeFileInput(saveHost.access).stageFile({ data: 'AAEC', name: 'sheet.csv' })
  assert.equal(saved.bytes, 3)
  assert.equal(saveCalls.saved.length, 1)
  assert.deepEqual(Array.from((saveCalls.saved[0] as { data: Uint8Array }).data), [0, 1, 2])

  assert.deepEqual(calls.readImage, [])
  assert.deepEqual(calls.readFileStream, [])
})

test('stageFile fails closed on missing services, native refusal, staleness and cancellation', async () => {
  await assert.rejects(
    new NativeFileInput(fakeHost({}).access).stageFile({ data: 'AAEC' }),
    (error: unknown) => codeOf(error) === 'CAPABILITY_UNAVAILABLE',
  )
  const unsupported = new NativeFileInput(fakeHost({
    attachments: fakeStore({
      admitEncodedFile: async () => {
        throw Object.assign(new Error('The mounted attachment provider cannot store verbatim files.'), { code: 'ATTACHMENT_FILES_UNSUPPORTED' })
      },
    }).store,
  }).access)
  await assert.rejects(unsupported.stageFile({ data: 'AAEC' }), (error: unknown) =>
    codeOf(error) === 'CAPABILITY_UNAVAILABLE' && /cannot store verbatim files/.test(String((error as Error).message)))

  const failing = new NativeFileInput(fakeHost({
    attachments: fakeStore({
      admitEncodedFile: async () => {
        throw new Error('storage failed for Authorization: Bearer sk-live-secret-123')
      },
    }).store,
  }).access)
  await assert.rejects(failing.stageFile({ data: 'AAEC' }), (error: unknown) => {
    const message = String((error as Error).message)
    return codeOf(error) === 'RUNTIME_REQUEST_FAILED' && /\[redacted]/.test(message) && !/sk-live-secret-123/.test(message)
  })

  const shortRef = new NativeFileInput(fakeHost({
    attachments: fakeStore({ admitEncodedFile: async () => ({ attachmentId: 'sha256:x', name: 'a', bytes: 1 }) }).store,
  }).access)
  await assert.rejects(shortRef.stageFile({ data: 'AAEC' }), (error: unknown) =>
    codeOf(error) === 'RUNTIME_REQUEST_FAILED' && /different byte length/.test(String((error as Error).message)))

  let invalidate: (() => void) | undefined
  const staleHost = fakeHost({
    attachments: fakeStore({
      admitEncodedFile: async (input: { data: string; name?: string }) => {
        invalidate?.()
        return { attachmentId: 'sha256:x', name: leafName(input.name), bytes: Buffer.from(input.data, 'base64').length }
      },
    }).store,
  })
  invalidate = staleHost.invalidate
  await assert.rejects(new NativeFileInput(staleHost.access).stageFile({ data: 'AAEC' }), (error: unknown) =>
    codeOf(error) === 'STALE_SESSION')

  const { store, calls } = fakeStore()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(new NativeFileInput(fakeHost({ attachments: store }).access).stageFile({ data: 'AAEC' }, controller.signal),
    (error: unknown) => codeOf(error) === 'ABORTED')
  assert.deepEqual(calls.encoded, [], 'a cancelled stage starts no native write')

  const host = fakeHost({ attachments: store })
  const { access } = host
  const detached: NativeUiAccess = { ...access, current: () => undefined }
  await assert.rejects(new NativeFileInput(detached).stageFile({ data: 'AAEC' }), (error: unknown) =>
    codeOf(error) === 'NOT_CONNECTED')
})

test('admitPrompt calls native admission once with ordered content and never reads bytes for files', async () => {
  const { store, calls } = fakeStore()
  const host = fakeHost({ attachments: store })
  const input = new NativeFileInput(host.access)
  const ref = fileRef('report.pdf', 12)
  const content: PromptContentPart[] = [
    { type: 'text', text: 'before' },
    { type: 'file', attachment: ref },
    { type: 'text', text: 'after' },
    { type: 'file', attachment: ref },
  ]
  const admitted = await input.admitPrompt(content)
  assert.equal(calls.admitted.length, 1)
  assert.deepEqual(admitted.map(part => part.type), ['text', 'file', 'text', 'file'])
  assert.deepEqual(admitted[1], { type: 'file', attachment: ref })
  assert.deepEqual(admitted[3], { type: 'file', attachment: ref })
  assert.deepEqual(calls.readImage, [])
  assert.deepEqual(calls.readFileStream, [])

  const fileOnly = await input.admitPrompt([{ type: 'file', attachment: ref }])
  assert.deepEqual(fileOnly, [{ type: 'file', attachment: ref }])

  const imageAdmitted = await input.admitPrompt([{ type: 'image', mediaType: 'image/png', data: PNG_1PX }])
  assert.equal(imageAdmitted[0]?.type, 'image')
  assert.deepEqual(calls.readImage, [])

  const textOnly = await new NativeFileInput(fakeHost({}).access).admitPrompt([{ type: 'text', text: 'plain' }])
  assert.deepEqual(textOnly, [{ type: 'text', text: 'plain' }], 'text-only content needs no attachment service')

  assert.deepEqual(calls.readFileStream, [])
})

test('admitPrompt fails closed on refusal, staleness, cancellation and re-admission of stored images', async () => {
  const refusal = new NativeFileInput(fakeHost({
    attachments: fakeStore({
      admitPromptContent: async () => {
        throw Object.assign(new Error('Image exceeds the configured byte limit.'), { code: 'IMAGE_TOO_LARGE' })
      },
    }).store,
  }).access)
  await assert.rejects(refusal.admitPrompt([{ type: 'file', attachment: fileRef() }]), (error: unknown) =>
    codeOf(error) === 'RUNTIME_REQUEST_FAILED' && /Image exceeds/.test(String((error as Error).message)))

  let invalidate: (() => void) | undefined
  const staleHost = fakeHost({
    attachments: fakeStore({
      admitPromptContent: async () => {
        invalidate?.()
        return [{ type: 'file', attachment: fileRef() }]
      },
    }).store,
  })
  invalidate = staleHost.invalidate
  await assert.rejects(new NativeFileInput(staleHost.access).admitPrompt([{ type: 'file', attachment: fileRef() }]), (error: unknown) =>
    codeOf(error) === 'STALE_SESSION')

  const controller = new AbortController()
  const { store } = fakeStore()
  const abortHost = fakeHost({ attachments: store })
  const input = new NativeFileInput(abortHost.access)
  controller.abort()
  await assert.rejects(input.admitPrompt([{ type: 'file', attachment: fileRef() }], controller.signal), (error: unknown) =>
    codeOf(error) === 'ABORTED')

  await assert.rejects(new NativeFileInput(fakeHost({}).access).admitPrompt([{ type: 'file', attachment: fileRef() }]), (error: unknown) =>
    codeOf(error) === 'CAPABILITY_UNAVAILABLE')
})

test('the installed public admission entry takes no signal and the adapter forwards exactly one argument', async () => {
  const resolver = createRequire(await nativeDshManifest())
  const manifestPath = resolver.resolve('@deepseek-ai/dsh-attachment/package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { types?: string }
  const declaration = await readFile(join(dirname(manifestPath), manifest.types ?? 'lib/types/index.d.ts'), 'utf8')

  const admission = /admitPromptContent\(([^)]*)\)\s*:\s*Promise<([^;]+)>/.exec(declaration)
  assert.ok(admission, 'the installed package declares admitPromptContent')
  assert.match(admission[1]!, /content: readonly AttachmentAdmissionPart\[\]/)
  assert.doesNotMatch(admission[1]!, /signal|abort/i, 'public prompt admission exposes no cancellation parameter')
  assert.match(admission[2]!, /AdmittedPromptContentPart\[\]/)
  // The package does expose signals where native supports them; the absence
  // above is therefore a real API fact, not a regex miss.
  const readImage = /readImage\(ref: ImageAttachmentRef([^)]*)\)/.exec(declaration)
  assert.ok(readImage, 'the installed package declares readImage')
  assert.match(readImage[1]!, /signal\?: AbortSignal/)

  const loaded: unknown = await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-attachment')).href)
  assert.ok(loaded !== null && typeof loaded === 'object')
  const AttachmentStore: unknown = (loaded as RecordValue).AttachmentStore
  assert.ok(typeof AttachmentStore === 'function', 'the installed package exports the AttachmentStore class')
  const nativeAdmission = (AttachmentStore as { prototype: RecordValue }).prototype.admitPromptContent as (...args: unknown[]) => unknown
  assert.equal(typeof nativeAdmission, 'function')
  assert.equal(nativeAdmission.length, 1, 'the runtime entry declares exactly one parameter')

  const { store, calls } = fakeStore()
  await new NativeFileInput(fakeHost({ attachments: store }).access).admitPrompt([{ type: 'file', attachment: fileRef() }])
  assert.deepEqual(calls.admittedArity, [1], 'the adapter never fabricates a second signal argument')
})

test('pre-cancelled admission is refused before capability, service or native work', async () => {
  const { store, calls } = fakeStore()
  const host = fakeHost({ attachments: store })
  const controller = new AbortController()
  controller.abort()
  const input = new NativeFileInput(host.access)

  await assert.rejects(input.admitPrompt([{ type: 'file', attachment: fileRef() }], controller.signal), (error: unknown) =>
    codeOf(error) === 'ABORTED' && /native prompt attachment admission was cancelled/.test(String((error as Error).message)))
  assert.deepEqual(calls.admitted, [], 'a cancelled admission starts no native call')
  assert.deepEqual(host.reads, [], 'a cancelled admission does not even resolve the attachment service')

  const textHost = fakeHost({})
  await assert.rejects(new NativeFileInput(textHost.access).admitPrompt([{ type: 'text', text: 'plain' }], controller.signal),
    (error: unknown) => codeOf(error) === 'ABORTED')
  assert.deepEqual(textHost.reads, [], 'text-only cancellation also needs no attachment service')

  // Cancellation wins over a missing capability and a detached identity...
  await assert.rejects(new NativeFileInput(fakeHost({}).access).admitPrompt([{ type: 'file', attachment: fileRef() }], controller.signal),
    (error: unknown) => codeOf(error) === 'ABORTED')
  const detached: NativeUiAccess = { ...fakeHost({ attachments: store }).access, current: () => undefined }
  await assert.rejects(new NativeFileInput(detached).admitPrompt([{ type: 'file', attachment: fileRef() }], controller.signal),
    (error: unknown) => codeOf(error) === 'ABORTED')

  // ...but shape validation is pure and still runs first, matching stageFile.
  await assert.rejects(input.admitPrompt([], controller.signal), (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT')
})

test('mid-flight cancellation discards a late native admission and never returns admitted parts', async () => {
  const ref = fileRef('late.txt', 4)
  const pending = deferred<readonly unknown[]>()
  const { store, calls } = fakeStore({
    admitPromptContent: (content: readonly RecordValue[], ...rest: unknown[]) => {
      calls.admitted.push(content)
      calls.admittedArity.push(1 + rest.length)
      return pending.promise
    },
  })
  const controller = new AbortController()
  const call = new NativeFileInput(fakeHost({ attachments: store }).access)
    .admitPrompt([{ type: 'file', attachment: ref }], controller.signal)
  assert.equal(calls.admitted.length, 1)

  controller.abort()
  // Native admission has no signal, so the adapter must not invent an abort
  // race or a second timeout: it stays pending until native actually settles.
  const early = await Promise.race([
    call.then(() => 'settled', () => 'settled'),
    new Promise<string>(resolve => { setTimeout(() => resolve('pending'), 25) }),
  ])
  assert.equal(early, 'pending')

  pending.resolve([{ type: 'file', attachment: ref }])
  await assert.rejects(call, (error: unknown) => codeOf(error) === 'ABORTED')
  assert.deepEqual(calls.admittedArity, [1])

  // A late malformed result after cancellation is still cancellation, not a
  // content-validation failure, and is never returned.
  const malformed = deferred<readonly unknown[]>()
  const malformedStore = fakeStore({ admitPromptContent: () => malformed.promise }).store
  const malformedController = new AbortController()
  const malformedCall = new NativeFileInput(fakeHost({ attachments: malformedStore }).access)
    .admitPrompt([{ type: 'file', attachment: ref }], malformedController.signal)
  malformedController.abort()
  malformed.resolve([{ type: 'text', text: 'tampered' }])
  await assert.rejects(malformedCall, (error: unknown) => codeOf(error) === 'ABORTED')

  // A native rejection that races the abort is reported as the cancellation.
  const rejection = deferred<readonly unknown[]>()
  const rejectionStore = fakeStore({ admitPromptContent: () => rejection.promise }).store
  const rejectionController = new AbortController()
  const rejectionCall = new NativeFileInput(fakeHost({ attachments: rejectionStore }).access)
    .admitPrompt([{ type: 'file', attachment: ref }], rejectionController.signal)
  rejectionController.abort()
  rejection.reject(Object.assign(new Error('storage write failed'), { code: 'ATTACHMENT_WRITE_FAILED' }))
  await assert.rejects(rejectionCall, (error: unknown) => codeOf(error) === 'ABORTED')
})

test('a malformed native admission result is refused and never returned', async () => {
  const ref = fileRef()
  const wrongLength = new NativeFileInput(fakeHost({
    attachments: fakeStore({ admitPromptContent: async () => [{ type: 'text', text: 'tampered' }] }).store,
  }).access)
  await assert.rejects(wrongLength.admitPrompt([{ type: 'file', attachment: ref }, { type: 'file', attachment: ref }]), (error: unknown) =>
    codeOf(error) === 'RUNTIME_REQUEST_FAILED' && /unexpected prompt content length/.test(String((error as Error).message)))

  const substituted = new NativeFileInput(fakeHost({
    attachments: fakeStore({ admitPromptContent: async () => [{ type: 'image', attachment: {} }] }).store,
  }).access)
  await assert.rejects(substituted.admitPrompt([{ type: 'file', attachment: ref }]), (error: unknown) =>
    codeOf(error) === 'RUNTIME_REQUEST_FAILED' && /altered the admitted file reference/.test(String((error as Error).message)))
})

test('descriptor gate and command attachment assembly stay native-shaped and honest', () => {
  assert.equal(commandDeclaresAttachments({ hint: 'x', attachments: true }), true)
  assert.equal(commandDeclaresAttachments({ hint: 'x' }), false)
  assert.equal(commandDeclaresAttachments({ hint: 'x', attachments: 'true' }), false)
  assert.equal(commandDeclaresAttachments({ hint: 'x', attachments: 1 }), false)
  assert.equal(commandDeclaresAttachments(undefined), false)

  const store = fakeStore().store
  const commands = { execute: async () => undefined }
  const commandHost = fakeHost({ attachments: store, commands })
  const withCommands = new NativeFileInput(commandHost.access)
  assert.deepEqual(withCommands.commandSupport({ hint: 'x', attachments: true }), {
    declared: true,
    images: true,
    files: false,
    reason: 'the native command executor accepts files only as session-staged receipts from a public upload owner, which this adapter does not mount or mint',
  })
  assert.deepEqual(withCommands.commandSupport({ hint: 'x' }), {
    declared: false,
    images: false,
    files: false,
    reason: 'this native command does not declare attachment input',
  })
  assert.deepEqual(new Set(commandHost.reads), new Set(['attachments', 'commands']), 'the descriptor gate never consults a model catalog')
  assert.equal(new NativeFileInput(fakeHost({ attachments: store }).access).commandSupport({ hint: 'x', attachments: true }).images, false)
  assert.equal(new NativeFileInput(fakeHost({ commands }).access).commandSupport({ hint: 'x', attachments: true }).images, false)

  // Even a hypothetical public upload owner cannot change the shared
  // contract: `CommandAttachmentPart` has no receipt, so files stay refused.
  const withUploads = new NativeFileInput(fakeHost({
    attachments: store,
    commands,
    fileUploads: { uploadStream: async () => ({}) },
  }).access)
  assert.equal(withUploads.commandSupport({ hint: 'x', attachments: true }).files, false)
  assert.equal(withUploads.capabilities().commandFiles, false)

  const image = { type: 'image' as const, mediaType: 'image/png' as const, data: PNG_1PX, name: 'shot.png' }
  assert.deepEqual(normalizeCommandAttachments([image, { type: 'file', attachment: fileRef() }]), [image, { type: 'file', attachment: fileRef() }])
  assert.throws(() => normalizeCommandAttachments([{ type: 'text', text: 'x' }]), /unsupported command attachment/)
  assert.throws(() => normalizeCommandAttachments([{ type: 'file', attachment: { attachmentId: 'x', name: '', bytes: 1 } }]), /native \{ attachmentId/)
  assert.deepEqual(withCommands.commandSubmitParts([image]), [image])
  assert.deepEqual(withCommands.commandSubmitParts([]), [])
  assert.throws(() => withCommands.commandSubmitParts([{ type: 'file', attachment: fileRef() }]), (error: unknown) =>
    codeOf(error) === 'CAPABILITY_UNAVAILABLE' && /draft was kept/.test(String((error as Error).message)))
  assert.throws(() => withCommands.commandSubmitParts([{ type: 'image', mediaType: 'image/png', data: 'AAA' }]), (error: unknown) =>
    codeOf(error) === 'INVALID_ARGUMENT')
  assert.throws(() => withCommands.commandSubmitParts([{ type: 'text', text: 'x' } as unknown as CommandAttachmentPart]), (error: unknown) =>
    codeOf(error) === 'INVALID_ARGUMENT')
  assert.throws(() => withCommands.commandSubmitParts([{ type: 'file', attachment: fileRef(), receiptId: 'invented' } as unknown as CommandAttachmentPart]), (error: unknown) =>
    codeOf(error) === 'CAPABILITY_UNAVAILABLE', 'no receipt is fabricated or honoured')
})

test('command outcome distinguishes settled success, settled refusal and no execution', () => {
  assert.deepEqual(commandOutcome({ commandId: 'cmd-1', result: { kind: 'success', text: 'ok', sourceEventSeq: 4 } }), {
    kind: 'success', commandId: 'cmd-1', text: 'ok', sourceEventSeq: 4,
  })
  assert.deepEqual(commandOutcome({ commandId: 'cmd-2', result: { kind: 'error', text: '/plan does not accept attachments' } }), {
    kind: 'error', commandId: 'cmd-2', text: '/plan does not accept attachments',
  })
  assert.equal(commandOutcome(undefined), undefined)
  assert.equal(commandOutcome({ commandId: 'cmd-3' }), undefined)
  assert.equal(commandOutcome({ commandId: 'cmd-3', result: { kind: 'error', text: '  ' } }), undefined)
  assert.equal(commandOutcome({ result: { kind: 'success', sourceEventSeq: -1 } }), undefined)
  assert.equal(commandOutcome({ result: { kind: 'unknown' } }), undefined)

  assert.equal(commandSettlesAsError({ commandId: 'cmd-1', result: { kind: 'success' } }), false)
  assert.equal(commandSettlesAsError({ commandId: 'cmd-2', result: { kind: 'error', text: 'refused' } }), true)
  assert.equal(commandSettlesAsError(undefined), true, 'an unresolved execute is never a consumed draft')
  assert.equal(commandSettlesAsError({ commandId: 'cmd-3' }), true)
})

test('queue recall is file-aware, metadata-only and preserves every non-text part', () => {
  const ref = fileRef('data.json', 7)
  const message = {
    id: 'm1',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: 'one' },
      { type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
      { type: 'file', attachment: ref },
      { type: 'text', text: 'two' },
      { type: 'file', attachment: { ...ref } },
    ],
  }
  const parts = recallableParts(message)
  assert.ok(parts !== undefined)
  assert.deepEqual(parts.map(part => part.type), ['text', 'image', 'file', 'text', 'file'])
  assert.deepEqual(contentCounts(parts), { images: 1, files: 2 })

  assert.deepEqual(recallableParts({ source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] }), [
    { type: 'file', attachment: ref },
  ], 'a file-only prompt is a real recallable human turn')
  assert.equal(recallableParts({ source: { kind: 'assistant' }, content: [] }), undefined)
  assert.equal(recallableParts({ source: { kind: 'user' }, content: [{ type: 'tool-call' }] }), undefined)
  assert.equal(recallableParts({ source: { kind: 'user' }, content: [{ type: 'file', attachment: {} }] }), undefined)
  assert.equal(recallableParts({ source: { kind: 'user' } }), undefined)
  assert.equal(recallableParts(null), undefined)

  const replacement = queueReplacementContent(parts, 'edited')
  assert.deepEqual(replacement.map(part => part.type), ['text', 'image', 'file', 'file'])
  assert.deepEqual(replacement[2], { type: 'file', attachment: ref }, 'file identity is preserved exactly')
  const attachmentOnly = queueReplacementContent(parts, '  ')
  assert.deepEqual(attachmentOnly.map(part => part.type), ['image', 'file', 'file'])
  assert.throws(() => queueReplacementContent([{ type: 'text', text: 'gone' }], ''), /requires text or an existing attachment/)
})

test('capabilities are mounted-method facts, and prompt file input needs both entries', () => {
  const { store } = fakeStore()
  const both = new NativeFileInput(fakeHost({ attachments: store, commands: { execute: async () => undefined } }).access)
  assert.deepEqual(both.capabilities(), {
    promptContent: true,
    stageFile: true,
    promptFiles: true,
    commandImages: true,
    commandFiles: false,
  })
  const stageOnly = fakeStore({ admitPromptContent: undefined }).store
  assert.equal(new NativeFileInput(fakeHost({ attachments: stageOnly }).access).capabilities().promptFiles, false)
  const admitOnly = fakeStore({ admitEncodedFile: undefined, saveFile: undefined }).store
  assert.deepEqual(new NativeFileInput(fakeHost({ attachments: admitOnly }).access).capabilities(), {
    promptContent: true,
    stageFile: false,
    promptFiles: false,
    commandImages: false,
    commandFiles: false,
  }, 'missing services stay unavailable instead of being faked')
})

test('native LocalAttachmentStore proves the public file shape in a temporary home', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-file-input-'))
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  const original = { HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME }
  process.env.HOME = home
  process.env.DSH_HOME = home
  let context: RecordValue | undefined
  try {
    const resolver = createRequire(await nativeDshManifest())
    const load = async (name: string): Promise<RecordValue> => {
      const value: unknown = await import(pathToFileURL(resolver.resolve(name)).href)
      assert.ok(value !== null && typeof value === 'object')
      return value as RecordValue
    }
    const cordis = await load('@deepseek-ai/cordis')
    const local = await load('@deepseek-ai/dsh-attachment-local')
    const llm = await load('@deepseek-ai/dsh-llm')
    const ContextClass = cordis.Context
    assert.equal(typeof ContextClass, 'function')
    context = Reflect.construct(ContextClass as new () => RecordValue, []) as RecordValue
    const plugin = context.plugin
    assert.equal(typeof plugin, 'function')
    await Reflect.apply(plugin as (...args: unknown[]) => unknown, context, [local.LocalAttachmentStore, { dshHome: home }, true])
    const get = context.get as (name: string) => unknown
    const attachments = get.call(context, 'attachments')
    assert.ok(attachments !== null && typeof attachments === 'object')

    const host = fakeHost({ attachments })
    const input = new NativeFileInput(host.access)
    const csv = 'name,value\nfixture,32\n'
    const bytes = new TextEncoder().encode(csv)
    const encoded = encodeFileBytes(bytes)
    const ref = await input.stageFile({ data: encoded, name: 'quarterly.csv' })
    const empty = await input.stageFile({ data: '', name: 'empty.txt' })
    assert.equal(ref.name, 'quarterly.csv')
    assert.equal(ref.bytes, bytes.length)
    assert.equal(ref.attachmentId, `sha256:${digest(bytes)}`, 'native content-addressed identity')
    assert.equal(empty.bytes, 0)
    assert.equal(empty.name, 'empty.txt')

    const admitted = await input.admitPrompt([
      { type: 'text', text: 'before' },
      { type: 'file', attachment: ref },
      { type: 'text', text: 'after' },
      { type: 'file', attachment: { ...ref } },
    ])
    assert.deepEqual(admitted.map(part => part.type), ['text', 'file', 'text', 'file'])
    assert.deepEqual(admitted[1], { type: 'file', attachment: ref })
    assert.deepEqual(admitted[3], { type: 'file', attachment: ref })

    const createUserMessage = llm.createUserMessage
    assert.equal(typeof createUserMessage, 'function')
    const message = Reflect.apply(createUserMessage as (...args: unknown[]) => unknown, llm, [{ content: admitted, source: { kind: 'user' } }])
    const blocks = (message as RecordValue).content
    assert.ok(Array.isArray(blocks))
    assert.deepEqual(blocks.map((block: unknown) => (block as RecordValue).type), ['text', 'file', 'text', 'file'])

    const read = Reflect.get(attachments as object, 'readFileStream') as (...args: unknown[]) => AsyncIterable<Uint8Array>
    const chunks: Uint8Array[] = []
    for await (const chunk of Reflect.apply(read, attachments, [ref])) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes), 'Durable bytes stay native-owned and exact')
  } finally {
    try {
      if (context !== undefined) {
        const fiber = context.fiber
        const dispose = (fiber as RecordValue | undefined)?.dispose
        if (typeof dispose === 'function') await Reflect.apply(dispose as (...args: unknown[]) => unknown, fiber, [])
      }
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('a backend-coded refusal never leaks a native object or a credential', () => {
  const error = backendError('RUNTIME_REQUEST_FAILED', 'native file staging failed for api_key=abc123')
  assert.match(error.message, /\[redacted]/)
  assert.ok(!('cause' in error))
  assert.ok(!Object.values(error).includes('abc123'))
  assert.equal(codeOf(error), 'RUNTIME_REQUEST_FAILED')
  const parts: DisplayContentPart[] = [{ type: 'file', attachment: fileRef() }]
  assert.deepEqual(parts[0], { type: 'file', attachment: fileRef() })
})