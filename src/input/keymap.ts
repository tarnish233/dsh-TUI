/**
 * Configurable CC keymap with contexts, chords and warning diagnostics.
 *
 * This is deliberately independent from Pi's global keybinding registry:
 * DSH TUI configuration must not silently inherit Pi application actions.
 * Pi's `matchesKey` is reused for terminal key parsing (legacy sequences,
 * Kitty CSI-u and xterm modifyOtherKeys).
 */

import { matchesKey, type KeyId } from "#pi-tui"
import {
  CC_ACTIONS,
  type CcActionDefinition,
  type CcCompatibilityStatus,
  type CcContext,
  type CcKeybindingPlatform,
  CC_CONTEXTS,
} from "./actions.ts"

export interface CcKeymapDiagnostic {
  severity: "error" | "warning" | "info"
  code:
    | "unknown-action"
    | "invalid-binding"
    | "conflict"
    | "byte-ambiguous"
    | "chord-shadow"
    | "cross-context-shadow"
    | "invalid-config"
  message: string
  action?: string
  otherAction?: string
  context?: CcContext
  /**
   * Every context affected by one cross-context shadow (the diagnostic is
   * grouped, so one message can describe several fallback chains).
   */
  contexts?: CcContext[]
  keys?: string
}

/** User keymap configuration: action id -> binding spec(s), or null to disable. */
export type CcKeymapConfig = Record<string, string | readonly string[] | null | undefined>

export interface CcKeymapOptions {
  bindings?: CcKeymapConfig
  /** Milliseconds allowed between chord keys. */
  chordTimeoutMs?: number
  /** Replace the built-in registry (tests, experimental extensions). */
  definitions?: readonly CcActionDefinition[]
  /**
   * Platform bucket for platform-specific default bindings (Windows/WSL Alt+V).
   * Defaults to the current process; inject it in tests.
   */
  platform?: CcKeybindingPlatform
  /**
   * Bindings the host always composes in addition to the registry defaults
   * (for example the TUI's per-screen `modeBindings`).
   *
   * They are the *baseline*, not user overrides: a cross-context shadow is only
   * reported when the current configuration adds it relative to this baseline.
   * Without it a host-composed binding would look like an ambiguous user
   * override. Defaults to the registry defaults alone.
   */
  baselineBindings?: CcKeymapConfig
}

export interface CcResolvedKey {
  kind: "action"
  action: CcActionDefinition
  /** Key identifiers of the matched binding, e.g. `["ctrl+x", "ctrl+e"]`. */
  keys: string[]
  context: CcContext
}

export interface CcPendingChord {
  kind: "pending"
  /** Canonical key identifiers consumed so far. */
  prefix: string[]
}

export interface CcCancelledChord {
  kind: "cancelled-chord"
  reason: "timeout" | "mismatch" | "cancelled"
  prefix: string[]
  /** The key event that cancelled the chord; caller should dispatch it fresh. */
  passthrough: string
}

export interface CcUnboundKey {
  kind: "none"
  key: string
}

export type CcKeyResolution = CcResolvedKey | CcPendingChord | CcCancelledChord | CcUnboundKey

interface CompiledBinding {
  action: CcActionDefinition
  keys: string[]
}

/** One binding of one context chain: an action's keys at one fallback layer. */
interface ChainClaim {
  action: string
  keys: string[]
  layer: number
}

/**
 * One binding that can never be delivered in a context because another
 * binding of the same fallback chain receives its keys first. Every kind is
 * derived from a real resolver walk (`resolveChainSequence()`), not from a
 * first-key heuristic.
 *
 * `single`: same single key claimed by a more local layer; the shadowed
 * binding never fires.
 * `same-sequence`: identical multi-key chord claimed by a more local layer;
 * exactly one of the two chord bindings can ever complete.
 * `chord-prefix`: a single key that starts a chord in another layer. Typing it
 * opens the chord; CcEditor drops the collected prefix on timeout/mismatch, so
 * the single binding is unreachable, not merely delayed.
 * `chord-sequence`: a chord whose full sequence extends a shorter binding of
 * another layer, which completes first, so the longer chord never completes.
 * `interrupt-priority`: the configured `app.interrupt` key is checked before
 * the chain (and before a pending chord) in read-only/modal contexts. The
 * action ships with no default; this shape only exists after an explicit
 * single-key override.
 */
interface ChainShadow {
  context: CcContext
  /** Full key sequence of the unreachable binding (canonical key ids). */
  keys: string[]
  /** Full key sequence the winning binding resolves with. */
  winnerKeys: string[]
  kind: "single" | "same-sequence" | "chord-prefix" | "chord-sequence" | "interrupt-priority"
  /** Action that effectively receives the keys. */
  winner: string
  /** Action whose binding is unreachable in that context. */
  shadowed: string
}

/** Effective-key picture of one compiled binding index. */
interface ChainAnalysis {
  shadows: ChainShadow[]
  /** `context\0<full sequence>` -> action that actually receives that sequence. */
  resolved: Map<string, string>
}

/** Why a shadow is worth reporting: a dead override or a stolen default key. */
type ShadowReason = "override" | "stolen"

/** Canonical text of a full key sequence, e.g. `ctrl+x ctrl+e`. */
const sequenceKey = (keys: readonly string[]): string => keys.join(" ")

const resolutionKey = (context: CcContext, sequence: string): string => `${context}\u0000${sequence}`

/**
 * Action ids whose *effective* binding list differs between the current
 * configuration and the host baseline. Comparing compiled bindings (not raw
 * file entries) keeps an override that merely restates a registry default
 * "unchanged": restating Ctrl+A for `editor.move.line-start` is not a new
 * precedence decision and must not produce diagnostics.
 */
function changedActionIds(
  current: ReadonlyMap<string, CompiledBinding[]>,
  baseline: ReadonlyMap<string, CompiledBinding[]>,
): Set<string> {
  const changed = new Set<string>()
  for (const [id, bindings] of current) {
    const before = baseline.get(id) ?? []
    const currentKeys = bindings.map((binding) => binding.keys.join(" "))
    const baselineKeys = before.map((binding) => binding.keys.join(" "))
    if (currentKeys.length !== baselineKeys.length || currentKeys.some((key, index) => key !== baselineKeys[index])) {
      changed.add(id)
    }
  }
  return changed
}

const MODIFIER_NAMES = ["ctrl", "shift", "alt", "super"] as const

/**
 * Context fallback chains (first match wins).
 *
 * `modelPickerList` is the /model picker browse list: picker-local provider
 * keys first, then the shared list keys (j/k/arrows/digits) and finally the
 * editor editing fallback. `modelPickerSearch` is its query field: picker
 * provider keys, then Enter/Esc as list actions, then the editor text layer.
 *
 * `toolDetails` and `imageDetails` are read-only modals: shared list
 * navigation, dialog and app keys, but **no editor fallback**, so
 * movement/kill/undo bindings cannot edit or type into those surfaces.
 *
 * `subagentList` and `subagentSession` are the read-only native Agents overlay
 * (agent list and one agent's session view). They follow the same read-only
 * shape: shared list navigation, dialog and app keys, never the editor layer.
 * The context-local actions are `subagent.reply` (`r`),
 * `subagent.interrupt` (`s`) and `subagent.filter.toggle` (Tab); all come from
 * this one registry, so they are remappable/disableable and plain `r`/`s`/Tab
 * stay ordinary input in the prompt.
 *
 * `settingsList`, `keybindingsList`, `modalList` and `queueList` are the unified
 * modal browse surfaces: shared list navigation, dialog and app keys, and **no
 * editor fallback**, so editor movement/kill/undo can never edit or type into a
 * read-only modal. `modalSearch` is the modal text field: the editor layer is
 * present (typing, word/whitespace deletion, kill/yank, undo in one Pi editor
 * state), Esc/app keys still fall through, and list navigation is passed by the
 * owning UI rather than resolved from editor bindings. Because `modal.search`
 * is not registered in `modalSearch`, Ctrl+F stays editor char-right there.
 * Context-local rows are resolved before every fallback layer, which is why the
 * `settingsList` group jumps (Left/Shift+Tab, Right/Tab) cannot be swallowed by
 * a generic `dialog` Tab binding or by the global `app.mode.cycle` (Shift+Tab).
 */
const CONTEXT_FALLBACK_CHAINS: Readonly<Record<CcContext, readonly CcContext[]>> = {
  editor: ["editor", "global"],
  autocomplete: ["autocomplete", "editor", "global"],
  historySearch: ["historySearch", "editor", "global"],
  dialog: ["dialog", "editor", "global"],
  list: ["list", "global"],
  modelPickerList: ["modelPickerList", "list", "editor", "global"],
  modelPickerSearch: ["modelPickerSearch", "editor", "global"],
  toolDetails: ["toolDetails", "list", "dialog", "global"],
  imageDetails: ["imageDetails", "list", "dialog", "global"],
  subagentList: ["subagentList", "list", "dialog", "global"],
  subagentSession: ["subagentSession", "list", "dialog", "global"],
  settingsList: ["settingsList", "list", "dialog", "global"],
  keybindingsList: ["keybindingsList", "list", "dialog", "global"],
  modalList: ["modalList", "list", "dialog", "global"],
  queueList: ["queueList", "list", "dialog", "global"],
  modalSearch: ["modalSearch", "editor", "dialog", "global"],
  global: ["global"],
}

/**
 * Contexts where a configured simple `app.interrupt` key always wins over a
 * local binding *and* over a pending chord.
 *
 * `app.interrupt` ships with **no default** (its old Ctrl+C default moved to
 * `app.clear`), so the shipped registry has no priority key here: default
 * Ctrl+C reaches the local cancel/restore/reject row (`list.cancel`,
 * `dialog.cancel`, `historySearch.cancel`, the picker rows) or the editor/
 * completion layer, never a hidden root clear. An explicit single-key override
 * restores the unconditional escape hatch from a read-only details modal, the
 * read-only Agents surface, the /model picker and the unified modal surfaces
 * (Settings, Keyboard shortcuts, generic modal lists, queue and their
 * `modalSearch` text field) without changing `list`/`dialog` semantics.
 */
const INTERRUPT_PRIORITY_CONTEXTS: ReadonlySet<CcContext> = new Set<CcContext>([
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
])

const SPECIAL_KEYS = new Set([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageUp".toLowerCase(),
  "pageDown".toLowerCase(),
  "up",
  "down",
  "left",
  "right",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
])

const SYMBOL_KEYS = new Set(
  "`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""),
)

function parseKeyId(raw: string): { modifiers: string[]; key: string } | undefined {
  let rest = raw.trim().toLowerCase()
  if (!rest) return undefined
  const modifiers: string[] = []
  while (true) {
    const modifier = MODIFIER_NAMES.find((name) => rest.startsWith(`${name}+`))
    if (!modifier) break
    if (modifiers.includes(modifier)) return undefined
    modifiers.push(modifier)
    rest = rest.slice(modifier.length + 1)
  }
  if (!rest) return undefined
  if (rest.includes("+") && rest !== "+") return undefined
  const isPlain = /^[a-z0-9]$/.test(rest) || SYMBOL_KEYS.has(rest) || SPECIAL_KEYS.has(rest)
  if (!isPlain) return undefined
  return { modifiers, key: rest }
}

/** Validate a single Pi key identifier such as `ctrl+w` or `alt+left`. */
export function isValidKeyId(raw: string): boolean {
  return parseKeyId(raw) !== undefined
}

/**
 * Split a binding spec into key identifiers.
 * Returns undefined for malformed specs (and records no state).
 */
export function parseBindingSpec(spec: string): string[] | undefined {
  if (typeof spec !== "string") return undefined
  const tokens = spec
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return undefined
  for (const token of tokens) {
    if (!isValidKeyId(token)) return undefined
  }
  return tokens.map((token) => token.toLowerCase())
}

const BYTE_EQUIVALENCE: ReadonlyMap<string, string> = new Map([
  ["ctrl+i", "byte:tab"],
  ["tab", "byte:tab"],
  ["ctrl+m", "byte:enter"],
  ["enter", "byte:enter"],
  ["return", "byte:enter"],
  ["ctrl+[", "byte:escape"],
  ["escape", "byte:escape"],
  ["esc", "byte:escape"],
  ["ctrl+h", "byte:backspace"],
  ["backspace", "byte:backspace"],
  ["ctrl+_", "byte:0x1f"],
  ["ctrl+-", "byte:0x1f"],
  ["ctrl+shift+-", "byte:0x1f"],
  ["ctrl+space", "byte:0x00"],
])

function byteGroup(keyId: string): string | undefined {
  return BYTE_EQUIVALENCE.get(keyId)
}

/** Bindings are validated by `parseBindingSpec` before reaching `matchesKey`. */
function keyMatches(data: string, keyId: string): boolean {
  return matchesKey(data, keyId as KeyId)
}

/** Human-readable label for a binding, e.g. `Ctrl+X Ctrl+E`. */
export function formatBinding(keys: readonly string[]): string {
  return keys
    .map((key) =>
      key
        .split("+")
        .map((part) => {
          if (part === "ctrl" || part === "shift" || part === "alt" || part === "super") {
            return part.charAt(0).toUpperCase() + part.slice(1)
          }
          if (part.length === 1) return part.toUpperCase()
          if (part === "pageup") return "PageUp"
          if (part === "pagedown") return "PageDown"
          return part.charAt(0).toUpperCase() + part.slice(1)
        })
        .join("+"),
    )
    .join(" ")
}

/**
 * Resolve the platform bucket used for platform-specific default bindings.
 * WSL is detected first because it reports `process.platform === "linux"` but
 * follows Windows clipboard conventions.
 */
export function detectKeybindingPlatform(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CcKeybindingPlatform {
  if (platform === "win32") return "windows"
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV) return "wsl"
  return "posix"
}

export class CcKeymap {
  readonly definitions: readonly CcActionDefinition[]
  readonly platform: CcKeybindingPlatform

  private readonly definitionsById: Map<string, CcActionDefinition>
  private readonly chordTimeout: number
  private userConfig: CcKeymapConfig = {}
  /** Host-composed bindings that are part of the baseline, not user overrides. */
  private readonly baselineConfig: CcKeymapConfig
  private bindingsByAction = new Map<string, CompiledBinding[]>()
  private index = new Map<CcContext, CompiledBinding[]>()
  private diagnostics: CcKeymapDiagnostic[] = []
  private pending: { since: number; prefix: string[]; candidates: CompiledBinding[]; generation: number } | null = null
  /** Monotonic id for each new pending chord (ownership for shared keymaps). */
  private chordGeneration = 0
  private readonly chordListeners = new Set<(prefix: readonly string[] | null) => void>()

  constructor(options: CcKeymapOptions = {}) {
    this.definitions = options.definitions ?? CC_ACTIONS
    this.platform = options.platform ?? detectKeybindingPlatform()
    this.definitionsById = new Map(this.definitions.map((action) => [action.id, action]))
    const timeout = options.chordTimeoutMs ?? 3000
    this.chordTimeout = Number.isFinite(timeout) && timeout > 0 ? timeout : 3000
    if (options.chordTimeoutMs !== undefined && (!Number.isFinite(options.chordTimeoutMs) || options.chordTimeoutMs <= 0)) {
      this.diagnostics.push({
        severity: "warning",
        code: "invalid-config",
        message: `chordTimeoutMs must be a positive number, got ${String(options.chordTimeoutMs)}`,
      })
    }
    this.userConfig = options.bindings ?? {}
    this.baselineConfig = options.baselineBindings ?? {}
    this.rebuild()
  }

  getChordTimeoutMs(): number {
    return this.chordTimeout
  }

  /**
   * Bindings that apply in a context: the context's own bindings first, then
   * its fallback chain (see `CONTEXT_FALLBACK_CHAINS`). Local bindings win, so
   * e.g. Ctrl+D stays forward-delete in the editor and only reaches
   * `app.exit` when the editor action itself forwards it.
   */
  private bindingsForContext(context: CcContext): CompiledBinding[] {
    return CONTEXT_FALLBACK_CHAINS[context].flatMap((entry) => this.index.get(entry) ?? [])
  }

  /** Context fallback chain, exposed for diagnostics and help UIs. */
  getFallbackChain(context: CcContext): CcContext[] {
    return [...CONTEXT_FALLBACK_CHAINS[context]]
  }

  /** Effective bindings for one action (empty when disabled). */
  getBindings(actionId: string): string[] {
    return (this.bindingsByAction.get(actionId) ?? []).map((binding) => binding.keys.join(" "))
  }

  getAction(actionId: string): CcActionDefinition | undefined {
    return this.definitionsById.get(actionId)
  }

  getActions(context?: CcContext): CcActionDefinition[] {
    if (!context) return [...this.definitions]
    return this.definitions.filter((action) => action.contexts.includes(context))
  }

  getDiagnostics(): readonly CcKeymapDiagnostic[] {
    return this.diagnostics
  }

  getConflicts(): CcKeymapDiagnostic[] {
    return this.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "conflict" ||
        diagnostic.code === "byte-ambiguous" ||
        diagnostic.code === "chord-shadow" ||
        diagnostic.code === "cross-context-shadow",
    )
  }

  getUserConfig(): CcKeymapConfig {
    return { ...this.userConfig }
  }

  /** Hot-update the user configuration; diagnostics are recomputed. */
  setBindings(config: CcKeymapConfig): void {
    const hadPending = this.pending !== null
    this.userConfig = config ?? {}
    this.pending = null
    this.rebuild()
    if (hadPending) this.notifyChord(null)
  }

  /**
   * Observe pending-chord transitions: `prefix` when a chord starts, `null`
   * when it completes, is cancelled, mismatches or times out.
   *
   * The keymap owns the pending state, so every cancellation path (including
   * dialogs calling `cancelChord()`) reaches one listener and the hint UI
   * cannot go stale. Returns an unsubscribe function.
   */
  onChordChange(listener: (prefix: readonly string[] | null) => void): () => void {
    this.chordListeners.add(listener)
    return () => {
      this.chordListeners.delete(listener)
    }
  }

  private notifyChord(prefix: readonly string[] | null): void {
    const value = prefix ? [...prefix] : null
    for (const listener of this.chordListeners) listener(value)
  }

  isPendingChord(): boolean {
    return this.pending !== null
  }

  getPendingChord(): string[] | null {
    return this.pending ? [...this.pending.prefix] : null
  }

  /** Identity of the current pending chord, or null when idle. */
  getPendingChordGeneration(): number | null {
    return this.pending?.generation ?? null
  }

  /** Drop a pending chord, returning the consumed prefix. */
  cancelChord(): string[] | null {
    const prefix = this.pending?.prefix ?? null
    this.pending = null
    if (prefix) this.notifyChord(null)
    return prefix ? [...prefix] : null
  }

  /**
   * Expire a pending chord. Returns the consumed prefix when it timed out,
   * otherwise null.
   */
  expireChord(now: number = Date.now()): string[] | null {
    if (!this.pending) return null
    if (now - this.pending.since < this.chordTimeout) return null
    const prefix = [...this.pending.prefix]
    this.pending = null
    this.notifyChord(null)
    return prefix
  }

  /**
   * Resolve raw terminal data for a context.
   *
   * `now` is injected so timeout behaviour is testable without wall-clock
   * sleeps. A `cancelled-chord` result asks the caller to dispatch
   * `passthrough` again as fresh input.
   */
  resolve(data: string, context: CcContext = "editor", now: number = Date.now()): CcKeyResolution {
    // An unconditional interrupt escape hatch comes before pending chords:
    // a read-only modal must never swallow the configured interrupt key just
    // because a chord prefix was already typed. Cancelling the chord here keeps
    // the hint state truthful, then the interrupt action is dispatched fresh.
    if (INTERRUPT_PRIORITY_CONTEXTS.has(context)) {
      const interrupt = (this.bindingsByAction.get("app.interrupt") ?? []).find(
        (binding) => binding.keys.length === 1 && keyMatches(data, binding.keys[0]),
      )
      if (interrupt) {
        if (this.pending) {
          this.pending = null
          this.notifyChord(null)
        }
        return { kind: "action", action: interrupt.action, keys: [...interrupt.keys], context }
      }
    }
    if (this.pending) {
      if (now - this.pending.since >= this.chordTimeout) {
        const prefix = [...this.pending.prefix]
        this.pending = null
        this.notifyChord(null)
        return { kind: "cancelled-chord", reason: "timeout", prefix, passthrough: data }
      }
      const { prefix, candidates } = this.pending
      const depth = prefix.length
      const matches = candidates.filter((binding) => {
        const key = binding.keys[depth]
        return key !== undefined && keyMatches(data, key)
      })
      if (matches.length === 0) {
        this.pending = null
        this.notifyChord(null)
        return { kind: "cancelled-chord", reason: "mismatch", prefix: [...prefix], passthrough: data }
      }
      const completed = matches.find((binding) => binding.keys.length === depth + 1)
      if (completed) {
        this.pending = null
        this.notifyChord(null)
        return { kind: "action", action: completed.action, keys: [...completed.keys], context }
      }
      const deeper = matches.filter((binding) => binding.keys.length > depth + 1)
      if (deeper.length > 0) {
        this.pending = {
          since: now,
          prefix: [...prefix, deeper[0].keys[depth]],
          candidates: deeper,
          generation: this.pending.generation,
        }
        this.notifyChord(this.pending.prefix)
        return { kind: "pending", prefix: [...prefix, deeper[0].keys[depth]] }
      }
      this.pending = null
      this.notifyChord(null)
      return { kind: "cancelled-chord", reason: "mismatch", prefix: [...prefix], passthrough: data }
    }

    const bindings = this.bindingsForContext(context)
    let simple: CompiledBinding | undefined
    const chordCandidates: CompiledBinding[] = []
    for (const binding of bindings) {
      if (!keyMatches(data, binding.keys[0])) continue
      if (binding.keys.length === 1) {
        simple ??= binding
      } else {
        chordCandidates.push(binding)
      }
    }
    if (chordCandidates.length > 0) {
      const first = chordCandidates[0]
      this.pending = {
        since: now,
        prefix: [first.keys[0]],
        candidates: chordCandidates,
        generation: ++this.chordGeneration,
      }
      this.notifyChord(this.pending.prefix)
      return { kind: "pending", prefix: [first.keys[0]] }
    }
    if (simple) {
      return { kind: "action", action: simple.action, keys: [...simple.keys], context }
    }
    return { kind: "none", key: data }
  }

  /** Keyboard metadata for Settings and diagnostic consumers. */
  getHelp(context?: CcContext): Array<{
    action: string
    keys: string[]
    keysLabel: string
    description: string
    status: CcCompatibilityStatus
    note?: string
  }> {
    return this.getActions(context)
      .map((action) => {
        const keys = this.getBindings(action.id)
        return {
          action: action.id,
          keys,
          keysLabel: keys.length > 0 ? keys.map((binding) => formatBinding(binding.split(" "))).join(", ") : "(unbound)",
          description: action.description,
          status: action.status,
          note: action.note,
        }
      })
      .filter((row) => row.keys.length > 0)
  }

  private rebuild(): void {
    const compiled = this.compileBindings(this.userConfig)
    const diagnostics = compiled.diagnostics
    this.bindingsByAction = compiled.bindingsByAction
    this.index = compiled.index
    this.detectConflicts(diagnostics)
    // The host baseline (`baselineBindings` + registry defaults) is the
    // reference for "by design" precedence: it already contains intentional
    // local-over-global overrides. Compiling it only when this configuration
    // actually differs keeps the no-override path free of extra work and of
    // cross-context diagnostics.
    let baseline: { index: Map<CcContext, CompiledBinding[]>; bindingsByAction: Map<string, CompiledBinding[]> } | undefined
    let changed = new Set<string>()
    if (Object.keys(this.userConfig).length > 0) {
      const compiledBaseline = this.compileBindings(this.baselineConfig)
      changed = changedActionIds(compiled.bindingsByAction, compiledBaseline.bindingsByAction)
      if (changed.size > 0) baseline = compiledBaseline
    }
    this.detectCrossContextShadows(diagnostics, baseline, changed)
    this.diagnostics = diagnostics
  }

  /**
   * Compile a configuration into per-action and per-context binding indexes.
   * Pure with respect to instance state, so the same helper produces the
   * no-override baseline used by the cross-context diagnostics.
   */
  private compileBindings(config: CcKeymapConfig): {
    bindingsByAction: Map<string, CompiledBinding[]>
    index: Map<CcContext, CompiledBinding[]>
    diagnostics: CcKeymapDiagnostic[]
  } {
    const diagnostics: CcKeymapDiagnostic[] = []
    const bindingsByAction = new Map<string, CompiledBinding[]>()
    const index = new Map<CcContext, CompiledBinding[]>()

    for (const actionId of Object.keys(config)) {
      if (!this.definitionsById.has(actionId)) {
        diagnostics.push({
          severity: "error",
          code: "unknown-action",
          action: actionId,
          message: `Unknown action "${actionId}"; ignored. Use getActions() to list valid ids.`,
        })
      }
    }

    for (const action of this.definitions) {
      const hasOverride = Object.prototype.hasOwnProperty.call(config, action.id)
      const compiled: CompiledBinding[] = []
      if (!hasOverride) {
        const specs = [...action.defaultBindings, ...(action.platformBindings?.[this.platform] ?? [])]
        for (const spec of specs) {
          const keys = parseBindingSpec(spec)
          if (!keys) {
            diagnostics.push({
              severity: "error",
              code: "invalid-binding",
              action: action.id,
              keys: spec,
              message: `Built-in default binding "${spec}" for ${action.id} is malformed.`,
            })
            continue
          }
          compiled.push({ action, keys })
        }
      } else {
        const override = config[action.id]
        if (override === null || (Array.isArray(override) && override.length === 0)) {
          // Explicitly disabled: no bindings, no fall-through.
        } else {
          const specs = Array.isArray(override) ? override : [override]
          if (specs.length === 0) {
            // Same as disabled.
          } else {
            let invalid = false
            for (const spec of specs) {
              if (typeof spec !== "string") {
                invalid = true
                diagnostics.push({
                  severity: "error",
                  code: "invalid-binding",
                  action: action.id,
                  message: `Binding for ${action.id} must be a string, got ${typeof spec}; action disabled.`,
                })
                continue
              }
              const keys = parseBindingSpec(spec)
              if (!keys) {
                invalid = true
                diagnostics.push({
                  severity: "error",
                  code: "invalid-binding",
                  action: action.id,
                  keys: spec,
                  message: `Invalid key binding "${spec}" for ${action.id}; action disabled.`,
                })
                continue
              }
              if (!compiled.some((binding) => binding.keys.join(" ") === keys.join(" "))) {
                compiled.push({ action, keys })
              }
            }
            if (invalid) compiled.length = 0
          }
        }
      }
      bindingsByAction.set(action.id, compiled)
      for (const context of action.contexts) {
        let list = index.get(context)
        if (!list) {
          list = []
          index.set(context, list)
        }
        list.push(...compiled)
      }
    }

    return { bindingsByAction, index, diagnostics }
  }

  private detectConflicts(diagnostics: CcKeymapDiagnostic[]): void {
    for (const context of CC_CONTEXTS) {
      const bindings = this.index.get(context) ?? []
      const bySequence = new Map<string, CompiledBinding>()
      const byByteGroup = new Map<string, CompiledBinding[]>()
      for (const binding of bindings) {
        const sequence = binding.keys.join(" ")
        const existing = bySequence.get(sequence)
        if (existing && existing.action.id !== binding.action.id) {
          diagnostics.push({
            severity: "warning",
            code: "conflict",
            context,
            action: binding.action.id,
            otherAction: existing.action.id,
            keys: sequence,
            message: `"${formatBinding(binding.keys)}" is bound to both ${existing.action.id} and ${binding.action.id} in context "${context}"; ${existing.action.id} wins.`,
          })
        } else {
          bySequence.set(sequence, binding)
        }
        for (const key of binding.keys) {
          const group = byteGroup(key)
          if (!group) continue
          const list = byByteGroup.get(group) ?? []
          list.push(binding)
          byByteGroup.set(group, list)
        }
      }
      for (const [group, list] of byByteGroup) {
        const distinct = new Map<string, CompiledBinding>()
        for (const binding of list) distinct.set(binding.action.id, binding)
        if (distinct.size <= 1) continue
        const actions = [...distinct.values()]
        diagnostics.push({
          severity: "warning",
          code: "byte-ambiguous",
          context,
          action: actions[1]?.action.id,
          otherAction: actions[0]?.action.id,
          keys: group.replace("byte:", ""),
          message: `Several bindings in context "${context}" share the same terminal byte (${group.replace("byte:", "")}): ${actions.map((binding) => binding.action.id).join(", ")}. Legacy terminals cannot distinguish them; the first in registry order wins.`,
        })
      }
      // Chord prefixes shadow same-prefix single-key bindings in this context.
      for (const binding of bindings) {
        if (binding.keys.length < 2) continue
        const prefixKey = binding.keys[0]
        const shadowed = (this.index.get(context) ?? []).filter(
          (candidate) =>
            candidate.keys.length === 1 && candidate.keys[0] === prefixKey && candidate.action.id !== binding.action.id,
        )
        for (const candidate of shadowed) {
          diagnostics.push({
            severity: "warning",
            code: "chord-shadow",
            context,
            action: candidate.action.id,
            otherAction: binding.action.id,
            keys: prefixKey,
            message: `${candidate.action.id} binds "${prefixKey}" but ${binding.action.id} uses it as a chord prefix in context "${context}"; typing the key opens the chord instead, so the single binding is unreachable (a cancelled or timed-out chord drops the collected prefix).`,
          })
        }
      }
    }
  }

  /**
   * Effective-key collisions across a whole fallback chain.
   *
   * `detectConflicts()` compares bindings that live in the *same* context. The
   * remaining silent case is the same physical key claimed by different layers
   * of one chain: a locally bound action and a global app action can both bind
   * Ctrl+W, and only the local one ever fires in the prompt.
   *
   * Local-over-global precedence is a documented rule, and the shipped registry
   * relies on it in many places (Ctrl+D delete vs. exit, Ctrl+C `app.clear` vs.
   * `list.cancel`/`dialog.cancel`, the Settings row keys, the history-search
   * layer, ...). Those collisions are therefore never reported. Only two introduced cases are:
   *
   * 1. `override` — the action a build changed relative to the host baseline
   *    is itself unreachable on that key sequence in some context, i.e. the new
   *    binding silently never fires there.
   * 2. `stolen` — a changed binding takes a key sequence away from an action
   *    that owned that sequence in the baseline for the same context.
   *
   * Analysis is per *full key sequence* (single keys and whole chords), because
   * the resolver walks a prefix tree: two chords that merely share a first key
   * are peers, while an identical chord on another layer, or a chord behind a
   * shorter binding, is dead. Equality/prefix decisions come from
   * `analyzeChains()` (a real resolver walk), never from first-key grouping.
   *
   * `baseline` is the compiled host baseline (`baselineBindings` + registry
   * defaults) and `changed` the actions this configuration binds differently.
   */
  private detectCrossContextShadows(
    diagnostics: CcKeymapDiagnostic[],
    baseline: { index: Map<CcContext, CompiledBinding[]>; bindingsByAction: Map<string, CompiledBinding[]> } | undefined,
    changed: ReadonlySet<string>,
  ): void {
    const current = this.analyzeChains(this.index)
    if (current.shadows.length === 0) return
    const before = baseline ? this.analyzeChains(baseline.index) : undefined
    const claimedByBaseline = (actionId: string, sequence: string): boolean =>
      (baseline?.bindingsByAction.get(actionId) ?? []).some((binding) => sequenceKey(binding.keys) === sequence)

    const introduced: Array<{ shadow: ChainShadow; reason: ShadowReason }> = []
    for (const shadow of current.shadows) {
      const sequence = sequenceKey(shadow.keys)
      // 1. The changed binding itself never receives the keys in this context.
      //    Only when the configuration *added* this sequence to the action: a
      //    sequence the action already had in the baseline was shadowed there
      //    by design, and restating that override must stay silent.
      if (changed.has(shadow.shadowed) && !claimedByBaseline(shadow.shadowed, sequence)) {
        introduced.push({ shadow, reason: "override" })
        continue
      }
      // 2. A changed binding takes a sequence away from an action that owned it
      //    in the baseline for the same context.
      if (!before || !changed.has(shadow.winner)) continue
      if (before.resolved.get(resolutionKey(shadow.context, sequence)) !== shadow.shadowed) continue
      introduced.push({ shadow, reason: "stolen" })
    }
    if (introduced.length === 0) return

    // One diagnostic per (reason, sequence, winner, shadowed) covering every
    // affected context, so one override does not produce eleven messages.
    const grouped = new Map<string, { shadow: ChainShadow; reason: ShadowReason; contexts: CcContext[] }>()
    for (const { shadow, reason } of introduced) {
      const key = `${reason}|${shadow.kind}|${sequenceKey(shadow.keys)}|${shadow.winner}|${shadow.shadowed}`
      const entry = grouped.get(key)
      if (entry) {
        if (!entry.contexts.includes(shadow.context)) entry.contexts.push(shadow.context)
        continue
      }
      grouped.set(key, { shadow, reason, contexts: [shadow.context] })
    }

    for (const { shadow, reason, contexts } of grouped.values()) {
      diagnostics.push({
        severity: "warning",
        code: "cross-context-shadow",
        context: contexts[0],
        contexts,
        action: shadow.shadowed,
        otherAction: shadow.winner,
        keys: sequenceKey(shadow.keys),
        message: this.shadowMessage(shadow, reason, contexts),
      })
    }
  }

  /**
   * Explain one introduced shadow, naming the resolution rule so a documented
   * precedence rule and an accidental dead override cannot be confused.
   */
  private shadowMessage(shadow: ChainShadow, reason: ShadowReason, contexts: readonly CcContext[]): string {
    const label = contexts.length === 1 ? `context "${contexts[0]}"` : `contexts ${contexts.join(", ")}`
    const key = formatBinding(shadow.keys)
    const fix = reason === "override" ? "Remap or disable one of the two bindings." : "Remap or disable one of the two bindings if this was not intended."
    const precedence = "local context bindings take precedence over more distant fallback layers"
    if (shadow.kind === "chord-prefix") {
      // CcEditor drops the collected prefix on timeout/mismatch, so the single
      // binding is unreachable, never "delayed". Say so instead of promising a
      // dispatch the timeout path does not perform.
      return reason === "override"
        ? `${shadow.shadowed} is bound to ${key} in your configuration, but ${shadow.winner} uses ${key} as a chord prefix in ${label}; typing the key opens that chord instead, and a cancelled or timed-out chord drops the collected prefix, so the single binding never fires. ${fix}`
        : `${shadow.winner} starts a chord on ${key} in ${label}, so ${shadow.shadowed} (which had ${key} in the shipped defaults) never fires there: typing the key opens the chord, and its prefix is dropped when the ${this.chordTimeout} ms timeout expires or the next key does not match. ${fix}`
    }
    if (shadow.kind === "interrupt-priority") {
      return reason === "override"
        ? `${shadow.shadowed} is bound to ${key} in your configuration, but ${shadow.winner} is checked before the context chain and before a pending chord in ${label}, so the override never fires there. ${fix}`
        : `${shadow.winner} is checked before the context chain and before a pending chord in ${label}, so it now takes ${key} away from ${shadow.shadowed}, which had that key in the shipped defaults. ${fix}`
    }
    if (shadow.kind === "same-sequence") {
      return reason === "override"
        ? `${shadow.shadowed} binds ${key} in your configuration, but ${shadow.winner} binds the identical chord in ${label} and resolves first (${precedence}), so the override never fires there. ${fix}`
        : `${shadow.winner} is now bound to the identical chord ${key} in ${label} and resolves before ${shadow.shadowed}, which had that chord in the shipped defaults (${precedence}). ${fix}`
    }
    if (shadow.kind === "chord-sequence") {
      const winnerKeys = formatBinding(shadow.winnerKeys)
      return reason === "override"
        ? `${shadow.shadowed} binds ${key} in your configuration, but ${shadow.winner} binds the shorter ${winnerKeys} in ${label} and completes first, so the longer chord never fires. ${fix}`
        : `${shadow.winner} now binds the shorter ${winnerKeys} in ${label} and completes first, so it takes ${key} away from ${shadow.shadowed}, which had that chord in the shipped defaults. ${fix}`
    }
    return reason === "override"
      ? `${shadow.shadowed} is bound to ${key} in your configuration, but ${shadow.winner} is bound to ${key} in ${label} and resolves first (${precedence}), so the override never fires there. ${fix}`
      : `${shadow.winner} is now bound to ${key} in ${label} and resolves before ${shadow.shadowed}, which had that key in the shipped defaults (${precedence}). ${fix}`
  }

  /**
   * Effective-key analysis of one compiled index: every key sequence claimed by
   * more than one *layer* of a context chain, resolved the way `resolve()`
   * really resolves it (first key opens a pending chord, the next key picks the
   * matching candidates, a completed chord wins over a longer one).
   *
   * Working per full sequence (not per first key) is what makes chord-vs-chord
   * collisions visible: an identical chord on another layer, or a chord behind
   * a shorter binding, can never complete, while two different chords that
   * share a prefix stay peers.
   */
  private analyzeChains(index: Map<CcContext, CompiledBinding[]>): ChainAnalysis {
    const shadows: ChainShadow[] = []
    const resolved = new Map<string, string>()
    for (const context of CC_CONTEXTS) {
      const chain = CONTEXT_FALLBACK_CHAINS[context]
      // An action registered in several chain layers claims its keys once, at
      // its most local layer (that is what the resolver sees first).
      const firstLayer = new Map<string, number>()
      const claims: ChainClaim[] = []
      for (let layer = 0; layer < chain.length; layer += 1) {
        for (const binding of index.get(chain[layer]!) ?? []) {
          const known = firstLayer.get(binding.action.id)
          if (known === undefined) firstLayer.set(binding.action.id, layer)
          else if (known !== layer) continue
          claims.push({ action: binding.action.id, keys: [...binding.keys], layer })
        }
      }
      // Resolver-ordered claimants per first key and per full sequence.
      const byFirstKey = new Map<string, ChainClaim[]>()
      const bySequence = new Map<string, ChainClaim[]>()
      for (const claim of claims) {
        const first = claim.keys[0]!
        const firstList = byFirstKey.get(first) ?? []
        firstList.push(claim)
        byFirstKey.set(first, firstList)
        const sequence = sequenceKey(claim.keys)
        const sequenceList = bySequence.get(sequence) ?? []
        sequenceList.push(claim)
        bySequence.set(sequence, sequenceList)
      }
      // `resolve()` checks the configured interrupt key before the chain in
      // these read-only/modal contexts *and* before a pending chord, so it wins
      // wherever it appears in a sequence.
      const interruptKey = INTERRUPT_PRIORITY_CONTEXTS.has(context)
        ? claims.find((claim) => claim.action === "app.interrupt" && claim.keys.length === 1)?.keys[0]
        : undefined

      for (const [sequence, claimants] of bySequence) {
        const keys = claimants[0]!.keys
        const outcome =
          this.resolveChainSequence(byFirstKey, keys, interruptKey) ??
          // A single key that starts a chord in another layer: the resolver
          // opens the chord instead of dispatching the single binding.
          (keys.length === 1
            ? (() => {
                const chord = (byFirstKey.get(keys[0]!) ?? []).find((claim) => claim.keys.length > 1)
                return chord ? { ...chord, interrupt: false } : undefined
              })()
            : undefined)
        if (!outcome) continue
        resolved.set(resolutionKey(context, sequence), outcome.action)
        for (const claimant of claimants) {
          if (claimant.action === outcome.action) continue
          // Same layer = same-context duplicate, already reported as `conflict`.
          if (claimant.layer === outcome.layer) continue
          const kind: ChainShadow["kind"] = outcome.interrupt
            ? "interrupt-priority"
            : claimant.keys.length === 1 && outcome.keys.length > 1
              ? "chord-prefix"
              : claimant.keys.length > outcome.keys.length
                ? "chord-sequence"
                : claimant.keys.length === 1
                  ? "single"
                  : "same-sequence"
          shadows.push({
            context,
            keys: [...claimant.keys],
            winnerKeys: [...outcome.keys],
            kind,
            winner: outcome.action,
            shadowed: claimant.action,
          })
        }
      }
    }
    return { shadows, resolved }
  }

  /**
   * Walk the real resolver for one full key sequence and return the binding
   * that actually fires (or `undefined` when nothing completes).
   *
   * Mirrors `resolve()`: the first key opens a pending chord when any chord
   * starts with it (single bindings on that key lose), each following key
   * narrows the candidates, and a candidate whose sequence ends here completes
   * before any longer one. The interrupt escape hatch is checked before every
   * key in the priority contexts.
   */
  private resolveChainSequence(
    byFirstKey: ReadonlyMap<string, ChainClaim[]>,
    keys: readonly string[],
    interruptKey: string | undefined,
  ): { action: string; keys: string[]; layer: number; interrupt: boolean } | undefined {
    let pending: ChainClaim[] | undefined
    for (let depth = 0; depth < keys.length; depth += 1) {
      const key = keys[depth]!
      if (interruptKey !== undefined && key === interruptKey) {
        return { action: "app.interrupt", keys: [interruptKey], layer: -1, interrupt: true }
      }
      const available = pending ?? byFirstKey.get(key) ?? []
      if (!pending) {
        const chords = available.filter((claim) => claim.keys.length > 1)
        if (chords.length === 0) {
          const simple = available.find((claim) => claim.keys.length === 1)
          return simple ? { ...simple, interrupt: false } : undefined
        }
        pending = chords
        continue
      }
      const matches = available.filter((claim) => claim.keys[depth] === key)
      const completed = matches.find((claim) => claim.keys.length === depth + 1)
      if (completed) return { ...completed, interrupt: false }
      const deeper = matches.filter((claim) => claim.keys.length > depth + 1)
      if (deeper.length === 0) return undefined
      pending = deeper
    }
    return undefined
  }
}

/** Build a keymap from the CC defaults plus optional user overrides. */
export function createCcKeymap(options: CcKeymapOptions = {}): CcKeymap {
  return new CcKeymap(options)
}