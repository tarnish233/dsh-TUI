# Native read-only UI panels (Jobs / Goal / Inventory / pending questions)

Status: frontend implementation complete this pass; parent owns App wiring, native
acceptance and dock placement. New files only — no App, backend, theme, modal,
dialogs, settings, input, vendor or manifest changes.

| Surface | Module | Kind |
| --- | --- | --- |
| Jobs inspector + bounded output | `src/ui/jobs-dialog.ts` → `JobsDialog` | modal (`ModalListSurface`) |
| Goal compact status | `src/ui/goal-progress.ts` → `GoalProgress` | dock row (`Component`) |
| Plugin / capability / tool inventory | `src/ui/native-inspection-dialog.ts` → `NativeInspectionDialog` | modal (`ModalListSurface`) |
| Pending continued questions | `src/ui/continued-questions-dialog.ts` | pure display helpers for the existing `SelectDialog`/`DecisionDialog` |

DTOs are **type-only imports** from the backend adapters:

```ts
import type { InspectionReason, InspectedJob, JobOutputChunkView, JobOutputSnapshot, JobPhase, JobsRead }
  from '../backend/native-inspection.ts'
import type { GoalRead, GoalStateView, PluginInventoryRead, ToolCatalogRead }
  from '../backend/native-inspection.ts'
import type { ContinuedQuestionRow, ContinuedQuestionsView }
  from '../backend/native-questions.ts'
```

There is no hand-copied DTO mirror in the UI layer, and no backend adapter, Cordis
service, DSH runtime or native module is loaded through these seams. An invalid
snapshot shape is skipped at runtime (never rendered raw).

---

## 1. `JobsDialog` — read-only jobs inspector

```ts
new JobsDialog(tui, {
  snapshot?: JobsRead,                     // initial roster read
  getSnapshot?: () => JobsRead | undefined,// live read, sampled per paint
  keymap?: CcKeymap,
  loading?: boolean,                       // parent phase-1 read
  initialState?: JobsViewState,            // selected id + scrolls on reopen
  maxHeight?: number,
  maxOutputLines?: number,                 // hard page bound, default 2000
  onOpenOutput?: (job: InspectedJob) => void,
  onRefresh?: () => void,                  // explicit refresh (app.redraw)
  onClose: () => void,
  onInterrupt?: () => void,
  onRenderRequest?: () => void,
})
```

Parent surface: `setSnapshot()`, `setLoading()`, `openOutput(id?)`, `closeOutput()`,
`setOutput(jobId, JobOutputSnapshot)`, `setOutputUnavailable(jobId, reason)`,
`setOutputError(jobId, message)`, `captureView()`, `selectJob(id)`, `dispose()`;
getters `jobs()`, `selectedId`, `outputId`, `mode`, `isLoading`, `isDone`.

### Ownership rules actually enforced

- **No job mutation.** No start/kill/wait/remove call and no producer effect exists
  in this module; the only writes are parent callbacks (`onOpenOutput`, `onRefresh`,
  `onClose`, `onInterrupt`).
- **No polling or timer.** Reads happen when the parent pushes (`setSnapshot`) or on
  an explicit user refresh. `onRefresh` is bound to the existing `app.redraw`
  binding (`Ctrl+L` by default, remappable/disable-able) and is advertised only when
  the callback exists; omitting it makes the key inert and shows no refresh chip.
  In the output view the parent can re-read the open page via `outputId`.
- **Native order.** Rows paint in the registry's registration order — no sort by
  time, status or label.
- **Opaque identity.** Selection is the native `id`. A refresh keeps the selected id
  through reordering and new rows; a vanished id falls back to the nearest
  still-listed row and is never resurrected.
- **Status honesty.** `running`/`stopping`/`completed`/`killed`/`failed` keep their
  glyph/colour; `unknown` and any unrecognized value are painted as the sanitized
  native word (or `status unknown`) and never mapped onto `completed`.
- **No guessed timing.** A duration appears only from native `startedAt`/`finishedAt`.
  A live row shows no locally computed elapsed time.
- **Output view is explicit and id-bound.** `setOutput` accepts only the currently
  open job id and only while mounted; a late page/failure for a closed, switched,
  disposed or different job is dropped (no revival, no error). The view opens at the
  newest line; `list.first`/`list.last` and page keys scroll **lines**, leaving the
  job selection untouched. `Esc` returns to the list (`captureView().mode` = `list`),
  `Esc` again closes. A job that leaves the roster keeps its already-read page and
  says `This job is no longer in the native list.`
- **Output bounds.** `maxOutputLines` caps retained display lines (tail kept, with
  `Showing the last N of M lines.`). Native `lossy` and `truncated` are explicit
  notes; `gapBefore` chunks insert `⋯ earlier output was lost ⋯`; native `from`/`next`
  offsets are displayed as `offset A→B`; the native stream labels present in the page
  are reported as `streams stdout+stderr` (deduplicated, native order, only when the
  chunks actually carry one); `job.output.total`/`earliest`/`evicted` are shown as
  native coordinates. Chunks are flattened in native order without inventing
  separators.
- **Honest empty/failure states.** `loading` → `Reading native jobs…`; no snapshot →
  `Native jobs have not been read in this session.`; `available:false` →
  `Native jobs are unavailable (<reason>)`; available with no rows → `No native
  background jobs.` `complete:false` marks the header `incomplete`.

### Input and mouse

Shared `modalList` context via `modalAction` (`list.previous/next/page-up/page-down/
first/last/select/cancel`, dialog confirm/cancel, app cancel/interrupt) plus the
explicit `app.redraw` refresh. Ctrl+C honours the configured `app.interrupt` and is
forwarded, not turned into a local action. No raw stdin listener, second editor or
hardcoded key label. Mouse: click selects, a second click on the selected row opens
output (same capability as Enter), wheel moves selection / scrolls output lines,
presses are pinned by native id + owner key and voided by drag/invalidation.

---

## 2. `GoalProgress` — compact goal status dock

```ts
const goal = new GoalProgress({ maxRows: () => sharedDockBudget(), visible: true })
goal.status = goalRead      // GoalRead | undefined
goal.render(width)          // string[]
```

- **Facts only:** native `phase`, `roundsStarted`/`maxGoalRounds`, `activation`,
  the objective as one bounded line, and `blockedReason.message` only while the
  native phase is `blocked`. Each round chip appears only for a finite native
  number; activation is omitted when the durable fallback could not read it.
- **No bogus active:** an unrecognized phase is painted verbatim (`phase <value>`),
  never as `active`. `complete:false` does not fabricate anything.
- **Honest emptiness:** `undefined` (not read), `available:false` and `goal:null`
  all paint `[]`. `state` distinguishes `'unavailable'`/`'none'`/`'goal'` for the
  parent only; the native `/goal` output keeps its authority.
- **Shared budget:** `maxRows` is a hard total (header + objective + blocked reason)
  re-sampled on every paint from a parent getter; `0` hides it, non-finite falls back
  to the default 3. The parent owns the combined Todo/Subagent/Goal dock budget.
- **No focus theft:** not `Focusable`, no input listener, no mouse handler, no timer
  and no stdout write; ordinary typing and native selection are untouched.

---

## 3. `NativeInspectionDialog` — read-only inventory summary

```ts
new NativeInspectionDialog(tui, {
  reads?: { plugins?: PluginInventoryRead; tools?: ToolCatalogRead; capabilities?: readonly string[] },
  getReads?: () => NativeInspectionReads | undefined,
  loading?: boolean,
  initialState?: InspectionViewState,   // selected row key + scroll
  keymap?, maxHeight?, onClose, onInterrupt?, onRenderRequest?,
})
```

Sections render in this fixed order: **Plugins → Capabilities → Tools**.

- **Plugin rows:** `enabled` glyph, `moduleName`, `fiberPhase` (`null` → `no fiber`,
  native words verbatim, `failed` in red); the selected row adds its exact `entryId`.
  Package metadata, `!!js` conditions, diagnostics text, credentials, config values
  and host paths are never painted.
- **Tool rows:** `name`, `deferred` marker, and (selected row only) the adapter's
  bounded, control-stripped `description`. No parameters, schema, executor or
  rendered arguments.
- **Capability rows:** the exact native `SessionInfo.capabilities` names.
- **Honest states:** per-section `available:false` shows one line with the reason
  code (`missing-service`, `no-agent`, …) instead of a zero count; `complete:false`
  marks that section `incomplete`; a never-read surface says so; all-available-and-
  empty says `No native plugins, capabilities or tools are mounted.`
- **Read-only:** Enter and printables are inert, Esc/`list.cancel`/Ctrl+C close,
  `list.*` navigates (crossing section boundaries, headers are not selectable).
  Selection is the stable row key (`plugin:<entryId>`, `tool:<name>`,
  `capability:<name>`, with an occurrence suffix for duplicates), so a refresh keeps
  the row through reordering; `captureView()` restores it.
- The parent re-reads on `native_ui_changed` (`domain: 'inventory' | 'tools'`) and
  calls `setReads()`; there is no timer, poll or automatic refresh.

---

## 4. Pending continued questions (helpers only)

`src/ui/continued-questions-dialog.ts` exports presentation helpers only; the parent
renders them with the existing `SelectDialog`/`DecisionDialog` and answers through
`NativeQuestionAdapter.answer()`.

```ts
continuedQuestionLabel(row, max?)          // sanitized one-line header + question
continuedQuestionDetail(row)               // state · N questions · reply queued · callId
continuedQuestionStateLabel(state)         // native word, unknown verbatim
continuedQuestionAnswerable(row)           // true only: state 'continued' && !replyQueued
continuedQuestionDisabledReason(row)       // '' or why the late path must not submit
continuedQuestionChoices(rows)             // native order; { label, description, value: callId, answerable, state }
continuedQuestionsNote(view)               // unread / unavailable / no-pending text
```

- **Opaque identity:** `value` is the native `callId`, so a roster refresh or reorder
  can never retarget a different call.
- **Open rows are not answerable here.** A native `open` row is owned by the live
  blocking question dialog; `replyQueued: true` means native `answer()` would refuse
  (`REPLY_QUEUED`). Both keep their honest status text and `answerable: false`.
- **No local timeout/scheduler:** no countdown, retry, timer or pending map exists in
  this module; "skip" is a real empty answer chosen by the user, never a cancel.

---

## 5. Parent integration checklist

1. Read the jobs roster through `NativeInspection.jobs()`; push via `setSnapshot()` on
   open and on `native_ui_changed` with `domain: 'jobs'` (coalesced, current-attachment
   guard stays yours). `onOpenOutput` should `jobOutput(id)` and answer with
   `setOutput(id, read)` or `setOutputUnavailable(id, reason)`; never keep a second
   pending map. `onRefresh` reuses your single-flight read and may also refresh the
   open page via `outputId`.
2. Assign `goal.status` from `NativeInspection.goal()` and pass the shared dock budget
   as `maxRows`. Placement next to Todo/Subagent is yours; the component takes no focus.
3. Read `pluginInventory()`/`toolCatalog()` on `domain: 'inventory' | 'tools'` and pass
   `SessionInfo.capabilities`; `setReads()` preserves the selected row.
4. Map `continuedQuestionChoices()` into `SelectDialog` items and submit only
   `answerable` rows through `NativeQuestionAdapter.answer()`; on `accepted`/`queued`
   refresh from `read()`, on `unavailable`/`stale` close and refresh.
5. Restore dialogs with `captureView()`; a reopened modal never replays a stale output
   page or a stale question answer.

---

## 6. Tests (scoped only)

| File | Cases | Covers |
| --- | --- | --- |
| `test/ui-jobs-dialog.test.ts` | 23 | honest states, native order, id-surviving refresh, output open/back/close, late-page drop, bounds/lossy/gaps/offsets/channels, scrolling, errors, mouse pinning, refresh binding, restore, width safety |
| `test/ui-goal-progress.test.ts` | 10 | facts, round/activation honesty, unknown phase, blocked reason, shared budget re-sampling, width safety, no focus/input |
| `test/ui-native-inspection.test.ts` | 11 | section order, whitelist (no diagnostics/meta/credentials), unavailable/incomplete, inert read-only input, row-key refresh, mouse, width safety |
| `test/ui-native-inspection-questions.test.ts` | 7 | state words, label/detail sanitation, answerable rules (`open`/queued), opaque call ids, honest notes, pure presentation |

Total: **51 passing cases** (`node --test test/ui-jobs-dialog.test.ts
test/ui-goal-progress.test.ts test/ui-native-inspection.test.ts
test/ui-native-inspection-questions.test.ts`). No whole-suite build/check was run in
this pass; the parent owns integration and native/PTY acceptance.

## 7. Deliberate non-goals

No job supervisor (start/kill/wait/remove), no polling, no process-status inference,
no local elapsed clock for live jobs, no Goal loop/round driver or `/goal`
replacement, no plugin enable/disable/config mutation, no raw diagnostics or
credential rendering, no second question engine or local countdown, no new input
action/context, and no second rendering or terminal writer.