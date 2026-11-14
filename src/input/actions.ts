/**
 * CC/readline action registry for the DSH TUI input layer.
 *
 * Status vocabulary (used in input docs and keymap diagnostics):
 * - `cc-match`: intended to match Claude Code / readline behaviour.
 * - `cc-app-override`: CC repurposes this key for an application action instead
 *   of the GNU readline command with the same key.
 * - `pi-extension`: Pi capability kept for compatibility, not a CC default.
 * - `tui-extension`: DSH TUI capability added on purpose; not observed in CC
 *   and therefore never presented as a CC-verified default.
 * - `unverified`: plausible GNU/readline command, not verified against CC.
 * - `unsupported`: knowingly not implemented or not distinguishable.
 */

export type CcContext =
  | "editor"
  | "autocomplete"
  | "list"
  | "dialog"
  | "historySearch"
  | "modelPickerList"
  | "modelPickerSearch"
  | "toolDetails"
  | "imageDetails"
  | "subagentList"
  | "subagentSession"
  | "settingsList"
  | "keybindingsList"
  | "modalList"
  | "queueList"
  | "modalSearch"
  | "global"

export const CC_CONTEXTS: readonly CcContext[] = [
  "editor",
  "autocomplete",
  "list",
  "dialog",
  "historySearch",
  "modelPickerList",
  "modelPickerSearch",
  "toolDetails",
  "imageDetails",
  "subagentList",
  "subagentSession",
  "settingsList",
  "keybindingsList",
  "modalList",
  "queueList",
  "modalSearch",
  "global",
]

export type CcActionFamily =
  | "movement"
  | "deletion"
  | "kill-ring"
  | "undo"
  | "history"
  | "editing"
  | "completion"
  | "submit"
  | "app"
  | "list"
  | "dialog"
  | "search"

export type CcCompatibilityStatus =
  | "cc-match"
  | "cc-app-override"
  | "pi-extension"
  | "tui-extension"
  | "unverified"
  | "unsupported"

export type CcActionImplementor = "editor" | "app"

/** Host platform bucket for key defaults; WSL follows Windows conventions here. */
export type CcKeybindingPlatform = "windows" | "wsl" | "posix"

export interface CcActionDefinition {
  id: string
  family: CcActionFamily
  contexts: readonly CcContext[]
  defaultBindings: readonly string[]
  /**
   * Extra default bindings that only exist on one platform, e.g. the Alt+V
   * clipboard alias on Windows/WSL. They extend `defaultBindings` and are ignored
   * when the user overrides the action, so an explicit binding always wins.
   */
  platformBindings?: Partial<Record<CcKeybindingPlatform, readonly string[]>>
  implementor: CcActionImplementor
  status: CcCompatibilityStatus
  description: string
  note?: string
}

const editorContext = ["editor"] as const
const autocompleteContext = ["autocomplete"] as const
const listContext = ["list"] as const
const dialogContext = ["dialog"] as const
const searchContext = ["historySearch"] as const
const appContext = ["global"] as const
/**
 * Read-only tool-details modal. It deliberately has no `editor` fallback, so
 * editor movement/kill/undo bindings cannot reach into a read-only surface.
 * Shared list/dialog/global actions provide scrolling, closing and app keys.
 */
const toolDetailsContext = ["toolDetails"] as const
/**
 * Read-only image viewer modal. Same shape as `toolDetails`: shared list/dialog/
 * global actions provide scrolling and closing, but there is no `editor`
 * fallback, so printable input can never reach a hidden text field.
 */
const imageDetailsContext = ["imageDetails"] as const
/**
 * Native Agents overlay (agent list and one child's session view). Same
 * read-only shape as `toolDetails`/`imageDetails`: list/dialog/global fallback,
 * never the editor layer. The overlay-local actions below are the only
 * additions, so plain `r`/`s`/Tab stay ordinary input everywhere else.
 */
const subagentContexts = ["subagentList", "subagentSession"] as const
const subagentListContext = ["subagentList"] as const
/**
 * Settings browse list (categories + typed rows). Same read-only shape as the
 * details modals: shared list/dialog/global keys, never the editor layer, so
 * editor movement/kill/undo cannot type into a settings surface. The search
 * field is a real text field and uses `modalSearch` instead.
 */
const settingsListContext = ["settingsList"] as const
/**
 * Settings → Keyboard shortcuts list. Same read-only shape; Enter edits the
 * selected row (`keybindings.edit`) instead of the shared `list.select`, which
 * stays the documented fallback if the edit action is disabled/remapped.
 */
const keybindingsListContext = ["keybindingsList"] as const
/**
 * Generic modal list (session picker and similar), plus the native queue list.
 * Both are read-only browsing surfaces with no editor fallback.
 */
const modalListContext = ["modalList"] as const
const queueListContext = ["queueList"] as const
/**
 * Native decision dialogs and generic modal lists. Registered in both named
 * contexts; every modal browse chain also reaches the `dialog` layer, so the
 * one Ctrl+O row is available wherever a decision surface can be focused.
 */
const decisionDialogContexts = ["dialog", "modalList"] as const
/**
 * Browse surfaces that offer `modal.search` (Ctrl+F). `imageDetails` is
 * intentionally absent: the image viewer has no search field.
 */
const modalSearchContexts = [
  "settingsList",
  "keybindingsList",
  "modalList",
  "toolDetails",
  "subagentList",
  "subagentSession",
  "queueList",
] as const

/** Browse mode of the provider-grouped /model picker (list + provider keys). */
const modelPickerListContext = ["modelPickerList"] as const
const modelPickerBothContexts = ["modelPickerList", "modelPickerSearch"] as const
/**
 * list.select / list.cancel also apply to the picker query field, so Enter and
 * Esc are forwarded as list actions. Other list keys (j/k/digits/arrows) stay
 * in the browse (`list`) context only.
 */
const listAndModelPickerSearchContexts = ["list", "modelPickerSearch"] as const

/**
 * Default CC keymap. Keys are Pi key identifiers; a binding with several keys
 * is a chord (e.g. `"ctrl+x ctrl+e"`).
 *
 * `subagentList` / `subagentSession` are the read-only native Agents overlay:
 * the agent list and one agent's session view. They share the read-only shape
 * of `toolDetails`/`imageDetails` (list navigation, dialog and global app keys,
 * no `editor` fallback) and add app-implemented, overlay-local actions:
 * `subagent.reply` (default `r`, set the App-owned reply target),
 * `subagent.interrupt` (default `s`, stop the focused child inside the
 * overlay) and `subagent.filter.toggle` (default Tab, the overlay's
 * Active/All filter). They are ordinary registry rows (remap/disable/reset in
 * the one grouped Settings list); the input layer only emits/returns the
 * action, the App performs the backend operation. There is no second
 * target/mode action in the root editor: leaving a reply target stays
 * `app.cancel`.
 *
 * `settingsList`, `keybindingsList`, `modalList` and `queueList` are the
 * unified modal browse surfaces. They follow the same read-only shape (shared
 * list/dialog/global keys, no `editor` fallback). Their context-local actions
 * are `modal.search`, `settings.*`, `keybindings.*`, `session.scope.toggle` and
 * `queue.*`. `modalSearch` is the one text field inside these modals (editor,
 * dialog, global) so typing, word/whitespace deletion, kill/yank and undo work
 * through the one Pi editor state; list navigation is passed by the UI, not by
 * editor keybindings.
 *
 * `/settings` is one continuous grouped list, so `settings.previous-category` /
 * `settings.next-category` mean previous/next *group (section)* and are the two
 * group-navigation rows bound to Left + Shift+Tab and Right + Tab. Both are
 * context-local to `settingsList`, so they are resolved before the `dialog` and
 * `global` fallback layers: a generic dialog Tab/focus binding or the global
 * `app.mode.cycle` (Shift+Tab) can never swallow them there, and the root
 * prompt keeps Tab = completion and Shift+Tab = native `/permission`.
 *
 * Ordering matters when one byte matches several identifiers (^M = enter,
 * ^J = ctrl+j): the first matching definition in this array wins.
 */
export const CC_ACTIONS: readonly CcActionDefinition[] = [
  // --- movement ---------------------------------------------------------
  {
    id: "editor.move.line-start",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["home", "ctrl+a"],
    implementor: "editor",
    status: "cc-match",
    description: "Move to the start of the current logical line",
  },
  {
    id: "editor.move.line-end",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["end", "ctrl+e"],
    implementor: "editor",
    status: "cc-match",
    description: "Move to the end of the current logical line",
  },
  {
    id: "editor.move.char-left",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["left", "ctrl+b"],
    implementor: "editor",
    status: "cc-match",
    description: "Move one grapheme left",
  },
  {
    id: "editor.move.char-right",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["right", "ctrl+f"],
    implementor: "editor",
    status: "cc-match",
    description: "Move one grapheme right",
  },
  {
    id: "editor.move.word-left",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["alt+b", "alt+left", "ctrl+left"],
    implementor: "editor",
    status: "cc-match",
    description: "Move one word left (punctuation/CJK aware)",
    note: "Platform aliases: Option+Left on macOS, Ctrl+Left elsewhere. Terminal coverage varies (see docs/INPUT.md).",
  },
  {
    id: "editor.move.word-right",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["alt+f", "alt+right", "ctrl+right"],
    implementor: "editor",
    status: "cc-match",
    description: "Move one word right (punctuation/CJK aware)",
  },
  {
    id: "editor.move.line-up",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["up", "ctrl+p"],
    implementor: "editor",
    status: "cc-match",
    description: "Move up a visual line; browse history at the first visual line",
    note: "CC has no extra jump-to-column-0 step: on the first visual line Up always browses history.",
  },
  {
    id: "editor.move.line-down",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["down", "ctrl+n"],
    implementor: "editor",
    status: "cc-match",
    description: "Move down a visual line; browse history at the last visual line",
  },
  {
    id: "editor.move.page-up",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["pageUp"],
    implementor: "editor",
    status: "unverified",
    description: "Move the cursor up one editor page",
  },
  {
    id: "editor.move.page-down",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["pageDown"],
    implementor: "editor",
    status: "unverified",
    description: "Move the cursor down one editor page",
  },
  {
    id: "editor.history.previous",
    family: "history",
    contexts: editorContext,
    defaultBindings: [],
    implementor: "editor",
    status: "unverified",
    description: "Browse one history entry older, ignoring visual lines",
    note: "Disabled by default; CC reaches history through Up/Ctrl+P boundary behaviour.",
  },
  {
    id: "editor.history.next",
    family: "history",
    contexts: editorContext,
    defaultBindings: [],
    implementor: "editor",
    status: "unverified",
    description: "Browse one history entry newer, ignoring visual lines",
  },
  {
    id: "editor.jump.forward",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["ctrl+]"],
    implementor: "editor",
    status: "pi-extension",
    description: "Pi: jump forward to a character",
  },
  {
    id: "editor.jump.backward",
    family: "movement",
    contexts: editorContext,
    defaultBindings: ["ctrl+alt+]"],
    implementor: "editor",
    status: "pi-extension",
    description: "Pi: jump backward to a character",
  },

  // --- insertion / submit ----------------------------------------------
  {
    id: "editor.newline",
    family: "editing",
    contexts: editorContext,
    defaultBindings: ["shift+enter", "ctrl+j", "alt+enter"],
    implementor: "editor",
    status: "cc-match",
    description: "Insert a newline (Ctrl+J, Shift+Enter; Alt+Enter alias)",
    note: "Listed before editor.submit because a bare LF matches both ctrl+j and enter.",
  },
  {
    id: "editor.submit",
    family: "submit",
    contexts: editorContext,
    defaultBindings: ["enter"],
    implementor: "editor",
    status: "cc-match",
    description: "Submit the input (Enter); trailing backslash inserts a newline instead",
  },
  {
    id: "editor.insert-space",
    family: "editing",
    contexts: editorContext,
    defaultBindings: ["shift+space"],
    implementor: "editor",
    status: "unverified",
    description: "Insert a literal space",
  },
  {
    id: "editor.complete",
    family: "completion",
    contexts: editorContext,
    defaultBindings: ["tab"],
    implementor: "editor",
    status: "cc-match",
    description: "Open or refresh completion",
  },
  {
    id: "editor.cancel",
    family: "app",
    contexts: editorContext,
    defaultBindings: ["escape"],
    implementor: "editor",
    status: "cc-match",
    description: "Close completion or restore the history-browsing draft first; only otherwise forward app.cancel",
    note: "Esc is contextual: a local completion/history layer consumes it so it never interrupts the Agent.",
  },

  // --- deletion / kill --------------------------------------------------
  {
    id: "editor.delete.char-backward",
    family: "deletion",
    contexts: editorContext,
    defaultBindings: ["backspace", "ctrl+h"],
    implementor: "editor",
    status: "cc-match",
    description: "Delete one grapheme backward",
    note: "Ctrl+H and Backspace are byte-equivalent on legacy terminals (^H ambiguity).",
  },
  {
    id: "editor.delete.char-forward",
    family: "deletion",
    contexts: editorContext,
    defaultBindings: ["delete", "ctrl+d"],
    implementor: "editor",
    status: "cc-match",
    description: "Delete one grapheme forward; on empty input forward app.exit",
  },
  {
    id: "editor.kill.whitespace-backward",
    family: "kill-ring",
    contexts: editorContext,
    defaultBindings: ["ctrl+w"],
    implementor: "editor",
    status: "cc-match",
    description: "Kill back to the previous whitespace boundary (whole path/flag)",
    note: "CC Ctrl+W is whitespace-delimited, unlike Alt+B/F word boundaries.",
  },
  {
    id: "editor.kill.word-backward",
    family: "kill-ring",
    contexts: editorContext,
    defaultBindings: ["alt+backspace", "ctrl+backspace"],
    implementor: "editor",
    status: "cc-match",
    description: "Kill one word backward using punctuation/CJK boundaries",
    note: "Option+Delete on macOS (Meta+Backspace); terminals without CSI-u may send Ctrl+W instead.",
  },
  {
    id: "editor.kill.word-forward",
    family: "kill-ring",
    contexts: editorContext,
    defaultBindings: ["alt+d", "alt+delete"],
    implementor: "editor",
    status: "cc-match",
    description: "Kill one word forward using punctuation/CJK boundaries",
  },
  {
    id: "editor.kill.whitespace-forward",
    family: "kill-ring",
    contexts: editorContext,
    defaultBindings: [],
    implementor: "editor",
    status: "unverified",
    description: "Kill forward to the next whitespace boundary",
    note: "GNU unix-word-rubout is backward-only; forward whitespace kill is opt-in.",
  },
  {
    id: "editor.kill.line-start",
    family: "kill-ring",
    contexts: editorContext,
    defaultBindings: ["ctrl+u"],
    implementor: "editor",
    status: "cc-match",
    description: "Kill from the line start to the cursor (newline at column 0)",
  },
  {
    id: "editor.kill.line-end",
    family: "kill-ring",
    contexts: editorContext,
    defaultBindings: ["ctrl+k"],
    implementor: "editor",
    status: "cc-match",
    description: "Kill from the cursor to the line end (newline at line end)",
  },
  {
    id: "editor.yank",
    family: "kill-ring",
    contexts: editorContext,
    defaultBindings: ["ctrl+y"],
    implementor: "editor",
    status: "cc-match",
    description: "Yank the most recent kill",
  },
  {
    id: "editor.yank-pop",
    family: "kill-ring",
    contexts: editorContext,
    defaultBindings: ["alt+y"],
    implementor: "editor",
    status: "cc-match",
    description: "Replace the last yank with an older kill",
    note: "Only valid immediately after a yank in Pi; CC yank-pop legality is unverified.",
  },
  {
    id: "editor.undo",
    family: "undo",
    contexts: editorContext,
    defaultBindings: ["ctrl+_", "ctrl+-", "ctrl+shift+-"],
    implementor: "editor",
    status: "cc-match",
    description: "Undo the last edit (text, cursor, paste registry)",
    note: "Ctrl+_ / Ctrl+- / Ctrl+Shift+- are byte-equivalent (^_) on legacy terminals.",
  },
  {
    id: "editor.transpose.chars",
    family: "editing",
    contexts: editorContext,
    defaultBindings: [],
    implementor: "editor",
    status: "unverified",
    description: "Transpose the grapheme before the cursor with the one at the cursor",
    note: "CC binds Ctrl+T to the todo app action, so transpose is unbound by default.",
  },

  // --- completion popup -------------------------------------------------
  {
    id: "autocomplete.previous",
    family: "completion",
    contexts: autocompleteContext,
    defaultBindings: ["up", "ctrl+p"],
    implementor: "editor",
    status: "cc-match",
    description: "Highlight the previous completion",
  },
  {
    id: "autocomplete.next",
    family: "completion",
    contexts: autocompleteContext,
    defaultBindings: ["down", "ctrl+n"],
    implementor: "editor",
    status: "cc-match",
    description: "Highlight the next completion",
  },
  {
    id: "autocomplete.page-up",
    family: "completion",
    contexts: autocompleteContext,
    defaultBindings: ["pageUp"],
    implementor: "editor",
    status: "unverified",
    description: "Page the completion list up",
  },
  {
    id: "autocomplete.page-down",
    family: "completion",
    contexts: autocompleteContext,
    defaultBindings: ["pageDown"],
    implementor: "editor",
    status: "unverified",
    description: "Page the completion list down",
  },
  {
    id: "autocomplete.accept",
    family: "completion",
    contexts: autocompleteContext,
    defaultBindings: ["tab", "enter"],
    implementor: "editor",
    status: "cc-match",
    description: "Accept the highlighted completion",
    note: "Enter submits slash-command completions; Tab keeps editing.",
  },
  {
    id: "autocomplete.cancel",
    family: "completion",
    contexts: autocompleteContext,
    defaultBindings: ["escape"],
    implementor: "editor",
    status: "cc-match",
    description: "Close the completion list",
    note: "Esc closes only the completion menu. Ctrl+C is not a completion cancel in the chosen Pi main-input policy: it clears the entire root draft (app.clear) even while the menu is open, and the stale menu closes as a consequence.",
  },

  // --- CC app overrides -------------------------------------------------
  // Ordering matters for one physical byte: an explicit `app.interrupt`
  // override on Ctrl+C keeps precedence over the shipped `app.clear` default
  // (the collision is reported as a conflict, never silently rewritten).
  {
    id: "app.interrupt",
    family: "app",
    contexts: appContext,
    defaultBindings: [],
    implementor: "app",
    status: "tui-extension",
    description: "Interrupt the active native operation (no shipped default; bind explicitly)",
    note: "The old Ctrl+C default moved to app.clear. An explicit single-key override keeps priority before a pending chord and before the chain in the read-only/modal contexts; an explicit Ctrl+C interrupt collides with the app.clear default and is reported, never rewritten.",
  },
  {
    id: "app.clear",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+c"],
    implementor: "app",
    status: "pi-extension",
    description: "Clear the root draft without aborting the active work; a repeated press within 500 ms arms the safe exit",
    note: "Chosen from the observed installed Pi 1.5.1 main-input policy, not a current-CC match (CC Ctrl+C cancels/interrupts). The App clears/saves the one draft and owns the 500 ms exit arm; the input layer only emits the action. Local dialog/list/search cancellation wins first; completion does not intercept Ctrl+C, so the root draft clears and the stale menu closes. Paste bytes are never keys, and Kitty key releases/repeats never dispatch a second clear.",
  },
  {
    id: "app.cancel",
    family: "app",
    contexts: appContext,
    defaultBindings: ["escape"],
    implementor: "app",
    status: "cc-match",
    description: "Cancel the focused app surface (Esc only after no local layer consumed it)",
  },
  {
    id: "app.exit",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+d"],
    implementor: "app",
    status: "cc-match",
    description: "Exit when the prompt is empty (Ctrl+D); never exits on a non-empty draft",
    note: "The empty-draft guard does not depend on binding priority, so disabling/rebinding forward-delete cannot resurrect global exit.",
  },
  {
    id: "app.redraw",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+l"],
    implementor: "app",
    status: "cc-match",
    description: "Clear and redraw while preserving the draft",
  },
  {
    id: "app.history.search",
    family: "search",
    contexts: appContext,
    defaultBindings: ["ctrl+r"],
    implementor: "app",
    status: "cc-match",
    description: "Open reverse history search",
  },
  {
    id: "app.stash",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+s"],
    implementor: "app",
    status: "cc-app-override",
    description: "Stash / restore the draft (CC app action, not flow control)",
  },
  {
    id: "app.editor.external",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+g", "ctrl+x ctrl+e"],
    implementor: "app",
    status: "cc-app-override",
    description: "Open the draft in an external editor",
  },
  {
    id: "app.tools.expand",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+o"],
    implementor: "app",
    status: "cc-app-override",
    description: "Expand or collapse tool output / transcript",
  },
  {
    id: "app.tools.details",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+x ctrl+o"],
    implementor: "app",
    status: "tui-extension",
    description: "Open tools inspector (initial latest)",
    note: "DSH TUI capability, not a verified CC default. Plain Ctrl+O keeps the CC expand/collapse meaning; the chord is app-owned and forwards to the App like other app-implemented actions. The inspector always opens on the latest tool; browse with tool.details.previous-tool/next-tool.",
  },
  {
    id: "app.images.details",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+x ctrl+i"],
    implementor: "app",
    status: "tui-extension",
    description: "Open the image details viewer for the focused image",
    note: "DSH TUI capability, not a verified CC default. Shown only when the surface has an image; the chord keeps Ctrl+I available for tab completion.",
  },
  {
    id: "app.subagents.details",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+x ctrl+a"],
    implementor: "app",
    status: "tui-extension",
    description: "Open the native Agents overlay",
    note: "DSH TUI capability, not a verified CC default. Opens the read-only native Agents overlay (agent list and one agent's session view); the chord keeps plain Ctrl+A available for line start in the prompt.",
  },
  // --- native Agents overlay (read-only) -------------------------------
  {
    id: "subagent.reply",
    family: "dialog",
    contexts: subagentContexts,
    defaultBindings: ["r"],
    implementor: "app",
    status: "tui-extension",
    description: "Reply to the focused native subagent",
    note: "Agents overlay only (subagentList/subagentSession), so plain `r` stays text in the prompt and is not a global fallback. The App owns the reply target and leaves it through app.cancel; this adds no second editor target/mode action. DSH TUI capability, not a verified CC default.",
  },
  {
    id: "subagent.interrupt",
    family: "dialog",
    contexts: subagentContexts,
    defaultBindings: ["s"],
    implementor: "app",
    status: "tui-extension",
    description: "Interrupt (stop) the focused native subagent",
    note: "Agents overlay only (subagentList/subagentSession), so plain `s` stays text in the prompt. Stops the focused child inside the overlay; the global Ctrl+C app.interrupt priority is unchanged. DSH TUI capability, not a verified CC default.",
  },
  {
    id: "subagent.filter.toggle",
    family: "list",
    contexts: subagentListContext,
    defaultBindings: ["tab"],
    implementor: "app",
    status: "tui-extension",
    description: "Toggle the Agents overlay Active / All filter",
    note: "Agent list only (subagentList), so Tab keeps editor completion in the prompt and the session view keeps its read-only list keys. Filters the current native catalog; it never starts, follows or stops a child. DSH TUI capability, not a verified CC default.",
  },
  {
    id: "app.queue.open",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+x ctrl+q"],
    implementor: "app",
    status: "tui-extension",
    description: "Open the native message queue",
    note: "DSH TUI capability, not a verified CC default. The chord keeps Ctrl+Q free for the prompt and reuses the existing Ctrl+X prefix. The queue is an operational view of DSH's native inbox; the TUI keeps no local queue.",
  },
  {
    id: "app.todo",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+t"],
    implementor: "app",
    status: "cc-app-override",
    description: "Toggle native todos above the editor",
  },
  {
    id: "app.thinking.toggle",
    family: "app",
    contexts: appContext,
    defaultBindings: [],
    implementor: "app",
    status: "unverified",
    description: "Expand or collapse the latest thinking summary; hidden reasoning is revealed first (unbound by default)",
    note: "This does not change model reasoning effort. The show/hide master switch lives in /settings → Thinking.",
  },
  {
    id: "app.model.select",
    family: "app",
    contexts: appContext,
    defaultBindings: ["alt+p"],
    implementor: "app",
    status: "pi-extension",
    description: "Open the model picker (Alt+P; Ctrl+P stays history)",
  },
  {
    id: "app.mode.cycle",
    family: "app",
    contexts: appContext,
    defaultBindings: ["shift+tab"],
    implementor: "app",
    status: "cc-app-override",
    description: "Cycle DSH permission presets (Shift+Tab)",
    note: "Legacy config ID retained. This executes /permission, not /plan.",
  },
  {
    id: "app.clipboard.pasteImage",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+v"],
    platformBindings: { windows: ["alt+v"], wsl: ["alt+v"] },
    implementor: "app",
    status: "cc-app-override",
    description: "Paste clipboard content / image attachment (CC Ctrl+V; Alt+V on Windows/WSL)",
    note: "Alt+V is added only on Windows and WSL, matching terminal clipboard conventions; no existing binding is taken over.",
  },
  {
    id: "app.suspend",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+z"],
    implementor: "app",
    status: "unverified",
    description: "Suspend the TUI (Unix job control) and restore state on resume",
  },
  {
    id: "app.message.sendNow",
    family: "app",
    contexts: appContext,
    defaultBindings: [],
    implementor: "app",
    status: "unverified",
    description: "Cancel the current turn and send this draft, or the first queued message, now",
    note: "Bound in the prompt to Ctrl+Enter. Enter still queues. Empty Ctrl+Enter sends the first queued row.",
  },
  {
    id: "app.message.steer",
    family: "app",
    contexts: appContext,
    defaultBindings: [],
    implementor: "app",
    status: "unverified",
    description: "Steer the draft into the current turn at the next DSH step",
    note: "Bound in the prompt to Ctrl+X Ctrl+S.",
  },
  {
    id: "app.message.followUp",
    family: "app",
    contexts: appContext,
    defaultBindings: [],
    implementor: "app",
    status: "unverified",
    description: "Queue the draft as a follow-up while streaming",
    note: "App-state dependent; unbound by default.",
  },
  {
    id: "app.help",
    family: "app",
    contexts: appContext,
    defaultBindings: ["f1"],
    implementor: "app",
    status: "unverified",
    description: "Show commands and help",
  },

  // --- list navigation --------------------------------------------------
  {
    id: "list.previous",
    family: "list",
    contexts: listContext,
    defaultBindings: ["up", "ctrl+p", "k"],
    implementor: "app",
    status: "cc-app-override",
    description: "Move the list selection up",
    note: "j/k only exist in list context; they never swallow text-field input.",
  },
  {
    id: "list.next",
    family: "list",
    contexts: listContext,
    defaultBindings: ["down", "ctrl+n", "j"],
    implementor: "app",
    status: "cc-app-override",
    description: "Move the list selection down",
  },
  {
    id: "list.page-up",
    family: "list",
    contexts: listContext,
    defaultBindings: ["pageUp"],
    implementor: "app",
    status: "cc-app-override",
    description: "Page the list selection up",
  },
  {
    id: "list.page-down",
    family: "list",
    contexts: listContext,
    defaultBindings: ["pageDown"],
    implementor: "app",
    status: "cc-app-override",
    description: "Page the list selection down",
  },
  {
    id: "list.first",
    family: "list",
    contexts: listContext,
    defaultBindings: ["home"],
    implementor: "app",
    status: "unverified",
    description: "Select the first list item",
  },
  {
    id: "list.last",
    family: "list",
    contexts: listContext,
    defaultBindings: ["end"],
    implementor: "app",
    status: "unverified",
    description: "Select the last list item",
  },
  {
    id: "list.select",
    family: "list",
    contexts: listAndModelPickerSearchContexts,
    defaultBindings: ["enter"],
    implementor: "app",
    status: "cc-app-override",
    description: "Accept the selected list item",
    note: "Also applies in modelPickerSearch: Enter must confirm the picker, not submit/clear the query field.",
  },
  {
    id: "list.cancel",
    family: "list",
    contexts: listAndModelPickerSearchContexts,
    defaultBindings: ["escape", "ctrl+c"],
    implementor: "app",
    status: "cc-app-override",
    description: "Close the list without selecting",
    note: "Also applies in modelPickerSearch (Esc dismisses). In picker, toolDetails, imageDetails and subagent contexts the configured app.interrupt key keeps priority over ctrl+c.",
  },
  {
    id: "list.select-digit",
    family: "list",
    contexts: listContext,
    defaultBindings: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    implementor: "app",
    status: "unverified",
    description: "Select a numbered list item (list context only)",
  },

  // --- tool details modal (read-only) ----------------------------------
  {
    id: "tool.details.next-section",
    family: "dialog",
    contexts: toolDetailsContext,
    defaultBindings: ["tab", "right"],
    implementor: "app",
    status: "tui-extension",
    description: "Show the next section of the tool details view",
    note: "Modal-only. It cannot reach editor completion or cursor movement.",
  },
  {
    id: "tool.details.previous-section",
    family: "dialog",
    contexts: toolDetailsContext,
    defaultBindings: ["shift+tab", "left"],
    implementor: "app",
    status: "tui-extension",
    description: "Show the previous section of the tool details view",
    note: "Modal-only. It does not cycle DSH permission presets while the modal is open.",
  },
  {
    id: "tool.details.previous-tool",
    family: "dialog",
    contexts: toolDetailsContext,
    defaultBindings: ["[", "alt+left"],
    implementor: "app",
    status: "tui-extension",
    description: "Show the previous tool in the tools inspector",
    note: "Modal-only. ASCII `[` and Alt+Left stay plain text/word-motion in the main editor.",
  },
  {
    id: "tool.details.next-tool",
    family: "dialog",
    contexts: toolDetailsContext,
    defaultBindings: ["]", "alt+right"],
    implementor: "app",
    status: "tui-extension",
    description: "Show the next tool in the tools inspector",
    note: "Modal-only. ASCII `]` and Alt+Right stay plain text/word-motion in the main editor.",
  },
  {
    id: "tool.details.copy",
    family: "dialog",
    contexts: toolDetailsContext,
    defaultBindings: ["c"],
    implementor: "app",
    status: "tui-extension",
    description: "Copy the focused tool details content",
    note: "Bound in toolDetails only, so `c` remains plain text in the main editor.",
  },

  // --- image details viewer (read-only) --------------------------------
  {
    id: "image.details.previous-image",
    family: "dialog",
    contexts: imageDetailsContext,
    defaultBindings: ["[", "alt+left"],
    implementor: "app",
    status: "tui-extension",
    description: "Show the previous image in the details viewer",
    note: "Modal-only. ASCII `[` and Alt+Left stay plain text/word motion in the main editor.",
  },
  {
    id: "image.details.next-image",
    family: "dialog",
    contexts: imageDetailsContext,
    defaultBindings: ["]", "alt+right"],
    implementor: "app",
    status: "tui-extension",
    description: "Show the next image in the details viewer",
    note: "Modal-only. ASCII `]` and Alt+Right stay plain text/word motion in the main editor.",
  },
  {
    id: "image.details.close",
    family: "dialog",
    contexts: imageDetailsContext,
    defaultBindings: ["escape"],
    implementor: "app",
    status: "tui-extension",
    description: "Close the image details viewer",
    note: "Context-local close wins over list.cancel for Esc. The configured app.interrupt key (Ctrl+C) always keeps priority in this context.",
  },
  {
    id: "image.details.toggle-preview",
    family: "dialog",
    contexts: imageDetailsContext,
    defaultBindings: ["p"],
    implementor: "app",
    status: "tui-extension",
    description: "Switch the image viewer between automatic and text-only display",
    note: "Image viewer only, so `p` stays ordinary text in the prompt and in modal text fields. A renderer-only display toggle: text-only mode must not start a read/decode or change attachments/facts. DSH TUI capability, not a verified CC default.",
  },

  // --- unified modal navigation (settings / keyboard / queue) ----------
  {
    id: "modal.search",
    family: "dialog",
    contexts: modalSearchContexts,
    defaultBindings: ["ctrl+f"],
    implementor: "app",
    status: "tui-extension",
    description: "Search the focused modal list or inspector",
    note: "Browse surfaces only (Settings, Keyboard shortcuts, generic modal lists, queue, tools inspector, Agents overlay; not the image viewer). Modal-local, so Ctrl+F stays editor char-right in the prompt, and in a modal text field (modalSearch) it stays char-right while typing.",
  },
  {
    id: "settings.reset",
    family: "dialog",
    contexts: settingsListContext,
    defaultBindings: ["ctrl+r"],
    implementor: "app",
    status: "tui-extension",
    description: "Reset the selected setting to its default",
    note: "Settings list only; removes that one local override and never writes unrelated settings. Modal-local, so Ctrl+R keeps its history-search meaning in the prompt.",
  },
  {
    id: "settings.previous-category",
    family: "dialog",
    contexts: settingsListContext,
    defaultBindings: ["left", "shift+tab"],
    implementor: "app",
    status: "tui-extension",
    description: "Jump to the previous Settings group (section)",
    note: "Settings browse list only. Left/Shift+Tab move to the previous group/section of the one continuous grouped list; there are no category tabs. The legacy ID is kept for existing keybindings.json overrides. In a settings text field (modalSearch) Left/Shift+Tab keep their editing/fallback meaning, and in the prompt Shift+Tab stays the native permission preset.",
  },
  {
    id: "settings.next-category",
    family: "dialog",
    contexts: settingsListContext,
    defaultBindings: ["right", "tab"],
    implementor: "app",
    status: "tui-extension",
    description: "Jump to the next Settings group (section)",
    note: "Settings browse list only. Right/Tab move to the next group/section of the one continuous grouped list; there are no category tabs. The legacy ID is kept for existing keybindings.json overrides. Legacy terminals send the same byte for Tab and Ctrl+I, so this context-local binding also sees Ctrl+I; the prompt keeps Tab for completion and a settings text field (modalSearch) keeps its own keys.",
  },
  {
    id: "keybindings.edit",
    family: "dialog",
    contexts: keybindingsListContext,
    defaultBindings: ["enter"],
    implementor: "app",
    status: "tui-extension",
    description: "Edit the selected shortcut",
    note: "Keyboard shortcuts list only; it deliberately wins over the shared list.select (both default to Enter) in this one context, so Enter edits a row instead of activating a hidden list. Disabling/remapping it falls back to list.select as documented in docs/INPUT.md.",
  },
  {
    id: "keybindings.reset",
    family: "dialog",
    contexts: keybindingsListContext,
    defaultBindings: ["ctrl+r"],
    implementor: "app",
    status: "tui-extension",
    description: "Reset the selected shortcut to its default",
    note: "Keyboard shortcuts list only; deletes exactly one keybindings.json override and never rewrites the rest. Modal-local, so Ctrl+R keeps its history-search meaning in the prompt.",
  },
  {
    id: "keybindings.disable",
    family: "dialog",
    contexts: keybindingsListContext,
    defaultBindings: ["ctrl+d"],
    implementor: "app",
    status: "tui-extension",
    description: "Disable the selected shortcut",
    note: "Keyboard shortcuts list only: Ctrl+D disables one row here and never exits the app (global app.exit only wins outside this list), while the editor keeps forward-delete.",
  },
  {
    id: "session.scope.toggle",
    family: "list",
    contexts: modalListContext,
    defaultBindings: ["ctrl+a"],
    implementor: "app",
    status: "tui-extension",
    description: "Toggle the modal list scope (sessions: current workspace / all)",
    note: "Generic modal list only; Ctrl+A keeps line-start in the prompt and in modal text fields, and browsing never changes the session itself.",
  },
  {
    id: "queue.edit",
    family: "dialog",
    contexts: queueListContext,
    defaultBindings: ["e"],
    implementor: "app",
    status: "tui-extension",
    description: "Edit the selected queued message in the composer",
    note: "Queue list only, so `e` stays ordinary text in the prompt. The App keeps the single composer and the native inbox entry/id; the queue list never owns message text.",
  },
  {
    id: "queue.cancel-entry",
    family: "dialog",
    contexts: queueListContext,
    defaultBindings: ["d"],
    implementor: "app",
    status: "tui-extension",
    description: "Cancel the selected queued message",
    note: "Queue list only, so `d` stays ordinary text and forward-delete in the prompt. Cancels exactly one native inbox entry through the App's existing operation; no local queue exists.",
  },
  {
    id: "queue.send-now",
    family: "dialog",
    contexts: queueListContext,
    defaultBindings: ["ctrl+enter"],
    implementor: "app",
    status: "tui-extension",
    description: "Cancel the current turn and send the selected queued message now",
    note: "Queue list only. Requires a terminal that reports Ctrl+Enter (Kitty protocol / xterm modifyOtherKeys); legacy terminals send plain Enter, which stays list.select there, so remap if needed.",
  },
  {
    id: "tool.details.toggle-calls",
    family: "dialog",
    contexts: toolDetailsContext,
    defaultBindings: ["ctrl+l"],
    implementor: "app",
    status: "tui-extension",
    description: "Show or hide the tool call list in the tools inspector",
    note: "Modal-only, so Ctrl+L keeps its redraw meaning in the prompt; selecting a call is metadata only and never re-runs a tool.",
  },
  {
    id: "tool.details.wrap",
    family: "dialog",
    contexts: toolDetailsContext,
    defaultBindings: ["ctrl+w"],
    implementor: "app",
    status: "tui-extension",
    description: "Toggle line wrapping in the tools inspector",
    note: "Browse mode only, so Ctrl+W keeps its CC whitespace-kill meaning; a tool text field uses modalSearch where Ctrl+W stays editor whitespace-kill.",
  },

  // --- /model picker navigation ----------------------------------------
  {
    id: "model.provider.previous",
    family: "list",
    contexts: modelPickerBothContexts,
    defaultBindings: ["shift+tab"],
    implementor: "app",
    status: "cc-app-override",
    description: "Select the previous provider group in the /model picker",
    note: "Picker-local UI navigation in browse and search mode; it does not switch DSH permission or plan modes.",
  },
  {
    id: "model.provider.next",
    family: "list",
    contexts: modelPickerBothContexts,
    defaultBindings: ["tab"],
    implementor: "app",
    status: "cc-app-override",
    description: "Select the next provider group in the /model picker",
    note: "Picker-local UI navigation in browse and search mode; the query text is kept.",
  },
  {
    id: "model.provider.previousArrow",
    family: "list",
    contexts: modelPickerListContext,
    defaultBindings: ["left"],
    implementor: "app",
    status: "cc-app-override",
    description: "Select the previous provider group in the /model picker (browse mode)",
    note: "Only in modelPickerList; in the search field Left/Right edit the query text.",
  },
  {
    id: "model.provider.nextArrow",
    family: "list",
    contexts: modelPickerListContext,
    defaultBindings: ["right"],
    implementor: "app",
    status: "cc-app-override",
    description: "Select the next provider group in the /model picker (browse mode)",
    note: "Only in modelPickerList; in the search field Left/Right edit the query text.",
  },

  // --- dialogs / approvals ---------------------------------------------
  {
    id: "dialog.confirm",
    family: "dialog",
    contexts: dialogContext,
    defaultBindings: ["enter"],
    implementor: "app",
    status: "cc-app-override",
    description: "Confirm the focused dialog",
  },
  {
    id: "dialog.cancel",
    family: "dialog",
    contexts: dialogContext,
    defaultBindings: ["escape", "ctrl+c"],
    implementor: "app",
    status: "cc-app-override",
    description: "Cancel and settle the focused dialog/approval request",
    note: "Default Ctrl+C cancels/rejects locally and never reaches the hidden root app.clear; a configured single-key app.interrupt keeps priority in the read-only/modal contexts.",
  },
  {
    id: "dialog.details",
    family: "dialog",
    contexts: decisionDialogContexts,
    defaultBindings: ["ctrl+o"],
    implementor: "app",
    status: "tui-extension",
    description: "Open the full read-only native decision details of the focused dialog",
    note: "Dialog/modal-list contexts only. It reads the already supplied native question/tool detail or pure proposal content; it never answers, executes tools, reads paths or fabricates an applied label. Plain Ctrl+O stays app.tools.expand in the root prompt.",
  },

  // --- history search ---------------------------------------------------
  {
    id: "historySearch.next",
    family: "search",
    contexts: searchContext,
    defaultBindings: ["ctrl+r"],
    implementor: "app",
    status: "unverified",
    description: "Search further back",
  },
  {
    id: "historySearch.previous",
    family: "search",
    contexts: searchContext,
    defaultBindings: ["ctrl+shift+r"],
    implementor: "app",
    status: "unverified",
    description: "Search forward again",
  },
  {
    id: "historySearch.accept",
    family: "search",
    contexts: searchContext,
    defaultBindings: ["enter", "tab"],
    implementor: "app",
    status: "unverified",
    description: "Accept the search result into the draft",
  },
  {
    id: "historySearch.cancel",
    family: "search",
    contexts: searchContext,
    defaultBindings: ["escape", "ctrl+c"],
    implementor: "app",
    status: "unverified",
    description: "Cancel the search and restore the pre-search draft",
  },
] as const

export const CC_ACTIONS_BY_ID: ReadonlyMap<string, CcActionDefinition> = new Map(
  CC_ACTIONS.map((action) => [action.id, action]),
)

/** Default binding strings for one action (empty array when unbound). */
export function getDefaultBindings(actionId: string): readonly string[] {
  return CC_ACTIONS_BY_ID.get(actionId)?.defaultBindings ?? []
}