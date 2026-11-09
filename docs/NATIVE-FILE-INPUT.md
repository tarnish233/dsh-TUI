# Native file input: prompt files, queue recall and command attachments

Baseline: DSH `0.2.2-rc.1` public types/source, same-process Cordis Context.
`src/backend/native-files.ts` is the only file-input helper; it is not a store,
an upload handler or a second attachment policy. DSH owns every byte, digest,
name, admission limit and durable reference.

## Why this shape

A DSH session has two public file shapes and they are not interchangeable:

- the **wire** prompt shape (`dsh-api-session-controller`'s
  `PromptContentPart`) carries `{ type:'file', receiptId }`, where the receipt
  is minted by the Host upload service (`ctx.fileUploads`) for an already
  stored upload. An unknown or foreign receipt refuses the whole prompt with
  `session/attachment-invalid`/`FILE_NOT_STAGED` and stores nothing;
- the **Host admission** shape (`dsh-attachment`'s `AttachmentAdmissionPart` /
  `dsh-llm`'s `FileBlock`) carries
  `{ type:'file', attachment:{ attachmentId, name, bytes } }` — a durable,
  content-addressed reference with metadata only.

This TUI is a same-process Host consumer, not a Remote caller, so it uses the
second shape directly. The frontend reads its own local file, the backend
stages the exact bytes through public native storage
(`attachments.admitEncodedFile`, or `saveFile` for exact bytes), and the editor
keeps only the returned `FileAttachmentRef`. Submission then uses the
documented Host sequence:

```
attachments.admitPromptContent([...text, encoded-image, file-ref, ...])   // exactly once
  → createUserMessage({ content: admitted, source: { kind:'user' } })
  → agent.followup(message) | agent.steer(message)
```

The native call passes file references through unchanged, persists encoded
images, counts only images toward the image limits, and performs no storage
operation for a prompt without encoded images. Request assembly later projects
each file block to deterministic handle text, so files never reach a provider
as bytes and never count as vision input.

## Native staging facts

| Fact | Contract |
| --- | --- |
| Encoding | `admitEncodedFile.data` must be **canonical** base64 (`Buffer.from(data,'base64').toString('base64') === data`). `saveFile.data` is exact `Uint8Array`. |
| Name | Optional on input; DSH sanitizes to a non-empty leaf name (last `/`/`\` segment, C0/C1 stripped, `<>:"\|?*` → `_`, ≤255 UTF-8 bytes, Windows device names prefixed, empty/`.`/`..` → `"file"`). The returned `name` is required and is never a path. |
| Empty file | Valid on both entries (`data:''` / zero-length bytes) and yields a normal reference with `bytes:0`. |
| Identity | Opaque and content-addressed (`sha256:<hex>` for `attachment-local`); same bytes → same id across sessions, `/new`, resume and restarts. `bytes` is the exact stored length. |
| Limits | Native files have **no** admission count/size limit. The frontend's local read budget is a frontend policy; the backend invents none. |
| Refusal | A provider without verbatim storage rejects with `ATTACHMENT_FILES_UNSUPPORTED`; that is surfaced as `CAPABILITY_UNAVAILABLE`, never as a silent text-only send. |
| Cleanup | No public delete/retire. A discarded draft leaves an unreachable immutable object that only native retention collects. The TUI never removes, re-hashes or rewrites a reference. |

`/attach <local-path>` therefore belongs to the frontend: it reads bounded
bytes from its own filesystem, passes canonical base64 plus the leaf name to
`Backend.stageFile`, and inserts one READY
`{ type:'file', attachment }` part into the editor. The backend never receives
a path and never assumes the TUI process cwd equals the DSH session/sandbox
cwd.

`@path` is deliberately a different native surface. Its candidates come from
DSH's mounted `ctx.fileReferences` provider and the accepted mention remains an
ordinary text token; no bytes are read or staged by completion. The provider's
model guidance tells an Agent with a visible `read` tool to inspect that path
before claiming knowledge of it. Consequently accepting `@src/a.ts` must never
call `stageFile`, allocate a `[File #N]` marker, or inherit `/attach` limits and
cleanup semantics.

## Module API (`src/backend/native-files.ts`)

Pure validation/projection:

```ts
isCanonicalBase64(value): value is string
encodeFileBytes(bytes: Uint8Array): string
normalizeFileInput(value): EncodedFileInput
normalizePromptContent(value): PromptContentPart[]
normalizeCommandAttachments(value): CommandAttachmentPart[]
admittedPromptContent(value, submitted): DisplayContentPart[]
commandDeclaresAttachments(input): boolean
commandOutcome(value): NativeCommandOutcome | undefined
commandSettlesAsError(value): boolean
recallableParts(message): DisplayContentPart[] | undefined
queueReplacementContent(parts, text): DisplayContentPart[]
contentCounts(parts): { images: number; files: number }
```

Identity-scoped native operations (`new NativeFileInput(access)` with the
shared `NativeUiAccess` seam):

```ts
capabilities(): { promptContent, stageFile, promptFiles, commandImages, commandFiles: false }
commandSupport(descriptorInput): { declared, images, files: false, reason? }
stageFile(input: EncodedFileInput, signal?): Promise<FileAttachmentRef>
admitPrompt(content: readonly PromptContentPart[], signal?): Promise<DisplayContentPart[]>
commandSubmitParts(parts: readonly CommandAttachmentPart[]): readonly NativeCommandSubmitAttachment[]
```

Every async operation resolves services per call through `access.service()`
(HMR/recomposition cannot leave a stale service), captures
`access.current()` before the native await, and re-checks
`access.isCurrent(scope)` after it. Cancellation wins over identity changes.
No call touches `agents`, so read-only discovery materializes no Agent.
Diagnostics are coded `BackendError`s (`INVALID_ARGUMENT`, `ABORTED`,
`STALE_SESSION`, `NOT_CONNECTED`, `CAPABILITY_UNAVAILABLE`,
`RUNTIME_REQUEST_FAILED`) with credential redaction and no native object
serialization.

Prompt rules enforced before native admission:

- ordered `text | encoded-image | file-ref`, repeats preserved, non-empty;
- encoded images need a supported media type and non-empty canonical base64;
- file parts need a valid `{ attachmentId, name, bytes }` and must not carry a
  receipt id;
- already stored image references are rejected for admission because native's
  `{ type:'image', attachment }` admission variant needs the original upload's
  `encodedBytes`, which the TUI never retains. Queue recall and
  `queue-replace` deliver such refs by building the native message directly.
- text-only content stays on the ordinary `send` path and calls no store.
- native admission output is verified: same length, same type per index,
  identical text, value-identical file refs, structurally valid image refs.
  Any mismatch is `RUNTIME_REQUEST_FAILED`; the draft stays retryable.

`stageFile` validates the returned reference against the submitted byte length,
so a provider that stores different bytes cannot reach a message.

## Queue recall

`recallableParts` is the read-only projection of one native inbox message. Only
`source.kind === 'user'` messages whose every block is text, an image ref or a
file ref are recallable; injected context and unknown blocks stay in the native
inbox. A file-only message is a real human turn. Recall restores a READY
`{ type:'file', attachment }` part directly — references are already durable,
so no bytes are re-read, re-staged or copied.

`queueReplacementContent(parts, text)` keeps the adapter's existing convention:
a replacement text part first when non-blank, then every image/file reference in
its original order with repeats. Non-text parts are never dropped or reordered
relative to each other, and an empty result is refused. `dequeue` transfers the
same ordered parts; `contentCounts` supplies the metadata row counts
(`{images, files}`) so a queue row can show files without reading them.

Failures, stale attachments and cancellation leave the native inbox untouched
(the adapter replaces/removes only after the replacement message exists).

## Command attachments

Native command submission is `commands.execute(agent, line, submitted, signal)`
with `submitted: CommandSubmitAttachment[]`:

```ts
| ({ type:'image' } & { mediaType; data; name? })   // encoded image, admitted by execute
| { type:'file'; receiptId }                       // staged receipt id ONLY
```

`execute` itself owns admission: it refuses attachments for a descriptor that
does not declare `input.attachments === true`, refuses images beyond the native
limits, resolves file receipts through the single resolver registered by the
public Host upload owner, and restores the original mixed order before running
the handler. Descriptors carry the gate (`input.attachments`), and `/plan` /
`/goal` declare it; `/feedback`, `/compact` do not.

**Command file attachments are unavailable in this application.** A durable
`FileAttachmentRef` is not a native command attachment, receipts are minted
only by `@deepseek-ai/dsh-client-file-upload` (which requires `connection` and
is deliberately not composed), and this adapter neither mounts it nor invents
receipts. `commandSubmitParts` refuses a file part before `execute` with
`CAPABILITY_UNAVAILABLE` and keeps the draft; `commandSupport().files` and
`capabilities().commandFiles` are false. A future composition that mounts the
public upload owner would need an approved contract extension (a
receipt-bearing draft input) — not a TUI upload handler, HTTP route, receipt
registry or fake UUID.

Command **images** are supported through the native path: encoded images are
validated by this module and admitted by `execute`. The handler decides their
model-visible use (`/plan`, `/goal` steer them as user-message content), so the
adapter adds no vision or permission gate of its own.

## Settled command outcome (draft restoration)

`execute` distinguishes two failure shapes:

- a **thrown** rejection (transport, cancellation, adapter capability, a
  handler that threw) — nothing settled;
- a **settled native execution** `{ commandId, result }` where `result.kind` is
  `success` or `error`.

`commandOutcome(value)` returns `{ kind, text?, commandId?, sourceEventSeq? }`
for a well-formed settled execution and `undefined` for anything else
(unresolved line, malformed envelope, or a thrown call the caller caught).
`commandSettlesAsError(value)` is the named rule for the App: true for
`undefined` and `kind:'error'`, false only for a settled `success`. A settled
`error` is native's documented refusal convention (descriptor, attachment
admission, or handler grammar) so the dispatching composer retains the
originals. The App must therefore restore the draft whenever
`commandSettlesAsError` is true, and consume it only after an identity-checked
`success`. Output is
normalized, never marked as a diagnostic, and no new event or session fact is
introduced.

## Integration (parent-owned files)

1. `types.ts` already exposes `PromptContentPart.file`, `EncodedFileInput`,
   `CommandAttachmentPart`, optional `Backend.stageFile` and optional
   `QueueEntry.files`.
2. `context.ts`
   - `sendContent`: `normalizePromptContent` → text-only delegates to `send`;
     otherwise `admitPrompt` → `createUserMessage` → `followup`/`steer`.
     A file-only prompt is valid.
   - `execute`: accept `params.attachments`, pass
     `commandSubmitParts(normalizeCommandAttachments(...))` as the third native
     argument, return the settled execution unchanged (do not convert a
     `kind:'error'` result into a throw).
   - queue: use `recallableParts` for read/dequeue, rebuild `queue-replace`
     content with `queueReplacementContent`, and never re-admit a stored image
     ref. `QueueEntry.files` comes from `contentCounts`.
3. `app.ts`: `/attach` reads bounded local bytes and calls `stageFile`; editor
   file chips hold refs only; queue recall restores them directly; command
   drafts gate images on the descriptor flag and keep files unavailable with a
   clear message; on `commandOutcome(...) !== success` restore the draft.

## Limits

- Command file attachments are a permanent no in this composition (see above).
- Provider file support cannot be proven without a real write: a store that
  rejects `saveFile` surfaces `ATTACHMENT_FILES_UNSUPPORTED` at staging time.
- Subagent replies accept `PromptContentPart[]` (text/encoded image) only; a
  reply draft with a file cannot be delivered and must keep the draft.
- There is no public attachment deletion or `readImage(file)`; file bytes are
  never read on the prompt, queue or display paths.

## Tests

`test/backend-native-files.test.ts` covers canonical base64 (including the
empty file), ordered mixed prompt normalization/admission with repeated files,
native output tampering, missing services, `ATTACHMENT_FILES_UNSUPPORTED`,
redacted native failures, staleness and cancellation before/after the await,
file-aware queue recall/replacement counts, the exact descriptor gate, command
image assembly, unconditional command-file unavailability (no fabricated
receipt), `commandOutcome` success/error/undefined, and one offline test against
the installed `LocalAttachmentStore` in a temporary `DSH_HOME` (durable
identity, mixed admission, `createUserMessage` blocks, exact `readFileStream`
bytes). No real profile, credential or provider is touched.