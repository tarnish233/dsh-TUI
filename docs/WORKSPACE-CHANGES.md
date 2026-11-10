# Workspace changes (live turn summary)

DSH's `workspaceChanges` service records the files one native turn touched. The
frontend renders that native summary as **one compact turn-level card** in the
transcript and, on request, one native per-file diff in a read-only modal.

This surface is deliberately narrow:

- DSH owns the summary, the file list, the line counts and the diff. The UI
  never diffs two blobs, reads a file, runs `git`, starts a watcher, resolves a
  path, or exposes the session cwd/snapshot identity.
- The card exists only where a **live** `SessionEvent` carried
  `workspaceChanges`. Resumed/snapshot replay, missing data, tool results and
  prose never fabricate one.
- Binary, oversized and coarse native diffs keep those exact labels. A coarse
  text diff is never painted as an exact unified diff.

## DTOs (`src/backend/types.ts`)

```ts
SessionEvent.workspaceChanges?: WorkspaceChangesSummary

interface WorkspaceChangeFile {
  path: string          // retained only for native identity; the UI paints `display`
  display: string       // the only path-like text that reaches the screen
  added: number
  deleted: number
  binary?: boolean
  oversized?: boolean
}

interface WorkspaceChangesSummary {
  turn: number
  files: readonly WorkspaceChangeFile[]
  total: number         // native file count; may exceed files.length for a bounded read
  added: number
  deleted: number
}

type WorkspaceFileDiff =
  | { kind: 'text'; path; display; before; after; coarse; hunks: ... }
  | { kind: 'binary' | 'oversized'; path; display }

interface WorkspaceChangeDiffResult {
  sessionId: string
  attachmentId?: string
  seq: number
  index: number
  diff?: WorkspaceFileDiff
}
```

`src/ui/workspace-*` imports these DTOs type-only. No backend runtime, Cordis
service or file-system API is loaded through this seam.

## Store projection (`src/state/transcript.ts`)

`TranscriptStore.handle({ type: 'session_event', ... })` is the only place a
summary can enter the projection. `reset()` replays the durable snapshot
through the ordinary event projector but **does not** call the workspace
attachment path, so a resumed history can never grow a card from a replayed
field. A summary that arrives live after `reset()` is a real observation.

- Item kind: `'workspace-changes'`, id `workspace-changes:turn:<turn>` — the
  card identity is the **native turn**, not the announcing seq, because DSH's
  own recorder may write the same turn twice and its contract says the latest
  record for one turn replaces earlier ones.
- `seq` is the durable position of the **latest** announcing record of that
  turn; that position is what the native diff read must use.
  `sessionId` is required and `attachmentId` optional: both are captured from
  the store's exact `SessionInfo` when the live summary is applied, so a click
  can prove which conversation the card belongs to.
  `turn`/`files`/`total`/`added`/`deleted` are native facts.
- It is a distinct item kind: not a tool result and with no `status` field, so
  grouping and detail surfaces cannot mistake it for a call.
- Replacement is native-latest-wins. A **higher** announcing position for the
  same turn replaces the summary in place (same row, `seq` updated, version
  bumped once). A late **lower** position for that turn is superseded and
  changes nothing. Identical facts at the same position are a complete no-op
  (item object/version and cached block stay stable); changed facts at the same
  position update once. A latest summary with zero files is a native fact and
  renders as its own card (`0 files`, `+0 · -0`), never as an invented empty.
- The summary is validated field by field and **fails closed**: one unusable
  native file row rejects the whole record, because dropping the row would shift
  every later array position and the native diff service is addressed by index.
  A whitespace-only `path`/`display` is legal native data (a real `write './ '`
  creates a single-space file) and is kept verbatim; only a non-string/empty
  `path` is unusable. `total` stays the native count, so a bounded native read
  can still say `N of total files`.
- Session reset/clear drops the card with the rest of the transcript; events
  for another session are ignored.

## Transcript card (`src/ui/workspace-changes.ts`)

Header facts: native turn, native file count (`files` / `N of total files`),
native `+added`/`-deleted` totals. Each file row prints the native `display`
label and either `+A -D`, `binary`, `oversized`, or `binary · oversized`.
Rows keep the native `files` order and length exactly; the array index **is** the
native diff index. `workspaceDisplayLabel()` sanitizes/flattens a label before
any width math and quotes a whitespace-only label (`' '`) so a legal native
whitespace file is never painted as a blank row.
The count suffix is dropped only when the terminal is too narrow to keep an
identity and a count readable; the final line is always fitted to the width.

The block participates in the existing render-cache contract:

- one cached block per stable item id (`workspace-changes|<id>` in the view);
- unchanged width/version/handler/hover reuses the exact lines array;
- hover, item update, explicit invalidation, handler/hint change and session
  switch drop the cache before the next paint;
- row spans/hitboxes use the shared `HitboxRegistry`; a claimed press also
  carries the block's native-target generation. Replacing the summary (even
  under the stable turn id), retiring pointer targets or removing affordances
  invalidates that generation. The old release cannot fall back to a newly
  painted file/snapshot; hover-only invalidations keep the press valid.

The card breaks tool, activity and subagent runs (it is not a group member), and
it is not affected by tool disclosure (`Ctrl+O`).

### Details callback

`TranscriptViewOptions` gains:

```ts
onWorkspaceChangesDetails?: (request: WorkspaceChangesDetailsRequest) => void
workspaceChangesDetailsHint?: string

interface WorkspaceChangesDetailsRequest {
  sessionId: string          // exact origin captured with the card
  attachmentId?: string      // exact process attachment, when known
  seq: number                // latest announcing position of this turn
  turn: number
  files: readonly WorkspaceChangeFile[]
  total: number
  added: number
  deleted: number
  index?: number    // absent when the header (list) was activated
}
```

Only the header/file label rows are links, and only when the callback exists.
Without it the card paints the same facts with no hitbox and no dead click.
The hint is display text only; there is no implicit keybinding.

`TranscriptView` is itself the first guard: the details callback it forwards is
wrapped with a dynamic current-fact check, so a callback that was cached or
pinned before `store.reset()` (or before the same turn's summary was replaced)
is dropped until the item/seq/session really is current again. The parent adds
the second guard (see integration below).

`TranscriptView.retirePointerTargets()` is the synchronous parent seam for an
attachment/root replacement: it clears pointer hover, the painted row spans and
every block's hitboxes/press pins immediately, before any repaint. It touches no
content, store item, editor or focus state and requests no repaint.

## Details dialog (`src/ui/workspace-changes-dialog.ts`)

`WorkspaceChangesDialog` is presentation-only:

- **List mode**: every native file row with display/counts or binary/oversized
  notes. Enter/click opens that exact file; Esc closes.
- **Detail mode**: `loadDiff(seq, index)` is called at most once per explicit
  open. The parent answers with `setDiff(result)` or
  `setDiffError(seq, index, message)`. Esc returns to the list; the footer keeps
  a real `close` action. Scroll keys/wheel read the native diff body.
- `src/ui/workspace-diff.ts` renders native hunks with real `@@` coordinates
  (or the binary/oversized explanation), sanitizes and width-fits every row,
  and emits an explicit `Coarse text diff — line positions may be approximate.`
  line when `coarse` is set.

Identity and late responses:

```ts
dialog = new WorkspaceChangesDialog(tui, {
  seq, summary, sessionId, attachmentId?, loadDiff, isSessionCurrent?,
  initialIndex?, keymap?, maxHeight?, onClose, onInterrupt?, onRenderRequest?,
})
```

`setDiff()` accepts a result only while the view is mounted, the detail request
for that exact `index` is still open, `result.seq` matches the announcing event,
`result.sessionId` / `result.attachmentId` match the dialog's exact identity,
and the optional `isSessionCurrent()` guard returns true. Closing the detail,
switching files, closing the dialog, disposing it or changing the native
session makes the old response a no-op. Late errors are dropped by the same
guard.

The payload's own identity is cross-checked too: a returned `diff.path` must
equal the selected native summary row's `path`. A mismatch (including for
binary/oversized payloads) settles that open load as an honest error
(`Native diff did not match the requested file.`), clears the loading state,
and never paints the foreign bytes under this row's label. A later matching
answer for the still-open row paints normally. `captureView()`/`selectIndex()` support parent restore/deep-links; the
component owns no timer, poll, file read or native command.

Mouse follows `ModalListSurface.rowMouse`: a press is pinned by row key plus
owner key, a repaint/move/vanished row voids it, chrome and body stay separate,
and the detail body claims a left press so it cannot leak into text selection.

## Parent App wiring

`src/app.ts` installs the details callback only after attachment discovery and
only while `workspace-change-diff` is mounted. Without it the same summary
facts remain readable as an inert card. The App rechecks capability at open and
read time, so a held callback cannot call an absent service. Same-attachment
capability loss closes an open workspace dialog; later reappearance enables
fresh actions without replacing the editor or summary.

The App calls `transcript.retirePointerTargets()` synchronously on root or
attachment replacement, before resetting the store or requesting the next
paint. The callback is also guarded independently at the App boundary:

```ts
const info = this.info
if (info === undefined || !this.connected || this.closing ||
    this.dialog !== undefined || this.decisionId !== undefined ||
    !info.capabilities.includes('workspace-change-diff') ||
    request.sessionId !== info.sessionId || request.attachmentId !== info.attachmentId) return
const card = this.store.items.find(item => item.kind === 'workspace-changes' &&
  item.sessionId === request.sessionId && item.attachmentId === request.attachmentId &&
  item.seq === request.seq && item.turn === request.turn)
if (card === undefined || card.kind !== 'workspace-changes') return
if (request.index !== undefined && (!Number.isSafeInteger(request.index) || request.index < 0 ||
    card.files[request.index] === undefined ||
    card.files[request.index]?.path !== request.files[request.index]?.path)) return
```

The dialog is built from **that verified card's** files, counts and identity,
not from the request's possibly superseded summary. Its loader captures the
App context (session, attachment, editor and epoch), and forwards the exact
scope to the public adapter command:

```ts
const result = workspaceChangeDiffResult(await this.options.backend.command('workspace-change-diff', {
  sessionId: context.sessionId,
  ...(context.attachmentId === undefined ? {} : { attachmentId: context.attachmentId }),
  seq, index,
}))
if (this.dialog !== dialog || !this.sameAttachment(context)) return
if (result === undefined) dialog.setDiffError(seq, index, 'Native diff response was not usable.')
else dialog.setDiff(result)
```

Only an open, current dialog can start a read; errors and successful responses
are both dropped after closure or replacement. `setDiff` then proves the
session/attachment/seq/index **and native file path** once more.
`showDialog`/`dismissDialog` retain their existing disposal and one-editor
contract. No App-side file read, git operation or diff reconstruction occurs.

## Tests

`test/ui-workspace-changes.test.ts` covers live-versus-resumed/missing data,
DTO fields, malformed summaries (whole-summary fail-closed), per-turn
replacement (higher seq wins, late lower seq ignored, same-seq no-op/version,
latest zero-files card), exact session/attachment capture in the item and the
details request, stale pinned presses after `store.reset` and after a same-turn
replacement both before and after repaint, `retirePointerTargets`, whitespace-only labels keeping native
order/index, width safety (CJK/emoji/ANSI and tiny widths), cache reuse/hover
invalidation, pinned mouse rows, grouping boundaries, projection reuse and
session reset/disposal.

`test/ui-workspace-dialog.test.ts` covers list/detail selection, exact
`loadDiff(seq,index)` call counts, native hunk text, new/deleted files, binary/
oversized/coarse labels, missing payloads, late/closed/switched/disposed
responses, session/attachment/seq/index guards, native-path cross-checking
(text and binary/oversized), whitespace-only label rendering with its native
index, missing callback, keyboard, mouse and width safety. These component tests
use no real provider, profile, file read, git command or terminal writer.

Parent App regressions additionally cover stale session/attachment callbacks
with the same seq/index/path, immediate pointer retirement, superseded seqs,
scoped command arguments and capability loss/reappearance. The real hermetic
`test/acceptance-native-review-fixes.test.ts` writes `./ ` and `a.txt` through
DSH in an owned temporary workspace, then uses the production transcript
pointer path and dialog keyboard navigation to read both official per-file
diffs at their original indices. It never touches a real user home or Provider.