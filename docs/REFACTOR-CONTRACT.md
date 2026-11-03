# Native DSH boundary refactor (historical)

> The provider/migration sections below were superseded by [NATIVE-DSH-CONFIG-CONTRACT.md](NATIVE-DSH-CONFIG-CONTRACT.md). They record an earlier approved pass; current code has no Pi model/auth importer. Other sections remain useful historical context.

This is the implementation contract for the user's approved refactor. Pi TUI is a reusable terminal/input toolkit, not the owner of agent business logic. Keep CC input and Pi rendering; call native DSH services and public helpers for business/data semantics. Do not modify global installations or real user configuration/credentials. No commits or remote model probes in delegated work.

## Shared contracts (parent-owned)

`src/backend/types.ts` now declares:

- `SessionEvent.surfaceOp`, `sourceEventSeqs`: preserve native metadata for BOTH realtime events and snapshots.
- `SessionEvent.toolPresentation?: JsonRecord`: ephemeral view from the exact native tool's `presentCall/presentResult`; never write this back to DSH's log.
- `TranscriptCodec`: `createStream()` -> `{push(chunk), snapshot(interrupted?)}`, `assemble(compactStream, interrupted?)`, `surfaceKind(event)` -> append/replace/none. Production uses public DSH BlockAssembler/assistant-stream/surface helpers. The parent supplies it through `Backend.transcriptCodec` BEFORE any ready event. Demo supplies a clearly mock-only codec; no production fallback/mirror.
- Process-local `SessionInfo.attachmentId` distinguishes Agent replacement even for the same session ID; it is not another durable identity. Migration diagnostics use `warning`, not model `error`.
- Optional question `id`/`intent` survive the wire. Ordered answer compatibility can remain; do not invent permission rules.
- `backend.command('commands')` -> native descriptors; `backend.command('execute', {line})` -> native `CommandExecution` (`{commandId,result:{kind,text?,sourceEventSeq?}}`). Existing `compact` may be a compatibility alias to native execute, never its own compactNow wrapper.

Wire: hello includes `protocolVersion: 2`. `SessionInfo.permissions` and permission-change events carry the native `{currentValue}` projection; there is no `mode` field/setter. The read-only `permissions` control preserves native catalog options; switches execute `/permission`. Native `/plan` is independent. Bridge accepts an `abort` control method with `{id: requestId}` to abort the corresponding active native command's signal; this is transport cancellation, not agent scheduling. Normal `cancel` aborts current-session active commands and calls native Agent.cancel. Parent handles client timeout policy/abort forwarding/protocol checks.

Parent passes `dshPackageJsonPath` in bridge config and PrepareWorkspaceOptions. Resolve packaged public exports with `createRequire(dshPackageJsonPath).resolve(...)` plus dynamic import, rather than copying helpers or depending on project/global layouts. Keep the existing agentModuleUrl compatible while moving discovery to public exports.

## Parallel ownership for THIS pass

### Runtime worker

Own `runtime/bridge.mjs`, `runtime/bridge.d.mts`, NEW `test/backend-native-runtime.test.ts`, `docs/BACKEND.md` only. This ownership snapshot predates the native-config pass; the provider-auth module no longer exists.

Implement native commands list/execute (argument checks, audit pairing, sourceCommandId via native CommandRuntime), signal cancellation/drain, remove bridge-level process crash handlers and conflicting immediate exits, remove first-provider default selection, use native createUserMessage, use sessionQuery for durable snapshots, correct title observations and expose honest createdAt. Preserve surface metadata. Generate optional tool presentation through `tools.get(name, agent)` and pure native presenters; map/cache call metadata only for presentation, never execute tools or alter results. Keep all native raw data and attempt frame revision/index semantics. Bound snapshots using UTF-8 bytes and explicitly report omissions instead of mutating durable text. Do not replace the working streaming bridge with committed-only SDK/ACP.

### Projection worker

Own `src/state/transcript.ts`, `src/ui/blocks.ts`, `src/demo.ts`, `test/ui-state.test.ts`, `test/ui-view.test.ts`, `test/ui-demo.test.ts`, `docs/FRONTEND-CONTRACT.md` only. Parent owns App/dialog orchestration and native codec loading.

Expose `TranscriptStore.setCodec(codec: TranscriptCodec)` (or constructor plus setter) so parent can install backend.transcriptCodec before reset/ready. Use injected native codec instead of the current production compact-expander/BlockAssembler mirror. Remove dead fields/algorithm copies; a thin fixture-only codec belongs in demo, not the production state module. Filter model-only replacement MESSAGE events while retaining non-surface lifecycle/attempt events. Keep live attempt identity/revision filtering, ordering and settlement de-duplication.

Consume native toolPresentation, with generic fallback when absent; retain CC layout/width/diff coloring. FileDiff contains before/after hunk text, so intra-hunk diffLines is rendering, not business duplication. Do NOT present relative hunk numbers as absolute file lines. Distinguish proposed/pending tool calls from observed tool/call, and settle outstanding visual status on turn end/disconnect without fabricating success/failure. Demo remains explicit offline-only, uses increasing frame revisions, and implements commands/execute shapes plus transcriptCodec. Do not change input or claim complete CC compatibility.

### Provider/bootstrap worker (superseded by native config pass)

This historical section required Pi catalog/auth import. It is no longer the current contract: see [NATIVE-DSH-CONFIG-CONTRACT.md](NATIVE-DSH-CONFIG-CONTRACT.md). The implementation has removed `external-models.ts`, `provider-profiles.ts` and the migration auth shim; there is no `modelsFile`, Pi import, provider regrouping or credential migration. Native DSH profile/home configuration, catalog, defaults and credentials are authoritative. Remaining runtime/home isolation is a narrow scratch seam only, not a model/auth subsystem.

### Parent

Own `src/backend/types.ts`, client/protocol/errors, NEW native codec loader, `src/app.ts`, CLI/config/dialog orchestration, manifest/lock, general backend tests and imported SSE tests, independent new acceptance tests, README/acceptance and integration. Fix decision FIFO/exact request IDs, dynamic command discovery/dispatch/result presentation, method timeout/abort, codec wiring, explicit-import examples. Verify actual changes and run full typecheck/tests, offline native SSE/command/approval/surface regressions, actual CLI PTY and opt-in representative live model acceptance in temporary homes.

## Acceptance invariants

- No AgentSession, second agent loop, new LLM client, permission-policy fork or second conversation persistence.
- Partial output appears before provider finish in inline/fullscreen; durable settlement de-duplicates it.
- Append-origin tool output survives native model-only pruning/replacement and replay.
- Multiple decisions retain individual entry/response/closure; old-session decisions cannot cross sessions.
- Native /compact handles arguments/results and produces command/run + command/done; cancellation propagates and timeout is not falsely presented as a committed success.
- Toolkit/input patch and terminal restoration remain intact.
- No real keys in config/argv/protocol/log fixtures; routine tests use temporary homes and loopback SSE only.

Ask parent before changing shared contracts/another worker's files. Run only owned targeted tests while peers are writing; parent owns the final full suite. Report exact changes and remaining gaps, not predictions.
