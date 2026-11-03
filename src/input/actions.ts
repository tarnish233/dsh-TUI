/**
 * CC/readline action registry for the DSH TUI input layer.
 *
 * Status vocabulary (used in input docs and keymap diagnostics):
 * - `cc-match`: intended to match Claude Code / readline behaviour.
 * - `cc-app-override`: CC repurposes this key for an application action instead
 *   of the GNU readline command with the same key.
 * - `pi-extension`: Pi capability kept for compatibility, not a CC default.
 * - `unverified`: plausible GNU/readline command, not verified against CC.
 * - `unsupported`: knowingly not implemented or not distinguishable.
 */

export type CcContext = "editor" | "autocomplete" | "list" | "dialog" | "historySearch" | "global"

export const CC_CONTEXTS: readonly CcContext[] = [
  "editor",
  "autocomplete",
  "list",
  "dialog",
  "historySearch",
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
  | "unverified"
  | "unsupported"

export type CcActionImplementor = "editor" | "app"

export interface CcActionDefinition {
  id: string
  family: CcActionFamily
  contexts: readonly CcContext[]
  defaultBindings: readonly string[]
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
 * Default CC keymap. Keys are Pi key identifiers; a binding with several keys
 * is a chord (e.g. `"ctrl+x ctrl+e"`).
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
    description: "Close completion, otherwise forward app.cancel",
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
  },

  // --- CC app overrides -------------------------------------------------
  {
    id: "app.interrupt",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+c"],
    implementor: "app",
    status: "cc-match",
    description: "Interrupt / cancel the current operation or dialog",
  },
  {
    id: "app.cancel",
    family: "app",
    contexts: appContext,
    defaultBindings: ["escape"],
    implementor: "app",
    status: "cc-match",
    description: "Cancel the focused app surface",
  },
  {
    id: "app.exit",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+d"],
    implementor: "app",
    status: "cc-match",
    description: "Exit when the prompt is empty (Ctrl+D)",
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
    id: "app.todo",
    family: "app",
    contexts: appContext,
    defaultBindings: ["ctrl+t"],
    implementor: "app",
    status: "cc-app-override",
    description: "Toggle the todo list (CC Ctrl+T, not transpose-char)",
  },
  {
    id: "app.thinking.toggle",
    family: "app",
    contexts: appContext,
    defaultBindings: [],
    implementor: "app",
    status: "unverified",
    description: "Show or hide reasoning text (display only; unbound by default)",
    note: "This does not change model reasoning effort. CC uses Ctrl+T for todos.",
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
    implementor: "app",
    status: "cc-app-override",
    description: "Paste clipboard content / image attachment (CC Ctrl+V)",
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
    description: "Send the queued message immediately while streaming",
    note: "App-state dependent; unbound by default so Enter keeps its CC meaning.",
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
    contexts: listContext,
    defaultBindings: ["enter"],
    implementor: "app",
    status: "cc-app-override",
    description: "Accept the selected list item",
  },
  {
    id: "list.cancel",
    family: "list",
    contexts: listContext,
    defaultBindings: ["escape", "ctrl+c"],
    implementor: "app",
    status: "cc-app-override",
    description: "Close the list without selecting",
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