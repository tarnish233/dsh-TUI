/**
 * CcEditor: a Claude-Code/readline compatible editor on top of Pi's Editor.
 *
 * There is exactly one editor state. This subclass only routes keys and adds
 * CC semantics through the narrow public seam added by the local Pi TUI patch
 * (`ccMoveWord`, `ccKillWord`, `ccCaptureSnapshot`, ...). Text is never rewritten
 * from the outside, undo/kill/yank/paste state stays in the Pi editor, and
 * `onSubmit`/`onChange` keep their Pi signatures.
 *
 * App-level actions (Ctrl+R, Ctrl+S, Ctrl+T, ...) are forwarded through
 * `onAction`; the app owns history search, stash, external editor, clipboard,
 * queueing and dialogs.
 */

import {
  decodeKittyPrintable,
  Editor,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type EditorOptions,
  type EditorTheme,
  type TUI,
} from "#pi-tui"
import type { CcActionDefinition, CcContext } from "./actions.ts"
import { graphemes } from "./boundaries.ts"
import { CcKeymap, createCcKeymap, type CcKeymapConfig } from "./keymap.ts"
import { BracketedPasteFilter, type PasteToken } from "./paste.ts"
import { assertCcEditorSeam, type CcEditorSnapshot } from "./pi-tui-seam-types.ts"
import { installPiTuiSeam } from "./pi-tui-seam.js"

// App-specific entry points on the vendored TUI. This is not a Pi provider or
// Agent feature; it replaces the former pnpm patch to Editor/SelectList.
installPiTuiSeam()
import type { CcDraftSnapshot } from "./snapshot.ts"
import type { PromptContentPart } from "../backend/types.ts"
import type { ImageUploadPart } from "../ui/image-view.ts"
import {
  asCcFileUpload,
  type CcFileAttachment,
  type CcFilePromptPart,
  type CcFileUpload,
} from "./file-attachment.ts"

/** Event forwarded to the app for actions the editor does not implement. */
export interface CcActionEvent {
  /** Action id, e.g. `app.history.search`. */
  id: string
  /** Raw terminal data that triggered the action. */
  key: string
  context: CcContext
  /** Current draft with large-paste markers (what `onSubmit` will receive, expanded). */
  text: string
  /** Draft with large-paste markers expanded. */
  expandedText: string
  /** True when the whole draft is empty. */
  empty: boolean
  cursor: { line: number; col: number }
  isBrowsingHistory: boolean
  definition?: CcActionDefinition
}

/**
 * In-memory prompt-attachment budgets.
 *
 * One budget covers both families (image uploads measured by encoded base64
 * length, file parts by their serialized size) because both live in the same
 * memory-only editor registry. The option name is retained for compatibility
 * with existing hosts/tests; it is not an image-only budget any more.
 */
export interface CcImageBudgets {
  /** Hard cap for payloads a draft may reference; further inserts are refused. */
  readonly liveBytes: number
  /** Spare (unreferenced) payloads kept for undo/kill-yank after a delete. */
  readonly sparePayloads: number
  /** Cap for the in-session prompt-history payload registry. */
  readonly historyBytes: number
}

const DEFAULT_IMAGE_BUDGETS: CcImageBudgets = {
  liveBytes: 64 * 1024 * 1024,
  sparePayloads: 12,
  historyBytes: 96 * 1024 * 1024,
}

/** History payload registry is bounded by the prompt-history length as well. */
const MAX_HISTORY_ATTACHMENT_ENTRIES = 100

/**
 * Accessors for one attachment family's live/history registries.
 *
 * Images and files keep separate ids, registries and payloads; only the
 * budget/protection algorithm is shared so the two can never drift apart.
 */
interface AttachmentFamily {
  readonly kind: "image" | "file"
  entries(): Array<[number, unknown]>
  setEntries(entries: Array<[number, unknown]>): void
  reservedIds(): number[]
  history(): Array<[string, Array<[number, unknown]>]>
  setHistory(entries: Array<[string, Array<[number, unknown]>]>): void
}

export interface CcEditorOptions extends EditorOptions {
  /** Keymap instance; defaults to a new CC keymap. */
  keymap?: CcKeymap
  /** Shorthand for `keymap: createCcKeymap({ bindings })`. */
  bindings?: CcKeymapConfig
  /** Keyboard chord timeout in milliseconds (CC default 3000). */
  chordTimeoutMs?: number
  /**
   * How long a fragmented bracketed-paste prefix may be held waiting for the
   * rest of the marker (default 50 ms). After it expires the held bytes are
   * dispatched as ordinary keys instead of swallowing the next keystroke.
   */
  pasteHoldTimeoutMs?: number
  /** Editor-side action context (default `"editor"`). */
  context?: CcContext
  /** Override the in-memory prompt-attachment budgets (tests, constrained hosts). */
  imageBudgets?: Partial<CcImageBudgets>
  /** Receives app-level actions; return true to report "handled". */
  onAction?: (event: CcActionEvent) => boolean | void
}

export interface CcExternalEditorRequest {
  snapshot: CcDraftSnapshot
  /** Full text with paste markers expanded, for the external editor. */
  text: string
  cursor: { line: number; col: number }
}

/** Actions that exist in the registry but are implemented by the app. */
const APP_FALLBACK_ACTIONS = new Set([
  "app.interrupt",
  "app.clear",
  "app.cancel",
  "app.exit",
  "app.redraw",
  "app.history.search",
  "app.stash",
  "app.editor.external",
  "app.tools.expand",
  "app.tools.details",
  "app.subagents.details",
  "subagent.reply",
  "subagent.interrupt",
  "app.todo",
  "app.thinking.toggle",
  "app.model.select",
  "app.mode.cycle",
  "app.clipboard.pasteImage",
  "app.suspend",
  "app.message.sendNow",
  "app.message.steer",
  "app.message.followUp",
  "app.help",
  "list.previous",
  "list.next",
  "list.page-up",
  "list.page-down",
  "list.first",
  "list.last",
  "list.select",
  "list.cancel",
  "list.select-digit",
  "dialog.confirm",
  "dialog.cancel",
  "dialog.details",
  "tool.details.next-section",
  "tool.details.previous-section",
  "tool.details.previous-tool",
  "tool.details.next-tool",
  "tool.details.copy",
  "historySearch.next",
  "historySearch.previous",
  "historySearch.accept",
  "historySearch.cancel",
])

/**
 * App actions that only make sense for the focused root prompt editor: they
 * stash/clear, paste into, submit, externally edit or search the single root
 * draft. A read-only surface has no editable draft behind it, so these fail
 * closed there instead of acting on hidden root state.
 *
 * Deliberately excluded: app.cancel/list.cancel/dialog.* keep their documented
 * local close behavior, an explicitly configured app.interrupt keeps its
 * read-only/modal priority, app.exit remains global (the App still applies its
 * empty-input exit policy), and app-level surfaces (redraw, help, todo, model
 * picker, detail overlays, suspend) remain available as global fallbacks. The
 * Agents surface actions `subagent.reply`/`subagent.interrupt` also remain
 * available to the overlay: they are app-implemented, the input layer only
 * emits the action, and the App owns the reply target and the native child
 * interrupt.
 */
const ROOT_EDITOR_APP_ACTIONS = new Set([
  // Pi-style Ctrl+C clears the *root* draft. A read-only surface must never
  // clear hidden root state, so the action fails closed there like stash/paste.
  "app.clear",
  "app.stash",
  "app.history.search",
  "app.editor.external",
  "app.clipboard.pasteImage",
  "app.message.sendNow",
  "app.message.steer",
  "app.message.followUp",
])

/**
 * Contexts backed by the one root prompt draft. `app.clear` is only meaningful
 * there; a picker, modal search field, history-search overlay or read-only
 * surface must not clear hidden root state when its own local cancel row is
 * disabled/remapped away. Installed Pi 1.5.1 CustomEditor handles Ctrl+C before
 * base autocomplete handling, so `autocomplete` is a root-clear context: the
 * whole draft clears and the stale menu closes naturally.
 * (Read-only surfaces are additionally covered by ROOT_EDITOR_APP_ACTIONS.)
 */
const ROOT_CLEAR_CONTEXTS: ReadonlySet<CcContext> = new Set<CcContext>([
  "editor",
  "autocomplete",
])

/** Same normalization Pi applies in `setText` (used for a true no-op check). */
function normalizeDraftText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ")
}

/**
 * Decode raw terminal data as printable text for a text field, or undefined.
 *
 * Plain text chunks (including multi-grapheme reads, spaces and non-ASCII) and
 * plain/shift Kitty CSI-u input are text. Control bytes (ESC sequences, C0,
 * DEL) and Ctrl/Alt-modified keys are not, so modifiers, chords, kill/yank,
 * undo and global actions keep their keymap meaning.
 */
export function printableInput(data: string): string | undefined {
  if (!data) return undefined
  const kitty = decodeKittyPrintable(data)
  if (kitty !== undefined && kitty.charCodeAt(0) >= 32 && kitty.charCodeAt(0) !== 0x7f) return kitty
  const first = data.charCodeAt(0)
  if (first >= 32 && first !== 0x7f) return data
  return undefined
}

/**
 * Split one terminal read into a jump target and any following printable text.
 * Only a real character (one grapheme) may become a jump target; control keys
 * and escape sequences are reported as no target so the caller can cancel the
 * jump and route the key through the shared CcKeymap.
 */
function splitJumpTarget(data: string): { target?: string; rest?: string } {
  if (!data) return {}
  const kitty = decodeKittyPrintable(data)
  if (kitty !== undefined && kitty.charCodeAt(0) >= 32 && kitty.charCodeAt(0) !== 0x7f) {
    return { target: kitty }
  }
  // C0 controls and DEL are not characters. DEL (\x7f) is Backspace on
  // legacy terminals and must cancel the jump so the CC deletion binding runs.
  if (data.charCodeAt(0) < 32 || data.charCodeAt(0) === 0x7f) return {}
  const first = graphemes(data)[0]
  if (!first) return {}
  const rest = data.slice(first.segment.length)
  return { target: first.segment, rest: rest.length > 0 ? rest : undefined }
}

// --- prompt attachments (images and files) -------------------------------

/**
 * Global marker regex for both attachment families.
 *
 * The family is part of the marker text, so `[Image #1]` and `[File #1]` are
 * different occurrences with independent ids. Every occurrence is one slot in
 * the ordered prompt content.
 */
const ATTACHMENT_MARKER_GLOBAL = /\[(Image|File) #(\d+)\]/g

/** One attachment marker occurrence in draft order. */
interface AttachmentMarker {
  readonly kind: "image" | "file"
  readonly id: number
  readonly start: number
  readonly end: number
}

/** Ordered marker occurrences of both families, image and file interleaved. */
function findAttachmentMarkers(text: string): AttachmentMarker[] {
  const markers: AttachmentMarker[] = []
  for (const match of text.matchAll(ATTACHMENT_MARKER_GLOBAL)) {
    const start = match.index ?? 0
    markers.push({
      kind: match[1] === "File" ? "file" : "image",
      id: Number.parseInt(match[2]!, 10),
      start,
      end: start + match[0].length,
    })
  }
  return markers
}

/** Base64 length is a stable, cheap proxy for encoded payload bytes. */
function imagePayloadBytes(image: ImageUploadPart): number {
  return typeof image.data === "string" ? image.data.length : 0
}

/**
 * Encoded size of one attachment payload.
 *
 * Images measure their base64 `data` (unchanged from the previous budget pass).
 * A file payload keeps its native part (metadata only), so its serialized size
 * is measured instead; it never contains a byte stream unless the parent put one
 * in the part, and even then the measurement is of what this layer holds.
 */
function attachmentPayloadBytes(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) return 0
  const data = (payload as { data?: unknown }).data
  if (typeof data === "string") return data.length
  try {
    return JSON.stringify(payload)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * Split draft text around attachment markers of both families.
 *
 * `segments[i]` is the exact text before marker `i`, and
 * `segments[markers.length]` is the exact text after the last marker: whitespace, indentation, CJK/emoji
 * text and newlines around a marker are the user's content and are preserved
 * verbatim. Only the marker itself is removed (it becomes an attachment part),
 * so concatenating the segments reproduces the input minus markers, character
 * for character. The only trimming happens once, at the submit boundary.
 */
function splitAttachmentMarkers(text: string): { segments: string[]; markers: AttachmentMarker[] } {
  const markers = findAttachmentMarkers(text)
  const segments: string[] = []
  let cursor = 0
  for (const marker of markers) {
    segments.push(text.slice(cursor, marker.start))
    cursor = marker.end
  }
  segments.push(text.slice(cursor))
  return { segments, markers }
}

/** One image marker occurrence backed by a live upload. */
export interface CcImageAttachment {
  /** `[Image #N]` marker id. Stable for the life of the editor and never reused. */
  readonly id: number
  readonly image: ImageUploadPart
}

/** One attachment occurrence in draft order, mixed families. */
export type CcAttachmentOccurrence =
  | { readonly kind: "image"; readonly id: number; readonly image: ImageUploadPart }
  | { readonly kind: "file"; readonly id: number; readonly file: CcFileAttachment }

/** Attachment occurrences per family, for prompt counts/preview. */
export interface CcAttachmentCounts {
  readonly images: number
  readonly files: number
}

/**
 * Pre-submit payload handed to `CcEditor.onSubmitContent`.
 *
 * The draft has already been cleared when this is delivered, which is why the
 * text, content and snapshot are captured before the clear.
 */
export interface CcSubmitPayload {
  /** Draft text as displayed: visible attachment markers kept, large pastes expanded. */
  readonly text: string
  /**
   * Ordered native prompt parts; each image/file marker replaces its own marker
   * in place (mixed families keep their text order).
   */
  readonly content: readonly PromptContentPart[]
  /** Full pre-submit draft state. Memory only: it may contain encoded image uploads. */
  readonly snapshot: CcDraftSnapshot
  /** Image occurrences referenced by the draft, in text order. */
  readonly images: readonly CcImageAttachment[]
  /** File occurrences referenced by the draft, in text order (never images). */
  readonly files: readonly CcFileAttachment[]
  /** True when the draft was recalled from prompt history when it was submitted. */
  readonly wasBrowsingHistory: boolean
}

/** A draft marker without an upload (e.g. text restored from `history.json`). */
export class CcUnresolvedImageMarkerError extends Error {
  readonly markerIds: number[]
  constructor(markerIds: readonly number[]) {
    super(
      `Draft references image markers without image data (${markerIds.map((id) => `[Image #${id}]`).join(", ")}). ` +
        "Remove the markers or attach the image again; this draft cannot be sent as text only.",
    )
    this.name = "CcUnresolvedImageMarkerError"
    this.markerIds = [...markerIds]
  }
}

/**
 * A `[File #N]` marker without a native file attachment.
 *
 * Only genuinely absent native refs can reach this: a durable `FileBlock` ref is
 * already admissible, so a hand-typed `[File #9]` or persisted `history.json`
 * text is the remaining source. Such a draft is never sent as text only.
 */
export class CcUnresolvedFileAttachmentError extends Error {
  readonly markerIds: number[]
  constructor(markerIds: readonly number[]) {
    super(
      `Draft references file markers without a native file attachment (${markerIds.map((id) => `[File #${id}]`).join(", ")}). ` +
        "Remove the markers or attach the file again; this draft cannot be sent as text only.",
    )
    this.name = "CcUnresolvedFileAttachmentError"
    this.markerIds = [...markerIds]
  }
}

/** The in-memory image budget would be exceeded by this attachment. */
export class CcImageBudgetError extends Error {
  readonly bytes: number
  readonly limit: number
  constructor(bytes: number, limit: number) {
    super(
      `Image attachment budget exceeded: ${Math.round(bytes / 1024)} KB of encoded images ` +
        `(limit ${Math.round(limit / 1024)} KB). Remove an image before attaching another one.`,
    )
    this.name = "CcImageBudgetError"
    this.bytes = bytes
    this.limit = limit
  }
}

/** The in-memory attachment budget would be exceeded by this file attachment. */
export class CcFileBudgetError extends Error {
  readonly bytes: number
  readonly limit: number
  constructor(bytes: number, limit: number) {
    super(
      `File attachment budget exceeded: ${Math.round(bytes / 1024)} KB of prompt attachments ` +
        `(limit ${Math.round(limit / 1024)} KB). Remove an attachment before adding another one.`,
    )
    this.name = "CcFileBudgetError"
    this.bytes = bytes
    this.limit = limit
  }
}

export class CcEditor extends Editor {
  /** App-level action sink. Set after construction or via options.onAction. */
  onAction?: (event: CcActionEvent) => boolean | void
  /** Called whenever a chord prefix is opened/closed (for a key hint UI). */
  onChordChange?: (prefix: string[] | null) => void
  /**
   * Content-aware submit sink. When set, every submit path (Enter, backslash
   * Enter, `ccSubmit`, autocomplete confirm) delivers the pre-clear payload here
   * instead of Pi's text-only `onSubmit`.
   */
  onSubmitContent?: (payload: CcSubmitPayload) => void
  /**
   * Called instead of submitting when the draft must not be sent: unresolved
   * image markers, or images without a content consumer. The draft is kept.
   */
  onSubmitBlocked?: (error: Error) => void

  private keymapInstance: CcKeymap
  private readonly imageBudgets: CcImageBudgets
  private readonly pasteFilter: BracketedPasteFilter
  private actionContext: CcContext
  private chordTimer: ReturnType<typeof setTimeout> | undefined
  private detachChordListener: (() => void) | undefined
  private disposed = false
  /** Generation of the keymap pending chord this editor opened, if any. */
  private ownedChordGeneration: number | null = null
  /** Payload captured immediately before the active submit clears the draft. */
  private pendingSubmit: CcSubmitPayload | undefined
  /**
   * Memoized `measureRows` answer: the row count together with the exact state
   * fingerprint (`ccRenderSignature`) it was computed from. One entry only —
   * the dock measures the current frame, and a stale width is not worth keeping.
   */
  private rowMeasure: { readonly signature: string; readonly rows: number } | undefined

  constructor(tui: TUI, theme: EditorTheme, options: CcEditorOptions = {}) {
    super(tui, theme, options)
    assertCcEditorSeam(Editor)
    this.keymapInstance =
      options.keymap ??
      createCcKeymap({
        bindings: options.bindings,
        chordTimeoutMs: options.chordTimeoutMs,
      })
    this.actionContext = options.context ?? "editor"
    this.imageBudgets = { ...DEFAULT_IMAGE_BUDGETS, ...options.imageBudgets }
    this.pasteFilter = new BracketedPasteFilter({
      holdTimeoutMs: options.pasteHoldTimeoutMs,
      onHoldTimeout: (data) => {
        // The held prefix was not a fragmented paste marker: release it through the
        // normal key path so it cannot swallow the next keystroke.
        if (this.disposed) return
        this.dispatchKeys(data)
        this.requestRender()
      },
    })
    this.onAction = options.onAction
    this.installFocusHook()
    this.installSubmitHook()
    this.attachChordListener()
  }

  /**
   * A focus change is an input boundary: a chord begun in one focus owner must
   * not complete after focus moved elsewhere. Pi's TUI assigns `focused`
   * directly, so this instance accessor is the narrow hook that lets the
   * editor cancel its own pending chord.
   */
  private installFocusHook(): void {
    let focused = false
    try {
      Object.defineProperty(this, "focused", {
        configurable: true,
        enumerable: true,
        get: () => focused,
        set: (value: boolean) => {
          const next = value === true
          if (!next) this.cancelChord()
          focused = next
        },
      })
    } catch {
      // Keep Pi's own `focused` field if a future version makes it read-only.
    }
  }

  /**
   * Route every Pi submit path through the content capture.
   *
   * Pi's `submitValue` clears the draft and only then calls `onSubmit(text)`, so
   * a payload captured at that point would be empty. The instance accessor lets
   * `CcEditor` keep the app's handler while it captures the pre-clear state in
   * `submitNow()`; without `onSubmitContent` the legacy text callback is used
   * unchanged (same arguments, same ordering).
   */
  private installSubmitHook(): void {
    let appHandler: ((text: string) => void) | undefined
    try {
      Object.defineProperty(this, "onSubmit", {
        configurable: true,
        enumerable: true,
        get: () => (text: string) => this.deliverSubmit(text, appHandler),
        set: (handler: ((text: string) => void) | undefined) => {
          appHandler = handler ?? undefined
        },
      })
    } catch {
      // Keep Pi's own field if a future version makes it non-configurable; the
      // content API then reports a blocked submit instead of silently losing it.
    }
  }

  /**
   * Keep the history payload registry bounded: recording an entry also triggers
   * the budget pass, so a long image history cannot grow without limit.
   */
  override addToHistory(text: string): void {
    super.addToHistory(text)
    this.reclaimAttachmentMemory()
  }

  /**
   * Deliver one submit to the consumer that can carry it.
   *
   * A captured payload goes to `onSubmitContent` whenever that consumer exists
   * (images **or** files), so the plain text callback can never receive draft
   * marker text. Only a draft with no attachments and no content consumer keeps
   * the legacy `onSubmit(text)` behaviour.
   */
  private deliverSubmit(text: string, appHandler?: (text: string) => void): void {
    if (this.disposed) {
      this.pendingSubmit = undefined
      return
    }
    const payload = this.pendingSubmit
    this.pendingSubmit = undefined
    if (payload !== undefined && this.onSubmitContent) {
      this.onSubmitContent(payload)
      return
    }
    appHandler?.(text)
  }

  /**
   * Submit the current draft through the single capture path.
   *
   * The App calls `ccSubmit()` directly for send-now / steer / follow-up / queue
   * delivery, which bypasses the Enter/backslash/autocomplete paths. Without
   * this override those calls reach Pi's `submitValue()` with no captured
   * payload, so a draft holding `[File #N]`/`[Image #N]` markers was handed to
   * the plain `onSubmit(text)` consumer as literal marker text instead of the
   * multipart `onSubmitContent(payload)`. Routing here makes every submit entry
   * point identical: attachments always go to the content consumer when it
   * exists, unresolved/typed markers block instead of sending text, and a
   * text-only draft keeps its existing callback behaviour.
   *
   * `pendingSubmit` is set exactly while a capture is in flight, so an inner
   * call from a handler (`onSubmitContent` re-entering) is not captured twice.
   */
  override ccSubmit(): void {
    if (this.pendingSubmit !== undefined) {
      super.ccSubmit()
      return
    }
    this.submitNow(() => super.ccSubmit())
  }

  /** Capture the payload, then run a Pi submit path; block instead of clearing. */
  private submitNow(run: () => void): void {
    if (this.disableSubmit || this.disposed) return
    let payload: CcSubmitPayload
    try {
      payload = this.captureSubmitPayload()
    } catch (error) {
      this.pendingSubmit = undefined
      this.onSubmitBlocked?.(error instanceof Error ? error : new Error(String(error)))
      return
    }
    // Image/file attachments require a content consumer: a text-only handler
    // would drop them and silently degrade the prompt, so the draft stays in the
    // editor instead.
    if ((payload.images.length > 0 || payload.files.length > 0) && !this.onSubmitContent) {
      this.pendingSubmit = undefined
      this.onSubmitBlocked?.(
        new Error(
          "This draft contains prompt attachments but no prompt-content consumer is configured; " +
            "the draft was kept instead of sending them as text only.",
        ),
      )
      return
    }
    this.pendingSubmit = payload
    try {
      run()
    } finally {
      this.pendingSubmit = undefined
    }
  }

  // --- prompt attachments (images and files) -----------------------------

  /**
   * The two attachment families share budget/protection semantics but never
   * share ids, registries or payloads. These accessors keep one budget
   * implementation instead of two divergent copies.
   */
  private imageFamily(): AttachmentFamily {
    return {
      kind: "image",
      entries: () => this.getImageAttachmentEntries(),
      setEntries: (entries) => this.setImageAttachmentEntries(entries),
      reservedIds: () => this.getReservedImageMarkerIds(),
      history: () => this.getHistoryImageAttachmentEntries(),
      setHistory: (entries) => this.setHistoryImageAttachmentEntries(entries),
    }
  }

  private fileFamily(): AttachmentFamily {
    return {
      kind: "file",
      entries: () => this.getFileAttachmentEntries(),
      setEntries: (entries) => this.setFileAttachmentEntries(entries),
      reservedIds: () => this.getReservedFileMarkerIds(),
      history: () => this.getHistoryFileAttachmentEntries(),
      setHistory: (entries) => this.setHistoryFileAttachmentEntries(entries),
    }
  }

  /**
   * Insert one clipboard image as an atomic `[Image #N]` marker.
   *
   * The upload is held in memory only. Marker ids are monotonic and never
   * reused, so a marker always resolves to the same image across undo, kill,
   * yank, stash restore and in-session history recall. Throws
   * `CcImageBudgetError` when the hard in-memory attachment budget is exhausted.
   */
  insertImage(image: ImageUploadPart): number {
    // Hand-typed or restored `[Image #N]` text carries no payload. Reserve its id
    // before allocating, so this new upload can never silently resolve a marker it
    // did not come from (the typed marker stays unresolved and blocks the send).
    // Symmetric with `insertFile`.
    this.noteImageMarkerIds(this.getText())
    this.reclaimAttachmentMemory()
    const bytes = imagePayloadBytes(image)
    const protectedBytes = this.protectedAttachmentBytes(this.imageFamily())
    if (protectedBytes + bytes > this.imageBudgets.liveBytes) {
      throw new CcImageBudgetError(protectedBytes + bytes, this.imageBudgets.liveBytes)
    }
    const id = this.insertImageAttachment(image)
    this.reclaimAttachmentMemory()
    this.requestRender()
    return id
  }

  /**
   * Insert one native file attachment as an atomic `[File #N]` marker.
   *
   * `upload` is either `{ part }` or the bare shared `PromptContentPart.file`
   * part produced from a durable native ref (`Backend.stageFile`, or a durable
   * `FileBlock` ref recalled from the native queue — already admissible, so no
   * byte read is needed). Marker ids are monotonic, never reused and separate
   * from image ids; a file marker can never resolve to an image payload.
   *
   * Throws before touching the draft when the payload is malformed or the
   * in-memory attachment budget is exhausted.
   */
  insertFile(upload: CcFileUpload | CcFilePromptPart): number {
    const normalized = asCcFileUpload(upload)
    // Hand-typed or restored `[File #N]` text carries no payload. Reserve its id
    // before allocating, so this new attachment can never silently resolve a
    // marker it did not come from (the marker stays unresolved and blocks the
    // send until the user removes it or attaches that file explicitly).
    this.noteFileMarkerIds(this.getText())
    this.reclaimAttachmentMemory()
    const bytes = attachmentPayloadBytes(normalized)
    const protectedBytes = this.protectedAttachmentBytes(this.fileFamily())
    if (protectedBytes + bytes > this.imageBudgets.liveBytes) {
      throw new CcFileBudgetError(protectedBytes + bytes, this.imageBudgets.liveBytes)
    }
    const id = this.insertFileAttachment(normalized)
    this.reclaimAttachmentMemory()
    this.requestRender()
    return id
  }

  /** Explicit alias of `insertFile` (parent-facing name). */
  addFile(upload: CcFileUpload | CcFilePromptPart): number {
    return this.insertFile(upload)
  }

  /**
   * Marker ids that side data must not be reclaimed for: everything the native
   * editor can still bring back (current draft, every real undo entry, kill
   * ring, pre-browsing draft) plus the in-session history payload registry,
   * which has its own budget.
   */
  private protectedMarkerIds(family: AttachmentFamily): Set<number> {
    const ids = new Set<number>(family.reservedIds())
    for (const [text, payloads] of family.history()) {
      void text
      for (const [id] of payloads) ids.add(id)
    }
    return ids
  }

  private protectedAttachmentBytes(family: AttachmentFamily): number {
    const protectedIds = this.protectedMarkerIds(family)
    let total = 0
    for (const [id, payload] of family.entries()) {
      if (protectedIds.has(id)) total += attachmentPayloadBytes(payload)
    }
    return total
  }

  /**
   * Ordered attachment occurrences of both families in `text` order.
   * Only markers backed by a real payload are listed; hand-typed or persisted
   * markers without one are never upgraded into attachments.
   */
  private attachmentOccurrences(text: string): CcAttachmentOccurrence[] {
    const occurrences: CcAttachmentOccurrence[] = []
    for (const marker of findAttachmentMarkers(text)) {
      if (marker.kind === "image") {
        const image = this.getImageAttachment(marker.id)
        if (image === undefined) continue
        occurrences.push({ kind: "image", id: marker.id, image: image as ImageUploadPart })
        continue
      }
      const payload = this.getFileAttachment(marker.id)
      if (payload === undefined) continue
      const upload = asCcFileUpload(payload)
      occurrences.push({
        kind: "file",
        id: marker.id,
        file: { id: marker.id, part: upload.part, attachment: upload.part.attachment },
      })
    }
    return occurrences
  }

  /** Image occurrences referenced by the current draft, in text order. */
  getImageAttachments(): CcImageAttachment[] {
    const occurrences: CcImageAttachment[] = []
    for (const occurrence of this.attachmentOccurrences(this.getText())) {
      if (occurrence.kind === "image") occurrences.push({ id: occurrence.id, image: occurrence.image })
    }
    return occurrences
  }

  /** File occurrences referenced by the current draft, in text order. */
  getFileAttachments(): CcFileAttachment[] {
    const occurrences: CcFileAttachment[] = []
    for (const occurrence of this.attachmentOccurrences(this.getText())) {
      if (occurrence.kind === "file") occurrences.push(occurrence.file)
    }
    return occurrences
  }

  /** True when the draft references at least one real image upload. */
  hasImageAttachments(): boolean {
    return this.getImageAttachments().length > 0
  }

  /** True when the draft references at least one real file attachment. */
  hasFileAttachments(): boolean {
    return this.getFileAttachments().length > 0
  }

  /** Mixed attachment occurrences in draft order (image and file interleaved). */
  getAttachmentOccurrences(): CcAttachmentOccurrence[] {
    return this.attachmentOccurrences(this.getText())
  }

  /** Prompt counts per family, for the dock/preview line. Data only, no rendering. */
  getAttachmentCounts(): CcAttachmentCounts {
    let images = 0
    let files = 0
    for (const occurrence of this.getAttachmentOccurrences()) {
      if (occurrence.kind === "image") images += 1
      else files += 1
    }
    return { images, files }
  }

  /**
   * Ordered native prompt parts for the current draft.
   *
   * Image and file markers each become their own part in place; marker text is
   * never sent to the model. Throws `CcUnresolvedImageMarkerError` /
   * `CcUnresolvedFileAttachmentError` when the draft contains a marker without a
   * payload, so a restored or hand-edited draft can never be sent as text only.
   */
  getPromptContent(): PromptContentPart[] {
    return this.buildPromptContent(this.getExpandedText())
  }

  /**
   * Capture everything a submit needs before Pi clears the draft.
   * Throws `CcUnresolvedImageMarkerError` / `CcUnresolvedFileAttachmentError` for
   * markers without a payload.
   */
  captureSubmitPayload(): CcSubmitPayload {
    const snapshot = this.captureDraft()
    const expanded = this.getExpandedText()
    // Trim exactly once, at the submit boundary, and derive `content` from that
    // same trimmed text: the ordered parts must describe the submitted `text`,
    // not a differently-padded draft. A whitespace-only draft submits `text: ""`
    // with an empty text part, never text that disagrees with its content.
    const text = expanded.trim()
    const content = this.buildPromptContent(text)
    const images: CcImageAttachment[] = []
    const files: CcFileAttachment[] = []
    for (const occurrence of this.attachmentOccurrences(expanded)) {
      if (occurrence.kind === "image") images.push({ id: occurrence.id, image: occurrence.image })
      else files.push(occurrence.file)
    }
    return {
      text,
      content,
      snapshot,
      images,
      files,
      wasBrowsingHistory: snapshot.historyIndex > -1,
    }
  }

  private buildPromptContent(expanded: string): PromptContentPart[] {
    const { segments, markers } = splitAttachmentMarkers(expanded)
    // Unresolved markers are reported before anything is built. Image checks keep
    // their existing error/order first, then files, so a mixed draft reports
    // deterministically and existing image behaviour is unchanged.
    const unresolvedImages = [
      ...new Set(
        markers
          .filter((marker) => marker.kind === "image" && this.getImageAttachment(marker.id) === undefined)
          .map((marker) => marker.id),
      ),
    ]
    if (unresolvedImages.length > 0) throw new CcUnresolvedImageMarkerError(unresolvedImages)
    const unresolvedFiles = [
      ...new Set(
        markers
          .filter((marker) => marker.kind === "file" && this.getFileAttachment(marker.id) === undefined)
          .map((marker) => marker.id),
      ),
    ]
    if (unresolvedFiles.length > 0) throw new CcUnresolvedFileAttachmentError(unresolvedFiles)
    const content: PromptContentPart[] = []
    for (const [index, marker] of markers.entries()) {
      const segment = segments[index] ?? ""
      if (segment.length > 0) content.push({ type: "text", text: segment })
      if (marker.kind === "image") {
        const image = this.getImageAttachment(marker.id) as ImageUploadPart
        // Every visible marker keeps its own position. Repeating one upload is the
        // caller's intent; DSH's content-addressed store de-duplicates bytes, and
        // the input layer never rewrites an ordered prompt.
        content.push({
          type: "image",
          mediaType: image.mediaType,
          data: image.data,
          ...(image.name ? { name: image.name } : {}),
        })
        continue
      }
      // A file part carries the durable native ref the parent staged or recalled;
      // it is passed through verbatim (same object identity is not assumed).
      const file = asCcFileUpload(this.getFileAttachment(marker.id))
      content.push({ type: "file", attachment: file.part.attachment })
    }
    const tail = segments[markers.length] ?? ""
    if (tail.length > 0) content.push({ type: "text", text: tail })
    if (content.length === 0) content.push({ type: "text", text: "" })
    return content
  }

  /**
   * Reclaim attachment payloads that nothing references any more, per family.
   *
   * Live entries referenced by the draft are always kept (they may still be
   * needed for undo, kill/yank, a stash restore or the next submit). Unreferenced
   * entries are kept newest-first up to the spare budget, so repeated
   * attach/delete cycles cannot grow the registry without bound. The in-session
   * history registry is trimmed oldest-first to its own byte/entry budget.
   */
  private reclaimAttachmentMemory(): void {
    // Never drop a payload the native editor can still restore: a marker that is
    // reachable from the undo stack, kill ring or the pre-browsing draft must stay
    // resolvable, otherwise Ctrl+_/Ctrl+Y would turn a real attachment into an
    // unresolved marker. Reclaiming only ever touches payloads nothing can reach.
    this.reclaimFamily(this.imageFamily())
    this.reclaimFamily(this.fileFamily())
  }

  private reclaimFamily(family: AttachmentFamily): void {
    const referenced = this.protectedMarkerIds(family)
    const entries = family.entries()
    const kept: Array<[number, unknown]> = []
    for (const [id, payload] of entries) {
      if (referenced.has(id)) kept.push([id, payload])
    }
    const spareLimit = Math.max(0, Math.floor(this.imageBudgets.sparePayloads))
    let spare = kept.length >= spareLimit ? 0 : spareLimit - kept.length
    let spareBytes = this.imageBudgets.liveBytes
    for (let index = entries.length - 1; index >= 0 && spare > 0; index -= 1) {
      const [id, payload] = entries[index]!
      if (referenced.has(id)) continue
      const bytes = attachmentPayloadBytes(payload)
      if (bytes > spareBytes) continue
      kept.push([id, payload])
      spareBytes -= bytes
      spare -= 1
    }
    if (kept.length !== entries.length) family.setEntries(kept)

    const history = family.history()
    if (history.length === 0) return
    let total = 0
    const trimmed: Array<[string, Array<[number, unknown]>]> = []
    for (const [text, payloads] of history) {
      trimmed.push([text, payloads])
      total += payloads.reduce((sum, [, payload]) => sum + attachmentPayloadBytes(payload), 0)
    }
    let changed = false
    while (
      (total > this.imageBudgets.historyBytes || trimmed.length > MAX_HISTORY_ATTACHMENT_ENTRIES) &&
      trimmed.length > 0
    ) {
      const [text, payloads] = trimmed.shift()!
      total -= payloads.reduce((sum, [, payload]) => sum + attachmentPayloadBytes(payload), 0)
      void text
      changed = true
    }
    if (changed) family.setHistory(trimmed)
  }

  private attachChordListener(): void {
    this.detachChordListener = this.keymapInstance.onChordChange((prefix) => {
      this.onChordChange?.(prefix ? [...prefix] : null)
      this.requestRender()
    })
  }

  /** True for the /model picker browse and query contexts. */
  private isModelPickerContext(): boolean {
    return this.actionContext === "modelPickerList" || this.actionContext === "modelPickerSearch"
  }

  // --- configuration -----------------------------------------------------

  getKeymap(): CcKeymap {
    return this.keymapInstance
  }

  setKeymap(keymap: CcKeymap): void {
    this.cancelChord()
    this.detachChordListener?.()
    this.detachChordListener = undefined
    this.keymapInstance = keymap
    this.attachChordListener()
    this.requestRender()
  }

  /** Replace user bindings on the current keymap (hot reload). */
  setBindings(bindings: CcKeymapConfig): void {
    this.clearChordTimer()
    this.ownedChordGeneration = null
    this.keymapInstance.setBindings(bindings)
    this.requestRender()
  }

  /** Alias of `getContext()` kept for existing callers. */
  getActionContext(): CcContext {
    return this.getContext()
  }

  /** Current editor action context (`editor`, `modelPickerSearch`, ...). */
  getContext(): CcContext {
    return this.actionContext
  }

  /**
   * Switch this editor between action contexts (e.g. `modelPickerList` <->
   * `modelPickerSearch`) without touching Pi's single editor state: text,
   * cursor, undo stack, kill ring, history and paste registry all stay intact.
   *
   * A pending chord opened by this editor is cancelled because its candidates
   * were compiled for the previous context; a chord owned by another editor on
   * a shared keymap is left alone. Same-context calls are a no-op.
   */
  setContext(context: CcContext): void {
    if (context === this.actionContext) return
    if (this.ownsPendingChord()) this.cancelChord()
    this.actionContext = context
    this.requestRender()
  }

  /** Alias of `setContext()` kept for existing callers. */
  setActionContext(context: CcContext): void {
    this.setContext(context)
  }

  /**
   * Explicit cancellation: drop any pending chord on the shared keymap and
   * clear its hint. Use for focus/config-driven cancellation. Disposal is
   * ownership-aware instead (see `dispose()`), because a hidden editor must
   * not cancel a chord that belongs to the focused prompt.
   */
  cancelChord(): void {
    if (this.disposed) return
    this.clearChordTimer()
    this.ownedChordGeneration = null
    this.keymapInstance.cancelChord()
  }

  /** True when this editor opened the keymap's current pending chord. */
  private ownsPendingChord(): boolean {
    if (this.ownedChordGeneration === null) return false
    return this.keymapInstance.getPendingChordGeneration() === this.ownedChordGeneration
  }

  /**
   * Release this editor's input hooks. Idempotent.
   *
   * Call it when the owning surface is replaced or closed (App editor swap,
   * question/dialog closure). It always clears this editor's chord timer and
   * removes only this editor's listener from a shared keymap; other live
   * editors keep their listeners. It cancels the shared pending chord only
   * when this editor actually opened it (generation match), so disposing an
   * inactive/hidden editor does not perturb the focused prompt's chord. It
   * does not dispose the keymap or any Pi editor state.
   * `setKeymap(sameInstance)` is not a teardown: it re-attaches this editor.
   *
   * After disposal the editor is inert: late terminal input (a detached stdin
   * handler, a stale resize/focus callback) cannot edit text, cannot emit
   * `onAction`, and cannot submit. A host that unloads the TUI may still have
   * bytes in flight, so "disposed" must mean "no app-visible effect", not just
   * "detached from the keymap".
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearChordTimer()
    if (this.ownsPendingChord()) this.keymapInstance.cancelChord()
    this.ownedChordGeneration = null
    this.detachChordListener?.()
    this.detachChordListener = undefined
    this.pasteFilter.reset()
  }

  /**
   * True while a bracketed paste is partially received, or while a possible
   * paste-marker prefix is still held back waiting for the next chunk. Hosts use
   * this as their paste protection, so held bytes are visible instead of the
   * editor looking idle while input is pending.
   */
  isPasting(): boolean {
    return this.pasteFilter.isPasting || this.pasteFilter.isHolding
  }

  /** Flush bytes held back while waiting for a fragmented paste marker. */
  flushInputBuffer(): void {
    if (this.disposed) return
    this.dispatchTokens(this.pasteFilter.flush())
  }

  // --- drafts ------------------------------------------------------------

  /** Lossless, JSON-serializable capture of text, cursor, history, kill ring, undo and pastes. */
  captureDraft(): CcDraftSnapshot {
    return this.ccCaptureSnapshot()
  }

  /**
   * Restore a snapshot captured earlier (stash, history search cancel,
   * suspend/resume, pre-submit restore after a native rejection).
   *
   * File payloads are validated before they reach the live registry: a malformed
   * stash/queue receipt throws here instead of poisoning later submits. Image
   * payload handling is unchanged.
   */
  restoreDraft(snapshot: CcDraftSnapshot, options: { notify?: boolean } = {}): void {
    this.pasteFilter.reset()
    this.cancelChord()
    this.ccRestoreSnapshot(this.validateAttachmentSnapshot(snapshot), options)
    this.reclaimAttachmentMemory()
  }

  /** Normalize file payloads (never bytes, paths or store ids) in a snapshot. */
  private validateAttachmentSnapshot(snapshot: CcDraftSnapshot): CcDraftSnapshot {
    const entries = snapshot.fileAttachments ?? []
    if (entries.length === 0) return snapshot
    const normalized: Array<[number, CcFileUpload]> = entries.map(([id, upload]) => [id, asCcFileUpload(upload)])
    return { ...snapshot, fileAttachments: normalized }
  }

  /** Everything needed to round-trip a draft through an external editor. */
  captureDraftForExternalEditor(): CcExternalEditorRequest {
    return {
      snapshot: this.captureDraft(),
      text: this.getExpandedText(),
      cursor: this.getCursor(),
    }
  }

  /**
   * Apply text returned by an external editor. Unchanged text restores the
   * original snapshot (keeping cursor, undo, pastes); changed text becomes one
   * atomic undoable edit and large-paste markers are dropped, matching Pi's
   * `setText`.
   */
  applyExternalEdit(text: string, previous?: CcDraftSnapshot): void {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    if (previous && normalized === previous.expandedText) {
      this.restoreDraft(previous)
      return
    }
    this.replaceDraftText(normalized)
  }

  /**
   * Replace the whole draft with `text` as one undoable edit.
   *
   * Backs the app's cleared-draft recall / external-editor return path: the
   * previous text, cursor, undo stack and paste registry are pushed onto the
   * editor undo stack first, so Ctrl+_ restores the full pre-replacement state.
   * Large-paste markers inside the old draft are dropped (as with Pi's
   * `setText`), and the cursor lands at `options.cursor` or at the end.
   * Returns true when the text actually changed.
   *
   * A true no-op (same text) returns false *without* calling Pi's `setText`,
   * so the paste registry, undo stack, cursor and any held paste framing stay
   * intact. This is what keeps a large-paste marker from turning into bare
   * text when the app re-applies an unchanged draft.
   */
  replaceDraftText(text: string, options: { cursor?: { line: number; col: number } } = {}): boolean {
    const normalized = normalizeDraftText(text)
    if (this.getText() === normalized) return false
    this.pasteFilter.reset()
    this.cancelChord()
    this.setText(normalized)
    if (options.cursor) {
      this.ccSetCursor(options.cursor.line, options.cursor.col)
    }
    return true
  }

  /** Restore the pre-history-browsing draft (Esc while browsing). */
  restoreHistoryDraft(): boolean {
    if (!this.ccIsBrowsingHistory()) return false
    let guard = this.ccGetHistory().length + 2
    while (this.ccIsBrowsingHistory() && guard > 0) {
      this.ccHistoryNext()
      guard -= 1
    }
    return true
  }

  // --- input -------------------------------------------------------------

  override handleInput(data: string): void {
    if (this.disposed) return
    // Kitty CSI-u / xterm modifyOtherKeys releases are not presses. Pi's main
    // screen filters them before a component by default, but CcEditor may be
    // driven directly (hosts/tests); a release must never complete a chord or
    // emit a second action (e.g. the second Ctrl+C that would arm exit).
    // Fragmented bracketed paste is exempt: pasted bytes are content.
    if (!this.pasteFilter.isPasting && isKeyRelease(data)) return
    const tokens = this.pasteFilter.push(data)
    // A paste boundary invalidates any half-typed chord: pasted bytes and the
    // next keys after the paste must never complete the old chord.
    if (this.pasteFilter.isPasting) this.cancelChord()
    this.dispatchTokens(tokens)
  }

  private dispatchTokens(tokens: readonly PasteToken[]): void {
    for (const token of tokens) {
      if (token.kind === "paste") {
        this.cancelChord()
        // Read-only surfaces (tool/image details, Agents overlay): pasted
        // content is never inserted.
        if (this.isReadOnlySurface()) continue
        if (token.text.length > 0) {
          this.ccPaste(token.text)
          this.requestRender()
        }
      } else {
        this.dispatchKeys(token.data)
      }
    }
  }

  private dispatchKeys(data: string): void {
    if (!data) return
    let jumpMode = this.ccGetJumpMode()
    if (jumpMode !== null && this.isReadOnlySurface()) {
      // A read-only surface has no editable draft behind it. A jump left over
      // from the prompt must not let a printable byte move the hidden cursor:
      // cancel it, then route the key through the read-only keymap below.
      this.ccCancelJump()
      this.requestRender()
      jumpMode = null
    }
    if (jumpMode !== null) {
      const target = splitJumpTarget(data)
      if (target.target !== undefined) {
        // Only an actual character is the jump target; any following printable
        // text from the same terminal read is normal input.
        this.ccJumpToChar(target.target, jumpMode)
        this.requestRender()
        if (target.rest) this.dispatchKeys(target.rest)
        return
      }
      // Control keys cancel the jump and return to the shared CcKeymap, so CC
      // whitespace Ctrl+W and user remaps still apply (no Pi default leak).
      this.ccCancelJump()
      this.requestRender()
      // Pressing a jump key again cancels without immediately re-arming it.
      if (
        this.isActionBoundToKey("editor.jump.forward", data) ||
        this.isActionBoundToKey("editor.jump.backward", data)
      ) {
        return
      }
    }
    const context: CcContext = this.isShowingAutocomplete() ? "autocomplete" : this.actionContext
    // /model picker: the query is a text field, so with NO chord already in
    // flight a plain printable chunk is text. This intentionally wins over a
    // simple list/global binding *and* over starting a printable-prefixed
    // chord (e.g. a configured "j k"): letters are never lost in the query.
    // Paste reassembly (handleInput) and jump mode ran before this; pending
    // chords are resolved first below, so modifier chord completion, mismatch
    // and timeout semantics are unchanged. Other contexts are untouched.
    if (this.isModelPickerContext() && !this.keymapInstance.isPendingChord()) {
      const text = printableInput(data)
      if (text !== undefined) {
        this.ccInsertCharacter(text)
        return
      }
    }
    const resolution = this.keymapInstance.resolve(data, context)
    switch (resolution.kind) {
      case "pending":
        // The keymap reports the hint transition (single owner); only the
        // timeout timer belongs to the editor. Record the generation so a later
        // disposal can tell whether the pending chord is still ours.
        this.ownedChordGeneration = this.keymapInstance.getPendingChordGeneration()
        this.armChordTimer()
        return
      case "cancelled-chord":
        this.clearChordTimer()
        this.ownedChordGeneration = null
        if (resolution.passthrough.length > 0) {
          this.dispatchKeys(resolution.passthrough)
        }
        return
      case "action":
        this.clearChordTimer()
        this.ownedChordGeneration = null
        // A held/repeated Ctrl+C is still one physical press for exit policy:
        // Kitty flag 2 repeats of app.clear are consumed instead of arming a
        // second exit. Other repeats keep their normal action (navigation,
        // deletion) because holding those keys is expected terminal behaviour.
        // Legacy terminals cannot distinguish a repeat from a new press; that
        // limit is documented in docs/INPUT.md.
        if (resolution.action.id === "app.clear" && isKeyRepeat(data)) return
        this.runAction(resolution.action, data, context)
        // A completion menu goes stale as soon as a non-completion action edits
        // or moves the draft; close it rather than showing a wrong prefix.
        if (
          context === "autocomplete" &&
          !resolution.action.id.startsWith("autocomplete.") &&
          this.isShowingAutocomplete()
        ) {
          this.ccCancelAutocomplete()
        }
        return
      case "none":
        this.dispatchUnbound(data, context)
        return
    }
  }

  /**
   * Modal surfaces with no editable draft behind them (tool/image details, the
   * Agents overlay and the unified modal browse lists for Settings, keyboard
   * shortcuts, generic modal lists and the queue). Their text field is the
   * separate `modalSearch` context, which stays editable.
   */
  private isReadOnlyContext(context: CcContext = this.actionContext): boolean {
    return (
      context === "toolDetails" ||
      context === "imageDetails" ||
      context === "subagentList" ||
      context === "subagentSession" ||
      context === "settingsList" ||
      context === "keybindingsList" ||
      context === "modalList" ||
      context === "queueList"
    )
  }

  /**
   * True when this editor is hosted by a read-only surface. Anchored on the
   * configured surface context (not the effective completion overlay), so a
   * completion menu cannot turn a read-only Agents/details surface into an
   * editable one.
   */
  private isReadOnlySurface(): boolean {
    return this.isReadOnlyContext(this.actionContext)
  }

  private dispatchUnbound(data: string, context: CcContext): void {
    // Read-only surfaces (tool/image details, Agents overlay): an unbound byte,
    // including a printable character, is inert here. It must never fall
    // through to Pi's text insertion or depend on the app having switched
    // contexts. This is anchored on the surface context so a stale completion
    // overlay cannot reopen the hidden editor's text path.
    if (this.isReadOnlySurface()) return
    const printable = decodeKittyPrintable(data)
    if (printable !== undefined) {
      this.ccInsertCharacter(printable)
      return
    }
    if (data.charCodeAt(0) >= 32) {
      // Printable chunk (possibly several graphemes from one terminal read).
      this.ccInsertCharacter(data)
      return
    }
    // Unbound control byte: consume it. Never fall through to Pi defaults:
    // a disabled or remapped action must not silently resurrect Pi behaviour.
    void context
  }

  // --- action dispatch ---------------------------------------------------

  private runAction(action: CcActionDefinition, data: string, context: CcContext): void {
    // Root-only editor commands (movement, kill, undo, submit, completion, ...)
    // act on the single root prompt state. A read-only surface has no editable
    // draft, so these fail closed even if a custom registry, a completion
    // overlay or a fallback layer makes them resolvable there: the key is
    // consumed instead of mutating the hidden root editor. App actions
    // (app.cancel, list.cancel, an explicitly configured app.interrupt,
    // subagent.reply/interrupt, ...) still flow below.
    if (this.isReadOnlySurface() && action.implementor === "editor") return
    // Hidden-root boundary for the Pi-style clear action: only the root prompt
    // (or its completion/history overlay) owns the draft, so a picker/modal
    // search field never clears hidden state when its local cancel is disabled.
    if (action.id === "app.clear" && !ROOT_CLEAR_CONTEXTS.has(this.actionContext)) return
    // Same boundary for app actions that would act on the hidden root draft
    // (stash, paste, external editor, submit/steer/follow-up, history search,
    // exit). They remain resolvable in the keymap for diagnostics/Settings,
    // but a read-only surface consumes the key instead of emitting them.
    if (this.isReadOnlySurface() && ROOT_EDITOR_APP_ACTIONS.has(action.id)) return
    switch (action.id) {
      case "editor.move.char-left":
        this.ccMoveCursor(0, -1)
        return
      case "editor.move.char-right":
        this.ccMoveCursor(0, 1)
        return
      case "editor.move.line-start":
        this.ccMoveLineStart()
        return
      case "editor.move.line-end":
        this.ccMoveLineEnd()
        return
      case "editor.move.word-left":
        this.ccMoveWord(-1, "word")
        return
      case "editor.move.word-right":
        this.ccMoveWord(1, "word")
        return
      case "editor.move.line-up":
        this.moveVertical(-1)
        return
      case "editor.move.line-down":
        this.moveVertical(1)
        return
      case "editor.move.page-up":
        this.ccPageScroll(-1)
        return
      case "editor.move.page-down":
        this.ccPageScroll(1)
        return
      case "editor.history.previous":
        this.ccHistoryPrevious()
        return
      case "editor.history.next":
        this.ccHistoryNext()
        return
      case "editor.jump.forward":
        this.ccStartJump("forward")
        this.requestRender()
        return
      case "editor.jump.backward":
        this.ccStartJump("backward")
        this.requestRender()
        return
      case "editor.insert-space":
        this.ccInsertCharacter(" ")
        return
      case "editor.delete.char-backward":
        this.ccDeleteCharBackward()
        return
      case "editor.delete.char-forward":
        if (this.ccIsEmpty() && this.isActionBoundToKey("app.exit", data)) {
          this.emitAction("app.exit", data, context)
          return
        }
        // Empty draft + a Delete key that is not the exit binding is a no-op.
        this.ccDeleteCharForward()
        return
      case "editor.kill.whitespace-backward":
        this.ccKillWord(-1, "whitespace")
        return
      case "editor.kill.word-backward":
        this.ccKillWord(-1, "word")
        return
      case "editor.kill.word-forward":
        this.ccKillWord(1, "word")
        return
      case "editor.kill.whitespace-forward":
        this.ccKillWord(1, "whitespace")
        return
      case "editor.kill.line-start":
        this.ccKillToLineStart()
        return
      case "editor.kill.line-end":
        this.ccKillToLineEnd()
        return
      case "editor.yank":
        this.ccYank()
        return
      case "editor.yank-pop":
        this.ccYankPop()
        return
      case "editor.undo":
        this.ccUndo()
        return
      case "editor.transpose.chars":
        if (this.ccTransposeChars()) this.requestRender()
        return
      case "editor.newline":
        this.insertNewLineOrSubmitOnBackslash(data)
        return
      case "editor.submit":
        // In the picker, Enter confirms through list.select only. If that
        // action is disabled the key is inert instead of submitting/clearing
        // the query (no generic submit result for an inline answer row).
        if (this.isModelPickerContext()) return
        this.submitOrInsertNewLine(data)
        return
      case "editor.complete":
        // The picker only changes provider groups via the registered
        // model.provider.* actions. A disabled/remapped provider action must
        // not surface the generic completion fallback, which an inline answer
        // row would report as Tab.
        if (this.isModelPickerContext()) return
        if (this.ccHasAutocompleteProvider()) {
          this.ccTriggerCompletion()
          return
        }
        this.emitAction("editor.complete", data, context)
        return
      case "editor.cancel":
        if (this.isShowingAutocomplete()) {
          this.ccCancelAutocomplete()
          return
        }
        // Esc is contextual: a local history layer that restores the draft has
        // consumed the key. It must not also reach app.cancel/interrupt.
        if (this.restoreHistoryDraft()) return
        this.emitAction("app.cancel", data, context)
        return
      case "autocomplete.previous":
        this.ccAutocompleteStep(-1)
        return
      case "autocomplete.next":
        this.ccAutocompleteStep(1)
        return
      case "autocomplete.page-up":
        this.ccAutocompletePage(-1)
        return
      case "autocomplete.page-down":
        this.ccAutocompletePage(1)
        return
      case "autocomplete.accept":
        if (matchesKey(data, "enter")) {
          // Apply the highlighted candidate on this same Editor state first,
          // then capture the content-aware payload immediately before Pi clears
          // the draft. Capturing before the apply would submit the typed
          // prefix instead of the accepted slash/skill name.
          this.ccAutocompleteAccept("confirm", () => this.submitNow(() => this.ccSubmit()))
          return
        }
        this.ccAutocompleteAccept("tab")
        return
      case "autocomplete.cancel":
        this.ccCancelAutocomplete()
        return
      default:
        break
    }
    // app.exit is only valid on an empty draft. This guard is independent of
    // binding priority: disabling/rebinding forward-delete (so Ctrl+D falls
    // through to global app.exit) must not make a non-empty draft exit.
    if (action.id === "app.exit" && !this.ccIsEmpty()) return
    if (APP_FALLBACK_ACTIONS.has(action.id) || action.implementor === "app") {
      this.emitAction(action.id, data, context)
      return
    }
    // Unknown editor-side action from a custom registry: forward to the app
    // instead of silently dropping the key.
    this.emitAction(action.id, data, context)
  }

  /**
   * True when `data` is one of the enabled physical bindings of `actionId`.
   * Used for contextual app actions such as Ctrl+D (exit only when the key is
   * still bound to app.exit, so remapped/disabled exit genuinely disables it).
   */
  isActionBoundToKey(actionId: string, data: string): boolean {
    return this.keymapInstance
      .getBindings(actionId)
      .some((binding) => binding.split(" ").length === 1 && matchesKey(data, binding as Parameters<typeof matchesKey>[1]))
  }

  private emitAction(id: string, data: string, context: CcContext): boolean {
    // A disposed editor consumes app keys without acting on them: the key must
    // not fall through to a default edit, and the app must not see an action.
    if (this.disposed) return true
    const event: CcActionEvent = {
      id,
      key: data,
      context,
      text: this.getText(),
      expandedText: this.getExpandedText(),
      empty: this.ccIsEmpty(),
      cursor: this.getCursor(),
      isBrowsingHistory: this.ccIsBrowsingHistory(),
      definition: this.keymapInstance.getAction(id),
    }
    const handled = this.onAction?.(event)
    return handled === true
  }

  private moveVertical(direction: -1 | 1): void {
    if (direction < 0) {
      // CC: visual-line movement first; on the first visual line Up browses
      // history directly (no Pi "jump to column 0" step).
      if (this.ccIsOnFirstVisualLine()) {
        this.ccHistoryPrevious()
        return
      }
      this.ccMoveCursor(-1, 0)
      return
    }
    if (this.ccIsOnLastVisualLine()) {
      this.ccHistoryNext()
      return
    }
    this.ccMoveCursor(1, 0)
  }

  private insertNewLineOrSubmitOnBackslash(data: string): void {
    if (this.ccShouldSubmitOnBackslashEnter(data)) {
      this.ccDeleteCharBackward()
      this.submitNow(() => this.ccSubmit())
      return
    }
    this.ccInsertNewLine()
  }

  private submitOrInsertNewLine(data: string): void {
    if (this.disableSubmit) return
    const cursor = this.getCursor()
    const line = this.getLines()[cursor.line] ?? ""
    if (cursor.col > 0 && line[cursor.col - 1] === "\\") {
      this.ccDeleteCharBackward()
      this.ccInsertNewLine()
      return
    }
    this.submitNow(() => this.ccSubmit())
    void data
  }

  // --- measurement (no paint) --------------------------------------------

  /**
   * Rows this editor paints at `width`: exactly `render(width).length`.
   *
   * The status dock needs the editor's height *before* it lays the transcript
   * out, and `docs/FRONTEND-CONTRACT.md` forbids re-rendering a member to count
   * its rows. Measuring therefore asks the vendored Editor for its row geometry
   * (`ccRenderRows`) instead of painting:
   *
   * - **side-effect free**: no line is emitted, and `scrollOffset`, `lastWidth`,
   *   `renderedVisibleLineCount`/`renderedAutocompleteHeight`, the cursor, the
   *   undo stack and the completion menu are untouched. The scroll adjustment
   *   that `render` applies to itself is computed on a local copy, so a
   *   measurement never changes the frame that follows it (and repeated
   *   measurements are identical);
   * - **one layout implementation**: the seam reuses `layoutText` (word-aware
   *   `wordWrapLine` + marker-aware grapheme segmentation), the same padding
   *   math and the same `SelectList.render` the paint uses, so the row count
   *   cannot drift from a second wrap algorithm;
   * - **memoized**: the answer is cached under a fingerprint of every input the
   *   row count reads — width, `paddingX`, terminal rows (the visible-line
   *   cap), draft text, cursor line/column, scroll offset, the paste/image/file
   *   marker id sets (they change segmentation), and completion state (open /
   *   closed, candidate count, selection, visible cap). A repeat measurement of
   *   unchanged state costs a fingerprint compare and performs no layout.
   *
   * `width` is passed through unmodified, exactly like `render(width)`, so the
   * two agree for every width the parent may pass.
   */
  measureRows(width: number): number {
    const signature = this.ccRenderSignature(width)
    const cached = this.rowMeasure
    if (cached !== undefined && cached.signature === signature) return cached.rows
    const rows = this.ccRenderRows(width)
    this.rowMeasure = { signature, rows }
    return rows
  }

  // --- chord timer -------------------------------------------------------

  private armChordTimer(): void {
    this.clearChordTimer()
    this.chordTimer = setTimeout(() => {
      this.chordTimer = undefined
      // Only the editor that opened the current pending chord may expire it;
      // a stale timer from an inactive shared-keymap editor must not drop the
      // focused prompt's chord. The keymap reports hint cleanup.
      if (this.ownsPendingChord()) this.keymapInstance.expireChord()
      this.ownedChordGeneration = null
    }, Math.ceil(this.keymapInstance.getChordTimeoutMs()) + 1)
    // Round up and allow a 1ms clock-resolution margin: never drop a one-shot
    // timer while the keymap still considers the exact deadline pending.
    // Do not keep the process alive for a pending chord.
    this.chordTimer.unref?.()
  }

  private clearChordTimer(): void {
    if (this.chordTimer !== undefined) {
      clearTimeout(this.chordTimer)
      this.chordTimer = undefined
    }
  }

  /** Redraw hook shared by chord and paste state changes. */
  private requestRender(): void {
    try {
      this.tui.requestRender()
    } catch {
      // A detached editor (tests, teardown) must not throw on redraw.
    }
  }
}