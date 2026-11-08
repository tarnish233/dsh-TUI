/**
 * Native DSH slash-command completion (thin combination layer).
 *
 * DSH skills are human-invocable as plain `/name`; there is no `/skill` wrapper
 * and no Pi `skill:name` / `skill:` alias. This provider only *combines*
 * metadata that the App already owns:
 *
 * - mounted native/UI commands (the same `SlashCommand` shape Pi accepts),
 * - read-only `SkillCatalogEntry` metadata fetched by the App,
 * - Pi's existing `CombinedAutocompleteProvider` for `@` attachments, file
 *   paths, command argument completion, forced completion and application.
 *
 * It is deliberately not a skill engine: it never reads skill files, expands
 * skill bodies, invokes anything, keeps a skill catalog of its own, or adds
 * Editor state / timers / raw stdin consumers. Catalogs are read through
 * getters on every request so an asynchronous refresh never loses state.
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

import {
  CombinedAutocompleteProvider,
  fuzzyMatch,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from "#pi-tui"

import type { SkillCatalogEntry } from "../backend/types.ts"

/** Options for {@link NativeAutocompleteProvider}. */
export interface NativeAutocompleteProviderOptions {
  /** Current command roster; read on every request (never cached here). */
  commands: () => readonly SlashCommand[]
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
}

const SKILL_LABEL = "Skill"
const USER_ONLY_SKILL_LABEL = "Skill (user-only)"

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
 * (commands win), and the list keeps source order: commands in roster order,
 * then skills in catalog order. Skills carry a `Skill` / `Skill (user-only)`
 * description label; nothing is reformatted into `skill:` aliases.
 */
export class NativeAutocompleteProvider implements AutocompleteProvider {
  private readonly commands: () => readonly SlashCommand[]
  private readonly skills: () => readonly SkillCatalogEntry[]
  private readonly refreshSkills: ((signal: AbortSignal) => Promise<void>) | undefined
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
    this.commands = options.commands
    this.skills = options.skills
    this.refreshSkills = options.refreshSkills
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
      // Preserve Pi's @-attachment, path, argument and forced-completion
      // semantics; those contexts never start a skill metadata refresh.
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

    const items: AutocompleteItem[] = []
    for (const entry of entries) {
      if (!matchesQuery(entry.name, query)) continue
      items.push({
        value: entry.name,
        label: entry.name,
        ...(entry.description ? { description: entry.description } : {}),
      })
    }
    return items
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

function readCommands(source: () => readonly SlashCommand[]): SlashCommand[] {
  let value: unknown
  try {
    value = source()
  } catch {
    // A broken roster must not break file/`@` completion.
    return []
  }
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is SlashCommand => typeof entry === "object" && entry !== null)
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

function commandDescription(command: SlashCommand): string | undefined {
  const hint = sanitizeDescription(command.argumentHint)
  const description = sanitizeDescription(command.description)
  if (hint !== "" && description !== "") return `${hint} — ${description}`
  if (hint !== "") return hint
  return description === "" ? undefined : description
}

function skillDescription(skill: SkillCatalogEntry): string {
  // Only an explicit native `true` claims model invocation; anything else is
  // labelled user-only so the menu never overstates a skill's policy.
  const label = skill.modelInvocable === true ? SKILL_LABEL : USER_ONLY_SKILL_LABEL
  const description = sanitizeDescription(skill.description)
  return description === "" ? label : `${label} — ${description}`
}

function matchesQuery(name: string, query: string): boolean {
  if (query === "") return true
  // Order-preserving fuzzy match: the native roster order is the menu order.
  return fuzzyMatch(query, name).matches
}