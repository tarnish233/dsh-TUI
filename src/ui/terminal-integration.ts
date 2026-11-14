/**
 * Terminal presentation adapter (OSC 7501 / OSC 0 / OSC 7 / OSC 777).
 *
 * One small renderer-side controller that turns *native* DSH presentation facts
 * into terminal-owned presentation:
 *
 *   - program status / progress  → `Terminal.setProgramStatus` / `setProgress`
 *   - window/tab title           → `Terminal.setTitle` (+ `saveTitle`/`restoreTitle`)
 *   - current DSH workspace      → OSC 7 (`file://host/path`), never a fake shell prompt
 *   - attention transitions      → one OSC 777 notification, deduplicated
 *
 * Ownership boundaries (docs/TERMINAL-INTEGRATION-CONTRACT.md):
 *
 *   - DSH owns turns, tools, permissions, decisions, titles and durability. This
 *     file owns *presentation only*: no agent loop, no scheduling, no guessed
 *     percentages, no transcript scraping, no `rex` subprocess/socket client.
 *   - The parent App supplies an authorized current-context snapshot from
 *     `render()` and forwards only authorized backend events. The controller
 *     additionally filters by `{sessionId, attachmentId}` and by a durable
 *     watermark, so a restored/replayed `turn/end` can never notify.
 *   - The controller never reads stdin. The parent's existing TUI input
 *     listener calls `handleInput(data, pasting)`; only a custom terminal
 *     *without* `onFocusChange` reaches the exact-`CSI I`/`CSI O` fallback, and
 *     a bracketed paste is never consumed.
 *   - Program status and notifications are transition-keyed, never heartbeats.
 *     Titles depend only on native title/workspace and a static Rex whale;
 *     unchanged frames/tokens are no-ops and this controller owns no timer.
 *
 * Outcome authority (verified native vocabulary):
 *
 *   `session_event` `turn/end` → `data.reason.kind` ∈
 *   `completed | aborted | blocked | error | max-tokens | interrupted | forked`.
 *   Only `completed` reports `done`; only `error` reports `error`. `aborted`
 *   (user/parent/disposed/hook/legacy), `blocked` (a pre-step rejection or
 *   archive gate — **not** a pending permission), `interrupted` and `forked`
 *   return to `idle` with no success notification. `max-tokens` returns to
 *   `idle` with the safe `Output limit reached` metadata and is not a failure.
 *   A tentative/abandoned `stream_end`, an `agent/error`, a `warning`, a native
 *   `command/done` settlement or an arbitrary notice is never a turn outcome.
 */
import { hostname as osHostname } from 'node:os'
import { basename } from 'node:path'
import type {
  BackendEvent,
  DecisionRequest,
  SessionInfo,
  SessionEvent,
  SubagentEntry,
  SubagentStatus,
} from '../backend/types.ts'
import type { ProgramStatus } from '#pi-tui'
import { sanitize } from './text.ts'

/** Stable DSH display identity for titles, notifications and non-Rex status. */
export const TERMINAL_APP_ID = 'dsh-tui'
/** Explicitly selected Rex activity classification; uses its built-in neutral icon. */
const REX_STATUS_APP = 'terminal'

/** Rex title text only; this is not an image upload or another app identity. */
const REX_TITLE_WHALE = '🐳'

/**
 * Records are bounded by the protocol: a terminal must keep 64. One is the
 * root record, so child/decision records never exceed this budget.
 */
export const MAX_CHILD_RECORDS = 63

/** Bounded notification dedupe window; a long session must not grow memory. */
const MAX_NOTIFICATION_KEYS = 64
const MAX_TITLE = 160
const MAX_LABEL = 48
const MAX_NOTIFICATION_BODY = 96

// ---------------------------------------------------------------------------
// Terminal seam (all capabilities optional; baseline builds keep working)

export type TerminalProgramState = 'idle' | 'working' | 'blocked' | 'done' | 'error'

export type TerminalBlockedKind = 'permission' | 'question'

/**
 * The canonical vendored `ProgramStatus`, plus the optional child-record fields
 * the input layer is adding. Reusing the canonical type keeps root writes exact
 * and makes the pending seam extension additive.
 */
export type TerminalProgramStatus = ProgramStatus & {
  /** Child record id (`[A-Za-z0-9_.+-]` segments). Absent = the root record. */
  readonly id?: string
  /** Short human label for a child record. Root labels are never sent. */
  readonly title?: string
  /** Percentage; never sent by this controller (no invented progress). */
  readonly progress?: number
}

/**
 * The narrow terminal surface this controller drives. Every member beyond
 * `setProgramStatus`/`setProgress`/`setTitle` is an approved optional seam:
 * `programStatusSupported`, `onProgramStatusSupportChange`, `setFocusReporting`,
 * `saveTitle`, `restoreTitle`.
 */
export interface TerminalIntegrationTerminal {
  /**
   * Canonical renderer writer (the same one frames go through). The controller
   * never falls back to `process.stdout`, so ownership stays with the renderer.
   */
  write?(data: string): void
  setProgramStatus?(status: TerminalProgramStatus): void
  setProgress?(active: boolean): void
  setTitle?(title: string): void
  /** True once the terminal answered the OSC 7501 query (or an env override). */
  readonly programStatusSupported?: boolean
  /**
   * Fired when support is confirmed/lost (and immediately with the current
   * value), so the controller can re-emit and drop/adjust legacy progress.
   */
  onProgramStatusSupportChange?(listener: (supported: boolean) => void): (() => void) | void
  /** Current focus state, when the terminal exposes it. */
  readonly terminalFocused?: boolean
  /** Focus changes already consumed by the terminal's own input pipeline. */
  onFocusChange?(listener: (focused: boolean) => void): (() => void) | void
  /** Opt-in xterm focus reporting (`CSI ?1004h/l`). */
  setFocusReporting?(enabled: boolean): void
  /**
   * Keep the legacy OSC 9;4 working indicator even when the terminal answers
   * the OSC 7501 query. Ghostty displays progress but not program status, so its
   * GUI needs the fallback regardless of a (library-level) reply.
   */
  setProgressFallback?(enabled: boolean): void
  /** Push/restore the window title around our presentation. */
  saveTitle?(): void
  restoreTitle?(): void
}

// ---------------------------------------------------------------------------
// Public snapshot / options / derived view

/** Authorized current-context identity. A change is a presentation context change. */
export interface TerminalPresentationIdentity {
  readonly sessionId: string
  readonly attachmentId?: string
}

/**
 * The parent's presentation snapshot, taken from the current render. Business
 * facts are native DSH truth. No animation clock, work-progress estimate or
 * second session state is created here.
 */
export interface TerminalPresentationSnapshot {
  /** Current root session info; `title` is the native auto-title projection. */
  readonly info?: SessionInfo
  readonly connected: boolean
  /** A fatal backend/native failure: presentation is released and stays silent. */
  readonly fatal: boolean
  /** `App.isBusy` only: native root work, never aggregated child work. */
  readonly busy: boolean
  /** Current native command ids from App's existing activity map, not a terminal-owned execution list. */
  readonly activeCommandIds?: readonly string[]
  /** Current pending native decisions, in native order. */
  readonly decisions: readonly DecisionRequest[]
  /** Current root child catalog. */
  readonly subagents: readonly SubagentEntry[]
}

/** Existing renderer-owned preferences (`src/config.ts`); no separate icon setting. */
export interface TerminalIntegrationSettings {
  readonly terminalStatus: boolean
  readonly terminalTitle: boolean
  readonly terminalNotifications: 'auto' | 'off' | 'always'
}

/** @deprecated alias kept for early call sites; use {@link TerminalIntegrationSettings}. */
export type TerminalIntegrationPreferences = TerminalIntegrationSettings

/**
 * Allowlisted environment for terminal detection. Re-exported through
 * `AppOptions` by the parent; never the whole process environment and never a
 * native DSH/provider configuration object.
 */
export interface TerminalEnvironment {
  readonly TERM?: string
  readonly TERM_PROGRAM?: string
  readonly TERM_PROGRAM_VERSION?: string
  readonly COLORTERM?: string
  readonly REX_SESSION?: string
  readonly REX_BLOCK?: string
  readonly GHOSTTY_RESOURCES_DIR?: string
  readonly GHOSTTY_BIN_DIR?: string
  readonly PI_PROGRAM_STATUS?: string
}

/** Exactly the keys {@link TerminalEnvironment} may carry. */
export const TERMINAL_ENV_KEYS = [
  'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM',
  'REX_SESSION', 'REX_BLOCK', 'GHOSTTY_RESOURCES_DIR', 'GHOSTTY_BIN_DIR', 'PI_PROGRAM_STATUS',
] as const

/** Build the allowlist from a process-like environment (parent AppOptions). */
export function terminalEnvironment(env: NodeJS.ProcessEnv = process.env): TerminalEnvironment {
  const picked: Record<string, string> = {}
  for (const key of TERMINAL_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string') picked[key] = value
  }
  return picked as TerminalEnvironment
}

export interface TerminalIntegrationOptions {
  readonly terminal: TerminalIntegrationTerminal
  /**
   * Process working directory, used only to restore terminal directory tracking
   * on handoff when the DSH workspace differs. A string or a getter.
   */
  readonly cwd: string | (() => string)
  /**
   * Environment for terminal detection. The parent passes its own
   * `TerminalEnvironment` allowlist (or `process.env`); only the allowlisted
   * keys are ever read, via {@link terminalEnvironment}.
   */
  readonly env?: TerminalEnvironment | NodeJS.ProcessEnv
  /**
   * Sink for the sequences the `Terminal` seam does not expose (OSC 7, OSC 777).
   * The parent passes the same writer the renderer uses.
   */
  readonly write?: (data: string) => void
  /** OSC 7 host component; defaults to the machine hostname. */
  readonly hostname?: () => string
}

/** Recognized terminal families for the notification policy. */
export type TerminalFamily = 'rex' | 'ghostty' | 'other' | 'unknown'

export type TerminalFocusState = 'focused' | 'unfocused' | 'unknown'

/** One derived record (root or child) with its transition key. */
export interface TerminalStatusRecord {
  readonly id?: string
  readonly title?: string
  readonly state: TerminalProgramState | 'clear'
  readonly kind?: TerminalBlockedKind
  readonly message?: string
  /** Stable presentation key; a repeated frame with the same key writes nothing. */
  readonly key: string
}

/** Read-only derived state, for the parent's diagnostics and tests. */
export interface TerminalIntegrationView {
  readonly context: TerminalPresentationIdentity | null
  readonly root: TerminalStatusRecord
  readonly children: readonly TerminalStatusRecord[]
  readonly title: string | null
  /** `file://host/path` for the current DSH workspace, when reportable. */
  readonly workspace: string | null
  readonly focus: TerminalFocusState
  readonly family: TerminalFamily
  readonly programStatusSupported: boolean
  readonly notificationsAllowed: boolean
}

/** Native `turn/end` reason kinds, normalized. `unknown` never changes state. */
export type TerminalTurnOutcomeKind =
  | 'completed'
  | 'error'
  | 'max-tokens'
  | 'interrupted'
  | 'aborted'
  | 'blocked'
  | 'forked'
  | 'unknown'

interface TerminalOutcome {
  readonly kind: TerminalTurnOutcomeKind
  readonly turn: number
  readonly key: string
  /** A native command settlement is a piece of work, never a model-turn settlement. */
  readonly source?: 'command'
}

interface DerivedPresentation {
  readonly root: TerminalStatusRecord
  readonly children: readonly TerminalStatusRecord[]
  readonly title: string | null
  readonly workspace: string | null
  readonly notify: { readonly key: string; readonly body: string } | null
  readonly notificationsAllowed: boolean
}

const IDLE_KEY = 'idle'

const EMPTY_SNAPSHOT: TerminalPresentationSnapshot = {
  connected: false, fatal: false, busy: false, decisions: [], subagents: [],
}

// ---------------------------------------------------------------------------
// Small pure helpers (exported for the offline unit matrix)

/**
 * Deterministic, protocol-safe child record id. The protocol caps ids at 128
 * bytes total / 32 per segment and only allows `[A-Za-z0-9_.+-]`, so the native
 * session id is hashed rather than embedded. Flat ids are deliberate: a root
 * `clear` must not accidentally erase descendants, and child records must not
 * depend on a parent record existing.
 */
export function terminalChildRecordId(seed: string): string {
  return `child-${fnv32(seed, 0x811c9dc5)}${fnv32(seed, 0x9e3779b9)}`
}

function fnv32(text: string, seed: number): string {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Bytes that may never reach a terminal title, record label or notification:
 * C0/C1 controls, DEL, zero-width and bidi embedding/override characters. The
 * protocol already refuses control characters in `msg`/`title`, and a title is
 * shown outside the grid (window lists, screen shares), so bidi overrides are
 * removed rather than passed through.
 */
// ZWJ/ZWNJ are legitimate emoji and language shaping, not direction overrides.
const UNSAFE_TERMINAL_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** Truncate on code-point boundaries so a surrogate pair is never split. */
function truncateCodePoints(text: string, max: number): string {
  if (max <= 0) return ''
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, max).join('')
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let used = 0
  let result = ''
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    used += size
    result += char
  }
  return result
}

/**
 * ANSI/OSC/escape sequences become a separator rather than vanishing, so
 * `bell\x07and` and `bell\x1b[31mansi` stay readable words instead of being
 * glued together (`src/ui/text.ts#sanitize` removes sequences entirely, which
 * is right for transcript text and wrong for a one-line label).
 */
const TERMINAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])/g

/** One-line, control/bidi-free, bounded text for a title/label/body. */
export function terminalSafeText(value: unknown, max: number): string {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  const cleaned = raw
    .replace(TERMINAL_SEQUENCE, ' ')
    .replace(UNSAFE_TERMINAL_TEXT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return truncateUtf8(truncateCodePoints(sanitize(cleaned), max), Math.max(1, max * 4))
}

/** `file://host/path` for an absolute native workspace, or null when unsafe. */
export function terminalFileUrl(path: string, host: string): string | null {
  if (!path.startsWith('/')) return null
  if (UNSAFE_TERMINAL_TEXT.test(path)) {
    UNSAFE_TERMINAL_TEXT.lastIndex = 0
    return null
  }
  const cleanHost = host.replace(/[^A-Za-z0-9._-]/g, '')
  try {
    const encoded = path.split('/').map(segment => encodeURIComponent(segment)).join('/')
    return `file://${cleanHost}${encoded}`
  } catch {
    // A malformed UTF-16 path is not a reportable workspace, never a TUI crash.
    return null
  }
}

/**
 * Terminal family from the allowlisted environment (never a native config read).
 *
 * Explicit identification wins: a Ghostty launched from a Rex shell inherits
 * `REX_SESSION`/`REX_BLOCK` (and `TERM=xterm-ghostty` plus
 * `TERM_PROGRAM=ghostty` stay correct), and a Rex app started from Ghostty can
 * inherit `GHOSTTY_RESOURCES_DIR`. Weak hints are therefore only a fallback.
 * Capability negotiation itself stays brand independent.
 */
export function detectTerminalFamily(env: TerminalEnvironment): TerminalFamily {
  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  if (program === 'rex') return 'rex'
  if (program === 'ghostty') return 'ghostty'
  const term = (env.TERM ?? '').toLowerCase()
  if (term === 'xterm-rex' || term === 'rex') return 'rex'
  if (term.includes('ghostty')) return 'ghostty'
  // Weak hints only when the environment carries no explicit identity.
  if (env.REX_SESSION !== undefined || env.REX_BLOCK !== undefined) return 'rex'
  if (env.GHOSTTY_RESOURCES_DIR !== undefined || env.GHOSTTY_BIN_DIR !== undefined) return 'ghostty'
  if (program === '' && term === '') return 'unknown'
  return 'other'
}

/** Normalize one native `turn/end` reason. Unknown values never change state. */
export function classifyTurnEnd(reason: unknown): TerminalTurnOutcomeKind {
  if (reason === null || typeof reason !== 'object') return 'unknown'
  const kind = (reason as { kind?: unknown }).kind
  switch (kind) {
    case 'completed':
    case 'error':
    case 'max-tokens':
    case 'interrupted':
    case 'aborted':
    case 'blocked':
    case 'forked':
      return kind
    default:
      return 'unknown'
  }
}

function childRank(state: TerminalProgramState | 'clear'): number {
  switch (state) {
    case 'blocked': return 0
    case 'error': return 1
    case 'working': return 2
    case 'done': return 3
    default: return 4
  }
}

function decisionKind(decision: DecisionRequest): TerminalBlockedKind {
  // DSH's native kind is `approval`; the protocol's blocked kind is `permission`.
  return decision.kind === 'question' ? 'question' : 'permission'
}

function blockedMessage(kind: TerminalBlockedKind): string {
  return kind === 'question' ? 'Waiting for your answer' : 'Waiting for approval'
}

function identityOf(snapshot: TerminalPresentationSnapshot): TerminalPresentationIdentity | null {
  const info = snapshot.info
  if (info === undefined) return null
  return info.attachmentId === undefined
    ? { sessionId: info.sessionId }
    : { sessionId: info.sessionId, attachmentId: info.attachmentId }
}

function sameIdentity(left: TerminalPresentationIdentity | null, right: TerminalPresentationIdentity | null): boolean {
  return left?.sessionId === right?.sessionId && left?.attachmentId === right?.attachmentId
}

function eventSeq(event: SessionEvent): number {
  return typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : 0
}

// ---------------------------------------------------------------------------
// Controller

/**
 * Renderer-owned terminal presentation controller.
 *
 * Lifecycle the parent owns:
 *
 * ```ts
 * const integration = new TerminalIntegration({
 *   terminal: tui.terminal,
 *   cwd: () => process.cwd(),
 *   env: terminalEnvironment(),
 *   write: data => tui.terminal.write(data),   // renderer writer
 * })
 * integration.start()          // after TUI start / initial render
 * // in the TUI input listener (before normal dispatch):
 * if (integration.handleInput(data, pasting)) return
 * // in render(), after native state is settled:
 * integration.update({ info, connected, fatal, busy: isBusy, decisions, subagents }, settings)
 * // backend event subscription (authorized current-context events only):
 * unsubscribe = backend.onEvent(event => integration.observe(event))
 * // suspend / external editor / shutdown:
 * integration.pause(); integration.resume(); integration.dispose()
 * ```
 */
export class TerminalIntegration {
  readonly #terminal: TerminalIntegrationTerminal
  readonly #options: TerminalIntegrationOptions
  readonly #write: (data: string) => void
  readonly #family: TerminalFamily
  /**
   * Child records need the extended seam (`id`/`title` formatting). A root-only
   * seam would format a child record as the root record and overwrite it, so on
   * that seam this controller publishes the root record only.
   */
  readonly #childRecordsSupported: boolean
  /** Latest renderer preferences from `update(snapshot, settings)`. */
  #settings: TerminalIntegrationSettings = {
    terminalStatus: true, terminalTitle: true, terminalNotifications: 'auto',
  }
  /** Focus reporting waits for the first native settings snapshot. */
  #settingsKnown = false
  /** Root children that showed live native work in this context (cold rows gate). */
  readonly #liveChildren = new Set<string>()
  /** An accepted live backend event proves the current context is connected. */
  #liveEvidence = false

  #snapshot: TerminalPresentationSnapshot = EMPTY_SNAPSHOT
  #context: TerminalPresentationIdentity | null = null
  /** Durable seq watermark per context: replayed history never produces outcomes. */
  #watermark = 0
  /** Latest accepted durable outcome for this context (null = none/acked). */
  #outcome: TerminalOutcome | null = null
  #acknowledged: string | null = null
  /** A `turn/start` was observed and its `turn/end` has not arrived yet. */
  #liveTurn: number | null = null
  #nativeRunning = false
  /** Presentation correlation only: DSH/App still own command execution and busy state. */
  readonly #commandIds = new Set<string>()

  #started = false
  #paused = false
  #disposed = false
  #halted = false

  #focus: TerminalFocusState = 'unknown'
  #focusReporting = false
  /** The terminal owns focus input; the controller must not consume sequences. */
  #focusEventsAvailable = false
  #progressFallback: boolean | null = null
  #unsubscribeSupport: (() => void) | null = null
  #unsubscribeFocus: (() => void) | null = null

  readonly #notified = new Set<string>()
  /** Last emitted presentation, reset on start/resume/context change to force re-emit. */
  #emittedRootKey: string | null = null
  /** Root presentation key of the previous sync, for transition-only notifications. */
  #previousRootKey: string | null = null
  /** True when this sync changed the root presentation key. */
  #rootTransition = false
  readonly #emittedChildren = new Map<string, string>()
  /** Progress is inactive until we start work; false avoids a redundant write. */
  #emittedProgress: boolean | null = false
  #emittedTitle: string | null = null
  #emittedWorkspace: string | null = null
  #titleSaved = false
  #view: TerminalIntegrationView = {
    context: null,
    root: { state: 'idle', key: IDLE_KEY },
    children: [],
    title: null,
    workspace: null,
    focus: 'unknown',
    family: 'unknown',
    programStatusSupported: false,
    notificationsAllowed: false,
  }

  constructor(options: TerminalIntegrationOptions) {
    this.#options = options
    this.#terminal = options.terminal
    this.#family = detectTerminalFamily(terminalEnvironment(options.env as NodeJS.ProcessEnv | undefined))
    this.#childRecordsSupported = typeof options.terminal.programStatusSupported === 'boolean'
    // Prefer the parent-supplied renderer writer, then the canonical terminal
    // writer. There is deliberately no `process.stdout` fallback: a second
    // writer would bypass the renderer's ownership of the terminal.
    this.#write = options.write ?? ((data: string) => { this.#terminal.write?.(data) })
  }

  // -------------------------------------------------------------------------
  // Public surface

  /** Derived presentation, recomputed from the last `update()`/`observe()`. */
  get view(): TerminalIntegrationView {
    return this.#view
  }

  /** True once the terminal confirmed OSC 7501 (or the env override forced it). */
  get programStatusSupported(): boolean {
    return this.#terminal.programStatusSupported === true
  }

  get isDisposed(): boolean {
    return this.#disposed
  }

  get isPaused(): boolean {
    return this.#paused
  }

  /** Attach to the running terminal: support listener, focus reporting, first sync. */
  start(): void {
    if (this.#disposed) return
    if (this.#halted) this.#notified.delete('halted')
    this.#halted = false
    // Reset before subscribing: the support listener replays the current value
    // immediately, and that replay must not double-emit the first frame.
    this.#resetEmissions()
    if (!this.#started) {
      this.#started = true
      this.#subscribeSupport()
      this.#subscribeFocus()
    }
    this.#paused = false
    this.#applyFocusReporting()
    this.#sync()
  }

  /** Suspend presentation before the terminal is handed to another owner. */
  pause(): void {
    if (this.#disposed) { this.#paused = true; return }
    // Release while this controller still owns the terminal, then latch.
    this.#releasePresentation()
    this.#paused = true
  }

  /** Re-arm after `pause()`, a native reload or a backend reconnect. */
  resume(): void {
    if (this.#disposed) return
    this.#halted = false
    this.start()
  }

  /**
   * Final handoff. Idempotent and silent afterwards: no terminal writes once
   * ownership is relinquished (`dispose()` twice, or any `update()` after it).
   */
  dispose(): void {
    if (this.#disposed) return
    // Release while this controller still owns the terminal, then relinquish:
    // every later `update`/`observe`/`handleInput` is a silent no-op.
    this.#releasePresentation()
    this.#disposed = true
    this.#unsubscribeSupport?.()
    this.#unsubscribeSupport = null
    this.#unsubscribeFocus?.()
    this.#unsubscribeFocus = null
    this.#started = false
    this.#paused = false
  }

  /** Mark the current done/error outcome as seen, returning the record to idle. */
  ack(): void {
    if (this.#outcome === null) return
    this.#acknowledged = this.#outcome.key
    this.#sync()
  }

  /**
   * Consume an exact xterm focus report from the parent's existing TUI input
   * listener. Returns true only for `CSI I` / `CSI O` while this controller owns
   * focus reporting, so paste payloads, chords, keys and replies are never
   * stolen. `pasting` comes from the listener's paste state: paste content can
   * never impersonate a focus report.
   */
  handleInput(data: string, pasting = false): boolean {
    // ProcessTerminal consumes CSI I/O before TUI listeners and reports through
    // `onFocusChange`; only a custom terminal without that API falls back here.
    if (pasting || this.#focusEventsAvailable || !this.#focusReporting || this.#disposed) return false
    if (data === '\x1b[I') {
      this.#focus = 'focused'
      this.#sync()
      return true
    }
    if (data === '\x1b[O') {
      this.#focus = 'unfocused'
      this.#sync()
      return true
    }
    return false
  }

  /** Authorized backend event observer (current context only; filtered again here). */
  observe(event: BackendEvent | { type: 'title'; sessionId: string; attachmentId?: string; value: string | null }): void {
    if (this.#disposed || (this.#halted && event.type !== 'ready')) return
    switch (event.type) {
      case 'ready': {
        // The parent has already applied the native snapshot; adopting identity
        // here clears stale outcomes before the next `update()`.
        const identity = event.info.attachmentId === undefined
          ? { sessionId: event.info.sessionId }
          : { sessionId: event.info.sessionId, attachmentId: event.info.attachmentId }
        this.#setContext(identity)
        this.#adoptWatermark(event.info)
        if (this.#halted) {
          // Ready is the native connection proof. Generic callers may deliver
          // it before their render snapshot; never stay halted on that old cut.
          if (!this.#snapshot.connected || this.#snapshot.fatal || !sameIdentity(identityOf(this.#snapshot), identity)) {
            this.#snapshot = {
              info: event.info, connected: true, fatal: false, busy: false,
              decisions: [], subagents: event.info.subagents?.entries ?? [], activeCommandIds: [],
            }
          }
          this.#halted = false
          this.#liveEvidence = true
          this.#notified.delete('halted')
          this.#applyFocusReporting()
          this.#sync()
        }
        return
      }
      case 'title':
        // Native title lives in the parent's snapshot; the event only invalidates.
        this.#sync()
        return
      case 'status':
        if (!this.#inContext(event.sessionId)) return
        this.#liveEvidence = true
        if (event.status === 'running' && !this.#nativeRunning) {
          this.#outcome = null
          this.#acknowledged = null
        }
        this.#nativeRunning = event.status === 'running'
        if (event.status === 'idle') this.#liveTurn = null
        this.#sync()
        return
      case 'session_event':
        if (!this.#inContext(event.sessionId)) return
        this.#observeSessionEvent(event.event)
        return
      case 'closed':
        if (event.code !== null && event.code !== 0) this.#halt('Session unavailable')
        else { this.#releasePresentation(); this.#resetWorkFacts(); this.#halted = true }
        return
      // Deliberately ignored for presentation: stream_* (tentative, abandoned is
      // a retry not a failure), agent/error (diagnostic before turn/end),
      // warning, metrics, todos, plan, permissions, skills_changed, subagents,
      // subagent, decision/decision_closed (the snapshot is authoritative).
      default:
        return
    }
  }

  /**
   * Parent's native presentation snapshot, called once per render.
   *
   * While paused/disposed the facts are still cached (`resume()` replays the
   * current native state) but nothing is written to the terminal.
   */
  update(snapshot: TerminalPresentationSnapshot, settings: TerminalIntegrationSettings): void {
    if (this.#disposed) return
    this.#snapshot = snapshot
    this.#settings = settings
    this.#settingsKnown = true
    this.#setContext(identityOf(snapshot))
    // Defense in depth: a durable snapshot is history. Even if the parent does
    // not forward `ready`, its events can never become live outcomes.
    if (this.#watermark === 0 && snapshot.info !== undefined) this.#adoptWatermark(snapshot.info)
    this.#applyFocusReporting()
    if (snapshot.fatal) {
      this.#halt('Session unavailable')
      return
    }
    this.#sync()
  }

  // -------------------------------------------------------------------------
  // Context / durability

  #inContext(sessionId: string): boolean {
    return this.#context === null || this.#context.sessionId === sessionId
  }

  /**
   * Adopt a new presentation context. A changed `sessionId` *or* `attachmentId`
   * clears outcomes, children, dedupe memory and emitted keys, so a resumed
   * session cannot inherit another session's record or notification identity.
   * A same-attachment refresh (materialization, capability change, reload) keeps
   * the presentation and therefore never re-notifies.
   */
  #setContext(identity: TerminalPresentationIdentity | null): void {
    if (sameIdentity(this.#context, identity)) return
    const hadContext = this.#context !== null
    this.#context = identity
    this.#watermark = 0
    this.#outcome = null
    this.#acknowledged = null
    this.#liveTurn = null
    this.#nativeRunning = false
    this.#commandIds.clear()
    this.#notified.clear()
    this.#liveChildren.clear()
    this.#liveEvidence = false
    // Clear the previous context's records *before* dropping ownership of their
    // ids; otherwise the seam keeps replaying stale children for the new session.
    // Adopting the very first context owns no prior records, so it stays silent.
    if (hadContext && this.#canWrite()) this.#clearStatusRecords()
    this.#emittedRootKey = null
    this.#previousRootKey = null
    // Title/workspace ownership survives a context change: the new title is a
    // plain `setTitle`, never a second `saveTitle` push.
  }

  /** Durable snapshot events are history, not live outcomes: ignore them by seq. */
  #adoptWatermark(info: SessionInfo): void {
    const events = info.events ?? []
    let maximum = 0
    for (const event of events) maximum = Math.max(maximum, eventSeq(event))
    this.#watermark = Math.max(this.#watermark, maximum)
  }

  #observeSessionEvent(event: SessionEvent): void {
    if (eventSeq(event) > 0 && eventSeq(event) <= this.#watermark) return
    if (eventSeq(event) > this.#watermark) this.#watermark = eventSeq(event)
    if (event.type === 'turn/start' || event.type === 'turn/end') this.#liveEvidence = true
    switch (event.type) {
      case 'turn/start': {
        const turn = turnNumber(event.data)
        if (turn !== null) this.#liveTurn = turn
        // A new turn supersedes the previous settlement: otherwise an older
        // `done` would resurface once this turn ends idle/cancelled.
        this.#outcome = null
        this.#acknowledged = null
        this.#sync()
        return
      }
      case 'turn/end': {
        const data = event.data
        const turn = turnNumber(data) ?? this.#liveTurn ?? 0
        const reason = data !== null && typeof data === 'object' ? (data as { reason?: unknown }).reason : undefined
        const kind = classifyTurnEnd(reason)
        this.#liveTurn = null
        if (kind === 'unknown') {
          // Never guess a terminal outcome from an unrecognized reason.
          this.#sync()
          return
        }
        this.#outcome = { kind, turn, key: `${this.#context?.sessionId ?? ''}:${turn}:${kind}` }
        this.#sync()
        return
      }
      case 'command/run':
      case 'command/done': {
        const data = event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data)
          ? event.data as Record<string, unknown> : undefined
        const id = data?.commandId
        if (typeof id !== 'string' || id === '' || id.length > 256) return
        if (event.type === 'command/run') {
          this.#commandIds.add(id)
          while (this.#commandIds.size > MAX_NOTIFICATION_KEYS) {
            const oldest = this.#commandIds.values().next().value
            if (oldest === undefined) break
            this.#commandIds.delete(oldest)
          }
          this.#outcome = null
          this.#acknowledged = null
        } else if ((this.#commandIds.delete(id) || this.#snapshot.activeCommandIds?.includes(id)) &&
          (data?.kind === 'success' || data?.kind === 'error')) {
          this.#outcome = {
            source: 'command', kind: data.kind === 'success' ? 'completed' : 'error', turn: 0,
            key: `command:${id}:${data.kind}`,
          }
          this.#acknowledged = null
        }
        this.#sync()
        return
      }
      default:
        // User/assistant/tool records and attempt settlements do not describe
        // a terminal work outcome. Native commands above stay distinct from turns.
        return
    }
  }

  /**
   * A native fatal failure or a closed transport: publish one bounded, generic
   * error while this controller still owns the terminal, then stop writing.
   * Nothing is derived from a raw native error/stack, and a disposed or already
   * restored presenter stays silent.
   */
  #halt(message: string): void {
    if (this.#halted || this.#disposed) return
    if (this.#canWrite()) {
      this.#clearStatusRecords()
      if (this.#settings.terminalStatus) {
        this.#emittedRootKey = 'halted'
        this.#terminal.setProgramStatus?.({ state: 'error', app: this.#statusAppId(), message })
      }
      if (this.#notificationsAllowed('error') && !this.#notified.has('halted')) {
        this.#rememberNotification('halted')
        this.#notify(message)
      }
      if (this.#emittedProgress !== false) {
        this.#terminal.setProgress?.(false)
        this.#emittedProgress = false
      }
      this.#restoreTitle()
      this.#restoreWorkspace()
      this.#setFocusReporting(false)
    }
    this.#resetWorkFacts()
    this.#halted = true
  }

  /** Once the native transport stops, its late events are not resumable work facts. */
  #resetWorkFacts(): void {
    this.#outcome = null
    this.#acknowledged = null
    this.#liveTurn = null
    this.#nativeRunning = false
    this.#commandIds.clear()
    this.#liveEvidence = false
  }

  // -------------------------------------------------------------------------
  // Writes

  #canWrite(): boolean {
    return this.#started && !this.#paused && !this.#disposed && !this.#halted
  }

  /**
   * Releasing is allowed after a halt: a fatal/closed transport stops *new*
   * presentation, but the records it published are still ours to clear on
   * pause/dispose. Nothing is written after `dispose()` latches.
   */
  #canRelease(): boolean {
    return this.#started && !this.#disposed && !this.#paused
  }

  #releasePresentation(): void {
    if (!this.#canRelease()) return
    this.#clearStatusRecords()
    if (this.#emittedProgress !== false) {
      this.#terminal.setProgress?.(false)
      this.#emittedProgress = false
    }
    this.#restoreTitle()
    this.#restoreWorkspace()
    this.#setFocusReporting(false)
  }

  /**
   * Remove every record this controller owns. Explicit per-child clears come
   * first: a root `clear` must not be the only path, so a shared terminal can
   * never keep a stale child record after a preference change or handoff.
   */
  #clearStatusRecords(): void {
    if (this.#emittedRootKey === null && this.#emittedChildren.size === 0) return
    for (const id of this.#emittedChildren.keys()) {
      this.#terminal.setProgramStatus?.({ state: 'clear', id })
    }
    this.#emittedChildren.clear()
    this.#terminal.setProgramStatus?.({ state: 'clear' })
    this.#emittedRootKey = null
  }

  #resetEmissions(): void {
    this.#emittedRootKey = null
    this.#emittedChildren.clear()
    this.#emittedProgress = false
    this.#emittedTitle = null
    this.#emittedWorkspace = null
    this.#titleSaved = false
    this.#progressFallback = null
  }

  #restoreTitle(): void {
    if (this.#emittedTitle === null) return
    this.#emittedTitle = null
    this.#titleSaved = false
    this.#terminal.restoreTitle?.()
  }

  #restoreWorkspace(): void {
    const previous = this.#emittedWorkspace
    this.#emittedWorkspace = null
    if (previous === null) return
    const cwd = this.#processCwd()
    const restored = terminalFileUrl(cwd, this.#hostname())
    if (restored === null || restored === previous) return
    this.#write(`\x1b]7;${restored}\x1b\\`)
  }

  #processCwd(): string {
    try {
      const source = this.#options.cwd
      return typeof source === 'function' ? source() : source
    } catch {
      return ''
    }
  }

  #hostname(): string {
    try {
      return (this.#options.hostname ?? (() => osHostname() || ''))()
    } catch {
      return ''
    }
  }

  #subscribeSupport(): void {
    if (this.#unsubscribeSupport !== null) return
    const subscribe = this.#terminal.onProgramStatusSupportChange
    if (typeof subscribe !== 'function') return
    const off = subscribe.call(this.#terminal, (supported: boolean) => {
      // A terminal that just confirmed support must not keep a legacy OSC 9;4
      // heartbeat, and must receive the current record again.
      if (supported) {
        if (this.#emittedProgress === true) {
          this.#terminal.setProgress?.(false)
          this.#emittedProgress = false
        }
        // Replay the current record on the new channel without disturbing title
        // or workspace ownership (a reset here would leak a second saveTitle
        // push and rewrite OSC 7 for nothing).
        this.#clearStatusRecords()
        this.#applyFocusReporting()
        this.#applyProgressFallback()
      }
      this.#sync()
    })
    if (typeof off === 'function') this.#unsubscribeSupport = off
  }

  /**
   * Prefer the terminal's own focus event API. Reading `terminalFocused` once
   * gives `auto` a positive initial answer; later changes arrive as events, so
   * this controller never parses raw stdin itself.
   */
  #subscribeFocus(): void {
    if (this.#unsubscribeFocus !== null) return
    const onChange = this.#terminal.onFocusChange
    if (typeof onChange !== 'function') return
    const off = onChange.call(this.#terminal, (focused: boolean) => {
      this.#focus = focused ? 'focused' : 'unfocused'
      this.#sync()
    })
    this.#focusEventsAvailable = true
    if (typeof off === 'function') this.#unsubscribeFocus = off
    const current = this.#terminal.terminalFocused
    if (typeof current === 'boolean') this.#focus = current ? 'focused' : 'unfocused'
  }

  #applyFocusReporting(): void {
    const wanted = this.#wantFocusReporting()
    this.#setFocusReporting(wanted)
  }

  #wantFocusReporting(): boolean {
    if (!this.#canWrite() || !this.#settingsKnown) return false
    // Only the automatic policy needs focus evidence; `always` and `off` never do.
    return this.#settings.terminalNotifications === 'auto'
  }

  #setFocusReporting(enabled: boolean): void {
    if (enabled === this.#focusReporting) return
    if (typeof this.#terminal.setFocusReporting !== 'function') {
      // Legacy seam: notifications under `auto` stay silent without focus proof.
      this.#focusReporting = false
      return
    }
    this.#focusReporting = enabled
    this.#terminal.setFocusReporting(enabled)
    if (!enabled) this.#focus = 'unknown'
  }

  // -------------------------------------------------------------------------
  // Derivation + emission

  #sync(): void {
    const snapshot = this.#snapshot
    const preferences = this.#settings
    const derived = this.#derive(snapshot, preferences)
    // A notification belongs to a *transition*, not to any re-sync (focus
    // changes, preference edits and repeated frames must not re-announce work).
    this.#rootTransition = derived.root.key !== this.#previousRootKey
    this.#previousRootKey = derived.root.key
    this.#view = {
      context: this.#context,
      root: derived.root,
      children: derived.children,
      title: derived.title,
      workspace: derived.workspace,
      focus: this.#focus,
      family: this.#family,
      programStatusSupported: this.programStatusSupported,
      notificationsAllowed: derived.notificationsAllowed,
    }
    if (!this.#canWrite()) return
    this.#apply(snapshot, preferences, derived)
  }

  #derive(snapshot: TerminalPresentationSnapshot, preferences: TerminalIntegrationPreferences): DerivedPresentation {
    const managed = preferences.terminalStatus
    const children = this.#deriveChildren(snapshot)
    // Root status is the App's native root busy/decision/outcome only: child
    // work is represented by child records that coexist with an idle root.
    // The logical state is always derived; `terminalStatus` only decides whether
    // it is published, so an explicit notification policy stays independent.
    const { state, kind, message, key } = this.#deriveRoot(snapshot)
    const root: TerminalStatusRecord = { state, kind, message, key }
    const title = preferences.terminalTitle ? this.#deriveTitle(snapshot) : null
    // Working-directory truth is independent of window-title presentation.
    const workspace = this.#deriveWorkspace(snapshot)
    const notificationsAllowed = this.#notificationsAllowed(state)
    // `terminalNotifications` and `terminalStatus` are independent preferences:
    // status off must not silence an explicitly requested notification policy.
    const notify = notificationsAllowed && this.#isConnected()
      ? this.#deriveNotification(state, kind, key)
      : null
    return {
      root,
      children: managed && this.#childRecordsSupported ? children : [],
      title,
      workspace,
      notify,
      notificationsAllowed,
    }
  }

  #deriveRoot(snapshot: TerminalPresentationSnapshot): {
    state: TerminalProgramState
    kind?: TerminalBlockedKind
    message?: string
    key: string
  } {
    if (!this.#isConnected()) return { state: 'idle', key: 'idle:disconnected' }
    const decision = snapshot.decisions[0]
    if (decision !== undefined) {
      const kind = decisionKind(decision)
      const label = terminalSafeText(decision.origin?.label ?? '', MAX_LABEL)
      const message = label === '' ? blockedMessage(kind) : `${label}: ${blockedMessage(kind)}`
      return { state: 'blocked', kind, message, key: `blocked:${kind}:${decision.id}:${message}` }
    }
    // A durable settlement outranks a still-running busy snapshot: DSH appends
    // `turn/end` before `status: idle`, and a new `turn/start` clears it again.
    const outcome = this.#visibleOutcome()
    if (this.#commandIds.size > 0 || (snapshot.activeCommandIds?.length ?? 0) > 0 ||
      (this.#liveTurn !== null && outcome?.source === 'command')) {
      return { state: 'working', message: 'Working', key: 'working' }
    }
    if (outcome !== null) {
      switch (outcome.kind) {
        case 'completed':
          return outcome.source === 'command'
            ? { state: 'done', message: 'Command complete', key: `done:${outcome.key}` }
            : { state: 'done', message: 'Turn complete', key: `done:${outcome.turn}` }
        case 'error':
          return outcome.source === 'command'
            ? { state: 'error', message: 'Command failed', key: `error:${outcome.key}` }
            : { state: 'error', message: 'Turn failed', key: `error:${outcome.turn}` }
        case 'max-tokens':
          // A lossy native fact: idle with bounded metadata, never a fake failure.
          return { state: 'idle', message: 'Output limit reached', key: `max-tokens:${outcome.turn}` }
        default:
          // aborted/blocked/interrupted/forked: cancellation reports idle.
          return { state: 'idle', key: IDLE_KEY }
      }
    }
    if (snapshot.busy || this.#nativeRunning || this.#liveTurn !== null) {
      return { state: 'working', message: 'Working', key: 'working' }
    }
    return { state: 'idle', key: IDLE_KEY }
  }

  #isConnected(): boolean {
    return this.#snapshot.connected || this.#liveEvidence
  }

  #visibleOutcome(): TerminalOutcome | null {
    const outcome = this.#outcome
    if (outcome === null) return null
    if (this.#acknowledged !== null && this.#acknowledged === outcome.key) return null
    return outcome
  }

  /**
   * Bounded child/decision records. Native catalog entries only: a child keeps
   * its truthful native state, a pending decision attributed to a child marks
   * that record blocked, and nothing external/cold is presented as live work.
   */
  #deriveChildren(snapshot: TerminalPresentationSnapshot): TerminalStatusRecord[] {
    const currentIds = new Set(snapshot.subagents.map(entry => entry.id))
    for (const decision of snapshot.decisions) {
      if (decision.origin?.childSessionId !== undefined) currentIds.add(decision.origin.childSessionId)
    }
    for (const id of this.#liveChildren) if (!currentIds.has(id)) this.#liveChildren.delete(id)
    const decisionsByChild = new Map<string, DecisionRequest>()
    for (const decision of snapshot.decisions) {
      const childId = decision.origin?.childSessionId
      if (childId === undefined) continue
      if (!decisionsByChild.has(childId)) decisionsByChild.set(childId, decision)
    }
    const seen = new Set<string>()
    const candidates: TerminalStatusRecord[] = []
    for (const entry of snapshot.subagents) {
      // The snapshot is already the current native tree (direct and nested
      // children), so it is never re-filtered by parentSessionId. A cold
      // `external`/`unknown` row is not current-tree live work: it is skipped
      // unless a native decision attributes itself to it.
      if (decisionsByChild.get(entry.id) === undefined && (entry.status === 'external' || entry.status === 'unknown')) continue
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      const decision = decisionsByChild.get(entry.id)
      if (entry.status === 'running') this.#liveChildren.add(entry.id)
      const state = decision === undefined ? this.#childPresentationState(entry) : 'blocked'
      const kind = decision === undefined ? undefined : decisionKind(decision)
      const label = nativeChildLabel(entry, decision)
      candidates.push({
        id: terminalChildRecordId(`${snapshot.info?.sessionId ?? ''}/${entry.id}`),
        title: label,
        state,
        ...(kind === undefined ? {} : { kind }),
        key: `${state}:${kind ?? ''}:${label}`,
      })
    }
    // A decision attributed to a child that the bounded catalog has not listed
    // yet still needs a bounded record; it is native truth, not a guess.
    for (const [childId, decision] of decisionsByChild) {
      if (seen.has(childId)) continue
      seen.add(childId)
      const kind = decisionKind(decision)
      const label = terminalSafeText(decision.origin?.label ?? '', MAX_LABEL) || 'Child session'
      candidates.push({
        id: terminalChildRecordId(`${snapshot.info?.sessionId ?? ''}/${childId}`),
        title: label,
        state: 'blocked',
        kind,
        key: `blocked:${kind}:${label}`,
      })
    }
    candidates.sort((left, right) => {
      const rank = childRank(left.state) - childRank(right.state)
      if (rank !== 0) return rank
      return (left.title ?? '').localeCompare(right.title ?? '')
    })
    return candidates.slice(0, MAX_CHILD_RECORDS)
  }

  /**
   * A child's presentation state. A cold catalog read (a durable session with no
   * process-local activation identity that never showed live work in this
   * context) may say `idle` but must never create new completion/error
   * attention for work this session did not observe.
   */
  #childPresentationState(entry: SubagentEntry): TerminalProgramState {
    // Live-work evidence is a process-local native activation identity or work
    // this context actually observed running. A restored/cold catalog row has
    // neither, so it may look idle but never announces historical attention.
    const live = entry.lastRunId !== undefined || this.#liveChildren.has(entry.id)
    switch (entry.status) {
      case 'running':
        return 'working'
      case 'initializing':
        // Only an accepted native activation may look like work.
        return live ? 'working' : 'idle'
      case 'completed':
        return live ? 'done' : 'idle'
      case 'failed':
      case 'max-tokens':
      case 'refusal':
        return live ? 'error' : 'idle'
      // idle/stopped/unknown/external: never live work.
      default:
        return 'idle'
    }
  }

  #deriveTitle(snapshot: TerminalPresentationSnapshot): string {
    const native = nativeSessionTitle(snapshot.info)
    let title: string
    if (native !== '') title = `${terminalSafeText(native, MAX_TITLE)} — ${TERMINAL_APP_ID}`
    else {
      const workspace = snapshot.info?.cwd ?? this.#processCwd()
      const name = terminalSafeText(basename(workspace), 64)
      title = name === '' ? TERMINAL_APP_ID : `${TERMINAL_APP_ID} · ${name}`
    }
    return this.#family === 'rex' ? `${REX_TITLE_WHALE} ${title}` : title
  }

  #deriveWorkspace(snapshot: TerminalPresentationSnapshot): string | null {
    const workspace = snapshot.info?.cwd
    if (typeof workspace !== 'string' || workspace === '') return null
    return terminalFileUrl(workspace, this.#hostname())
  }

  /**
   * Explicit-notification policy. `off` disables only our own one-shot
   * notifications (the terminal still displays published status), `always`
   * forces them on transitions even when the terminal shows status natively,
   * and `auto` requires *positive* evidence: a recognized terminal whose GUI
   * ignores OSC 7501 (Ghostty) plus an exact `CSI O` focus report.
   */
  #notificationsAllowed(state: TerminalProgramState): boolean {
    const mode = this.#settings.terminalNotifications
    if (mode === 'off') return false
    const notifiable = state === 'blocked' || state === 'done' || state === 'error'
    if (!notifiable) return false
    if (mode === 'always') return true
    // auto: only Ghostty is known to accept a query yet not present program
    // status in its GUI, so only it may be notified explicitly. Rex (and any
    // other 7501 terminal) owns attention natively. This decision is
    // deliberately independent of `programStatusSupported`: a terminal may
    // parse OSC 7501 and still show nothing.
    if (this.#family !== 'ghostty' && !(this.#family === 'rex' && !this.#settings.terminalStatus)) return false
    return this.#focus === 'unfocused'
  }

  #deriveNotification(
    state: TerminalProgramState,
    kind: TerminalBlockedKind | undefined,
    rootKey: string,
  ): { key: string; body: string } | null {
    const context = this.#context?.sessionId ?? ''
    if (state === 'blocked') {
      // Per current native request, never a joined set: a second pending
      // decision must not re-notify the first one.
      const current = this.#snapshot.decisions[0]?.id ?? ''
      return {
        key: `blocked:${context}:${current}`,
        body: blockedMessage(kind ?? 'permission'),
      }
    }
    const command = this.#visibleOutcome()?.source === 'command'
    if (state === 'done') return { key: `done:${context}:${rootKey}`, body: command ? 'Command complete' : 'Turn complete' }
    if (state === 'error') return { key: `error:${context}:${rootKey}`, body: command ? 'Command failed' : 'Turn failed' }
    return null
  }

  #apply(
    snapshot: TerminalPresentationSnapshot,
    preferences: TerminalIntegrationPreferences,
    derived: DerivedPresentation,
  ): void {
    this.#applyTitle(derived.title)
    this.#applyWorkspace(derived.workspace)
    if (preferences.terminalStatus) {
      this.#applyChildren(derived.children)
      this.#applyRoot(derived.root)
    } else {
      // `terminalStatus` off owns nothing: drop our records (the terminal's own
      // display of anything already published is unaffected).
      this.#clearStatusRecords()
    }
    this.#applyProgress(preferences, derived.root)
    if (this.#rootTransition && derived.notify !== null && !this.#notified.has(derived.notify.key)) {
      this.#rememberNotification(derived.notify.key)
      this.#notify(derived.notify.body)
    }
    void snapshot
  }

  #statusAppId(): string {
    // The user explicitly accepted generic Rex activity grouping to obtain the
    // neutral terminal icon. This never changes native DSH identity or titles.
    return this.#family === 'rex' ? REX_STATUS_APP : TERMINAL_APP_ID
  }

  #applyRoot(root: TerminalStatusRecord): void {
    if (this.#emittedRootKey === root.key) return
    this.#emittedRootKey = root.key
    this.#terminal.setProgramStatus?.({
      state: root.state,
      app: this.#statusAppId(),
      ...(root.kind === undefined ? {} : { kind: root.kind }),
      ...(root.message === undefined || root.message === '' ? {} : { message: root.message }),
    })
  }

  #applyChildren(children: readonly TerminalStatusRecord[]): void {
    const next = new Set(children.flatMap(child => child.id === undefined ? [] : [child.id]))
    // Retire old ids first. A transient 64+ record burst would otherwise evict
    // the unchanged root in both the terminal and the bounded replay store.
    for (const id of this.#emittedChildren.keys()) {
      if (next.has(id)) continue
      this.#emittedChildren.delete(id)
      this.#terminal.setProgramStatus?.({ state: 'clear', id })
    }
    for (const child of children) {
      if (child.id === undefined) continue
      if (this.#emittedChildren.get(child.id) === child.key) continue
      this.#emittedChildren.set(child.id, child.key)
      this.#terminal.setProgramStatus?.({
        state: child.state,
        app: this.#statusAppId(),
        id: child.id,
        ...(child.title === undefined || child.title === '' ? {} : { title: child.title }),
        ...(child.kind === undefined ? {} : { kind: child.kind }),
        ...(child.message === undefined ? {} : { message: child.message }),
      })
    }
  }

  /**
   * Ghostty's GUI shows progress but not program status, so ask the seam to keep
   * the OSC 9;4 fallback there even after a 7501 reply; every other host stays
   * automatic (fallback only while rich support is unconfirmed).
   */
  #applyProgressFallback(): void {
    // Only Ghostty opts in explicitly (its GUI shows progress but not program
    // status). Every other host keeps the seam's automatic policy; sending
    // `false` there would disable the fallback for terminals that need it.
    if (this.#family !== 'ghostty') return
    if (this.#progressFallback === true) return
    this.#progressFallback = true
    this.#terminal.setProgressFallback?.(true)
  }

  #applyProgress(preferences: TerminalIntegrationPreferences, root: TerminalStatusRecord): void {
    const supported = this.programStatusSupported
    // Legacy OSC 9;4 is an indeterminate fallback only and never carries a
    // percentage. Ghostty displays OSC 9;4 but not OSC 7501, so it keeps the
    // legacy indicator even when it answers the status query (verified:
    // `progress-style` defaults to true). Every other terminal drops it once
    // rich support is confirmed — Rex maps OSC 9;4 onto the root record, which
    // would erase `kind`/`msg`.
    this.#applyProgressFallback()
    const keepLegacy = !supported || this.#family === 'ghostty'
    const wanted = preferences.terminalStatus && keepLegacy && root.state === 'working'
    if (wanted === this.#emittedProgress) return
    this.#emittedProgress = wanted
    this.#terminal.setProgress?.(wanted)
  }

  #applyTitle(title: string | null): void {
    if (title === null) {
      this.#restoreTitle()
      return
    }
    if (this.#emittedTitle === title) return
    if (!this.#titleSaved) {
      this.#titleSaved = true
      this.#terminal.saveTitle?.()
    }
    this.#emittedTitle = title
    this.#terminal.setTitle?.(title)
  }

  #applyWorkspace(workspace: string | null): void {
    if (workspace === null) {
      this.#restoreWorkspace()
      return
    }
    if (this.#emittedWorkspace === workspace) return
    this.#emittedWorkspace = workspace
    this.#write(`\x1b]7;${workspace}\x1b\\`)
  }

  #rememberNotification(key: string): void {
    this.#notified.add(key)
    while (this.#notified.size > MAX_NOTIFICATION_KEYS) {
      const oldest = this.#notified.values().next().value
      if (oldest === undefined) break
      this.#notified.delete(oldest)
    }
  }

  /** One OSC 777 notification; the body is a fixed, privacy-safe phrase. */
  #notify(body: string): void {
    const safe = terminalSafeText(body, MAX_NOTIFICATION_BODY)
    if (safe === '') return
    this.#write(`\x1b]777;notify;${TERMINAL_APP_ID};${safe}\x07`)
  }
}

/**
 * Native auto-title projection. Read structurally so this adapter compiles both
 * before and after `SessionInfo.title` lands in the shared type.
 */
function nativeSessionTitle(session: SessionInfo | undefined): string {
  if (session === undefined) return ''
  const value = (session as { title?: unknown }).title
  return typeof value === 'string' ? value.trim() : ''
}

function turnNumber(data: unknown): number | null {
  if (data === null || typeof data !== 'object') return null
  const value = (data as { turn?: unknown }).turn
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nativeChildLabel(entry: SubagentEntry, decision: DecisionRequest | undefined): string {
  const candidates = [entry.label, decision?.origin?.label]
  for (const candidate of candidates) {
    const label = terminalSafeText(candidate ?? '', MAX_LABEL)
    if (label !== '') return label
  }
  return 'Child session'
}
