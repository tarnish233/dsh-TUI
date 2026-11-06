# /model picker input API (handoff for frontend + parent)

Owner: input developer (`src/input/`). This is the contract the frontend
`src/ui/model-picker.ts` may rely on. Filtering, provider/model roster,
selection and rendering stay in the frontend / native DSH services; the input
layer only adds contexts, configurable actions and text-field routing.

No new editor state, no hardcoded modal key checks in the picker, and no
second keybindings hierarchy: everything goes through the existing `CcKeymap`
and the single Pi `Editor` state inside `CcEditor`.

## Contexts and fallback chains

Two `CcContext` values were added to `src/input/actions.ts`:

- `modelPickerList` — browse mode (roster focused).
- `modelPickerSearch` — query/search mode (text field focused).

Fallback chains (first match wins; `CcKeymap.getFallbackChain(context)`
returns the authoritative list):

| context | chain |
| --- | --- |
| `modelPickerList` | `modelPickerList → list → editor → global` |
| `modelPickerSearch` | `modelPickerSearch → editor → global` |

All existing chains are unchanged:
`editor → global`, `autocomplete → editor → global`,
`historySearch → editor → global`, `dialog → editor → global`,
`list → global`, `global`. The tool-details modal adds a separate
`toolDetails → list → dialog → global` chain with no editor layer; it does not
alter the picker chains.

Consequences:

- Browse mode (`modelPickerList`) keeps the shared configurable list layer
  (`list.previous/next/pageUp/pageDown/first/last/select/cancel/select-digit`)
  and the editor editing layer underneath. **However, the `CcEditor` picker
  path treats typed printable input as query text in both picker contexts**
  (see “Text-first query routing”): the first `j`/`k`/digit from browse focus
  becomes query text, not `list.next`/`list.select-digit`. Arrow/Ctrl+P/N
  navigation, Tab/Shift+Tab, Enter/Esc and Ctrl+C stay available.
- Search mode (`modelPickerSearch`) gets editor text editing
  (`Left/Right`, `Ctrl+B/F`, `Alt+B/F`, `Ctrl+A/E`, `Ctrl+W` vs
  `Alt+Backspace`, kill/yank/yank-pop, undo, graphemes, paste). It does **not**
  get `j`/`k`/digit list selection.
- `Enter`/`Esc` are forwarded in both picker contexts as the existing
  `list.select` / `list.cancel` actions (see below), because those two
  definitions now also list `modelPickerSearch` in their `contexts`.

## Configurable actions

Registered in `CC_ACTIONS`; they appear automatically in the grouped
`/settings` → **Keyboard shortcuts** list under **Lists & dialogs** (family
`list`), configurable/disableable like every other action. There is no
hotkeys file, profile or local override hierarchy.

| action | default | contexts | implementor | status |
| --- | --- | --- | --- | --- |
| `model.provider.previous` | `shift+tab` | `modelPickerList`, `modelPickerSearch` | `app` | `cc-app-override` |
| `model.provider.next` | `tab` | `modelPickerList`, `modelPickerSearch` | `app` | `cc-app-override` |
| `model.provider.previousArrow` | `left` | `modelPickerList` | `app` | `cc-app-override` |
| `model.provider.nextArrow` | `right` | `modelPickerList` | `app` | `cc-app-override` |

`cc-app-override` here means "picker-local app navigation overriding the
shared list/editor default for that key". These are UI navigation actions, not
DSH permission/plan/model business modes: the picker emits events and the
frontend/native services decide what a provider group is.

Forward them through the existing sink:

```ts
editor.onAction = (event) => {
  switch (event.id) {
    case "model.provider.previous": // Shift+Tab, both modes
    case "model.provider.next":     // Tab, both modes
    case "model.provider.previousArrow": // Left, browse mode only
    case "model.provider.nextArrow":     // Right, browse mode only
      // change the frontend provider-group focus; keep the query text
      return true
    case "list.select":  // Enter in browse or search mode
      // confirm the selected model
      return true
    case "list.cancel":  // Esc in browse or search mode
      // dismiss the picker
      return true
    case "app.interrupt": // Ctrl+C (global)
      // abort/cancel the picker or current operation
      return true
    default:
      return false
  }
}
```

Raw `keymap.resolve(data, "modelPickerList")` retains the list defaults:

| key | action |
| --- | --- |
| `Tab` / `Shift+Tab` | `model.provider.next` / `model.provider.previous` |
| `Left` / `Right` | `model.provider.previousArrow` / `model.provider.nextArrow` |
| `Up`/`Down`/`Ctrl+P`/`Ctrl+N`/`j`/`k` | `list.previous` / `list.next` |
| `1`–`9` | `list.select-digit` |
| `Enter` / `Esc` | `list.select` / `list.cancel` (or `app.interrupt` for Ctrl+C) |

Do not use raw `keymap.resolve` to type into the picker: feed keys through
`editor.handleInput(data)` instead. In the `CcEditor` picker path, printable
`j`/`k`/digits/space/letters are inserted into the query (see below), while the
raw resolution above remains available for a custom list component.

Raw `keymap.resolve(data, "modelPickerSearch")`:

| key | action |
| --- | --- |
| `Tab` / `Shift+Tab` | `model.provider.next` / `model.provider.previous` |
| `Left`/`Right`, `Ctrl+B/F`, `Alt+B/F`, `Ctrl+A/E` | editor movement (text field) |
| `Up`/`Down`, `Ctrl+P/N` | `editor.move.line-up` / `editor.move.line-down` (query visual lines; frontend handles the boundary case, see below) |
| `Enter` / `Esc` | `list.select` / `list.cancel` |
| `Ctrl+W` / `Alt+Backspace` / `Ctrl+U/K/Y` / `Alt+Y` / `Ctrl+_` | editor kill/Yank/undo |
| printable `j`, `k`, digits, space, letters | text (never list selection) |
| `Ctrl+C` | `app.interrupt` (global, see below) |

## `CcEditor.getContext()` / `setContext()`

```ts
editor.getContext(): CcContext
editor.setContext(context: CcContext): void
```

These switch the action context of the **same** `CcEditor` instance, so the
picker can reuse one editor for browse and search instead of creating a second
editor or hardcoding modal keys:

```ts
editor.getContext()            // "modelPickerList" or "modelPickerSearch"
editor.setContext("modelPickerSearch") // typing/editing activates the query
editor.setContext("modelPickerList")   // Up/Down at the query boundary
```

Guarantees:

- No Pi editor state is recreated or reset. Text, cursor, undo stack, kill
  ring, history, large-paste markers, paste registry and paste framing are
  untouched (verified by snapshot equality tests).
- A pending chord **opened by this editor** is cancelled on a real context
  change (its candidates were compiled for the old context); a chord owned by
  another editor on a shared keymap is not touched. Same-context calls are a
  no-op.
- `getActionContext()` / `setActionContext()` remain as aliases for existing
  callers (`InlineAnswer`).

Suggested frontend usage:

1. Start in `modelPickerList` and forward keys to `editor.handleInput(data)`.
   Do **not** pre-filter printables or cancel a chord to switch modes: a plain
   printable already inserts into the query in both picker contexts (and a
   mismatched chord is cancelled by the keymap before the printable is
   re-dispatched as text). As soon as `editor.onChange` reports text, call
   `setContext("modelPickerSearch")`; switching after the key is safe and the
   snapshot is preserved.
2. `printableInput(data)` (exported from `src/input/index.ts`) returns the
   printable text for a raw terminal chunk (or `undefined`) if a UI wants to
   decide “typing activates search” without duplicating Kitty/CSI-u decoding.
   It does not mutate state; it is optional because the editor already routes
   printables to text.
3. Up/Down/Ctrl+P/N in search mode move within the query (editor visual
   lines). At the first/last visual line the frontend may move the model
   selection itself and switch back to `modelPickerList`. The input layer adds
   no search-specific list actions, per contract.
4. Keep the query text when switching contexts or providers. `setContext()`
   never clears it. Do not use numeric quick-select in the picker; digits are
   always query text.

## Text-first query routing (BOTH picker contexts)

`CcEditor.dispatchKeys` applies a picker-only rule: when the configured
context is `modelPickerList` **or** `modelPickerSearch`, and the keymap has **no
pending chord**, a plain printable input chunk is inserted into the query
before the keymap is consulted.

This is deliberately stronger than “text beats simple bindings”. A configured
printable-prefixed chord (e.g. `"j k"`) is **not started** by typing `j` in the
picker; the letter goes into the query instead. Text fields must not lose
letters. Modifier-led chords (`Ctrl+X Ctrl+E`, …) still open normally.

Ordering:

1. bracketed-paste reassembly (`handleInput` / `pasteFilter`) — pasted bytes,
   including `j`, digits, Tab, Ctrl+C bytes, are always text and never actions;
2. character-jump mode (Pi extension) keeps its existing priority;
3. if a chord is already pending, the keymap resolves it first: modifier chord
   completion, mismatch and timeout are unchanged; a mismatched key (including
a printable) is re-dispatched with no pending chord and then becomes text;
4. no pending chord + printable → insert into the query (this overrides simple
   list/global/editor bindings and printable chord starts);
5. otherwise normal action dispatch (`Tab`, arrows, Enter/Esc, Ctrl/Alt reads,
   global app actions, …).

Notes and limits:

- Ctrl/Alt modified keys are never “printable” for this rule: `Ctrl+B/F`,
  `Alt+B/F`, `Ctrl+W` vs `Alt+Backspace`, yank/undo and the global actions keep
  their keymap meaning.
- The rule is scoped to the two picker contexts. Old `editor`, `list`, `dialog`,
  `historySearch` and `autocomplete` behaviour is unchanged, including `j`/`k`/
  digit list selection in `list`.
- Raw `keymap.resolve(data, "modelPickerList")` keeps `list.next` for `j`.
  That distinction is intentional: a custom list component can still ask the
  keymap, while the `CcEditor` picker path treats direct printable input as
  query text.
- Enter is not affected: it is non-printable and resolves `list.select` in
  both picker contexts.

## Disabled provider actions never become generic completion

Only a registered `model.provider.*` action event may change the provider
group. If `model.provider.next` is disabled, raw `keymap.resolve` falls through
to the editor layer (`editor.complete` for Tab), but `CcEditor` **consumes that
fallback in the picker contexts**: no `editor.complete` event is emitted, so an
`InlineAnswer`-style generic `Tab` result can never be mistaken for provider
cycling. The same applies to `model.provider.previous`/arrow keys: disabling
them leaves that key inert (or at most an unrelated non-provider action); no
`model.provider.*` event is synthesized.

For the same reason, if `list.select` is disabled, Enter is consumed in the
picker contexts instead of falling through to `editor.submit`: it never calls
`onSubmit`, never clears the query and never emits a generic submit result.

## Ctrl+C stays global in picker contexts

`list.cancel` (also active in `modelPickerSearch` for Esc) binds `ctrl+c`.
Without a rule, the local list binding would shadow the global
`app.interrupt` in the picker. `CcKeymap.resolve()` therefore gives the
configured **simple** `app.interrupt` binding priority in `modelPickerList`,
`modelPickerSearch` and `toolDetails`, **before** pending-chord resolution and
before the context chain.

Result:

- Default `Ctrl+C` → `app.interrupt` in both picker contexts (and the
tool-details modal), including while a chord is pending: the chord is
cancelled, its hint clears once, and the interrupt is dispatched directly
instead of being re-dispatched after a mismatch. Pasted Ctrl+C bytes are text.
- If `app.interrupt` is disabled or remapped, the configured binding is
  honoured; `Ctrl+C` then falls back to `list.cancel` in the picker.
- Existing `list` / `dialog` semantics are untouched (`list.cancel` still owns
  Ctrl+C there; their UI helpers already check the interrupt key first).

## Enter in search mode never submits/clears the query

Because `list.select` is resolved in `modelPickerSearch` before
`editor.submit`, pressing `Enter` in the search field emits
`event.id === "list.select"` to `onAction`. The editor does **not** call
`onSubmit`, does not clear the text and does not insert a newline. The frontend
confirms the selected model in its `list.select` handler (and may then dismiss
the picker). `Esc` likewise emits `list.cancel` and keeps the query text until
the picker is dismissed.

## Verification

Focused offline tests: `node --test test/input-model-picker.test.ts` (plus the
existing `test/input-*.test.ts` suite). They cover the new chains, action
resolution/remap/disable/chords, `setContext()` snapshot preservation and chord
ownership, text-first routing from both picker contexts (including a configured
printable chord that must not swallow `j`, and mismatched-chord passthrough),
disabled provider actions not emitting `editor.complete`, Enter forwarding
without submit/clear, Ctrl+C priority, standard readline edits, paste
fragmentation and regressions of the old contexts.

Known gaps (input-side):

- `Up`/`Down` boundary crossing from the query into the model list is a
  frontend decision; the input layer only guarantees query movement and
  `ccIsOnFirstVisualLine()` / `ccIsOnLastVisualLine()` remain available.
- The picker's provider grouping, filtering, selected model and model
  enumeration are not part of the input layer.
- No remote/model calls are made by these tests.