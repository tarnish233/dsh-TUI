# Composer interactions and Pi-style Ctrl+C — implementation contract

Status: implemented and included in user-authorized local v0.1.6; no remote push or registry publication. The final frozen functional gate and local version verification are recorded in docs/ACCEPTANCE.md. This pass supersedes the blanket centered-popup placement rule, not DSH business ownership. The user chose the observed installed Pi 1.5.1 main-input Ctrl+C policy instead of current CC documentation. Other CC/readline editing semantics remain.

## Safety and architecture

The following sections record implementation-phase constraints and ownership. The later user-authorized local version commit/tag is recorded separately in docs/ACCEPTANCE.md; it does not change DSH business ownership or the safety boundary.

Read AGENTS.md and docs/PROPOSAL.zh-CN.md, especially section 5. Preserve every existing uncommitted change. Production stays native DSH bundle + same-process Cordis plugin. No private process/IPC, Pi AgentSession backend, second domain loop/scheduler/persistence, or model/credential subsystem. No real providers/model calls, user credentials/config/session reads or writes, global installation changes, manifest changes, staging/commit/push/publish. Tests use owned temporary homes/workspaces and fixture-only hosts. Schedule remains deferred.

## Parallel ownership

All agents use cloudagent/glm-5.3 in this checkout, not worktrees.

- Parent: src/app.ts, src/native-ui-controller.ts, src/ui/interaction.ts, src/ui/modal.ts, shared composer allocation and transcript mouse seam, App/shared/PTY/native acceptance tests, root docs and final integration.
- composer-decisions: src/ui/dialogs.ts; NEW src/ui/decision-details.ts; test/ui-dialogs.test.ts, test/ui-cancel-dialogs.test.ts, test/ui-approval-proposal.test.ts, test/ui-select-roster-identity.test.ts and uniquely named new decision/chooser tests. No model/session/help files.
- independent-surfaces: src/ui/settings.ts, keybindings.ts, model-picker.ts, session-picker.ts, help.ts, queue-dialog.ts, jobs-dialog.ts, native-inspection-dialog.ts, history-dialog.ts, workspace-changes-dialog.ts; their directly corresponding UI tests and uniquely named new surface-cancellation tests. No src/ui/dialogs.ts, modal.ts, input files, tool/image/agents/child/history-search files.
- history-inspectors: src/history-search.ts (explicit parent delegation), src/ui/tool-details.ts, image-details.ts, agents-overlay.ts, child-session-view.ts; corresponding UI tests and uniquely named new history-search/detailed-surface tests. No src/ui/transcript.ts or input files.
- pi-clear-input: src/input/, test/input*.test.ts, docs/INPUT.md, docs/INPUT-API.md; vendor/pi-tui/ only if a narrowly evidenced seam is indispensable, with SOURCE.md documentation. Prefer action/keymap changes; App clear/exit policy belongs to parent.

Ask parent before changing another owner's files or contracts. Do not run pnpm check during parallel work. Each owner runs focused source tests only; parent owns builds/typecheck/native acceptance/final serialized gate. Focused mutation checks must be single-file, restore immediately, and verify hashes; do not weaken tests or leave a temporary mutation behind. If parent-owned wiring is unfinished, report the exact dependency rather than patching it.

## Shared presentation seam

Parent has created src/ui/interaction.ts:

```ts
export type InteractionPlacement = 'composer' | 'workspace'
export interface InteractionLayout {
  readonly placement: InteractionPlacement
  readonly maxHeight: number
}
export interface ComposerInteraction extends Component {
  setInteractionLayout(layout: InteractionLayout): void
  measureRows(width: number): number
}
```

Only composer-capable views need this seam. setInteractionLayout is idempotent and presentation-only: no reads, answers, focus changes, editor replacement, or requestRender. Layout changes retire old mouse targets/pins. measureRows is pure and matches render without calling component render; use the same prepared/cached geometry. Render stays within the parent's hard height/width. Max height is a cap, not an excuse to pad a short picker to a huge panel.

Parent showDialog keeps the logical single dialog identity but explicitly chooses composer/workspace placement by call site. Workspace views retain bounded centered overlays. Composer views mount between the status dock stack and the unchanged main prompt; the frozen prompt may be compacted without copying/replacing its Editor. Parent computes a joint row budget using pure measureRows; no render-to-measure recursion, no renderer-private patch. Background reading remains available; option/submit input never leaks to the main editor.

### Placement classification

Composer: live native questions/approvals, actual continued-question answers, Ctrl+R prompt-history search, quick preset/permission/effort pickers and short permission confirmation, /attach path prompt, main-command rename/fork forms.

Workspace: Settings/Keyboard, grouped/searchable ModelPicker and SessionPicker, full Help, History, Workspace Changes, Queue/Jobs, native inspection/default/pending-question directories, Tool/Image details, Agents list and ChildSessionView. Settings-initiated rename/fork/default suboperations inherit workspace placement. Existing completion and status docks stay input-adjacent.

### Long native decision details

composer-decisions may add the following approved API (export from NEW src/ui/decision-details.ts):

```ts
export type DecisionDetailContent =
  | { readonly kind: 'markdown'; readonly title: string; readonly text: string }
  | { readonly kind: 'proposal'; readonly title: string; readonly presentation: JsonRecord }
export interface DecisionDetailsOptions {
  readonly content: DecisionDetailContent
  readonly keymap: CcKeymap
  readonly onClose: () => void
  readonly onInterrupt?: () => void
}
export class DecisionDetailsDialog implements Component, Focusable { /* readonly workspace view */ }
```

DecisionDialog options add onDetails?: (content: DecisionDetailContent) => void. It shows a keyboard-accessible native-detail action only when native question.detail or usable pure native proposal exists. Named dialog.details (Ctrl+O) is assigned by input owner in dialog/modalList contexts. No presentResult/tool execution/path reads, no applied-label fabrication. The full detail reads the already supplied native content and is bounded/scrollable. Parent mounts it as a separate read-only overlay over the retained decision instance, returns focus on close, and retires it on request close/session/attachment change. Selections/custom drafts/native IDs and ordered opaque values survive; no second main editor or durable store.

## Pi-style Ctrl+C input contract

Observed installed Pi 1.5.1: app.clear defaults to Ctrl+C; app.interrupt defaults to Esc. Its main handler has no busy check: first Ctrl+C calls editor.setText('') and records time; a second within 500ms calls shutdown. clearEditor does not abort a model/tool/child; setText creates an undo snapshot. Pi's ordinary select/custom dialog cancellation stays local to the focused surface.

For this DSH application:

- Add named global app.clear, default Ctrl+C. Parent clears/saves the main draft without backend.cancel, even during active root/child/command work; 500ms second clear press exits through existing terminal-safe shutdown.
- Keep app.cancel = Esc for local-first cancellation, then native interruption. Keep app.interrupt as an explicit configurable native interrupt action but remove its default Ctrl+C binding (default empty); do not give two global actions the same default Escape. Explicit user interrupt overrides and their priority remain supported and visible, without rewriting user files.
- Preserve existing app.exit/Ctrl+D and other CC/readline semantics; this pass is the chosen Ctrl+C/interrupt split, not a wholesale Pi keymap import.
- All actions use the current named registry/Settings/override file, not hardcoded raw bytes, a new keymap profile, or /hotkeys. An old explicit interrupt override is explicit intent; collisions with the new clear default must be reported, not silently rewritten.
- Default Ctrl+C in modal/list/search contexts must reach the local cancel/restore/reject path, not the hidden root clear or global native abort. Disabled local cancel keys must not gain an invented unconfigured fallback. HistorySearch Ctrl+C cancels/restores even when the root is busy.
- Bracketed paste treats Ctrl+C bytes as content. Chords/jump/completion reset or close consistently; one physical press produces one action. Key releases/repeats must not become an accidental second exit press.
- Main clear keeps the one editor, undo, kill ring, paste/image/file recovery; use captureDraft + undoable replaceDraftText, no bare external setText copy. Frontend attachment/clipboard/queue-read completions must not revive cleared text, but clear never invokes native Agent/tool cancellation.
- OS SIGINT remains the separate terminal-safe shutdown path, not simulated raw Ctrl+C.

The input owner adds dialog.details = Ctrl+O in dialog/modalList contexts for native decision detail viewing. Preserve full-sequence conflict detection and default-layer diagnostics.

## Required focused evidence

Component tests: pure row measurement/render equality, width/height caps at 12/18/24/40 rows and 40/80/120 columns, no unnecessary padding for small choices, viewport reading versus local option navigation, native detail full read/back/selection preservation, Ctrl+C local cancellation and disabled/remapped keys, stale mouse pins after height/row identity changes, immutable native data/readonly disclosure.

Parent integration: default Ctrl+C busy root draft clears with ZERO native cancellation; 500ms repeated clear exits safely; empty/busy/idle and subagent-reply cases; configured explicit interrupt still cancels; exact Up/undo/paste/image/file recovery; local modal/search cancel while root continues; same-session reattachment and late source replies; every approved call-site placement; both terminal modes and PTY restoration. Native hermetic approval -> allow -> write -> summary/diff -> history remains genuine native composition with no extra FS scope or real model. Final gate is pnpm check on a frozen tree; no file writes during it.
