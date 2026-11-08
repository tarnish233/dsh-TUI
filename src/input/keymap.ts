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
  code: "unknown-action" | "invalid-binding" | "conflict" | "byte-ambiguous" | "chord-shadow" | "invalid-config"
  message: string
  action?: string
  otherAction?: string
  context?: CcContext
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
 * Contexts where the configured simple `app.interrupt` key always wins over
 * a local binding (list.cancel also binds Ctrl+C) *and* over a pending chord.
 * That makes Ctrl+C an unconditional escape hatch from a read-only details
 * modal, the read-only Agents surface, the /model picker and the unified modal
 * surfaces (Settings, Keyboard shortcuts, generic modal lists, queue and their
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
      (diagnostic) => diagnostic.code === "conflict" || diagnostic.code === "byte-ambiguous" || diagnostic.code === "chord-shadow",
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
    const diagnostics: CcKeymapDiagnostic[] = []
    this.bindingsByAction = new Map()
    this.index = new Map()

    for (const actionId of Object.keys(this.userConfig)) {
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
      const hasOverride = Object.prototype.hasOwnProperty.call(this.userConfig, action.id)
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
        const override = this.userConfig[action.id]
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
      this.bindingsByAction.set(action.id, compiled)
      for (const context of action.contexts) {
        let list = this.index.get(context)
        if (!list) {
          list = []
          this.index.set(context, list)
        }
        list.push(...compiled)
      }
    }

    this.detectConflicts(diagnostics)
    this.diagnostics = diagnostics
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
            message: `${candidate.action.id} binds "${prefixKey}" but ${binding.action.id} uses it as a chord prefix in context "${context}"; the single key only fires after the chord timeout.`,
          })
        }
      }
    }
  }
}

/** Build a keymap from the CC defaults plus optional user overrides. */
export function createCcKeymap(options: CcKeymapOptions = {}): CcKeymap {
  return new CcKeymap(options)
}