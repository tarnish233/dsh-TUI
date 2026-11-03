# Frontend contract

Own src/state/, src/ui/, src/demo.ts, test/ui*.test.ts. Parent integrates app and CLI; no manifest/backend/input/shared-helper changes. Use src/backend/types.ts.

## Transcript projection (state)

`src/state/transcript.ts` projects DSH's durable v2 log plus the tentative live stream. It does **not** implement agent semantics and it does **not** reimplement DSH assembly:

- `TranscriptStore` constructor: `new TranscriptStore({ onChange?, codec? } | onChangeCallback)`.
- `setCodec(codec: TranscriptCodec | undefined)`: install `Backend.transcriptCodec`. The parent calls it **before** `reset`/`ready`. `hasCodec` reports whether native helpers are installed.
- `items` read-only view, `info`, `sessionId`, `status`, `hasLiveAttempt`, `reset(info: SessionInfo)`, `clear()`, `handle(event: BackendEvent)`, `report(text, level?: 'info' | 'error')`, assignable `onChange`.
- With a codec: `createStream()` drives the live attempt, `assemble(stream)` drives committed `assistant/attempt` views, `surfaceKind(event)` decides append/replace/none. Without a codec the store keeps attempt identity/ordering/settlements only and shows no streamed preview — there is deliberately no local BlockAssembler/compact-expander mirror.
- Surface semantics: a message event (`user/message`, `assistant/message`, `tool/result`, `system/message`, `developer/message`) classified `replace` is a **model-only** replacement copy. It never appends a transcript item, never overwrites and never erases append-origin human transcript facts, including tool output that native pruning shadowed. Non-surface lifecycle records (`tool/call`, `assistant/attempt`, turn/step markers, `command/*`) are always projected. `sourceEventSeqs` is not written back anywhere.
- Live identity: `attemptId` is identity; every frame carries an increasing `revision`, and `index` only rejects duplicates/stale replays. A committed `stream_end` marks the attempt `committing` until the matching durable settlement replaces it in place; abandonment leaves an explicit tentative `attempt` item.

Item status vocabulary (never a fabricated success/failure):

- `ToolTranscriptItem.status`: `proposed` (model requested the call in an assistant message) → `running` (durable `tool/call`) → `done`/`error` (durable `tool/result`); `unknown` when the turn ended, the connection closed, or a snapshot replay ended before a result. `unknown` never overwrites a real `done`/`error`.
- `AttemptTranscriptItem.status`: `streaming`, `committing`, `abandoned` (durable attempt settlement or explicit abandonment), `unknown` (turn/disconnect before settlement).
- `ToolTranscriptItem.presentation?: JsonRecord`: the ephemeral native view forwarded as `SessionEvent.toolPresentation`. Primary shape `{ call?: ToolCallView, result?: ToolResultView }` from `@deepseek-ai/dsh-tools/presentation`; a flat single native card is also accepted (settled cards are read as results, unsettled ones as call intents). Both halves are merged so a card keeps its pending and completed intent. It is display state only and is never persisted into DSH's log.

## Rendering (ui)

- `src/ui/transcript.ts`: `TranscriptView` implementing `Component`, constructor `(store, options: { showThinking: boolean, expandTools: boolean })`. Options stay mutable by the parent. One cached component per stable item id; a token only invalidates the live item.
- `src/ui/blocks.ts`: tool cards prefer the native render intent — terminal (command/cwd/description, output, exit code/signal), diff (pending "proposed, not applied" vs completed "Updated … with N additions and M removals"), read (native absolute line numbers), search (files/paths with `truncated`/`total`), web (sources or fetch status) — and fall back to the generic name+argument summary plus opaque `tool/result` `meta.diffs` when no card is forwarded. FileDiff carries a hunk, not file coordinates: hunk rows keep CC add/delete colors but show **no** absolute line numbers, and a pending call never claims a file effect.
- `src/ui/theme.ts`: `editorTheme`, `markdownTheme` and small styling functions; no Pi Agent dependencies.
- `src/ui/dialogs.ts`: `SelectDialog(tui, {title,items:DecisionOption[],onSelect,onCancel})` and `DecisionDialog(tui,request,onSubmit,onCancel)`. Both are Focusable Components, expose capturesViewportInput where appropriate, Ctrl+P/N navigate via injected global keybindings, printable custom answers edit rather than trigger j/k selection. `DecisionDialog` returns the opaque option value or `{answers:(string|string[])[]}` per backend contract.

## Demo (offline only)

- `src/demo.ts`: `DemoBackend({cwd?:string,delayMs?:number}?) implements Backend`, explicitly demo-only and never a fallback for a failed real connection. Deterministic real-shaped DSH live frames with strictly increasing revisions + durable v2 session events, every surface event carrying `surfaceOp: 'append'`, plus questions, tool call/result, abort, error and unresolved-tool fixtures.
- `transcriptCodec` is exposed **before** `ready` and is a clearly fixture-only implementation (`DemoTranscriptCodec`) so `--demo` and pure UI tests run without DSH installed. It is not a production mirror and must not be used when a real backend is present.
- Commands: `command('commands')` returns native-shaped `CommandDescriptor[]` (`{name,description,input?}`); `command('execute', {line})` returns `CommandExecution` (`{commandId,result:{kind,text?,sourceEventSeq?}}`) and appends paired durable `command/run`/`command/done` records. `command('compact')` is a compatibility alias for the execute path, not its own compaction implementation.

The parent implements the prompt wrapper, working/status/footer, key action routing, history search, native codec loading/wiring, CLI and shutdown. Tests use @xterm/headless or pure state assertions, no model calls and no DSH runtime imports from UI/state. Preserve attribution for copied helpers.