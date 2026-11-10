# Approval proposal preview (`toolPresentation` diff intent)

DSH decides an approval **before** the tool runs. When the native
`ToolDefinition.presentCall` returns a diff call view, the decision request
carries it as `DecisionRequest.toolPresentation`; `src/ui/dialogs.ts`
(`DecisionDialog`) may then paint a bounded **proposal** preview above the
opaque options. This document is the UI contract only: DSH owns the tool call,
its execution, its durable result and the decision settlement.

## Ownership

| fact | owner |
| --- | --- |
| the proposed change (hunks, paths, before/after text) | DSH `presentCall` |
| whether the call actually ran | DSH tool lifecycle (never this dialog) |
| the applied file change | the tool result / `tool/result` meta |
| the opaque option values and the settled answer | native decision request |
| the preview rows, label, truncation and layout | this dialog (display only) |

The dialog never reads a file, never diffs two files itself, never reruns a
tool, and never upgrades the intent into an outcome.

## What is accepted (and what is not)

`proposedCallDiffs(request.toolPresentation)` accepts a record only when all of
the following hold:

1. it is a plain object (`DecisionRequest.toolPresentation` itself);
2. it carries **no** `result` key at all — an approval is decided before
   execution, so a record with a result half is not a pure pre-execution intent;
3. the shared `readToolPresentation(record, false)` reader (the same one the
   transcript cards use) yields a call card, either flat
   (`{ card: 'diff', diffs: [...] }`) or enveloped (`{ call: {...} }`);
4. that card is `card: 'diff'` and at least one entry survives the reader's own
   validation (string `path`/`newText`, `oldText` string or `null`).

Everything else — a missing record, a string/array/number, `{ call: {} }`, a
`diffs` value that is not an array, entries with a non-string path, a
`terminal`/`generic`/`read` card, a result-only record — is **not** a proposal.
The approval then keeps exactly today's body: native message, numbered options,
hint and footer. No error, no "diff unavailable" placeholder, no empty frame.

`DecisionRequest.callId` is correlated identity only. It is never read by this
preview and is never evidence of a diff; an approval with a `callId` and no
validated presentation paints no preview.

Presentation is only read for `kind: 'approval'`. Question dialogs (including
the plan-review shape) never show it, and their tabs, multi-select, custom
answers and review step are untouched.

## Rendering

The rows come from the shared `renderDiffBlock` (`src/ui/tool-diff.ts`), so the
split threshold, word wrap, width fitting and LCS budget are the same code the
tool cards use. The dialog adds only:

- one label row: `Proposal · not run yet · <path | N files> · +A -R lines`
  (`hunk too large to count precisely` when the shared budget refuses an exact
  count). The not-run wording comes before the paths so a narrow body truncates
  the file list, never the honesty;
- classic `indicatorMode` (`-`/`+`), because an approval has no card chrome and
  may be read without diff colors;
- a one-column indent, `(diff too large to display)` for an oversized hunk, and
  `… N more lines` for rows the bounded preview folded away.

The preview never claims an applied change, an executed call or a result: those
words are owned by the settled tool result on the transcript, not by an
approval. It paints **only** `Proposal` / `not run yet` / counts.

### Row budget and degradation

The body is composed in this order, and the first two always win:

1. the native message (its own trailing separator row);
2. the options (at least two painted rows, or all of them when shorter);
3. the hint row group;
4. what is left becomes the proposal preview, hard-capped at
   `PROPOSAL_PREVIEW_ROWS` (12) diff rows.

The hint is dropped *before* the options lose their two-row floor, so a small
composer budget can never hide the permission options behind prose. A windowed
option list keeps the focused row and moves with the normal local keys.

A short terminal therefore shows the heading only, then a heading plus an
honest `… N more proposal lines` marker, then more rows. When no row is left the
preview disappears completely; the decision surface is never squeezed below the
options. A one-row budget keeps the `Proposal` label instead of painting an
empty gap.

## Interaction contract (unchanged)

The preview is plain body text: it paints no hit rows, owns no press, and a
click on it can never answer the request. Everything else keeps the existing
`DecisionDialog` semantics:

- `Enter` / the `Choose` chip settles the focused opaque option value;
- `Esc`, `list.cancel`, the frame `[×]` and the `Reject` chip settle the
  request's own rejected opaque option (falling back to the parent's
  `onCancel` only when no rejection option exists);
- `Ctrl+C` is the focused surface's local cancel/reject by default (the shipped
  keymap has no `app.interrupt` default since the Pi-style `app.clear` pass): it
  settles the request's own rejected opaque option and never implies a backend
  turn abort. Only an explicitly configured `app.interrupt` key is a global
  interrupt; it never answers and never cancels locally, and the surface stays
  usable. A disabled or remapped local cancel key gains no invented fallback
  (the root `app.clear` binding is never re-aliased);
- mouse press+release ownership, wheel navigation, focus and pending-chord
  cancellation are inherited unchanged;
- the lazy highlight subscription is still created in the constructor, dropped
  by `dispose()` (idempotent) and by `invalidate()` for the cached proposal rows;
  a later grammar readiness still requests exactly one repaint, and a disposed
  dialog neither invalidates nor paints.

## Composer placement

`DecisionDialog` and `SelectDialog` implement `ComposerInteraction`
(`src/ui/interaction.ts`, docs/COMPOSER-INTERACTION-CONTRACT.md):

- the default placement is the historical bounded workspace overlay
  (`modalHeight`), unchanged for every existing call site and for a terminal
  resize;
- an explicit layout is presentation only: `setInteractionLayout` is idempotent,
  never reads/answers/focuses/requests a frame, and retires old mouse pins and
  targets so a press recorded before a reflow cannot answer a moved row;
- `measureRows(width)` is pure, shares the exact geometry with `render`, and
  equals `render(width).length`;
- the parent's `maxHeight` is a cap, never padding: a one-row chooser stays
  short (with a small readable floor), and the frame chrome (action footer,
  including Reject/Cancel) is allocated before the body at every height;
- a composer mount returns `capturesViewportInput === false`, so PageUp/PageDown
  keep scrolling the transcript while the dialog's own selection keys stay
  local. Workspace placement keeps claiming the viewport.

## Full native detail (`dialog.details`, Ctrl+O)

`DecisionDialogOptions.onDetails?: (content: DecisionDetailContent) => void`
receives the already-supplied native snapshot and nothing else:

- `{ kind: 'markdown', title, text }` — the focused question's native
  `Question.detail` verbatim (plan review body);
- `{ kind: 'proposal', title, presentation }` — the same validated pure
  `toolPresentation` record the preview uses (never a `result`/`presentResult`
  half, never a guessed call).

The action and its `Details` chip exist only when that native content exists and
`onDetails` is provided; the key comes from the registry (`dialog.details`,
default `Ctrl+O`) and a disabled/remapped binding changes nothing else. The
parent mounts `DecisionDetailsDialog` (`src/ui/decision-details.ts`) as a separate
read-only workspace overlay over the retained decision: it renders the complete
content (expanded proposal rows, both sides of every hunk) with a bounded
scrollable viewport and an honest position/metadata row, closes through the same
local cancel path, keeps an explicit `app.interrupt` global, and never answers,
executes, reads a path or fabricates an applied change. Selections, checks,
custom drafts and ordered opaque values survive because the decision instance is
untouched.

## Files

- `src/ui/dialogs.ts` — validation, label, budget and composition; composer
  seam; native-detail action and request.
- `src/ui/decision-details.ts` — the full read-only native detail overlay.
- `src/ui/tool-diff.ts` / `src/ui/tool-io.ts` — the reused diff rows and the
  shared presentation reader (no second parser, no second diff math).
- `test/ui-approval-proposal.test.ts` — write/edit/apply_patch-like intents,
  malformed and result-bearing records, widths, proposal-only wording, row
  budget, Esc/Ctrl+C, mouse ownership, `invalidate()` and disposal.
- `test/ui-dialog-composer-layout.test.ts` — pure measurement, natural bounded
  height, presentation-only layout, retired pins, transcript paging.
- `test/ui-decision-details.test.ts` — full native readback, expanded proposal,
  honest oversized diffs, read-only input, native-detail gating and preserved
  decision state.