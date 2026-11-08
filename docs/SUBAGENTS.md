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

One line per direct child when grouping does not apply (see
[Consecutive record grouping](#consecutive-record-grouping-tools-style)); no
accordion and no per-row expansion:

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
  label/status. Labels pass through `sanitize` and are whitespace-folded with
  `oneLine` **before** any width math (only the display copy; the store keeps
  the exact native label), so CJK, emoji, LF/CR/TAB and hostile ANSI never
  overflow, add a row or paint the terminal.
- **Only the visible name text** is a child-navigation link — `onSubagentDetails(sessionId)`
  bold + brand blue + underline, brighter on hover. The status glyph, mode,
  status, activity tail, hint and every gap stay plain text with native
  selection/copy. A non-openable (external/remote) child, a missing callback or
  a name clipped out of the final paint owns no hitbox at all; link columns are
  measured from that final clipped paint in display columns.
- Gestures (`src/ui/subagent-link.ts`, one narrow helper shared by every
  subagent name link — individual rows, both group member modes and collapsed
  group summaries):
  - only a left press on a visible link claims the gesture; any other press is
    remembered as an **outside press** and stays unhandled for native selection,
    so a later frame that grows a label or resolves a durable sender id into a
    real catalog name under those coordinates can never turn that press into
    navigation;
  - `move`/`drag` are never claimed, so hover repaints locally while
    drag-to-select and copy-on-select keep working, including the first drag
    that crosses a hovered name;
  - a click is accepted only for the claimed region with the same press
    coordinates, no drag and no vanished/invalidated region — it is never
    re-derived from the newest frame's coordinates;
  - a claimed region that disappears for any frame permanently voids that
    gesture, even if the same link returns before the release;
  - an ordinary in-place repaint keeps the pin (a row that updates between press
    and release still opens the pressed child); eviction, session replacement and
    dispose clear it.
- Generic tool cards are never merged into a subagent row by label or time.

### Consecutive record grouping (Tools-style)

`src/ui/subagent-group.ts` projects the *view* only; `TranscriptStore.items`
keeps every native row, seq, source attribution and message text in native
order.

```
● Subagents: 3 records · 1 running · 1 completed · 1 message · ctrl+o to expand
 ├ ⏺ Alpha 仓库 · running · reading src/app.ts
 ├ ⏺ Beta · completed
 └ ⏺ Subtask status updated · Gamma
```

- Only `subagent` catalog rows and `subagent-message` (`subagent-settled` /
  `agent-message`) facts join; a run needs at least two members. User/assistant/
  tool/attempt/notice/todo items and tool groups always break the run, so
  nothing is merged across a real boundary and nothing is reordered.
- Collapsed member rows keep the identifier/status/attribution summary and fold
  the message body; expanded members are the **real** child blocks (never a
  rewrite), prefixed with a two-column tree guide. Prefix width, member render
  width and the dispatched mouse `xOffset` all derive from the same constants, so
  a member paint is never over-clipped or mis-addressed.
- Disclosure is the existing ephemeral Tools map under
  `group:<anchor item id>`, so `Ctrl+O` (`app.tools.expand`) and single-expand
  treat a subagent group exactly like a tool group. The **header is a
  disclosure control only** and can never open a child; expanded member bodies
  are plain selectable text with no body hitbox, so no repaint can retarget a
  press there into child navigation.
- Collapsed member names and expanded member names are the same name-only links
  described above (catalog label, or the honest durable sender id with no link
  when the catalog does not know that child).
- Grouping follows the independent `groupSubagentMessages` preference: `false` restores one
  row per record. It no longer reuses `groupTools`; a legacy file is snapshotted once from its old
  Tools value, then Agents reset uses the Agents default and never reads Tools again. Ctrl+O and
  single-expand still share only the temporary disclosure state. No backend field or stored
  synthetic fact exists.

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
- The sender identity is resolved from the **already-held** catalog
  (`store.subagentEntries`, synced through presentation flags; nothing is
  fetched): a known child shows its real native label as the name link, an
  unknown/unopenable (external, non-local) child shows the durable sender id as
  plain text and offers no link, so no dead navigation is advertised.
- On a narrow terminal the attribution is kept and the name is partially
  clipped by the final `fit`: the link covers only the visible name columns, so
  the ellipsis cells are never clickable and no invisible hitbox exists.
- Only that visible sender name invokes `onSubagentDetails(senderSessionId)`;
  the attribution title, gap and body paragraphs stay selectable text.
- Surface replacement copies are still ignored, and other synthetic
  `user/message` sources keep the previous behavior (not shown).

## 4. Agents overlay

`AgentsOverlay` is a temporary shared-`ModalFrame` modal (standard), not a permanent pane. It holds no timer
and never polls.

```ts
new AgentsOverlay(tui, {
  entries, truncated?, initialState?: AgentsViewState, keymap?, onClose, onOpen?,
  onReply?, onStop?, onInterrupt?, onGlobalAction?, onRenderRequest?, maxHeight?, now?,
})

overlay.setEntries(entries, { truncated? })
overlay.setSnapshot(snapshot)
overlay.setEntry(entry)
overlay.update({ entry?, entries?, truncated?, snapshot? })
overlay.setMessage(message, error?)    // visible current-surface native failure
overlay.captureView(): AgentsViewState // query/filter/selected native id/scroll
overlay.invalidate(); overlay.dispose(); overlay.focused
```

- Search is an on-demand `modal.search` field over native label/description/metadata; browse-mode
  printable keys and digits are inert. `subagent.filter.toggle` (Tab) switches Active/All in browse.
  Filtering never mutates the catalog; selection reconciles by native child id when rows reorder,
  disappear or the query changes. A removed id is replaced by the nearest visible row, never
  resurrected.
- Tree: roots are rows whose `parentSessionId` is not itself a known row; nested
  children follow their parent. Sibling order is native catalog seq, then
  creation time, then id. Cycles/orphans are shown rather than hidden.
- Rows show native label, mode, status, current activity, session-total tokens
  and session-total timing. Missing numbers paint nothing. Selecting or hovering
  a row reads only this metadata: no follow, transcript read, stop or model call.
- External tasks are selectable leaves and never call `onOpen`.
- Input resolves in the `subagentList` context (`subagentList → list → dialog →
  global`, no editor fallback). Up/Down/PageUp/PageDown/Home/End navigate,
  Enter opens a local child and Esc closes. `modal.search` (Ctrl+F) focuses the
  search field; `subagent.filter.toggle` (Tab) switches Active/All. `subagent.reply`
  (default `r`) is offered only for a local continuable row with `onReply`;
  `subagent.interrupt` (default `s`) only for a local running/initializing row
  with `onStop`. Ctrl+C prefers that same gated Stop, otherwise it uses
  `onInterrupt`/closes. `app.exit` is forwarded to `onGlobalAction`; every other
  parent action is inert. The search field uses the shared CC editor grammar,
  so `r`/`s` are ordinary text while typing and no unknown action leaks into
  the hidden root editor.
- Mouse: rows select/open with a claimed press; the wheel scrolls. Visible
  Reply/Stop footer chips use the same gating and pinned hitboxes as the keys.
  Narrow widths drop metrics and chips before truncating identity; invisible
  chips have no hitbox. A short viewport keeps selection and close.
- `dispose()` is idempotent, releases this instance's chord/hitboxes and never
  calls `onClose` or moves focus.

The parent action is `app.subagents.details` (registered by the input layer as
Ctrl+X Ctrl+A by default); its own chord is not advertised here. The App also
mounts the UI-owned `/agent` alias, which opens this same overlay. `/agent` is
a TUI navigation alias, not a DSH mutation command: it never starts, resumes,
stops or prompts a child and performs no native child read.

This overlay is the **history surface** for retired children: the progress
widget above the Editor is active-only, while `AgentsOverlay` keeps showing the
full native catalog (settled, nested and external rows).

## 5. Child Session view

`ChildSessionView` frames a parent-supplied child `TranscriptStore` +
`TranscriptView` in a shared `ModalFrame` (wide); it does not own child lifecycle or backend transport.

```ts
new ChildSessionView(tui, {
  entry, info?, store, view, keymap?, breadcrumb?, onClose, onReply?, onStop?,
  onInterrupt?, onGlobalAction?, onRenderRequest?, maxHeight?, now?,
  follow?, ownsView?, loading?,
})

childView.setEntry(entry)             // header refresh, same/new child id
childView.setEntries(entries)         // pick this child's row from a snapshot
childView.update({ entry?, entries?, info? })
childView.setLoading(loading)         // loading shell on/off; display only
childView.setMessage(message, error?) // native stop/reply failure in this surface
childView.invalidate()
childView.dispose()                   // idempotent; calls view.dispose() by default
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
- Loading shell: `loading: true` (constructor) or `setLoading(true)` replaces
  only the conversation body with `Loading child session…` — never the
  misleading `No messages` empty state — and keeps the normal header, identity,
  footer, Reply/Stop gating, Esc/global actions and hitboxes. Scrolling is inert
  while loading, and the compact viewport states the same pending read. The
  parent constructs this same view immediately from the catalog entry plus an
  empty child store/view, then resets that store from the native snapshot and
  calls `setLoading(false)`; no fake `SessionInfo` is required (`info` stays an
  optional fallback supplied later through `update({ info })`), no second
  Editor or Agent is created, and no timer or child read happens here.
- Settling never auto-closes an open child view: the parent only refreshes the
  header entry, so the final output stays readable (mirroring Pi's conversation
  viewer, which also stays open when its agent finishes). Esc/surface
  replacement/session change close it; settlement does not.
- No timer: native session-total timing is folded from `settledMs`/`activeSince`
  on each frame (`now` is injectable for tests); the parent decides repaint
  cadence.
- Short viewports degrade to breadcrumb/status/close and never render an editor.

## 6. Demo fixtures (offline only)

`src/demo.ts` adds a `subagent` keyword flow (plus the `subagent-many`
overflow variant below). It is fixture-only and calls no model:

- three parallel direct children with native catalog seqs
  (`running` continuable, `completed` one-shot, `failed` one-shot);
- one nested child and one external leaf without a parent catalog seq; both
  stay in the Agents catalog without inventing transcript anchors, while only
  native active entries are eligible for progress;
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
- `subagent-many` keyword flow: the same fixture **plus** three deterministic
  local `continuable`/`running` rows (`demo-child-active-1..3` with distinct
  labels and current activity). They carry no `catalogSeq` (so they invent no
  transcript anchor) and no session totals/timing the fixture did not observe,
  are emitted as native-shaped `subagent` upserts and included in the final
  snapshot, and their `subagent-session` reads work like any other fixture
  child. This is the explicit offline CLI fixture supplying enough live
  children for active-only progress overflow (`+N more`) acceptance. It adds no
  production flag, transport, Agent or model behaviour; the default `subagent`
  fixture (exactly one live child) is unchanged.

## 7. App integration contract

`src/app.ts` owns the two overlay lifecycles and native follow boundaries:

- `app.subagents.details` opens `AgentsOverlay`; the UI-owned `/agent`
  alias opens the same overlay from the root Editor and is navigation only
  (never a native DSH mutation command). In an explicit child-reply target,
  `/...` remains child text; Esc returns to the root before using `/agent`. A main-transcript row or above-editor agent-name link
  opens a child directly and closes back to the one Editor; a row opened from
  Agents returns to Agents on close. A settled child remains listed here, so
  `/agent` is also the historical navigation path once progress retires it.
- Opening a child creates the `ChildSessionView` loading shell immediately
  (catalog entry + empty child store/view, `loading: true`), then acknowledges
  `subagent-follow` and buffers at most 1024 of that child's frames while
  `subagent-session` reads the durable cut. The child store is reset with
  native events, the buffered frames are drained through the same
  revision/seq dedupe path, and the shell is switched off with
  `setLoading(false)`. Esc while loading closes the surface, releases any late
  follow acknowledgement and never starts/finishes a root cancel; overflow
  fails visibly instead of silently showing an incomplete conversation.
- The child `TranscriptStore`/`TranscriptView` uses the same native codec but no
  parent tool/image/model/settings callbacks. Root events are filtered again
  after child routing, so followed frames cannot alter parent busy/output
  state or create root user/assistant items.
- Closing, replacing or shutting down a surface releases follow. Session
  changes, fatal close and backend shutdown close and dispose every overlay;
  no child Agent is created or resumed for display. A child settling does
  **not** close a manually opened child view (only its header entry is
  refreshed), and progress retirement is display-only.
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

Progress is hidden when `Settings → Agents → Progress above input` is off and uses a static
frame when reduced motion is on; both are renderer preferences and never change the native
catalog, child status or lifecycle. The remaining visual/action contract is unchanged.

The visual reference is the user's installed `@tintinweb/pi-subagents` 0.23.1
(MIT), `src/ui/agent-widget.ts` / `renderWidget()`, and the supplied Pi
screenshot. Grok supplies the **navigation behavior**, not the table styling:
click one agent to enter that child, then Esc returns directly to the unchanged
root Editor. The Pi plugin itself is not loaded; its Agent engine, timer,
turn/tool-use counters, context percentages and costs are not copied. Pi's
"finished row lingers for one turn" (`onTurnStart` ages `finishedTurnAge` on
`tool_execution_start`, 2 turns for error statuses) is deliberately **not**
ported: DSH progress is active-only, so a settled child leaves the widget on
the native catalog frame that settles it. There is no wall-clock linger
either; Pi's 4-second finished linger belongs to its different below-editor
fleet list, not to this surface.

```text
● Agents · 3 children · Ctrl+X Ctrl+A open
├─ ⏺ Explore repository  continuable · running · 9s · 1.2k tok
│    ⎿  reading src/app.ts
├─ ⏺ Review changes  one-shot · running
│    ⎿  checking the native fixture
└─ +1 more (1 running)
────────────────────────────────────────────────────────────
❯ the one existing draft
```

`SubagentProgress` accepts the full `store.subagentEntries` snapshot and paints
only its **active** children:

- App mounts it after the queue projection and immediately before the
  Editor/dialog slot, outside the fullscreen transcript `ScrollView`. Native
  transcript catalog/settlement facts remain where they were.
- **Active-only:** rows exist only for native `running`/`initializing` children.
  A settled child (`idle`/`completed`/`failed`/`stopped`/`max-tokens`/`refusal`,
  an external leaf, or an unknown status) retires on the same catalog update:
  the component filters the input per frame, keeps no memory, turn age, timer
  or removal state, and never mutates the catalog. A settled `replyTargetId`
  does not resurrect a row either — the main Editor already shows that
  destination and continues to own the target.
- All history stays available: `store.subagentEntries` is unchanged, so the
  Agents overlay (and the UI-owned `/agent` alias, or its `app.subagents.details`
  chord) still lists settled, nested and external children. Local children can
  be opened like before; external leaves remain display-only with no local
  transcript. Retiring is a presentation fact only.
- A blue `● Agents` heading, dim tree guides, cyan live marker, bold child
  label, muted native state/metrics and a second indented native activity line
  follow Pi's compact design. Missing native metrics are omitted, never zero or
  estimated. `lastActivity` is shown only while native status is `running`.
- **Parent Working clock, no component timer.** `progress.spinnerFrame?: string`
  is an optional presentation input: the parent assigns the raw one-cell Working
  glyph (`· ✻ ✶ ✳`, the same sequence its editor status uses) from the existing
  shared spinner clock before each renderer paint, and only native
  `running`/`initializing` rows paint it. The component itself keeps no timer,
  starts no animation and never touches historical transcript rows. A value that
  is empty, multi-cell or control/ANSI-bearing is sanitized, measured and
  rejected to the static native `⏺`, so a hostile frame cannot widen a row or
  shift the name columns; assignment alone never renders and never resets a
  hitbox (the two-line summary + activity layout is unchanged). Leaving the
  field `undefined` restores the static marker for standalone hosts.
  `Settings → Agents → Progress above input` hides the widget; `Reduced motion`
  freezes the shared clock's glyph while keeping the live row and native status.
  Neither setting stops early, retires a child or mutates the native catalog.
- The active reply target comes first (marked), then every other active row
  **with its activity**, in native catalog order. The hard budget includes the
  heading, every row, activity, overflow and separator. App caps it at eight
  lines and samples actual queue/Editor/dialog/hint/footer heights on each
  renderer paint, reserving a transcript slice. A short terminal falls back to
  summaries or no widget. An empty catalog, and equally an all-settled one,
  consumes no row at all (no header, spacer or invisible hitbox); the overflow
  count (`+N more (…)`, grouped by raw native status) counts only active
  children that did not fit, so retired history is never folded into it.
- Only the visible **agent-name text** is an internal child-navigation link:
  bold + brand blue + underline, brighter on hover. Its hitbox excludes the
  guide, status glyph, gaps, mode/status/metrics/route, activity and padding.
  Non-openable and missing-callback names are plain text, not fake links.
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
  snapshot reads or component timer for progress; only the parent's existing
  Working clock supplies `spinnerFrame` frames. Ordinary `r`/`s` still edit the
  draft; native Reply/Stop remain in the Agents/child surfaces.
- App uses live getters for the height budget and current mouse owner. Dialogs
  and overlays block underlying hits; Esc immediately re-enables progress
  clicks without a new key or native frame. Claimed presses are pinned to the
  child identity. Attachment invalidation or any frame hiding/removing a
  pressed region permanently voids that gesture, even if the same id appears
  again before release. Shutdown disposes the component.

`test/ui-subagents.test.ts` covers the standalone row and durable-message paint,
the name-only link geometry of individual rows, grouped collapsed/expanded
members and trigger senders, grouping boundaries/prefix-width consistency, and
the shared gesture rules (motion unclaimed, outside press, vanished link,
catalog arrival, LF/CR/TAB flattening). `test/ui-subagent-progress.test.ts` tests
the pure component, including the active-only retirement, its overflow/link
geometry, the `spinnerFrame` seam and the press → retire → reactivate gesture
veto. The parent-owned `test/app-subagent-progress.test.ts`
covers both renderers, real mouse dispatch, scroll pinning, multiline/resize
budgets, image-bearing draft preservation, direct return/reopen, overflow,
decisions and stale attachment/membership gestures; the parent-owned
`test/app-subagent-startup.test.ts` covers the loading shell before the native
snapshot resolves. `scripts/pty-subagent-progress-smoke.py` tests visible
placement, the Pi tree style, direct fullscreen agent-name clicks, Esc/draft
return, header navigation, resize and terminal restore through the real offline
CLI/PTY. `scripts/pty-subagent-links-smoke.py` adds exact title/name/overflow
span boundaries, non-link cells, real drag/copy-on-select after hover, and
clickable-name style checked from independent emulator cells; its
active-overflow scenario runs the `subagent-many` fixture. Copy packets are
captured inside a private PTY, never sent to the real clipboard.
`scripts/pty-subagent-retirement-smoke.py` additionally proves both renderers
release all settled progress rows, preserve the explicit idle reply destination
without pinning a row, and reopen the durable child through `/agent` with the
original root draft and normal terminal restoration.
