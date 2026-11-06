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
- Notice plane: there is exactly one, `store.report(text, level)`. The caller's `level` — never the text — decides presentation: `error` is `● <headline>` in error red with every following line indented under the marker, `info` is a muted `· …` line. Multi-line native text (including a bounded redacted `Native cause: …` line a backend may append to a *correlated* compact failure) is rendered verbatim and wrapped width-safely, so the UI never summarizes, truncates, relabels or re-splits it, and never invents a cause. A notice is not durable session truth: it is appended after any tentative live item and never settles or rewrites it. `src/ui/text.ts#sanitize` strips terminal sequences and C0/C1/DEL bytes before any notice, tool or dialog row is styled, so untrusted provider text cannot paint the screen.
- `src/ui/dialogs.ts`: `SelectDialog(tui, {title,items:DecisionOption[],onSelect,onCancel})` and `DecisionDialog(tui,request,onSubmit,onCancel)`. Both are Focusable Components, expose capturesViewportInput where appropriate, Ctrl+P/N navigate via injected global keybindings, printable custom answers edit rather than trigger j/k selection. `DecisionDialog` returns the opaque option value or `{answers:(string|string[])[]}` per backend contract.

## Subagent surfaces

See `docs/SUBAGENTS.md` for the full contract.

- `src/state/subagents.ts`: pure `SubagentProjection` fold of `subagents` snapshots and `subagent` upserts; `composeSubagentRows` anchors one stable transcript row per **direct** child only when `parentSessionId` matches and `catalogSeq` is trustworthy; unsequenced/nested/external cold rows stay overlay-only. `readSubagentMessage` projects durable `user/message` sources `subagent-settled` / `agent-message` with exact seq/sender/summary/text. `buildSubagentTree` is cycle-safe on `parentSessionId`.
- `TranscriptStore`: `subagentEntries`, `subagentSnapshot`, `subagentsTruncated`, `subagentEntry(id)`; `items` composes anchored subagent rows; `subagents`/`subagent` events are idempotent and session-scoped.
- `TranscriptViewOptions.onSubagentDetails(sessionId)` / `subagentDetailsHint`: inline subagent row and trigger-row sender clicks. Rows have no accordion and no per-run metrics; continuable completion reads `last run completed · idle`.
- `src/ui/agents-overlay.ts`: temporary `AgentsOverlay` modal with `setEntries`/`setSnapshot`/`setEntry`/`update`/`dispose`, `subagentList` key context, `parentSessionId` tree, native session-total tokens/timing, external leaves, mouse/wheel and width-safe degradation; no pane or timer. Optional `onReply`/`onStop` plus pure `subagentCanReply`/`subagentCanStop` gate configurable R/S actions and pinned mouse chips; the component emits intent but never mutates a child.
- `src/ui/child-session-view.ts`: `ChildSessionView` frames a parent-supplied child `TranscriptStore` + `TranscriptView` with `subagentSession` input: read-only conversation, breadcrumb/status/model/session totals, Esc close, global `app.exit` delegated via `onGlobalAction`, no composer/timer. Reply requests the parent's one main Editor; Stop only targets active local rows; external tasks have no local transcript or controls.
- `src/ui/subagent-progress.ts`: `SubagentProgress` is the compact progress tree the parent mounts immediately **before** the one Editor/slot (never inside the transcript scroll host). Visual shape follows the installed pi-subagents `aboveEditor` widget (`src/ui/agent-widget.ts`, MIT): dim `├─`/`└─` guide, small live marker, **bold** label, muted inline state/metrics, one indented `⎿` activity line per live child, `+N more (…)` overflow. Only DSH facts are painted: native label, `one-shot`/`continuable`/`external`/`unknown mode`, native status (`last run completed · idle` for a continuable child), optional `provider/model · effort` route, session-total tokens/time and the real current `lastActivity` of a `running` child. Pi's turn counter, tool-use count, context percentage and cost have no DSH equivalent and are never synthesized; no transcript is fetched to fill the activity line.

  ```ts
  const progress = new SubagentProgress({
    keymap, onOpenAgents, onOpenChild, onRenderRequest,
    maxRows: () => rowBudget(),
    mouseBlocked: () => dialogOpen || overlayOpen,
  })
  progress.entries = store.subagentEntries   // projected before every render
  progress.truncated = store.subagentsTruncated
  progress.replyTargetId = target?.childId
  // Static hosts may instead assign progress.maxRows / progress.mouseBlocked.
  progress.render(width); progress.invalidate(); progress.handleMouse(event); progress.dispose()
  ```

  - `maxRows` is a **hard total** (header, rows, per-row activity, overflow count and the trailing separator). A constructor value may be a live getter/callback (re-sampled on every paint for resize/multiline budgets); an explicit assignment wins, otherwise the constructor option, otherwise the last number. Default 8. Non-positive budgets render `[]`; non-finite values fall back to 8.
  - App uses a live `mouseBlocked` getter: closing an overlay only requests a Pi repaint, so mouse affordances must immediately become available again without waiting for typing or another native event.
  - An empty catalog renders `[]`: no blank spacer row and no invisible hitbox. Nothing is read from the backend, no timer runs, no polling, no child work.
  - Priority: reply target first (marked, label in the accent tier), then live children **with** their activity line, then settled history; each group in native catalog order. The overflow count is reserved before extra rows, so bounded history is always stated. A live row degrades to its summary line only when the budget cannot hold the pair; once a live row cannot be admitted, settled rows are not admitted either.
  - Header `● Agents · N children · <chord> open` (the native marker dims when everything settled; the actionable `Agents` word remains a blue underlined link; `incomplete` when the native catalog is truncated). The chord comes from the real keymap in the editor context, so a remapped action advertises the new key and a disabled one advertises nothing.
  - Mouse is the only input: **only the `Agents` word / `+N more` text** request `onOpenAgents`, and **only a visible openable agent-name span** requests `onOpenChild(entry)`. Internal links are bold + brand blue + underline, brighter on hover; no OSC8/browser/custom-scheme URL is emitted. External, remote, missing-callback and clipped-away names have no fake link/hitbox. Spans are measured from final painted/clipped display columns (CJK/emoji/ANSI safe), not string lengths. Guide/glyph/gaps/counts/chords/status/timing/tokens/route/activity/padding stay non-navigation text.
  - Non-link presses and every move/drag stay unclaimed: native selection and copy-on-select work after a hovered link and across link boundaries. An outside-press tombstone survives reflow/invalidate/temporary blocking, so a name that later moves under its coordinates cannot receive that click. Claimed name presses are pinned by id; vanish/reappearance, invalidate and blocking void them; dragging never becomes a click jump. `mouseBlocked` removes hits and never captures input. The component never takes focus or installs an input listener; the Editor keeps ordinary typing and `r`/`s` stay text.

## Demo (offline only)

- `src/demo.ts`: `DemoBackend({cwd?:string,delayMs?:number}?) implements Backend`, explicitly demo-only and never a fallback for a failed real connection. Deterministic real-shaped DSH live frames with strictly increasing revisions + durable v2 session events, every surface event carrying `surfaceOp: 'append'`, plus questions, tool call/result, abort, error and unresolved-tool fixtures.
- `transcriptCodec` is exposed **before** `ready` and is a clearly fixture-only implementation (`DemoTranscriptCodec`) so `--demo` and pure UI tests run without DSH installed. It is not a production mirror and must not be used when a real backend is present.
- Commands: `command('commands')` returns native-shaped `CommandDescriptor[]` (`{name,description,input?}`); `command('execute', {line})` returns `CommandExecution` (`{commandId,result:{kind,text?,sourceEventSeq?}}`) and appends paired durable `command/run`/`command/done` records. `command('compact')` is a compatibility alias for the execute path, not its own compaction implementation.
- `subagent` keyword fixture: parallel direct children (running/completed/failed), one nested child, one external leaf, a durable settlement notice and adjacent-Agent trigger, a full catalog snapshot plus a live reactivation upsert. `command('subagent-session', {sessionId})` returns a deterministic child `SessionInfo`; external ids fail. `command('subagent-follow', {sessionId, follow})` is a fixture no-op (`following:false`, `supported:false`). Fixture-only `subagent-prompt` preserves text/image content and queue/steer, appends durable child facts and settles continuable work to `idle`; `subagent-interrupt` projects an active local row as `stopped` with `lastStopReason:'aborted'`. Fixture-only, no model/network.

The parent implements the prompt wrapper, working/status/footer, key action routing, history search, native codec loading/wiring, CLI and shutdown. Tests use @xterm/headless or pure state assertions, no model calls and no DSH runtime imports from UI/state. Preserve attribution for copied helpers.