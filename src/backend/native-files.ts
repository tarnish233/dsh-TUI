/**
 * Native general-file prompt input and native command attachment assembly.
 *
 * DSH owns file storage, admission, reference identity and retention. This
 * module is a *narrow* validation/admission seam over the public
 * `ctx.attachments` and `ctx.commands` services:
 *
 * - a frontend reads its own local bytes (the backend never resolves, records
 *   or assumes a local path) and hands canonical base64 to `stageFile`;
 * - native `admitEncodedFile`/`saveFile` computes the durable content-addressed
 *   `FileAttachmentRef` (sha256 for `attachment-local`);
 * - prompt submission passes ordered text, encoded images and already durable
 *   file references to native `admitPromptContent` exactly once, then the
 *   admitted blocks become native user-message content;
 * - command submission uses the native `CommandSubmitAttachment[]` shape
 *   (encoded images, or a *staged receipt id* for files). File receipts can
 *   only come from the public Host upload service when a composition mounts
 *   it; this bundle mounts neither it nor `connection`, so command file input
 *   stays explicitly unavailable. No receipt is invented and no upload handler
 *   or second store is added.
 *
 * Recall is metadata-only: a durable reference restored from the native queue
 * is already a READY file part, so queue recall never reads bytes again.
 * Nothing here creates an Agent, scheduler, timer or persistence layer, and no
 * image read is ever performed for a file. Failures are coded adapter
 * diagnostics; the frontend draft is never consumed here.
 *
 * ## Admission cancellation and the single wall-clock bound
 *
 * The installed public entry is, verbatim, `@deepseek-ai/dsh-attachment`
 * `0.2.2-rc.1` `lib/types/index.d.ts`:
 *
 * ```ts
 * admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]>
 * ```
 *
 * It accepts **no** `AbortSignal` and no cancellation option (only
 * `readImage`, `readFileStream`, `readImageRequest` and `saveFileStream` carry
 * one). This adapter therefore never forwards a fabricated signal argument:
 * `NativeFileInput.admitPrompt(content, signal)` is an adapter-level
 * cancellation contract, not a native one.
 *
 * - Pre-cancelled (`signal.aborted` before the call) admission is refused with
 *   `ABORTED` after pure shape validation and before the capability probe or
 *   any store call, so no native write or admission starts. Text-only content
 *   honours the same pre-cancellation even though it never touches the store.
 * - Mid-flight cancellation cannot interrupt the native await, because native
 *   exposes no signal. When the unabortable call settles, the adapter re-checks
 *   the signal (cancellation wins over a changed attachment identity) and
 *   rejects `ABORTED`; admitted parts are never returned, so a late native
 *   result cannot be mistaken for a sendable prompt. A late malformed result
 *   is still refused (`ABORTED` when cancelled, otherwise
 *   `RUNTIME_REQUEST_FAILED`) and is never returned.
 * - Wall-clock bounding belongs to the caller. `Backend` supplies the sole
 *   timeout through its `nativeUiRead` helper (which also re-checks the live
 *   Agent before creating/sending the message); the send path must route this
 *   call through that helper. This module deliberately adds no second timer: a
 *   second bound would double-report the same stall and could reject a call
 *   that the caller still owns.
 *
 * @module dsh-tui/backend/native-files
 */
import { asFileAttachmentRef, asImageAttachmentRef, isImageMediaType } from '../attachments.ts'
import { asBackendError, backendError } from './errors.ts'
import type { BackendError } from './errors.ts'
import type {
  CommandAttachmentPart,
  DisplayContentPart,
  EncodedFileInput,
  FileAttachmentRef,
  ImageMediaType,
  PromptContentPart,
} from './types.ts'
import type { NativeUiAccess, NativeUiScope } from './native-ui-scope.ts'

/** Native `CommandSubmitAttachment` shape for an encoded image. */
export interface NativeCommandImageSubmit {
  readonly type: 'image'
  readonly mediaType: ImageMediaType
  readonly data: string
  readonly name?: string
}

/** Native `CommandSubmitAttachment` shape for a staged file receipt. */
export interface NativeCommandFileSubmit {
  readonly type: 'file'
  readonly receiptId: string
}

export type NativeCommandSubmitAttachment = NativeCommandImageSubmit | NativeCommandFileSubmit

/** Live native capability view; every field is a mounted-method fact, not a policy. */
export interface NativeFileCapabilities {
  /** `attachments.admitPromptContent` is mounted. */
  readonly promptContent: boolean
  /** A public staging entry (`admitEncodedFile` or `saveFile`) is mounted. */
  readonly stageFile: boolean
  /** Prompt file input is usable: both staging and native prompt admission. */
  readonly promptFiles: boolean
  /** `commands.execute` plus an attachment store (native image admission). */
  readonly commandImages: boolean
  /**
   * Always false: the native executor accepts files only as session-staged
   * receipt ids from a public upload owner, and this adapter mints none.
   */
  readonly commandFiles: false
}

/** Per-descriptor command attachment gate; the native executor remains authoritative. */
export interface NativeCommandSupport {
  /** `input.attachments === true` (the native registry normalizes anything else away). */
  readonly declared: boolean
  readonly images: boolean
  readonly files: boolean
  /** Why the unavailable parts are unavailable; absent when everything is usable. */
  readonly reason?: string
}

/**
 * Neutral view of one settled native command execution.
 *
 * `undefined` means the value is not a settled execution at all (unresolved
 * line, malformed envelope, or a thrown failure was caught by the caller).
 * A `success` outcome means the native handler owned the invocation, including
 * any submitted attachments; an `error` outcome is native's documented
 * refusal convention so the dispatching composer keeps the originals. The App
 * should restore its draft for `undefined` and `error`, and only consume it
 * after an identity-checked `success`.
 */
export interface NativeCommandOutcome {
  readonly kind: 'success' | 'error'
  readonly text?: string
  readonly commandId?: string
  readonly sourceEventSeq?: number
}

interface AttachmentsLike {
  admitPromptContent?(content: readonly PromptContentPart[]): Promise<readonly unknown[]>
  admitEncodedFile?(input: { data: string; name?: string }): Promise<unknown>
  saveFile?(input: { data: Uint8Array; name?: string }): Promise<unknown>
}

interface CommandsLike {
  execute?(agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<unknown>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Canonical base64 exactly as native `admitEncodedFile` requires (empty is valid). */
export function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0) return false
  if (value.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

/** Encode frontend-read bytes for the JSON-friendly native staging entry. */
export function encodeFileBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw backendError('INVALID_ARGUMENT', 'file staging requires exact Uint8Array bytes')
  }
  return Buffer.from(bytes).toString('base64')
}

/** Shape validation for one frontend file input; canonical base64 is the wire fact. */
export function normalizeFileInput(value: unknown): EncodedFileInput {
  const item = record(value)
  if (item === undefined) throw backendError('INVALID_ARGUMENT', 'a file input requires { data: canonical base64, name? }')
  if (!isCanonicalBase64(item.data)) {
    throw backendError('INVALID_ARGUMENT', 'file input data must be canonical base64')
  }
  if (item.name !== undefined && (typeof item.name !== 'string' || item.name.length === 0)) {
    throw backendError('INVALID_ARGUMENT', 'file input name must be a non-empty string when present')
  }
  return { data: item.data, ...(item.name === undefined ? {} : { name: item.name }) }
}

function normalizeEncodedImage(value: Record<string, unknown>, label: string): NativeCommandImageSubmit {
  if (!isImageMediaType(value.mediaType)) {
    throw backendError('INVALID_ARGUMENT', `${label} image parts require a supported mediaType`)
  }
  if (!isCanonicalBase64(value.data) || value.data.length === 0) {
    throw backendError('INVALID_ARGUMENT', `${label} image parts require non-empty canonical base64 data`)
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    throw backendError('INVALID_ARGUMENT', `${label} image part name must be a string when present`)
  }
  return {
    type: 'image',
    mediaType: value.mediaType,
    data: value.data,
    ...(value.name === undefined ? {} : { name: value.name }),
  }
}

/**
 * Validate one ordered prompt content list.
 *
 * Accepts native `AttachmentAdmissionPart` text, encoded-image and durable
 * file-reference variants. The native stored-image admission variant is
 * rejected on purpose: it requires the original upload's `encodedBytes`, which
 * this adapter never retains. Stored image references are delivered by
 * building the native message directly (queue recall), never by re-admitting.
 */
export function normalizePromptContent(value: unknown): PromptContentPart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw backendError('INVALID_ARGUMENT', 'prompt content requires a non-empty ordered part list')
  }
  const parts: PromptContentPart[] = []
  for (const entry of value) {
    const part = record(entry)
    if (part?.type === 'text') {
      if (typeof part.text !== 'string') throw backendError('INVALID_ARGUMENT', 'prompt text parts require a text string')
      parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part?.type === 'image') {
      if (part.attachment !== undefined || part.encodedBytes !== undefined) {
        throw backendError(
          'INVALID_ARGUMENT',
          'prompt image parts must carry encoded data; a stored image reference needs the native upload byte count and is delivered as message content instead',
        )
      }
      parts.push(normalizeEncodedImage(part, 'prompt'))
      continue
    }
    if (part?.type === 'file') {
      if (part.receiptId !== undefined) {
        throw backendError('INVALID_ARGUMENT', 'prompt file parts require a durable attachment reference, not a file-upload receipt id')
      }
      const attachment = asFileAttachmentRef(part.attachment)
      if (attachment === undefined) {
        throw backendError('INVALID_ARGUMENT', 'prompt file parts require a native { attachmentId, name, bytes } reference')
      }
      parts.push({ type: 'file', attachment })
      continue
    }
    throw backendError('INVALID_ARGUMENT', `unsupported prompt content part: ${JSON.stringify(part?.type)}`)
  }
  return parts
}

/** Validate one ordered command attachment input list (encoded images or durable refs). */
export function normalizeCommandAttachments(value: unknown): CommandAttachmentPart[] {
  if (!Array.isArray(value)) throw backendError('INVALID_ARGUMENT', 'command attachments require an ordered part list')
  const parts: CommandAttachmentPart[] = []
  for (const entry of value) {
    const part = record(entry)
    if (part?.type === 'image') {
      parts.push(normalizeEncodedImage(part, 'command'))
      continue
    }
    if (part?.type === 'file') {
      if (part.receiptId !== undefined) {
        throw backendError('INVALID_ARGUMENT', 'command attachment input carries a durable attachment reference, not a receipt id')
      }
      const attachment = asFileAttachmentRef(part.attachment)
      if (attachment === undefined) {
        throw backendError('INVALID_ARGUMENT', 'command file attachments require a native { attachmentId, name, bytes } reference')
      }
      parts.push({ type: 'file', attachment })
      continue
    }
    throw backendError('INVALID_ARGUMENT', `unsupported command attachment part: ${JSON.stringify(part?.type)}`)
  }
  return parts
}

function sameFileAttachment(ref: FileAttachmentRef, expected: FileAttachmentRef): boolean {
  return ref.attachmentId === expected.attachmentId && ref.name === expected.name && ref.bytes === expected.bytes
}

/**
 * Verify native admitted content against the submitted order.
 *
 * Native `admitPromptContent` reconstructs text/file parts and replaces every
 * encoded image with its durable reference; index, type and text are fixed,
 * file references must be value-identical, and every image reference must be
 * structurally valid. A mismatch is a native contract failure, not input the
 * adapter may reinterpret.
 */
export function admittedPromptContent(value: unknown, submitted: readonly PromptContentPart[]): DisplayContentPart[] {
  if (!Array.isArray(value) || value.length !== submitted.length) {
    throw backendError('RUNTIME_REQUEST_FAILED', 'the native attachment store returned an unexpected prompt content length')
  }
  const parts: DisplayContentPart[] = []
  for (const [index, expected] of submitted.entries()) {
    const part = record(value[index])
    if (expected.type === 'text') {
      if (part?.type !== 'text' || typeof part.text !== 'string' || part.text !== expected.text) {
        throw backendError('RUNTIME_REQUEST_FAILED', 'the native attachment store altered admitted prompt text')
      }
      parts.push({ type: 'text', text: expected.text })
      continue
    }
    if (expected.type === 'image') {
      const attachment = part?.type === 'image' ? asImageAttachmentRef(part.attachment) : undefined
      if (attachment === undefined) {
        throw backendError('RUNTIME_REQUEST_FAILED', 'the native attachment store returned an invalid admitted image reference')
      }
      parts.push({ type: 'image', attachment })
      continue
    }
    const attachment = part?.type === 'file' ? asFileAttachmentRef(part.attachment) : undefined
    if (attachment === undefined || !sameFileAttachment(attachment, expected.attachment)) {
      throw backendError('RUNTIME_REQUEST_FAILED', 'the native attachment store altered the admitted file reference')
    }
    parts.push({ type: 'file', attachment })
  }
  return parts
}

/** Exact native descriptor gate: only `input.attachments === true` declares attachments. */
export function commandDeclaresAttachments(input: unknown): boolean {
  return record(input)?.attachments === true
}

/**
 * Classify one native `CommandExecution` value without inventing an outcome.
 *
 * `undefined` means "not a settled execution" (the line did not resolve, the
 * envelope is malformed, or the call threw and the caller caught it). A
 * settled `error` is native's own refusal result — descriptor, attachment
 * admission or handler grammar — after which the dispatching composer keeps
 * the originals, so the App restores the draft for `undefined` and `error`.
 */
export function commandOutcome(value: unknown): NativeCommandOutcome | undefined {
  const execution = record(value)
  const result = record(execution?.result)
  if (result === undefined) return undefined
  const commandId = typeof execution?.commandId === 'string' && execution.commandId.length > 0
    ? execution.commandId
    : undefined
  if (result.kind === 'success') {
    if (result.text !== undefined && typeof result.text !== 'string') return undefined
    const sourceEventSeq = result.sourceEventSeq
    if (sourceEventSeq !== undefined &&
        (typeof sourceEventSeq !== 'number' || !Number.isSafeInteger(sourceEventSeq) || sourceEventSeq < 0)) return undefined
    return {
      kind: 'success',
      ...(typeof result.text === 'string' ? { text: result.text } : {}),
      ...(commandId === undefined ? {} : { commandId }),
      ...(typeof sourceEventSeq === 'number' ? { sourceEventSeq } : {}),
    }
  }
  if (result.kind === 'error') {
    if (typeof result.text !== 'string' || result.text.trim().length === 0) return undefined
    return {
      kind: 'error',
      text: result.text,
      ...(commandId === undefined ? {} : { commandId }),
    }
  }
  return undefined
}

/**
 * Whether the App must restore the submitted draft for this execute value.
 *
 * A settled `error` is a native refusal result and an unparseable value is not
 * a settled execution; both leave the user's input unconsumed. Only a settled
 * `success` may consume the draft, and the App still re-checks its own session
 * and attachment identity first.
 */
export function commandSettlesAsError(value: unknown): boolean {
  return commandOutcome(value)?.kind !== 'success'
}

/**
 * Ordered recallable content of one native inbox message, file-aware.
 *
 * Only a human `source.kind === 'user'` message whose every block is text, an
 * image reference or a file reference is recallable; injected context and
 * unknown blocks stay in the native inbox. Repeats and order are preserved, and
 * a file-only message is a real human turn. File refs are already durable, so
 * recall restores a READY `{type:'file',attachment}` part and never reads bytes.
 */
export function recallableParts(message: unknown): DisplayContentPart[] | undefined {
  const raw = record(message)
  if (record(raw?.source)?.kind !== 'user') return undefined
  if (!Array.isArray(raw?.content)) return undefined
  const parts: DisplayContentPart[] = []
  for (const block of raw.content) {
    const item = record(block)
    if (item === undefined) return undefined
    if (item.type === 'text') {
      if (typeof item.text !== 'string') return undefined
      parts.push({ type: 'text', text: item.text })
      continue
    }
    if (item.type === 'image') {
      const attachment = asImageAttachmentRef(item.attachment)
      if (attachment === undefined) return undefined
      parts.push({ type: 'image', attachment })
      continue
    }
    if (item.type === 'file') {
      const attachment = asFileAttachmentRef(item.attachment)
      if (attachment === undefined) return undefined
      parts.push({ type: 'file', attachment })
      continue
    }
    return undefined
  }
  return parts
}

/**
 * Native message content for one edited queued occurrence.
 *
 * The adapter's existing convention is kept: a replacement text part first
 * (when non-blank), then every image/file reference in its original order with
 * repeats. Non-text parts are never dropped or reordered relative to each
 * other, and an empty result is refused instead of silently discarding them.
 */
export function queueReplacementContent(parts: readonly DisplayContentPart[], text: string): DisplayContentPart[] {
  if (typeof text !== 'string') throw backendError('INVALID_ARGUMENT', 'queue replacement text must be a string')
  const content: DisplayContentPart[] = []
  if (text.trim() !== '') content.push({ type: 'text', text })
  for (const part of parts) {
    if (part.type === 'image') content.push({ type: 'image', attachment: part.attachment })
    else if (part.type === 'file') content.push({ type: 'file', attachment: part.attachment })
  }
  if (content.length === 0) {
    throw backendError('INVALID_ARGUMENT', 'queue replacement requires text or an existing attachment')
  }
  return content
}

/** Metadata counts for one queue row; images and files stay distinguishable. */
export function contentCounts(parts: readonly DisplayContentPart[]): { images: number; files: number } {
  let images = 0
  let files = 0
  for (const part of parts) {
    if (part.type === 'image') images += 1
    else if (part.type === 'file') files += 1
  }
  return { images, files }
}

/** Error code carried by a native `AttachmentError`-shaped rejection, if any. */
function nativeCode(error: unknown): string | undefined {
  const code = record(error)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Map a native storage rejection without serializing native objects.
 *
 * `ATTACHMENT_FILES_UNSUPPORTED` means the mounted provider has no verbatim
 * file store: that is an unavailable native capability, never a silent
 * text-only send. Every other rejection keeps its redacted message.
 */
function storageFailure(error: unknown, signal: AbortSignal | undefined, action: string): BackendError {
  if (signal?.aborted === true) return backendError('ABORTED', `${action} was cancelled`)
  const code = nativeCode(error)
  const mapped = asBackendError(error, 'RUNTIME_REQUEST_FAILED')
  if (code === 'ATTACHMENT_FILES_UNSUPPORTED') {
    return backendError(
      'CAPABILITY_UNAVAILABLE',
      `${action} is unavailable: the mounted native attachment provider cannot store verbatim files`,
      mapped.message,
    )
  }
  if (code === 'INVALID_FILE_BASE64') {
    return backendError('INVALID_ARGUMENT', `${action} requires canonical base64 file data`)
  }
  return backendError('RUNTIME_REQUEST_FAILED', `${action} failed: ${mapped.message}`)
}

/**
 * One attachment-identity-scoped native file-input session.
 *
 * The supplied {@link NativeUiAccess} is the only host seam: services are
 * resolved per call (HMR/recomposition never leaves a stale reference), the
 * current attachment identity is captured before every native await and
 * re-checked after it, and no read-only call materializes an Agent.
 */
export class NativeFileInput {
  private readonly access: NativeUiAccess

  constructor(access: NativeUiAccess) {
    this.access = access
  }

  /** Live mounted-method facts only; no speculative write probe is performed. */
  capabilities(): NativeFileCapabilities {
    const attachments = this.attachments()
    const commands = this.commands()
    const promptContent = typeof attachments?.admitPromptContent === 'function'
    const stageFile = typeof attachments?.admitEncodedFile === 'function' || typeof attachments?.saveFile === 'function'
    const executable = typeof commands?.execute === 'function'
    return {
      promptContent,
      stageFile,
      promptFiles: promptContent && stageFile,
      commandImages: executable && attachments !== undefined,
      // Native file submissions need a staged receipt minted by a public upload
      // owner; this bundle mounts none and this adapter mints none.
      commandFiles: false,
    }
  }

  /** Per-descriptor gate; the native executor still enforces `input.attachments`. */
  commandSupport(input: unknown): NativeCommandSupport {
    const declared = commandDeclaresAttachments(input)
    const capabilities = this.capabilities()
    if (!declared) {
      return { declared, images: false, files: false, reason: 'this native command does not declare attachment input' }
    }
    if (!capabilities.commandImages) {
      return {
        declared,
        images: false,
        files: false,
        reason: 'the native command executor or attachment store is not mounted',
      }
    }
    return {
      declared,
      images: true,
      files: false,
      reason: 'the native command executor accepts files only as session-staged receipts from a public upload owner, which this adapter does not mount or mint',
    }
  }

  /**
   * Stage exact frontend bytes as one durable native file.
   *
   * Native `admitEncodedFile` is the canonical-base64 entry (empty file valid);
   * `saveFile` is the exact-byte fallback. The returned reference is validated
   * against the submitted byte length, and DSH owns name sanitization,
   * content-addressed identity and the durable commit. There is no public
   * delete: a discarded draft's object is collected only by native retention.
   */
  async stageFile(input: EncodedFileInput, signal?: AbortSignal): Promise<FileAttachmentRef> {
    const draft = normalizeFileInput(input)
    const attachments = this.attachments()
    if (typeof attachments?.admitEncodedFile !== 'function' && typeof attachments?.saveFile !== 'function') {
      throw backendError(
        'CAPABILITY_UNAVAILABLE',
        'this runtime mounts no public native file staging entry (ctx.attachments.admitEncodedFile / saveFile)',
      )
    }
    const bytes = Buffer.from(draft.data, 'base64')
    const scope = this.requireScope()
    this.assertActive(scope, signal)
    let stored: unknown
    try {
      if (typeof attachments.admitEncodedFile === 'function') {
        stored = await attachments.admitEncodedFile({
          data: draft.data,
          ...(draft.name === undefined ? {} : { name: draft.name }),
        })
      } else {
        stored = await attachments.saveFile!({
          data: new Uint8Array(bytes),
          ...(draft.name === undefined ? {} : { name: draft.name }),
        })
      }
    } catch (error) {
      throw storageFailure(error, signal, 'native file staging')
    }
    this.assertActive(scope, signal)
    return storedFileReference(stored, bytes.length)
  }

  /**
   * Native prompt admission for ordered text, encoded images and durable file
   * references. Text-only content performs no store call.
   *
   * `signal` is the adapter's own cancellation contract, not a native feature:
   * public `AttachmentStore.admitPromptContent(content)` takes no signal. A
   * pre-cancelled call is refused before any native admission; a mid-flight
   * cancellation is observed when the unabortable native call settles, and its
   * late result is discarded (`ABORTED`) rather than returned. The caller owns
   * the one wall-clock bound and the live/send guard after this method (see the
   * module header).
   */
  async admitPrompt(content: readonly PromptContentPart[], signal?: AbortSignal): Promise<DisplayContentPart[]> {
    const parts = normalizePromptContent(content)
    this.assertNotCancelled(signal, 'native prompt attachment admission')
    if (parts.every(part => part.type === 'text')) {
      return parts.map(part => ({ type: 'text' as const, text: part.type === 'text' ? part.text : '' }))
    }
    const attachments = this.attachments()
    if (typeof attachments?.admitPromptContent !== 'function') {
      throw backendError(
        'CAPABILITY_UNAVAILABLE',
        'this runtime mounts no native prompt attachment admission (ctx.attachments.admitPromptContent); the prompt was not sent',
      )
    }
    const scope = this.requireScope()
    this.assertActive(scope, signal)
    let admitted: readonly unknown[]
    try {
      admitted = await attachments.admitPromptContent(parts)
    } catch (error) {
      throw storageFailure(error, signal, 'native prompt attachment admission')
    }
    this.assertActive(scope, signal)
    return admittedPromptContent(admitted, parts)
  }

  /**
   * Pure native `CommandSubmitAttachment[]` assembly.
   *
   * Images stay encoded (the executor admits them). Native files must cite a
   * session-staged receipt minted by a public upload owner; a durable
   * reference is not a native command attachment, so a file part is refused
   * before `execute` with `CAPABILITY_UNAVAILABLE` and the App keeps the draft.
   */
  commandSubmitParts(value: readonly CommandAttachmentPart[]): readonly NativeCommandSubmitAttachment[] {
    if (!Array.isArray(value)) throw backendError('INVALID_ARGUMENT', 'command attachments require an ordered part list')
    const submitted: NativeCommandSubmitAttachment[] = []
    for (const entry of value) {
      const part = record(entry)
      if (part?.type === 'image') {
        if (part.receiptId !== undefined) {
          throw backendError('INVALID_ARGUMENT', 'command image attachments must carry encoded data, not a receipt id')
        }
        submitted.push(normalizeEncodedImage(part, 'command'))
        continue
      }
      if (part?.type === 'file') {
        throw backendError(
          'CAPABILITY_UNAVAILABLE',
          'native command file attachments need a session-staged receipt from a mounted public upload owner; this runtime mounts none, so the command was not executed and the draft was kept',
        )
      }
      throw backendError('INVALID_ARGUMENT', `unsupported command attachment part: ${JSON.stringify(part?.type)}`)
    }
    return submitted
  }

  private attachments(): AttachmentsLike | undefined {
    return record(this.access.service('attachments')) as AttachmentsLike | undefined
  }

  private commands(): CommandsLike | undefined {
    return record(this.access.service('commands')) as CommandsLike | undefined
  }

  private requireScope(): NativeUiScope {
    const scope = this.access.current()
    if (scope === undefined) throw backendError('NOT_CONNECTED', 'the DSH session is not attached; the input was not sent')
    return scope
  }

  /** Refuse before any native call; a pre-cancelled operation owns no store work. */
  private assertNotCancelled(signal: AbortSignal | undefined, action: string): void {
    if (signal?.aborted === true) throw backendError('ABORTED', `${action} was cancelled`)
  }

  /** Cancellation wins over a changed identity; both prevent any later native write. */
  private assertActive(scope: NativeUiScope, signal?: AbortSignal): void {
    this.assertNotCancelled(signal, 'the file input operation')
    if (!this.access.isCurrent(scope)) {
      throw backendError('STALE_SESSION', 'the DSH attachment changed during file input; the input was not sent')
    }
  }
}

function storedFileReference(value: unknown, expectedBytes: number): FileAttachmentRef {
  const ref = asFileAttachmentRef(value)
  if (ref === undefined) {
    throw backendError('RUNTIME_REQUEST_FAILED', 'the native attachment store returned an invalid file reference')
  }
  if (ref.bytes !== expectedBytes) {
    throw backendError('RUNTIME_REQUEST_FAILED', 'the native attachment store returned a file reference with a different byte length')
  }
  return ref
}