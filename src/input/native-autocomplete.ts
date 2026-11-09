/**
 * Native DSH completion (thin combination layer).
 *
 * DSH skills are human-invocable as plain `/name`; there is no `/skill` wrapper
 * and no Pi `skill:name` / `skill:` alias. This provider only *combines*
 * metadata that the App already owns:
 *
 * - mounted native/UI commands (the same `SlashCommand` shape Pi accepts),
 * - read-only `SkillCatalogEntry` metadata fetched by the App,
 * - native `@file` mention candidates from DSH's public file-reference
 *   discovery seam, tokenized/formatted by DSH's public `@file` grammar,
 * - Pi's existing `CombinedAutocompleteProvider` for plain file paths, command
 *   argument completion, forced completion and the `@`-insertion/cursor rules.
 *
 * It is deliberately not a skill engine and not a file index: it never reads
 * skill files, expands skill bodies, invokes anything, scans the filesystem,
 * runs `fd`, or keeps a skill/file catalog of its own. Catalogs and candidates
 * are read through parent callbacks on every request.
 *
 * DSH's `@file` grammar (`@deepseek-ai/dsh-file-reference/grammar`) is loaded
 * lazily and cached: only a non-slash line containing `@` for which the App
 * configured `fileReferences` imports it. A slash menu, a plain path, an
 * argument or an `@`-free draft never touches that module, so the explicit
 * `--demo` entry (which runs without the native DSH peers installed) still
 * loads this provider. A failed load is cached as "unavailable" and treated as
 * an empty native candidate domain (silent `null`), never an unhandled
 * rejection and never a terminal diagnostic.
 *
 * Skill refresh is non-blocking: a slash-name query *starts* the optional
 * parent query (single-flight/dirty, catalog validity and scope ownership are
 * the parent's job) and returns the menu from the current getters immediately.
 * The provider never memoizes a query: every regular slash query may ask the
 * parent again once the previous call settles, so unavailable/error/scope
 * changes are retried by the next genuine user query. The parent re-triggers
 * Pi's own completion when metadata settles (`CcEditor` / seam
 * `ccRefreshAutocomplete()`), which re-reads the getters with no cached catalog.
 */

// Type-only: erased at build/run time, so the module graph does not depend on
// the native DSH package being installed. The runtime value is loaded lazily by
// `loadFileGrammar()` below, only for an actual native `@` query.
import type { ActiveAtToken } from "@deepseek-ai/dsh-file-reference/grammar"

import {
  CombinedAutocompleteProvider,
  fuzzyMatch,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from "#pi-tui"

import type { FileReferenceCandidate, SkillCatalogEntry } from "../backend/types.ts"

/** The public DSH `@file` grammar module (values only; types are erased above). */
type FileGrammar = typeof import("@deepseek-ai/dsh-file-reference/grammar")

/**
 * Cached lazy import of DSH's public `@file` grammar.
 *
 * Resolves to `undefined` (never rejects) when the module cannot be loaded, so a
 * provider without native DSH peers keeps working and an `@` query simply
 * contributes no rows. The promise itself is cached: one attempted load per
 * process, no per-keystroke `import()`. Tests and the `--demo` entry never pay
 * for it because they never reach an `@` query with a candidate source.
 */
let fileGrammarPromise: Promise<FileGrammar | undefined> | undefined

function loadFileGrammar(): Promise<FileGrammar | undefined> {
  if (fileGrammarPromise === undefined) {
    fileGrammarPromise = import("@deepseek-ai/dsh-file-reference/grammar").then(
      (module) =>
        typeof module.activeAtToken === "function" && typeof module.formatFileMention === "function"
          ? module
          : undefined,
      () => undefined,
    )
  }
  return fileGrammarPromise
}

/** Options for {@link NativeAutocompleteProvider}. */
export interface NativeAutocompleteProviderOptions {
  /** Current command roster; read on every request (never cached here). */
  commands: () => readonly NativeCommandEntry[]
  /** Current Agent-scoped skill metadata; read on every request. */
  skills: () => readonly SkillCatalogEntry[]
  /** Working directory for Pi's relative path completion. */
  basePath: string
  /**
   * Optional parent-owned skill metadata refresh. At most one call is in flight
   * at a time and it is never awaited; otherwise a regular slash query calls it
   * again (no query-string memo here, so failures and scope changes stay
   * retryable). Never called for file/`@`/argument/forced completion. The signal
   * is this provider's lifetime controller and aborts on `dispose()` (it is not
   * tied to a single keystroke, so the parent query is not aborted by edits).
   */
  refreshSkills?: (signal: AbortSignal) => Promise<void>
  /**
   * Optional native `@file` candidate source (DSH `fileReferences.list`).
   *
   * Called only when DSH's public `activeAtToken(line, cursorCol)` grammar finds
   * an `@path` / `@"path with spaces"` token ending at the cursor, with the
   * grammar's `query` (the text after `@` / `@"`) and Pi's per-request abort
   * signal. Candidates are mapped in the callback's own order; the provider
   * never scans, sorts, fuzzes or falls back to `fd`.
   *
   * Without this callback, `@` behaves exactly like Pi's own combined provider
   * (no local scan, no `fd`), and slash/argument/plain-path completion is
   * untouched. A rejection, an abort or a stale response yields no rows (the
   * menu closes silently) and never surfaces a diagnostic in the terminal.
   */
  fileReferences?: (query: string, signal: AbortSignal) => Promise<readonly FileReferenceCandidate[]>
}

const SKILL_LABEL = "Skill"
const USER_ONLY_SKILL_LABEL = "Skill (user-only)"

/**
 * One mounted command as the App exposes it: Pi's `SlashCommand` plus the
 * App-mapped native descriptor field `input.hint` (stored as `inputHint`, the
 * same field Help already renders). It is the existing roster shape, not a
 * second registry: `getArgumentCompletions` and `argumentHint` still come from
 * Pi's `SlashCommand`.
 */
export interface NativeCommandEntry extends SlashCommand {
  /** Native DSH command `input.hint`, forwarded by the App (read-only display). */
  inputHint?: string
}

/** Terminal escape sequences (CSI / OSC / two-byte) never reach the menu. */
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])/g
/** Remaining control characters and Unicode line separators are flattened. */
const CONTROL_PATTERN = /[\p{Cc}\u2028\u2029]/gu
const WHITESPACE_PATTERN = /\s+/gu
/** A DSH skill/command name must be invocable as `/name`. */
const INVALID_NAME_PATTERN = /[\s/\\]/u

interface MenuEntry {
  readonly name: string
  readonly description?: string
}

/** Public factory: the stable API surface for the App integration. */
export function createNativeAutocompleteProvider(
  options: NativeAutocompleteProviderOptions,
): NativeAutocompleteProvider {
  return new NativeAutocompleteProvider(options)
}

/**
 * Slash-name menu (commands + skill metadata) composed on Pi's autocomplete.
 *
 * Slash menu entries are native names, exactly as `/name`. A command and a
 * skill with the same name produce one entry with the command's description
 * (commands win). Candidate priority is Pi's editor match order, expressed in
 * the menu's name namespace: exact name first, then prefix matches, then
 * fuzzy-only matches. Ties keep the caller's roster order (commands in roster
 * order, then skills in catalog order), so the native roster remains the
 * stable menu order. Pi's `getBestAutocompleteMatchIndex` compares
 * `item.value` with the suggestion `prefix`, and this provider returns the
 * slash-including prefix (`/name`), so it can never select an exact entry
 * itself; ranking here is what chooses the default highlight. Skills carry a
 * `Skill` / `Skill (user-only)` description label; nothing is reformatted
 * into `skill:` aliases.
 */
export class NativeAutocompleteProvider implements AutocompleteProvider {
  private readonly commands: () => readonly NativeCommandEntry[]
  private readonly skills: () => readonly SkillCatalogEntry[]
  private readonly refreshSkills: ((signal: AbortSignal) => Promise<void>) | undefined
  private readonly fileReferences:
    | ((query: string, signal: AbortSignal) => Promise<readonly FileReferenceCandidate[]>)
    | undefined
  private readonly basePath: string
  private readonly applyDelegate: CombinedAutocompleteProvider
  /** Lifetime cancellation for parent refreshes; aborted only by `dispose()`. */
  private readonly lifetime = new AbortController()
  /** Settled-marker of the one in-flight parent call, if any. */
  private refreshFlight: Promise<void> | null = null
  private disposed = false

  constructor(options: NativeAutocompleteProviderOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("NativeAutocompleteProvider requires an options object")
    }
    if (typeof options.commands !== "function") {
      throw new TypeError("NativeAutocompleteProvider.commands must be a function")
    }
    if (typeof options.skills !== "function") {
      throw new TypeError("NativeAutocompleteProvider.skills must be a function")
    }
    if (typeof options.basePath !== "string") {
      throw new TypeError("NativeAutocompleteProvider.basePath must be a string")
    }
    if (options.refreshSkills !== undefined && typeof options.refreshSkills !== "function") {
      throw new TypeError("NativeAutocompleteProvider.refreshSkills must be a function")
    }
    if (options.fileReferences !== undefined && typeof options.fileReferences !== "function") {
      throw new TypeError("NativeAutocompleteProvider.fileReferences must be a function")
    }
    this.commands = options.commands
    this.skills = options.skills
    this.refreshSkills = options.refreshSkills
    this.fileReferences = options.fileReferences
    this.basePath = options.basePath
    // applyCompletion/shouldTriggerFileCompletion are command-roster independent.
    this.applyDelegate = new CombinedAutocompleteProvider([], options.basePath)
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? ""
    const textBeforeCursor = currentLine.slice(0, cursorCol)
    const slashPrefix = nativeSlashNamePrefix(textBeforeCursor, options.force === true)

    if (slashPrefix === null) {
      // Native `@file` mentions: DSH's public grammar decides whether the cursor
      // is inside an `@path` / `@"..."` token. With a parent candidate source
      // this context is answered natively (no scan, no `fd` fallback, never a
      // skill refresh); everything else still belongs to Pi.
      const native = await this.nativeFileMentionQuery(currentLine, textBeforeCursor, cursorCol, options.signal)
      if (native !== undefined) return native
      // Preserve Pi's path, argument and forced-completion semantics; those
      // contexts never start a skill metadata refresh.
      return await this.createDelegate().getSuggestions(lines, cursorLine, cursorCol, options)
    }

    // Parent single-flight/dirty decides whether this is a real fetch; the
    // provider only gates concurrent calls and never memoizes the query text.
    this.requestSkillRefresh()
    const items = this.menuItems(slashPrefix.slice(1))
    if (items.length === 0) return null
    return { items, prefix: slashPrefix }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    // Pi owns every insertion and cursor rule. Native `@file` mentions only add
    // the closing quote for a quoted directory (below), so a spacer path stays a
    // submittable mention while the cursor stops before the quote and can
    // descend further; the file/directory trailing-space and cursor arithmetic
    // itself stays exactly Pi's.
    if (prefix.startsWith("@")) {
      return this.applyDelegate.applyCompletion(lines, cursorLine, cursorCol, closeQuotedDirectory(item), prefix)
    }
    // Pi owns insertion/cursor rules (`/name ` for slash-name items).
    return this.applyDelegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.applyDelegate.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
  }

  /** True while a parent metadata refresh started by this provider is pending. */
  isRefreshingSkills(): boolean {
    return this.refreshFlight !== null
  }

  /**
   * Stop starting refreshes and abort the in-flight one. Suggestion reads keep
   * working from the getters; dispose when the App drops this provider.
   * Idempotent. Late refresh results are ignored either way (no catalog is
   * cached here, so a late catalog can only appear via the getters).
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.refreshFlight = null
    this.lifetime.abort()
  }

  private createDelegate(): CombinedAutocompleteProvider {
    // Rebuilt per request so dynamic commands keep their argument completions;
    // construction is trivial and performs no I/O.
    return new CombinedAutocompleteProvider([...readCommands(this.commands)], this.basePath)
  }

  /**
   * Answer a non-slash request natively when it is a DSH `@file` token.
   *
   * Returns `undefined` when this request is *not* a native context (no
   * `fileReferences` callback, no `@` before the cursor, grammar unavailable, or
   * no grammar token) so the caller falls back to Pi unchanged. Returns the
   * suggestions (possibly `null` = native domain with no rows) when the request
   * belongs to the native `@file` domain.
   *
   * The `@`-character pre-check is what keeps the lazy grammar import out of
   * slash/argument/plain-path completion: those drafts never contain `@` before
   * the cursor. There is no local tokenization here — only DSH's own
   * `activeAtToken` decides the prefix and query.
   */
  private async nativeFileMentionQuery(
    currentLine: string,
    textBeforeCursor: string,
    cursorCol: number,
    signal: AbortSignal,
  ): Promise<AutocompleteSuggestions | null | undefined> {
    if (this.fileReferences === undefined) return undefined
    if (!textBeforeCursor.includes("@")) return undefined
    if (signal.aborted) return null

    const grammar = await loadFileGrammar()
    if (grammar === undefined) return null
    if (signal.aborted) return null

    const token = grammar.activeAtToken(currentLine, cursorCol)
    if (token === undefined) return undefined
    return await this.fileMentionSuggestions(grammar, token, signal)
  }

  /**
   * Map one native `@file` query to Pi menu items, in the source's own order.
   *
   * `value` is DSH's `formatFileMention` output (the grammar decides quoting and
   * the directory slash); `label` is the entry name plus `/` for directories
   * (Pi's own directory marker); `description` is the parent path. A candidate
   * the grammar cannot represent (quote/control characters in the path) or a
   * malformed record contributes no row instead of a broken mention.
   */
  private async fileMentionSuggestions(
    grammar: FileGrammar,
    token: ActiveAtToken,
    signal: AbortSignal,
  ): Promise<AutocompleteSuggestions | null> {
    if (signal.aborted) return null
    const source = this.fileReferences
    if (source === undefined) return null

    const candidates = await settleFileCandidates(source, token.query, signal)
    if (signal.aborted) return null

    const items: AutocompleteItem[] = []
    for (const candidate of candidates) {
      const item = fileMentionItem(grammar, candidate, token.quoted)
      if (item !== null) items.push(item)
    }
    if (items.length === 0) return null
    // The active grammar token is the replacement range, so Pi's own
    // `applyCompletion` can splice it and keep undo/pastes on this Editor.
    return { items, prefix: token.prefix }
  }

  private menuItems(query: string): AutocompleteItem[] {
    const entries: MenuEntry[] = []
    const seen = new Set<string>()

    for (const command of readCommands(this.commands)) {
      const name = sanitizeName(command.name)
      if (name === null || seen.has(name)) continue
      seen.add(name)
      const description = commandDescription(command)
      entries.push(description ? { name, description } : { name })
    }

    for (const skill of readSkills(this.skills)) {
      const name = sanitizeName(skill.name)
      if (name === null || seen.has(name)) continue
      seen.add(name)
      entries.push({ name, description: skillDescription(skill) })
    }

    const ranked: Array<{ rank: MatchRank; item: AutocompleteItem }> = []
    for (const entry of entries) {
      const rank = matchRank(entry.name, query)
      if (rank === null) continue
      ranked.push({
        rank,
        item: {
          value: entry.name,
          label: entry.name,
          ...(entry.description ? { description: entry.description } : {}),
        },
      })
    }
    // Stable sort: equal ranks keep the roster order built above.
    ranked.sort((left, right) => left.rank - right.rank)
    return ranked.map((entry) => entry.item)
  }

  private requestSkillRefresh(): void {
    const refresh = this.refreshSkills
    if (!refresh || this.disposed) return
    // Strict single-flight: while a parent call is pending, background
    // re-queries (metadata settle, same menu re-trigger) add no new fetch.
    if (this.refreshFlight !== null) return

    let task: Promise<void>
    try {
      task = Promise.resolve(refresh(this.lifetime.signal))
    } catch {
      // Refresh failures are the parent's to report; never leak a rejection
      // into the Editor request and never hide the current menu. The next
      // genuine slash query retries (no memoized query to suppress it).
      return
    }
    // Swallow rejection in the settled marker; failures must stay retryable.
    const flight = task.then(
      () => undefined,
      () => undefined,
    )
    this.refreshFlight = flight
    void flight.then(() => {
      if (this.refreshFlight === flight) this.refreshFlight = null
    })
  }
}

/**
 * Match Pi's slash-name context exactly: a leading `/` on the trimmed line with
 * no space yet (arguments) and no forced (`Tab`) file completion. Otherwise the
 * request belongs to Pi's combined provider.
 */
function nativeSlashNamePrefix(textBeforeCursor: string, forced: boolean): string | null {
  if (forced) return null
  const commandText = textBeforeCursor.trimStart()
  if (!commandText.startsWith("/")) return null
  if (commandText.includes(" ")) return null
  return commandText
}

function readCommands(source: () => readonly NativeCommandEntry[]): NativeCommandEntry[] {
  let value: unknown
  try {
    value = source()
  } catch {
    // A broken roster must not break file/`@` completion.
    return []
  }
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is NativeCommandEntry => typeof entry === "object" && entry !== null)
}

/**
 * Await one native `@file` candidate query without ever leaking a rejection.
 *
 * Resolves with the source's rows, or with `[]` when the query throws, returns a
 * non-array, or the request signal aborts. An abort resolves immediately (Pi's
 * next request must not wait on a cancelled domain query) while the abandoned
 * promise keeps its own rejection handler, so nothing surfaces as an unhandled
 * rejection or a terminal diagnostic.
 */
function settleFileCandidates(
  source: (query: string, signal: AbortSignal) => Promise<readonly FileReferenceCandidate[]>,
  query: string,
  signal: AbortSignal,
): Promise<readonly FileReferenceCandidate[]> {
  let task: Promise<unknown>
  try {
    task = Promise.resolve(source(query, signal))
  } catch {
    return Promise.resolve([])
  }
  const settled = task.then(
    (value) => (Array.isArray(value) ? (value as readonly FileReferenceCandidate[]) : []),
    () => [] as readonly FileReferenceCandidate[],
  )
  // `settled` already owns both fulfillment/rejection handlers; if a source
  // synchronously aborted the request, return immediately instead of waiting
  // for an abandoned provider promise that may never settle.
  if (signal.aborted) return Promise.resolve([])

  return new Promise((resolve) => {
    let done = false
    const finish = (value: readonly FileReferenceCandidate[]): void => {
      if (done) return
      done = true
      signal.removeEventListener("abort", onAbort)
      resolve(value)
    }
    const onAbort = (): void => {
      finish([])
    }
    signal.addEventListener("abort", onAbort, { once: true })
    void settled.then(finish)
  })
}

/**
 * One native candidate as a Pi menu item, or `null` when DSH's grammar cannot
 * represent it. Labels/descriptions are display-only; the accepted text is the
 * grammar's `formatFileMention` value, never a locally assembled mention.
 */
function fileMentionItem(grammar: FileGrammar, candidate: unknown, quoted: boolean): AutocompleteItem | null {
  if (typeof candidate !== "object" || candidate === null) return null
  const record = candidate as { readonly path?: unknown; readonly kind?: unknown }
  if (typeof record.path !== "string" || record.path === "") return null
  if (record.kind !== "file" && record.kind !== "directory") return null
  const kind: "file" | "directory" = record.kind
  const value = grammar.formatFileMention({ path: record.path, kind }, quoted)
  // `undefined` = quote/control characters in the path: no broken mention row.
  if (value === undefined) return null

  const displayPath = record.path.replace(/\\/gu, "/")
  const name = displayName(displayPath)
  if (name === "") return null
  const parent = parentPath(displayPath)
  return {
    value,
    label: kind === "directory" ? `${name}/` : name,
    ...(parent === "" ? {} : { description: parent }),
  }
}

/** Last path segment of a display path (`main.ts` for `src/main.ts/`). */
function displayName(displayPath: string): string {
  const trimmed = displayPath.replace(/\/+$/u, "")
  return trimmed.slice(trimmed.lastIndexOf("/") + 1)
}

/** Parent path of a display path (`src/` for `src/main.ts`); `""` at the root. */
function parentPath(displayPath: string): string {
  const index = displayPath.replace(/\/+$/u, "").lastIndexOf("/")
  if (index <= 0) return ""
  return displayPath.slice(0, index + 1)
}

/**
 * Close the quote of a quoted directory mention.
 *
 * DSH's grammar deliberately leaves a quoted directory's quote open
 * (`@"dir with space/`) so it can be typed into further. On a terminal draft
 * that would be an unsubmittable token, so the closing quote is added here while
 * Pi's own directory cursor rule (value ends with `"` and the label ends with
 * `/` → cursor one column earlier, deduplicating a quote already after the
 * cursor) keeps the single Editor state. Files are already closed by
 * `formatFileMention`, and unquoted paths need no quote at all.
 */
function closeQuotedDirectory(item: AutocompleteItem): AutocompleteItem {
  if (!item.label.endsWith("/")) return item
  if (!item.value.startsWith('@"') || item.value.endsWith('"')) return item
  return { ...item, value: `${item.value}"` }
}

function readSkills(source: () => readonly SkillCatalogEntry[]): SkillCatalogEntry[] {
  let value: unknown
  try {
    value = source()
  } catch {
    // A failed/native-less skill observation must not hide human commands.
    return []
  }
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is SkillCatalogEntry =>
      typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string",
  )
}

function sanitizeName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const name = value.replace(ANSI_ESCAPE_PATTERN, "").replace(CONTROL_PATTERN, "").trim()
  if (name === "" || INVALID_NAME_PATTERN.test(name)) return null
  return name
}

/** Flatten untrusted metadata so a description can never move the cursor/screen. */
function sanitizeDescription(value: unknown): string {
  if (typeof value !== "string") return ""
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .trim()
}

function commandDescription(command: NativeCommandEntry): string | undefined {
  // Native `input.hint`, mapped by the App to `inputHint`; Pi's own
  // `argumentHint` remains the fallback for direct Pi `SlashCommand` callers.
  const hint = sanitizeDescription(nativeInputHint(command) || command.argumentHint)
  const description = sanitizeDescription(command.description)
  if (hint !== "" && description !== "") return `${hint} — ${description}`
  if (hint !== "") return hint
  return description === "" ? undefined : description
}

/** Structural read of the App-mapped native command hint; never a second schema. */
function nativeInputHint(command: NativeCommandEntry): string | undefined {
  const hint: unknown = command.inputHint
  return typeof hint === "string" ? hint : undefined
}

function skillDescription(skill: SkillCatalogEntry): string {
  // Only an explicit native `true` claims model invocation; anything else is
  // labelled user-only so the menu never overstates a skill's policy.
  const label = skill.modelInvocable === true ? SKILL_LABEL : USER_ONLY_SKILL_LABEL
  const description = sanitizeDescription(skill.description)
  return description === "" ? label : `${label} — ${description}`
}

/**
 * Candidate priority for a slash-name query, mirroring the intent of Pi's
 * editor `getBestAutocompleteMatchIndex` (exact → prefix → no match) but in the
 * menu's own namespace: `item.value`/`prefix` there is `name`, while the
 * suggestion prefix includes the leading `/`.
 *
 * `null` drops a non-match. An empty query gives every entry the same rank, so
 * the roster order is the menu order for `/`.
 */
type MatchRank = 0 | 1 | 2

function matchRank(name: string, query: string): MatchRank | null {
  if (query === "") return 0
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  // Order-preserving fuzzy match: roster order stays the tiebreaker among
  // fuzzy-only candidates (the native roster is not re-sorted by score here).
  return fuzzyMatch(query, name).matches ? 2 : null
}