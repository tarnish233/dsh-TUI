# Native long history (read-only)

`src/ui/history-dialog.ts` owns one read-only long-history surface:

```
History                        (native turn outline)
  #1  prompt preview
      ↳ response preview
  #2  …
      ↳ …
─────────────────────────────
History › #2                   (one opened turn)
  prompt preview
  ↳ response preview
  seq 300–319 · 20 events · 3 pages
─────────────────────────────
  projected native events (ScrollView + TranscriptView)
─────────────────────────────
  [older] [newer] [escape back] [close]
```

The parent owns every native read and the App lifecycle. The component owns no
durable history: the detail `TranscriptStore` is created per opened turn from the
exact native window events and disposed with it. The main live transcript is
never passed in, reset, prepended to or mutated.

## Public API

```ts
const dialog = new HistoryDialog(tui, options: HistoryDialogOptions)
```

State supplied by the parent:

| Option | Meaning |
| --- | --- |
| `session: SessionInfo` | Current native session; `sessionId` + `attachmentId` guard every page. |
| `outline?: HistoryTurnsResult` | Already-read native turn outline. Without it the surface says the outline has not been read. |
| `loading?: boolean` | Phase-1 outline read in flight (never an empty history). |
| `keymap?: CcKeymap` | Shared keymap; defaults to the CC defaults for standalone hosts/tests. |
| `maxHeight?`, `maxEvents?`, `maxBytes?`, `maxPages?` | Bounded frame and read budgets (defaults: 1200 events, 1 MiB of approximate JSON text, 40 automatic pages). |
| `codec?: TranscriptCodec` | Native codec used by the throwaway detail store. |
| `createView?: (store) => TranscriptView` | Replace the default read-only view options; the dialog disposes the returned view **and** enforces `setReadonlyDisclosure(true)` on it. |

Callbacks and lifecycle:

| Option | Meaning |
| --- | --- |
| `loadTurns?: () => void` | Explicit outline refresh, wired to the shared `app.redraw` binding (Ctrl+L by default). No timer/polling. |
| `loadWindow?: (request) => void` | One bounded native window read. The parent must echo `request.requestId`. |
| `onClose: () => void` | Esc from the outline / close chip / frame `×`. The parent hides and disposes the dialog. |
| `onInterrupt?: () => void` | Global `app.interrupt` (Ctrl+C). When omitted the dialog closes. |
| `onRenderRequest?: () => void` | Parent repaint hook; no terminal writes happen here. |

The dialog keeps at most **one outstanding window request per opened turn**, so
the parent does not need its own single-flight queue for this surface. Pass the
same `Backend.transcriptCodec` as `codec` so historical assistant messages and
attempts project exactly like the live transcript.

Parent answers one read:

```ts
loadWindow: request => {
  // request: { requestId, sessionId, attachmentId?, turn,
  //            targetSeq, before, after, page: 'anchor' | 'older' | 'newer' }
  // Backend `history-window` params: { sessionId?, attachmentId?, seq, before?, after? }
  void nativeHistoryWindow(request.sessionId, request.attachmentId, request.targetSeq, {
    before: request.before,   // <= 50
    after: request.after,     // <= 50
  }).then(
    result => dialog.setWindow(request.requestId, result),
    error => dialog.failWindow(request.requestId, `Native history window is unavailable (${error}).`),
  )
}
```

Parent-facing methods:

```ts
dialog.setOutline(outline)          // initial read / refresh / retry
dialog.setTurnsLoading(boolean)     // phase flag
dialog.setTurnsError(message)       // honest failure; known rows stay visible
dialog.setTurnsUnavailable(reason?) // honest unavailability
dialog.setWindow(requestId, result) // accept one outstanding page
dialog.failWindow(requestId, text)  // honest failure for one outstanding page
dialog.setSession(session, outline?)// session/attachment switch discards detail
dialog.reloadTurns()                // same as the explicit redraw key
dialog.selectTurn(seq)              // select by exact outline seq
dialog.openSelectedTurn()           // open the selected turn (no-op without loadWindow)
dialog.closeTurn()                  // back to the outline
dialog.invalidate()
dialog.dispose()                    // idempotent; never calls onClose
```

Read-only getters used by the parent/tests: `mode`, `selectedSeq`, `selectedTurn`,
`detailTurn`, `detailEventSeqs`, `detailEventCount`, `detailHasOlder`,
`detailHasNewer`, `detailIsTruncated`, `detailMessage`, `turnsStatus`, `outline`,
`store`, `view`, `focused`, `isDone`, `isDisposed`.

`HistoryWindowRequest` and `HISTORY_PAGE_LIMIT` (`50`) are exported.

## Paging contract

- A turn is identified by the outline `(turn, seq)` pair. Rows paint in native
  outline order; selection is the exact native `seq`, never a row index.
- Opening a turn requests one **anchor** page at `targetSeq = turn.seq` with
  `before = after = 50`.
- Accepted events are clipped to `[turn.seq, nextTurn.seq)` or, for the last
  turn, to `outline.asOfSeq + 1`. A detected `turn/end` for the selected turn
  (or a `turn/start` of a later turn) tightens the same boundary. Native
  identity/order is preserved; pages merge into a `Map<seq, event>`, so
  overlapping pages and duplicate seqs never duplicate rows.
- Forward/backward pages re-anchor on an **existing loaded seq** (the latest or
  earliest edge) because DSH's `readEvent` requires its target event; the edge
  event is repeated by the native window and deduplicated by seq.
- Automatic paging continues forward (and, when the window did not reach the
  turn start, backward) until:
  - the proven turn boundary is reached,
  - a page adds no new native seq,
  - the event/byte cap is reached, or
  - `maxPages` automatic pages were read.
- `older`/`newer` footer chips are clickable only when the native outline/window
  proves events remain: `older` needs `hasOlder` plus a loaded range above
  `turn.seq`; `newer` needs the loaded max seq + 1 to stay below the proven
  upper bound, or—when the outline proves no tail bound—a contiguous native
  window whose `endSeq` is after its target. There is no fabricated `hasNewer`; when no proof
  exists the chip is absent. Manual navigation may continue after the automatic
  page limit but never after an event/byte cap.
- Every stop that leaves the turn partial paints an explicit marker (`event`
  cap, byte cap, automatic page limit, or a no-forward-progress stop while the
  outline cut still proves unread events). An unavailable/malformed/failed read
  is shown as such; it is never rendered as an empty turn.

The requested per-side safety cap is 50, not an assumption about the mounted
reader's configured `readWindowMax`. The adapter handles the official smaller
bound with one strictly validated narrowing inside the same 5-second durable
read; it neither reads private native configuration nor widens a request.
Subsequent pages reuse that bound for the same native service/method identity,
and successful adaptation is silent (no live-transcript warning).
A native maximum of 0 can return only the anchor: one duplicate page ends
paging boundedly and states `Partial turn: the native event reader made no
forward progress.` when the outline cut proves the turn is still incomplete.

## Input and lifecycle

- Input uses the shared `modalList` context through `modalAction`; `app.redraw`
  is the only additional allowed action. No raw stdin listener, second editor,
  standalone hotkey table or search subsystem is added.
- Outline mode: list keys move/select, Enter opens, Esc closes, Ctrl+C resolves
  `app.interrupt` (parent forwards/cancels).
- Turn mode: list keys scroll the projected events, Esc (`list.cancel`) returns
  to the outline, Enter is inert, `older`/`newer` are explicit click actions.
- Every request carries a monotonic `requestId`. A response after close, another
  turn was opened, a session/attachment change, or dispose is dropped; its id is
  no longer outstanding even if the same native seq would have been valid.
- The detail view is created with disclosure disabled and no advertised shortcut
  labels, and body clicks are claimed without mutating the module-level
  transcript disclosure state. There is no timer: repaints come from parent
  render requests, input, mouse and native page/projection changes.

## Read-only disclosure isolation (`readonlyDisclosure`)

Reasoning and tool/group expansion live in module-level maps shared by every
block in the process. A second `TranscriptView` that merely sets
`mouseBlocked: true` would still *read* those maps (inheriting a same-key live
override) and would clear/prune them on its own first paint and on every
`retainToolExpansion` pass — silently collapsing cards in the live transcript.

The historical detail is therefore a **read-only disclosure projection**:

- The dialog builds its view with `readonlyDisclosure: true` and then calls
  `view.setReadonlyDisclosure(true)`, so a host-supplied `createView` cannot opt
  out: the dialog owns the guarantee.
- A read-only view never reads the module maps, so a historical item that
  happens to share an id/call-id with a live card can never inherit its expanded
  state; disclosure is always collapsed, and no expand hint or expansion hitbox
  is painted.
- It never writes, clears, retains or transfers them: no
  `setToolExpanded`/`setThinkingExpanded`, no `clearToolExpansion`,
  `clearThinkingExpansion`, `retainToolExpansion` or `adoptThinkingExpansion`,
  and no `applyToolExpansionRequest` path. `requestToolExpansion` is a global
  no-op for a read-only flag, and `toggleToolsExpanded`/
  `toggleLatestThinking`/`expandTools` are inert on such a view.
- There is deliberately **no backup/restore** of shared state: restoring a
  snapshot could erase a real change made in the live transcript while the
  dialog was open. The read-only view simply never touches it.
- Opening a turn, paging (anchor/older/newer), repeated paints, explicit
  `invalidate()` and `dispose()` are all neutral for the live maps; a live
  expanded tool card, tool group and reasoning run stay expanded and paint the
  same bytes across the whole history read.

This is presentation state only — not a DSH mode, input state or persisted
setting.

## Limitations (intentional)

- No text search in the outline or turn view; adding one would require a second
  fact index or a search field over native events.
- No expansion, image-details or tool-details navigation inside the historical
  projection. It is a read-only, scrollable projection.
- No parent-owned restore state (`initialState`/`captureView`) yet; reopen the
  dialog and select by native `seq`.
- Detail scroll position is retained while new pages append. Prepend (older)
  pages may shift the visual anchor; no line-offset compensation is claimed.
- The component never retries a failed native read on its own; the parent calls
  `setOutline`/`loadWindow` again or the user presses the explicit refresh key.

## Tests

`test/ui-history-dialog.test.ts` covers outline states, native order/identity,
>50-event paging, overlapping/duplicate pages, turn boundaries, older/newer
proof, event/byte/page caps and truncation markers, zero-context/no-progress
partial cuts, unavailable/malformed/failed windows, late pages after
close/supersede/session change, Esc/Ctrl+C semantics,
widths 40/80/120/160, mouse open, live-store isolation, read-only disclosure
isolation (live tool/group/reasoning overrides preserved across the first
detail paint, multi-page reads, `invalidate()`, reopen and `dispose()`;
same-key overrides never inherited; inert public toggles; `createView`
enforcement) and zero stdout/stderr writes. All component fixtures are hermetic
callbacks; no provider, profile, PTY, network or model call is involved.

Parent `test/acceptance-native-review-fixes.test.ts` additionally runs the
actual native composition in owned temporary homes/workspaces with
`readWindowMax` 0/1/20 in inline/fullscreen. It verifies official event ranges,
complete bounded paging or an honest anchor-only partial view, no mutation of
live facts, and the same editor/draft after closing. The shared fixture
intercepts native model streaming; no real Provider or user state is accessed.