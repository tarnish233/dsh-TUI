# Popup/settings implementation contract (2026-11-07)

> **Historical pass contract.** The current placement and Ctrl+C policy is [COMPOSER-INTERACTION-CONTRACT.md](COMPOSER-INTERACTION-CONTRACT.md): transient decisions/short input use the composer region, browsing/configuration stays an independent overlay, and default Ctrl+C uses Pi clear/exit plus local surface cancellation. The blanket-overlay and default-global-interrupt statements below describe the prior pass, not the current UI.

> **Status: implemented in the current working tree; unreleased.** Final parent
> verification: `pnpm check` 1646/1646 (121 files), latest Settings CLI/PTY 2/2
> and native Settings 2/2; earlier popup offline CLI/PTY 23/23,
> native production Skills PTY 2/2, native model picker 2/2 and a read-only
> native auto-title/profile-byte-identical probe. This document
> remains the ownership/API record for the pass; it is not a release or a
> substitute for the acceptance log in `docs/ACCEPTANCE.md`.

User approved docs/DIALOG-REDESIGN-RESEARCH.zh-CN.md and asked to start implementation. This pass implements unified native Pi TUI modal UI, display preferences and safe navigation to existing DSH operations; no release authorization.

Read AGENTS.md, docs/PROPOSAL.zh-CN.md (§5) and the research proposal. Preserve all existing uncommitted Skills/Enter work. Native DSH remains owner of model/tool/permission/preset/session/credential business. No private harness/process/IPC, config mirrors, real user credential/profile/session/clipboard reads, global changes, dependency changes, commit/push/publish, or live provider calls. Tests use temporary homes/workspaces and hermetic native fixtures only.

## Ownership for this pass

- Parent: src/app.ts, src/config.ts, src/history-search.ts, NEW src/ui/modal.ts (shared rendering primitive only), src/backend/types.ts if ever necessary, plugin/CLI/manifests, shared helpers, test/config.test.ts and NEW test/app-modal*.test.ts/test/modal-render*.test.ts, independent PTY/native acceptance, root docs.
- settings-ui: src/ui/settings.ts, src/ui/keybindings.ts, src/ui/queue-list.ts (default-collapse setter only), NEW src/ui/queue-dialog.ts; test/ui-settings.test.ts, test/ui-keybindings.test.ts and NEW test/ui-settings-modal.test.ts/test/ui-queue-dialog.test.ts.
- chooser-ui: src/ui/dialogs.ts, src/ui/model-picker.ts, src/ui/session-picker.ts, src/ui/help.ts; corresponding test/ui-dialogs*, test/ui-cancel*, test/ui-model-picker*, test/ui-session-picker*, test/ui-help*, test/ui-skills-help*. No src/history-search.ts (parent).
- inspector-ui: src/ui/tool-details.ts, src/ui/image-details.ts; corresponding test/ui-tool-details*, test/ui-image-viewer*, test/ui-images.test.ts. May add private src/ui/inspector-search.ts, no other tool fact/presenter edits without asking.
- agents-ui: src/ui/agents-overlay.ts, src/ui/child-session-view.ts, src/ui/transcript.ts (independent grouping only), src/ui/subagent-progress.ts only if needed; corresponding test/ui-subagents* and test/ui-subagent-progress*. No src/state/native fact changes needed.
- input-ui: src/input/ (prefer only actions.ts/keymap.ts), vendor/pi-tui only if a narrowly evidenced input seam is indispensable, test/input*.test.ts, input docs. Preserve the recent Enter acceptance capture fix. No editor/protocol/second-input changes just for modal navigation.

All work shares this checkout, not worktrees (previous Skills changes must remain visible). Never edit another owner's files. UI owners can add uniquely named NEW tests; do not run full pnpm check until integration settles. Parent will build/typecheck/shared acceptance. If another file is temporarily incomplete, report exact dependency, don't patch it or weaken tests. No read/write to competitor caches is needed for implementation.

## Shared rendering primitive (parent implements src/ui/modal.ts)

Use only #pi-tui. The primitive draws chrome and maps mouse coordinates; it owns no input/editor/native state and never writes terminal output.

Exports:

```ts
export type ModalSize = 'compact' | 'standard' | 'wide'
export interface ModalAction {
  id: string
  label: string
  action?: string // CcKeymap action id; actual first enabled binding rendered
  onActivate?: () => void
  disabled?: boolean
}
export interface ModalFrameOptions {
  title: string
  subtitle?: string
  before?: readonly string[] // already-rendered search/segment lines, inner width
  after?: readonly string[] // already-rendered status lines, capped by frame budget
  actions?: readonly ModalAction[]
  onClose?: () => void
  maxHeight?: number
  keymap?: CcKeymap
}
export interface ModalGeometry {
  width: number
  bodyWidth: number
  bodyHeight: number
  bodyRow: number
  bodyCol: number
}
export class ModalFrame {
  measure(width: number, options: ModalFrameOptions): ModalGeometry
  render(width: number, body: readonly string[], options: ModalFrameOptions): string[]
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined // chrome only
  bodyMouse(event: TuiMouseEvent): TuiMouseEvent | undefined // translated into body rect
  invalidate(): void
}
export function modalOverlayOptions(size?: ModalSize): OverlayOptions
export function modalHeight(tui: Pick<TUI, 'terminal'>, size?: ModalSize): number
export function modalBinding(keymap: CcKeymap, actionId: string, excludeInterrupt?: boolean): string | undefined
```

Geometry is from the same options used for render. Components measure first, compute/slice visible body, render second. Body height is strictly bounded with a tiny-terminal fallback; chrome/action geometry is rebuilt for each frame. Native image APC lines are not sanitized/reflowed as text by chrome; image owners render with measured inner width and height. Ordinary body lines must already be width-safe/sanitized. No RGBA backdrop or new renderer. Do not double-frame a component in parent App.

Components may declare `readonly modalSize: ModalSize` for parent generic dialog hosting; default standard. Existing specialized overlay hosts remain but use matching size/height options.

## Display preference schema (parent implements src/config.ts)

Keep existing 16 keys and values. Add exactly:
- showSubagentProgress: boolean = true
- groupSubagentMessages: boolean = true
- imagePreview: 'auto' | 'text' = 'auto'
- copyOnSelect: boolean = true
- queueCollapsed: boolean = false
- reducedMotion: boolean = false

All are renderer/display only. No model/vision/skills engine/tool/policy/scheduler knobs.

SettingsStore adds `reset(key: keyof Settings): Promise<void>` (delete one override) and `getOverrides(): Partial<Settings>`. Known defaults remain exported. Stores preserve unrelated/unknown keys, refuse malformed files, and serialize writes. Legacy groupTools initial value is migrated once to independent groupSubagentMessages; reset afterwards uses its own default, never a permanent Tools fallback. Parent owns a flat formatVersion marker if needed to distinguish legacy migration from intentional unset. No extra preference file or hierarchy. New files can stay sparse; old resolved files stay readable.

## UI contracts/additions

### Settings / keyboard

Retain existing constructor basics/settings accessors where sensible. After user feedback, Settings is explicitly one continuous scrollable page: general/thinking/tools/agents/images/dsh/keyboard are group headings (tools label Tools & Diff), never tabs or page filters. Up/Down crosses groups, and Tab/Shift+Tab or Right/Left jumps sections without clearing search or changing the roster. Search covers label/description/keywords; focus/search input uses existing InlineAnswer/CcEditor grammar, no bespoke readline. Typed boolean/enum/numeric editing; retain custom legal numeric values, per-item reset, saving/failed feedback, effective binding hints. Native rows are navigation/information supplied by parent, not schema autoforms.

- `captureView(): SettingsViewState` and `initialState?: SettingsViewState` preserve section, selected id, query/scroll across child navigation. The legacy `category` field means the selected row's group, never a filter. `getVisibleRows()`/`rows()` returns all unfiltered rows or cross-section search matches; `allRows` always ignores the query. Export type from settings.ts; parent imports it.
- `onReset?: (key: keyof Settings) => void | Promise<void | Settings>`.
- `onChange: (patch: Partial<Settings>) => void | Promise<void | Settings>` remains usable by old tests; prefer confirmed saved snapshot, no double-submit/late optimistic success.
- Auto-title has no local writable preference or `onAutoTitle` callback. The parent supplies a read-only `NativeSettingsEntry`; DSH profile composition owns enablement, and opening Settings re-queries the native state without sending `enabled`.
- `getNativeEntries?: () => readonly NativeSettingsEntry[]`, export entry {id,label,value,description?,available?,onActivate?}; parent supplies safe scalar rows/existing navigation. No native runtime imports.
- Preserve onKeybindings, onCancel, onInterrupt. Keyboard remains one grouped editable/filterable list, reset deletes one override, disable/remap/conflict checks go through existing parent save callback. No /hotkeys.

QueueDialog (new) takes readonly QueueEntry[] snapshot or `getEntries:()=>readonly QueueEntry[]`, keymap and parent callbacks onEdit/onCancelEntry/onSendNow/onClose/onInterrupt; it is an operational view of native inbox, no local queue. It should filter/select rows and provide native-id actions using queueList context; parent owns each action and refresh.

### Choosers / help / decisions

Use ModalFrame and width-safe mouse/navigation. Preserve native IDs, scope/sort/title lazy-enrichment, source search semantics and readonly Help/Skills. Search fields reuse CC input where replacing Pi Input is necessary. No catalog ownership changes.

For asynchronous parent opening, add:
- SelectDialog: setItems(items), setLoading(boolean), setError(message)
- ModelPickerDialog: setModels(models), setLoading(boolean), setError(message)
Keep current query/selection when safe; loading/empty/no-match/error are distinct; no auto-select/submit when data arrives.

DecisionDialog preserves opaque native option values and ordered answers, current review/multiselect/custom text. Frame close invokes the same rejection/cancel path as Esc; no arbitrary backdrop close. App remains final owner of question cancellation/native settlement. Standalone legacy dismissed-state APIs can remain, but documentation must not claim App leaves pending questions hidden. No guessed approval-to-tool diff.

### Tools / images

Preserve existing I/O, source fidelity/copy, navigation, per-section scroll and real result/status. Add measured frame, CC search for output/input, optional wide calling list:
- ToolDetails options `getTools?: () => readonly ToolTranscriptItem[]`, `onSelectTool?: (callId:string)=>void`.
- optional call-list selection is metadata only; never tool rerun/path read.
- native changes/presenter data only for Diff; do not invent a new changes tab from filesystem guesses.
- ImageDetails options `preview?: 'auto'|'text'`, `setPreview?(value)`; text-only must not initiate read/decode on construct and must abort/retire pending reads, leave refs/facts intact.
Frame body coordinates must preserve existing header/image chips/selection. Tool -> Image -> Back retains the existing ToolDetails instance/section/scroll, no implicit global copy actions.

### Agents / child

Search and Active/All filters, stable selected native id, no hover follow/read/stop. Preserve metadata and exact capability/no-metric estimates. Add:
- AgentsOverlay `captureView()` and `initialState?` (export type) to preserve query/filter/selected id/scroll on child back.
- ChildSessionView same readonly transcript/explicit loading/native controls, optional search if safely implemented without copied facts; no second composer.
- `setMessage?(message, error?)` for native stop/reply failures visible in current surface.
- src/ui/transcript.ts uses `groupSubagentMessages` independently; flags/options add optional boolean. Defaults true in standalone rendering; parent passes migrated value.
Progress always remains the requested two-line native summary + activity, active-only retirement, name-only links. Parent gates visibility via showSubagentProgress and existing maxRows getter; reducedMotion uses one shared parent Working clock, no component timer.

## Input action contract (input-ui implements registry)

Add readonly navigation contexts settingsList/keybindingsList/modalList/queueList with list/dialog/global fallback but NO editor fallback, plus modalSearch (editor/dialog/global; search is a field, navigation passed by UI). Existing model search/detail contexts remain unchanged.

Named local actions/defaults:
- modal.search (ctrl+f; settingsList/keybindingsList/modalList/toolDetails/subagentList/subagentSession/queueList)
- settings.reset (ctrl+r; settingsList)
- settings.previous-category (left, shift+tab; settingsList; previous group/section)
- settings.next-category (right, tab; settingsList; next group/section)
- keybindings.edit (enter; keybindingsList)
- keybindings.reset (ctrl+r; keybindingsList)
- keybindings.disable (ctrl+d; keybindingsList)
- session.scope.toggle (ctrl+a; modalList)
- subagent.filter.toggle (tab; subagentList)
- tool.details.toggle-calls (ctrl+l; toolDetails)
- tool.details.wrap (ctrl+w; toolDetails; only browse, not text field)
- app.queue.open (ctrl+x ctrl+q; global)
- queue.edit (e; queueList)
- queue.cancel-entry (d; queueList)
- queue.send-now (ctrl+enter; queueList)

These are TUI-specific, not CC-verified defaults. All registry rows are remappable/disableable/reset in the same grouped Keyboard list. Modal field typing, word/whitespace deletion, kill/yank/undo must work; unknown global editor/app actions never reach a hidden root editor. app.interrupt retains existing priority for modal contexts. No new input readers, raw stdin, editor state, completion binding/capture changes. GUI owners can add uniquely named PRIVATE view-local literal controls only by first requesting registry additions, not silently hardcoding them.

## Parent integration and acceptance

Generic showDialog becomes a real bounded overlay while prompt remains mounted/frozen. Root Editor remains sole composer; lifecycle increments/retires existing surfaceGeneration/attachment identity. Use captureView/explicit return routes or retained instances, no surprise late reopen. Decision priority/native answer semantics unchanged. Skills menu remains Editor-owned and exact Enter completed-payload acceptance retained.

Native settings rows: current model/effort/preset/permission/plan, Skills metadata and native-managed defaults explanatory rows; reuse existing picker/commands only. No broad settings.describe/native YAML/credential values, model catalogs/caches or policy setter implementation in this pass. Default preset/permission editing is blocked pending a safe narrow API/revision seam.

Independent parent tests: both renderers, actual VT popup geometry and mouse/key parity, settings/keyboard/back/drafts/images, stale loading/write failures, independent grouping/reset/migration, preview text no reads, queue same native IDs, exact Enter Skills/native command preservation, terminal recovery. No claim of production GPU/IME/live provider acceptance. Do not run competitors or real user dsh for testing.
