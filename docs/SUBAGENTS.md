# Subagent frontend surfaces

DSH owns the child catalog and every child Session. The frontend projects the
shared contract in `src/backend/types.ts` and emits explicit user intent through
callbacks; it never calls a native mutation service itself, never spawns or
resumes a child for display, and never invents a status, seq, token count or
duration. The parent App/backend own prompt and interrupt execution.

Owned modules:

- `src/state/subagents.ts` — pure catalog fold, transcript anchoring, trigger
  message reader, overlay tree.
- `src/ui/subagent-format.ts` — shared native labels and metric formatting.
- `src/ui/blocks.ts` — single-line transcript row and settlement/trigger row.
- `src/ui/subagent-progress.ts` — bounded Pi-style progress tree above the one
  Editor, with parent-owned Grok-style direct child navigation.
- `src/ui/agents-overlay.ts` — temporary Agents modal.
- `src/ui/child-session-view.ts` — read-only child transcript frame with gated
  Reply/Stop controls and no composer.

## 1. Catalog projection (state)

`SubagentProjection` folds the two shared backend events:

- `subagents` (`{ sessionId, value: SubagentSnapshot }`) is an authoritative
  **full snapshot**: membership is replaced. Replaying an equal snapshot is a
  no-op (same entry object, same revision).
- `subagent` (`{ sessionId, value: SubagentEntry }`) is one native **upsert**.
  Equal data is a no-op. A later upsert that omits `catalogSeq` keeps the known
  cold-catalog anchor; a row with no known anchor never gets a guessed one.

`SessionInfo.subagents` is applied on `ready`/`reset`, so a resumed session gets
the cold catalog without a second read. Entries are normalized defensively:
unknown `mode`/`status` becomes the native `unknown` vocabulary and absent
numeric fields stay absent (never `0`).

`TranscriptStore` exposes:

```ts
store.subagentEntries          // every known child (direct + nested), catalog order
store.subagentSnapshot         // serializable snapshot, or undefined before a read
store.subagentsTruncated       // native incomplete-catalog flag
store.subagentEntry(sessionId) // one child, for detail wiring
```

### Transcript anchoring

`composeSubagentRows(items, projection, sessionId)` inserts one stable item per
**direct child**:

- `item.kind === 'subagent'`, `item.id === 'subagent:<childSessionId>'`;
- the entry must have `parentSessionId === sessionId` and a trustworthy
  `catalogSeq` (safe non-negative integer);
- the row is placed after the last projected item whose native `seq` is
  `<= catalogSeq`; if none, it goes first. A seq beyond the current (truncated)
  window lands at the durable tail rather than at a guessed future position;
- nested children and cold/external rows without a parent catalog seq are **not**
  inserted into the main transcript. They remain available to the overlay.

A child that finished before its catalog event was projected is still shown from
the backend's resolved entry, anchored at its native spawn seq (not the later
settlement).

## 2. Transcript row

One line per direct child, no accordion, no expansion:

```
⏺ Explore 仓库 · continuable · running · reading src/state/transcript.ts
```

- Native labels only: `one-shot` / `continuable` / `external` / `unknown mode`
  and the shared `SubagentStatus` vocabulary.
- A continuable finished child reads `last run completed · idle`, never a
  permanent `Done`. A one-shot child may read `completed`.
- Only a `running` child shows `lastActivity` (the one current activity); a stale
  activity is never presented as live work.
- No per-run metrics. Tokens/timing are session totals and appear in the
  above-editor progress, overlay and child header, not this transcript row.
- Width-safe degradation drops mode, then activity before truncating the
  label/status. Labels and activity pass through `sanitize`, so CJK, emoji and
  hostile ANSI never overflow or paint the terminal.
- A click activates `TranscriptViewOptions.onSubagentDetails(sessionId)` and
  opens the parent-owned details surface. Without that callback the row is
  inert. A claimed press survives an in-place row update (the hitbox is pinned
  by region id), so a repaint between press and release cannot steal the click.
- Generic tool cards are never merged into a subagent row by label or time.

## 3. Durable settlement / trigger rows

DSH writes child-settlement and adjacent-Agent messages as durable
`user/message` facts with `source.kind === 'subagent-settled' | 'agent-message'`.
The store keeps a real item:

```ts
{ kind: 'subagent-message', seq, sourceKind, senderSessionId, summary?, form?, text, version }
```

- `seq`, `senderSessionId`, `summary` and the exact joined text are preserved.
- The block renders native attribution (`Subtask status updated` / `Task message
  received`) plus the sender, never a `> ` human-prompt band and never a `· `
  ephemeral notice. Only an exact native prefix already stated by the header is
  removed from the paint; the stored text stays exact.
- Clicking the row/sender invokes the same `onSubagentDetails(senderSessionId)`.
- Surface replacement copies are still ignored, and other synthetic
  `user/message` sources keep the previous behavior (not shown).

## 4. Agents overlay

`AgentsOverlay` is a temporary modal, not a permanent pane. It holds no timer
and never polls.

```ts
new AgentsOverlay(tui, {
  entries, truncated?, keymap?, onClose, onOpen?, onReply?, onStop?, onInterrupt?,
  onGlobalAction?, onRenderRequest?, maxHeight?, now?,
})

overlay.setEntries(entries, { truncated? }) // omitted truncated preserves the current flag
overlay.setSnapshot(snapshot)               // a snapshot owns the flag explicitly
overlay.setEntry(entry)
overlay.update({ entry?, entries?, truncated?, snapshot? })
overlay.invalidate()
overlay.dispose()
overlay.focused
```

- Tree: roots are rows whose `parentSessionId` is not itself a known row; nested
  children follow their parent. Sibling order is native catalog seq, then
  creation time, then id. Cycles/orphans are shown rather than hidden.
- Rows show native label, mode, status, current activity, session-total tokens
  and session-total timing. Missing numbers paint nothing.
- External tasks are selectable leaves and never call `onOpen`.
- Input resolves in the `subagentList` context (`subagentList → list → dialog →
  global`, no editor fallback). Up/Down/PageUp/PageDown/Home/End navigate,
  Enter opens a local child and Esc closes. `subagent.reply` (default `r`) is
  offered only for a local continuable row with `onReply`; `subagent.interrupt`
  (default `s`) only for a local running/initializing row with `onStop`.
  Ctrl+C prefers that same gated Stop, otherwise it uses `onInterrupt`/closes.
  `app.exit` is forwarded to `onGlobalAction`; every other parent action is inert.
- Mouse: rows select/open with a claimed press; the wheel scrolls. Visible
  Reply/Stop footer chips use the same gating and pinned hitboxes as the keys.
  Narrow widths drop metrics and chips before truncating identity; invisible
  chips have no hitbox. A short viewport keeps selection and close.
- `dispose()` is idempotent, releases this instance's chord/hitboxes and never
  calls `onClose` or moves focus.

The parent action is `app.subagents.details` (registered by the input layer as
Ctrl+X Ctrl+A by default). Its own chord is not advertised here.

## 5. Child Session view

`ChildSessionView` frames a parent-supplied child `TranscriptStore` +
`TranscriptView`; it does not own child lifecycle or backend transport.

```ts
new ChildSessionView(tui, {
  entry, info?, store, view, keymap?, breadcrumb?, onClose, onReply?, onStop?,
  onInterrupt?, onGlobalAction?, onRenderRequest?, maxHeight?, now?,
  follow?, ownsView?,
})

childView.setEntry(entry)          // header refresh, same/new child id
childView.setEntries(entries)      // pick this child's row from a snapshot
childView.update({ entry?, entries?, info? })
childView.invalidate()
childView.dispose()                // idempotent; calls view.dispose() by default
childView.focused
```

- Header: breadcrumb (`Agents › parent › label` by default), native status/mode,
  route (`provider/model · effort`), session-total tokens and timing. `info`
  supplies model/provider fallback and the child session id.
- Conversation: the supplied `TranscriptView` inside a public `ScrollView`;
  following the end is the default (`follow: false` starts at the top). No
  composer, no prompt editor, no parent tool/model/permission/settings actions.
  Reply asks the parent to reuse the one main Editor; Stop is gated exactly as
  in Agents. Their visible footer chips are also mouse targets.
- Input resolves in `subagentSession` (no editor fallback). List keys scroll,
  Esc closes without stopping, `r` requests Reply and `s` requests Stop when
  applicable. Ctrl+C stops an active child first, otherwise delegates/closes;
  `app.exit` is forwarded to `onGlobalAction`. Typing and unrelated parent
  actions are inert.
- External tasks are framed honestly as having no local transcript.
- No timer: native session-total timing is folded from `settledMs`/`activeSince`
  on each frame (`now` is injectable for tests); the parent decides repaint
  cadence.
- Short viewports degrade to breadcrumb/status/close and never render an editor.

## 6. Demo fixtures (offline only)

`src/demo.ts` adds a `subagent` keyword flow. It is fixture-only and calls no
model:

- three parallel direct children with native catalog seqs
  (`running` continuable, `completed` one-shot, `failed` one-shot);
- one nested child and one external leaf without a parent catalog seq, so they
  remain available to the progress/overlay without inventing transcript anchors;
- a durable `subagent-settled` notice and an `agent-message` trigger;
- a full `subagents` snapshot followed by a live reactivation `subagent` upsert;
- `command('subagent-session', { sessionId })` returns a deterministic child
  `SessionInfo` snapshot for local children; external ids fail honestly;
- `command('subagent-follow', { sessionId, follow })` is a fixture no-op with a
  truthful shape: `{ sessionId, follow, following: false, supported: false,
  demo: true }`;
- fixture-only `subagent-prompt` accepts text or ordered text/image content and
  `queue|steer`, returns a deterministic receipt, appends a durable child user
  fact and later answer, and settles the continuable row to `idle`;
- fixture-only `subagent-interrupt` returns an admitted receipt and, only for
  an active local row, projects `stopped + lastStopReason:'aborted'`. These
  explicit demo transitions exercise the UI without pretending an Agent/model
  exists.

## 7. App integration contract

`src/app.ts` owns the two overlay lifecycles and native follow boundaries:

- `app.subagents.details` opens `AgentsOverlay`. A main-transcript row or
  above-editor agent-name link opens a child directly and closes back to the
  one Editor; a row opened from Agents returns to Agents on close.
- Opening a child first acknowledges `subagent-follow`, then buffers at most
  1024 of that child's frames while `subagent-session` reads the durable cut.
  The child store is reset with native events and the buffered frames are
  drained through the same revision/seq dedupe path. Overflow fails visibly
  instead of silently showing an incomplete conversation.
- The child `TranscriptStore`/`TranscriptView` uses the same native codec but no
  parent tool/image/model/settings callbacks. Root events are filtered again
  after child routing, so followed frames cannot alter parent busy/output
  state or create root user/assistant items.
- Closing, replacing or shutting down a surface releases follow. Session
  changes, fatal close and backend shutdown close and dispose every overlay;
  no child Agent is created or resumed for display.
- Native decisions stay rooted at the current top-level session and carry a
  `DecisionOrigin`; App prefixes the existing dialog title with the child label
  without mutating the native request or changing its response id.
- Reply closes both surfaces without an intermediate Agents reopen, unfollows
  and focuses the same root Editor with the exact draft/image registry intact.
  A visible `Replying to <label> · Esc to return` target controls only the submit
  destination. Enter uses native `queue`, Ctrl+X Ctrl+S uses native `steer`, and
  text/image parts go through `subagent-prompt`; targeted `/...` text is not a
  root slash command. Root `send-now` is rejected rather than mislabeled as
  steer. Accepted receipts consume the draft but do not create optimistic
  transcript/status; failures restore the draft. Esc only clears the target.
- Ctrl+C in a reply target interrupts that active child instead of the root;
  an idle target keeps the normal draft/exit behavior. Stop receipts likewise
  wait for later native lifecycle facts. Session/attachment changes and removed
  or ineligible targets clear the destination fail closed.
- `app.exit` keeps the root editor's existing empty-draft/double-press policy.
  Other parent-only actions stay inert. Mouse blocking covers every overlay,
  and header updates only invalidate on a real entry replacement (avoiding a
  synchronous render recursion).

`test/app-subagents.test.ts` covers the integrated DemoBackend path in both
renderers, including draft failure recovery, queue/steer, images and child-stop
routing. `test/acceptance-subagents.test.ts` uses real DSH parallel children,
a real child approval, cold reads, a followed delayed live chunk, a durable
continuable reply and a real running-child interrupt in both renderers.
`scripts/pty-subagents-smoke.py` proves inline keyboard and fullscreen mouse
chips through Stop → Reply → follow-up transcript → target exit, with resize,
draft preservation and terminal restore through the actual CLI.

## 8. Pi-style progress above the Editor

The visual reference is the user's installed `@tintinweb/pi-subagents` 0.23.1
(MIT), `src/ui/agent-widget.ts` / `renderWidget()`, and the supplied Pi
screenshot. Grok supplies the **navigation behavior**, not the table styling:
click one agent to enter that child, then Esc returns directly to the unchanged
root Editor. The Pi plugin itself is not loaded; its Agent engine, timer,
turn/tool-use counters, context percentages and costs are not copied.

```text
● Agents · 3 children · Ctrl+X Ctrl+A open
├─ ⏺ Explore repository  continuable · running · 9s · 1.2k tok
│    ⎿  reading src/app.ts
├─ ⏺ Review changes  one-shot · running
│    ⎿  checking the native fixture
└─ +1 more (1 completed)
────────────────────────────────────────────────────────────
❯ the one existing draft
```

`SubagentProgress` projects the existing `store.subagentEntries` snapshot:

- App mounts it after the queue projection and immediately before the
  Editor/dialog slot, outside the fullscreen transcript `ScrollView`. Native
  transcript catalog/settlement facts remain where they were.
- A blue `● Agents` heading, dim tree guides, cyan live marker, bold child
  label, muted native state/metrics and a second indented native activity line
  follow Pi's compact design. Missing native metrics are omitted, never zero or
  estimated. `lastActivity` is shown only while native status is `running`.
- Reply target first, then active rows **with their activity**, then settled
  history, retaining native order within each group. The hard budget includes
  the heading, every row, activity, overflow and separator. App caps it at eight
  lines and samples actual queue/Editor/dialog/hint/footer heights on each
  renderer paint, reserving a transcript slice. A short terminal falls back to
  summaries, a heading or no widget. An empty catalog consumes no row.
- Only the visible **agent-name text** is an internal child-navigation link:
  bold + brand blue + underline, brighter on hover. Its hitbox excludes the
  guide, status glyph, gaps, mode/status/metrics/route, activity and padding.
  External/non-openable/missing-callback names are plain text, not fake links.
  Only the `Agents` word and `+N more` text open the full tree; the heading's
  count/chord and overflow grouped counts remain inert. No OSC8 URLs, browser
  destinations or custom schemes are generated. Inline keeps the design but
  leaves the mouse to terminal scrollback; the shared Agents shortcut is its
  keyboard path. Remaps/disabled bindings are reflected honestly in the header.
- All non-link text keeps native selection, drag and copy, including the first
  drag after hovering a link and a selection dragged across a link. Spans use
  Pi display columns from the actual final clipped paint, not UTF-16 lengths;
  clipped-away names have no hitbox. A press begun outside a link remains
  unclaimed even if native reflow or reattachment moves a name under that point.
  Claimed presses stay pinned; invalidation/temporary blocking cannot revive
  an old gesture. No drag is converted into a click jump.
- No second editor, no input listener, no focus capture, no polling, child
  snapshot reads or timer for progress. Ordinary `r`/`s` still edit the draft;
  native Reply/Stop remain in the Agents/child surfaces.
- App uses live getters for the height budget and current mouse owner. Dialogs
  and overlays block underlying hits; Esc immediately re-enables progress
  clicks without a new key or native frame. Claimed presses are pinned to the
  child identity. Attachment invalidation or any frame hiding/removing a
  pressed region permanently voids that gesture, even if the same id appears
  again before release. Shutdown disposes the component.

`test/ui-subagent-progress.test.ts` tests the pure component. The parent-owned
`test/app-subagent-progress.test.ts` covers both renderers, real mouse dispatch,
scroll pinning, active-detail priority, multiline/resize budgets, image-bearing
draft preservation, direct return/reopen, overflow, decisions and stale
attachment/membership gestures. `scripts/pty-subagent-progress-smoke.py` tests
visible placement, the Pi tree style, direct fullscreen agent-name clicks,
Esc/draft return, header navigation, resize and terminal restore through the
real offline CLI/PTY. `scripts/pty-subagent-links-smoke.py` adds exact title/name/
overflow span boundaries, external non-links, real drag/copy-on-select after
hover, and clickable-name style checked from independent emulator cells. Copy
packets are captured inside a private PTY, never sent to the real clipboard.
