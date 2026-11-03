/**
 * DSH TUI input subsystem.
 *
 * Public surface:
 * - `CcEditor`: CC/readline editor on one Pi Editor state.
 * - `CcKeymap` / `createCcKeymap`: configurable, contextual keymap with chords
 *   and diagnostics, independent from Pi's global keybindings.
 * - CC_ACTIONS: the named action registry (editor, autocomplete, app, list,
 *   dialog, history-search contexts).
 * - Draft snapshots for stash / history search / external editing.
 */

export {
  CcEditor,
  type CcActionEvent,
  type CcEditorOptions,
  type CcExternalEditorRequest,
} from "./cc-editor.ts"

export {
  CcKeymap,
  createCcKeymap,
  formatBinding,
  isValidKeyId,
  parseBindingSpec,
  type CcCancelledChord,
  type CcKeymapConfig,
  type CcKeymapDiagnostic,
  type CcKeymapOptions,
  type CcKeyResolution,
  type CcPendingChord,
  type CcResolvedKey,
  type CcUnboundKey,
} from "./keymap.ts"

export {
  CC_ACTIONS,
  CC_ACTIONS_BY_ID,
  CC_CONTEXTS,
  getDefaultBindings,
  type CcActionDefinition,
  type CcActionFamily,
  type CcActionImplementor,
  type CcCompatibilityStatus,
  type CcContext,
} from "./actions.ts"

export {
  BracketedPasteFilter,
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  type PasteToken,
} from "./paste.ts"

export {
  assertCcEditorSeam,
  hasCcEditorSeam,
  type CcEditorSnapshot,
  type CcUndoSnapshot,
  type SeamEditor,
} from "./pi-tui-seam-types.ts"

export {
  deserializeCcDraftSnapshot,
  isCcDraftSnapshot,
  parseCcDraftSnapshot,
  serializeCcDraftSnapshot,
  type CcDraftSnapshot,
} from "./snapshot.ts"

export {
  graphemeAfter,
  graphemeBefore,
  graphemes,
  isWhitespaceAt,
  whitespaceBoundaryBackward,
  whitespaceBoundaryForward,
  type GraphemeSlice,
} from "./boundaries.ts"