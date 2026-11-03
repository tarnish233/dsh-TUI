/**
 * Real DSH backend for the TUI.
 *
 * One backend owns one private DSH runtime process (the actual `dsh`
 * launcher) and exactly one root Agent inside it. Live assistant tokens are
 * forwarded from the process-local `agent/assistant-stream`; durable
 * settlements keep flowing from `session/event`. Commands report only what the
 * runtime actually mounts, and every capability that is not available is
 * rejected with a stable code instead of being faked.
 *
 * @module dsh-pi-tui/backend/client
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backendError, asBackendError, type BackendError, type BackendErrorCode } from './errors.ts'
import { resolveDshInstall, type DshInstall } from './discover.ts'
import {
  BRIDGE_FD,
  LineDecoder,
  encodeLine,
  normalizeSessionInfo,
  parseRuntimeMessage,
  type BridgeRuntimeMessage,
} from './protocol.ts'
import { prepareWorkspace, syncWorkspace, type RuntimeWorkspace } from './runtime-home.ts'
import { loadNativeHelpers, type NativeHelpers } from './native-codec.ts'
import { planProfile, type ProfilePlan } from './native-profile.ts'
import type { Backend, BackendEvent, DshOptions, JsonRecord, SessionInfo, TranscriptCodec } from './types.ts'

const BRIDGE_PATH = fileURLToPath(new URL('../../runtime/bridge.mjs', import.meta.url))
const CONNECT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000
const COMMAND_TIMEOUT_MS = 200_000
const CATALOG_TIMEOUT_MS = 180_000
const CLOSE_TIMEOUT_MS = 20_000
const KILL_GRACE_MS = 4_000

/** Env override for timeouts (tests use short values). Invalid values are ignored. */
function envTimeout(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 50 || parsed > 3_600_000) return fallback
  return parsed
}

function requestTimeout(fallback = REQUEST_TIMEOUT_MS): number {
  return envTimeout('DSH_PI_TUI_REQUEST_TIMEOUT_MS', fallback)
}

function closeTimeout(): number {
  return envTimeout('DSH_PI_TUI_CLOSE_TIMEOUT_MS', CLOSE_TIMEOUT_MS)
}
function suppressionKey(plan: ProfilePlan | undefined): string {
  return (plan?.suppressedRows ?? [])
    .map(row => row.id + '\u0000' + row.name)
    .sort()
    .join('\n')
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

const LOG_TAIL_BYTES = 16 * 1024
const DEBUG = process.env.DSH_PI_TUI_DEBUG === '1'
const DEBUG_LOG = process.env.DSH_PI_TUI_DEBUG_LOG ?? join(tmpdir(), 'dsh-pi-tui-debug-' + process.pid + '.log')
function debugLine(text: string): void {
  if (!DEBUG) return
  try { appendFileSync(DEBUG_LOG, redactSecrets(text) + '\n', { mode: 0o600 }) } catch { /* debug logging must not break rendering */ }
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  method: string
}

interface RuntimeExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/** Bounded diagnostics tail; secrets are redacted before it is ever surfaced. */
class LogTail {
  private chunks: string[] = []
  private bytes = 0

  push(chunk: string): void {
    const data = Buffer.from(chunk, 'utf8')
    if (data.length > LOG_TAIL_BYTES) chunk = data.subarray(data.length - LOG_TAIL_BYTES).toString('utf8')
    this.chunks.push(chunk)
    this.bytes += Buffer.byteLength(chunk)
    while (this.bytes > LOG_TAIL_BYTES && this.chunks.length > 1) {
      const removed = this.chunks.shift()
      if (removed !== undefined) this.bytes -= Buffer.byteLength(removed)
    }
  }

  text(): string {
    return redactSecrets(this.chunks.join('')).trim()
  }
}

function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer <redacted>')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*["']?\s*[:=]\s*["']?)\S+/gi, '$1<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
}

/** One spawned runtime process and its NDJSON control plane. */
class RuntimeProcess {
  private readonly install: DshInstall
  private readonly options: DshOptions
  private readonly workspace: RuntimeWorkspace
  private readonly callbacks: {
    onEvent(event: BackendEvent): void
    onExit(exit: RuntimeExit): void
  }
  private child: ChildProcess | undefined
  private decoder = new LineDecoder()
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private exited = false
  private closing = false
  private exitInfo: RuntimeExit | undefined
  private exitWaiters: Array<(exit: RuntimeExit) => void> = []
  private helloResolve: ((value: { capabilities: string[]; hasModelSelection: boolean }) => void) | undefined
  private helloReject: ((error: Error) => void) | undefined
  private readonly log = new LogTail()

  constructor(
    install: DshInstall,
    options: DshOptions,
    workspace: RuntimeWorkspace,
    callbacks: { onEvent(event: BackendEvent): void; onExit(exit: RuntimeExit): void },
  ) {
    this.install = install
    this.options = options
    this.workspace = workspace
    this.callbacks = callbacks
  }

  diagnostics(): string {
    return this.log.text()
  }

  /** Spawn the launcher and resolve once the bridge handshake arrives. */
  start(): Promise<{ capabilities: string[]; hasModelSelection: boolean }> {
    const hello = new Promise<{ capabilities: string[]; hasModelSelection: boolean }>((resolve, reject) => {
      this.helloResolve = resolve
      this.helloReject = reject
    })
    this.spawn()
    return hello
  }

  private spawn(): void {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: this.workspace.homeDir,
      DSH_PI_TUI_BRIDGE: JSON.stringify({
        cwd: this.options.cwd,
        dshPackageJsonPath: this.install.packageJsonPath,
        ...(this.options.resume === undefined ? {} : { resume: this.options.resume }),
        ...(this.options.provider === undefined ? {} : { provider: this.options.provider }),
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        ...(this.install.agentModuleUrl === undefined ? {} : { agentModuleUrl: this.install.agentModuleUrl }),
      }),
    }
    // A replay snapshot or a desktop-managed profile would change what the
    // launcher composes; neither belongs in a private runtime home.
    delete env.DSH_SNAPSHOT
    let child: ChildProcess
    try {
      // Native launcher composition: bundle layers, the profile's own patch,
      // the home patch, then this application's bridge overlay.
      const args = [this.install.binPath, '--profile', this.workspace.profileName, '--patch', this.workspace.patchPath]
      child = spawn(process.execPath, args, {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw backendError('SPAWN_FAILED', `failed to start dsh: ${String(error)}`)
    }
    this.child = child
    liveRuntimes.add(this)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.log.push(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.log.push(chunk))
    const protocolStream = child.stdio[BRIDGE_FD] as Readable | null | undefined
    if (protocolStream === null || protocolStream === undefined) {
      this.failPending(backendError('SPAWN_FAILED', 'runtime control channel was not created'))
      return
    }
    protocolStream.setEncoding('utf8')
    protocolStream.on('data', (chunk: string) => this.onChunk(chunk))
    protocolStream.on('error', (error: Error) => {
      this.log.push(`\ncontrol channel error: ${error.message}\n`)
    })
    child.on('error', (error) => {
      this.log.push(`\nspawn error: ${error.message}\n`)
      const failure = backendError('SPAWN_FAILED', `dsh runtime failed to start: ${error.message}`)
      this.helloReject?.(failure)
      this.helloReject = undefined
      this.helloResolve = undefined
      this.failPending(failure)
    })
    child.on('close', (code, signal) => this.onExit(code, signal))
  }

  private onChunk(chunk: string): void {
    for (const decoded of this.decoder.push(chunk)) {
      if (decoded.ok === false) {
        this.callbacks.onEvent({ type: 'error', message: `runtime framing error: ${decoded.error}` })
        continue
      }
      let message: BridgeRuntimeMessage
      try {
        message = parseRuntimeMessage(decoded.value)
      } catch (error) {
        const failure = backendError('PROTOCOL_ERROR', `runtime protocol violation: ${asBackendError(error).message}`)
        const duringHandshake = this.helloReject !== undefined
        this.helloReject?.(failure)
        this.helloResolve = undefined; this.helloReject = undefined
        if (duringHandshake) this.failPending(failure)
        this.callbacks.onEvent({ type: 'error', message: failure.message, fatal: duringHandshake })
        continue
      }
      debugLine(`[dsh-pi-tui] <- ${JSON.stringify(message).slice(0, 400)}`)
      this.onMessage(message)
    }
  }

  private onMessage(message: BridgeRuntimeMessage): void {
    switch (message.t) {
      case 'hello': {
        const resolve = this.helloResolve
        this.helloResolve = undefined
        this.helloReject = undefined
        resolve?.({ capabilities: message.capabilities, hasModelSelection: message.hasModelSelection })
        return
      }
      case 'event': {
        this.callbacks.onEvent(message.event)
        return
      }
      case 'res': {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.result)
        else pending.reject(mapRuntimeError(message.error))
        return
      }
      case 'protocol': {
        this.callbacks.onEvent({ type: 'error', message: `runtime protocol error: ${message.error.message}` })
        return
      }
      case 'fatal': {
        const failure = backendError('STARTUP_FAILED', message.error.message, message.error.code)
        this.helloReject?.(failure)
        this.helloReject = undefined
        this.helloResolve = undefined
        this.failPending(failure)
        this.callbacks.onEvent({ type: 'error', message: message.error.message, fatal: true })
        return
      }
      case 'bye':
        return
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    liveRuntimes.delete(this)
    this.exitInfo = { code, signal }
    const detail = this.diagnostics()
    const failure = backendError(
      'RUNTIME_EXITED',
      `dsh runtime exited (code ${code === null ? 'null' : String(code)}${signal === null ? '' : `, signal ${signal}`})` +
        (detail.length > 0 ? `: ${detail.slice(-2000)}` : ''),
    )
    this.helloReject?.(this.closing ? backendError('CLOSED', 'dsh runtime closed during startup') : failure)
    this.helloReject = undefined
    this.helloResolve = undefined
    this.failPending(this.closing ? backendError('CLOSED', 'dsh runtime is closing') : failure)
    for (const waiter of this.exitWaiters.splice(0)) waiter({ code, signal })
    this.callbacks.onExit({ code, signal })
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = requestTimeout()): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(backendError('RUNTIME_EXITED', 'the dsh runtime is not running'))
    }
    const child = this.child
    const stdin = child?.stdin
    if (child === undefined || stdin === null || stdin === undefined || stdin.destroyed) {
      return Promise.reject(backendError('NOT_CONNECTED', 'the dsh runtime control channel is closed'))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const abortable = method === 'command' && (params.name === 'execute' || params.name === 'compact')
        if (abortable) this.abortRequest(id)
        reject(backendError(
          'REQUEST_TIMEOUT',
          `${method} timed out after ${timeoutMs}ms${abortable ? '; native request cancellation was requested, inspect the final DSH outcome before retrying' : ''}` +
            (this.diagnostics().length > 0 ? `: ${this.diagnostics().slice(-800)}` : ''),
        ))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        const frame = encodeLine({ t: 'req', id, method, params })
        debugLine(`[dsh-pi-tui] -> ${frame.slice(0, 400)}`)
        stdin.write(frame)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(backendError('NOT_CONNECTED', `failed to write to the dsh runtime: ${String(error)}`))
      }
    })
  }

  /** Best-effort cancellation of a timed-out native operation, not a new scheduler. */
  private abortRequest(id: number): void {
    try {
      if (this.exited || this.child?.stdin?.destroyed) return
      this.child?.stdin?.write(encodeLine({ t: 'req', id: this.nextId++, method: 'abort', params: { id } }))
    } catch {
      // Runtime exit/diagnostics remain authoritative when transport is gone.
    }
  }

  private waitExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(false)
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.exitWaiters.push(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  /** Ask for an orderly runtime shutdown, then escalate if it does not exit. */
  async shutdown(): Promise<void> {
    if (this.exited) return
    this.closing = true
    try {
      await this.request('close', {}, closeTimeout())
    } catch {
      // The runtime may already be going down; the exit wait decides.
    }
    if (await this.waitExit(closeTimeout())) return
    this.kill('SIGTERM')
    if (await this.waitExit(KILL_GRACE_MS)) return
    this.kill('SIGKILL')
    await this.waitExit(KILL_GRACE_MS)
  }

  kill(signal: NodeJS.Signals): void {
    try {
      this.child?.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

/**
 * The removed Pi catalog import is never read again; naming the old pointers
 * only tells an upgrading user where model routes now come from.
 */
function legacyImportWarnings(environment: NodeJS.ProcessEnv): string[] {
  const names = ['DSH_PI_TUI_MODELS_FILE', 'DSH_PI_TUI_IMPORT_MODELS']
    .filter(name => (environment[name] ?? '').trim().length > 0)
  if (names.length === 0) return []
  return [
    `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} no longer read: DSH TUI never imports Pi models.json/auth.json. ` +
      'Configure providers, model defaults and credentials natively in DSH, then select that profile with --profile <name>.',
  ]
}

/** Map a runtime-reported code onto the backend's stable taxonomy. */
function mapRuntimeError(error: { message: string; code?: string }): BackendError {
  const code = error.code
  const mapped: BackendErrorCode =
    code === 'CAPABILITY_UNAVAILABLE' ? 'CAPABILITY_UNAVAILABLE'
      : code === 'UNSUPPORTED_COMMAND' ? 'UNSUPPORTED_COMMAND'
        : code === 'STALE_DECISION' ? 'STALE_DECISION'
          : code === 'STALE_SESSION' ? 'STALE_SESSION'
          : code === 'MODELS_UNAVAILABLE' ? 'MODELS_UNAVAILABLE'
            : code === 'UNKNOWN_MODEL' ? 'UNKNOWN_MODEL'
              : code === 'INVALID_ARGS' || code === 'INVALID_ANSWER' ? 'INVALID_ARGUMENT'
                : code === 'TIMEOUT' ? 'REQUEST_TIMEOUT'
                  : code === 'CLOSED' ? 'CLOSED'
                    : code === 'NO_SESSION' ? 'NOT_CONNECTED'
                      : 'RUNTIME_REQUEST_FAILED'
  return backendError(mapped, error.message, code)
}

/** Children that must not outlive the backend process. */
const liveRuntimes = new Set<RuntimeProcess>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const runtime of liveRuntimes) runtime.kill('SIGTERM')
  })
}

export class DshBackend implements Backend {
  private readonly options: DshOptions
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private install: DshInstall | undefined
  private workspace: RuntimeWorkspace | undefined
  private runtime: RuntimeProcess | undefined
  private info: SessionInfo | undefined
  private starting: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private closed = false
  private closedEmitted = false
  private startupWarnings: string[] = []
  private codec?: TranscriptCodec
  private helpers?: NativeHelpers
  private nativeHome?: string
  private plan?: ProfilePlan
  private bridgeCapabilities = new Set<string>()

  get transcriptCodec(): TranscriptCodec | undefined { return this.codec }

  constructor(options: DshOptions) {
    // Construction never touches the filesystem: the app reports startup
    // failures from `connect()`, where they are awaitable. Options are still
    // validated before anything is spawned.
    this.options = { ...(options as DshOptions) }
  }

  /** Validate options lazily so a bad path is an async startup failure. */
  private validateOptions(): void {
    const options = this.options
    if (options === null || typeof options !== 'object') {
      throw backendError('INVALID_OPTIONS', 'DshOptions are required')
    }
    if (typeof options.cwd !== 'string' || options.cwd.trim().length === 0) {
      throw backendError('INVALID_OPTIONS', 'DshOptions.cwd must be a non-empty path')
    }
    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
      throw backendError('INVALID_OPTIONS', `working directory does not exist: ${options.cwd}`)
    }
    for (const key of ['dshPath', 'home', 'resume', 'provider', 'model', 'profile'] as const) {
      const value = options[key]
      if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
        throw backendError('INVALID_OPTIONS', `DshOptions.${key} must be a non-empty string when present`)
      }
    }
  }

  onEvent(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: BackendEvent): void {
    if (event.type === 'permissions' && this.info?.sessionId === event.sessionId) this.info.permissions = event.value
    if (event.type === 'closed') this.closedEmitted = true
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A listener bug must not break the runtime control loop.
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw backendError('CLOSED', 'the backend is closed')
  }

  private start(): Promise<void> {
    if (this.starting !== undefined) return this.starting
    const task = (async () => {
      this.validateOptions()
      installExitHook()
      const install = resolveDshInstall(this.options.dshPath)
      this.install = install
      const helpers = await loadNativeHelpers(install.packageJsonPath)
      this.helpers = helpers
      this.codec = helpers.transcriptCodec
      const home = helpers.resolveHome(this.options.home)
      this.nativeHome = home
      // Native profile selection owns bundle resolution, patch precedence and
      // package resolution; this plan only names the profile and reports which
      // application frontends the TUI replaces.
      const plan = planProfile({
        native: helpers.profile,
        installAnchor: install.packageJsonPath,
        home,
        ...(this.options.profile === undefined ? {} : { profile: this.options.profile }),
      })
      this.plan = plan
      this.startupWarnings = [
        ...plan.warnings,
        ...legacyImportWarnings(process.env),
      ]
      this.workspace = prepareWorkspace({
        bridgePath: BRIDGE_PATH,
        plan,
        native: helpers.profile,
        home,
        dshPackageJsonPath: install.packageJsonPath,
      })
      const runtime = new RuntimeProcess(install, this.options, this.workspace, {
        onEvent: (event) => this.emit(event),
        onExit: (exit) => {
          if (this.closed) return
          this.closed = true
          if (!this.closedEmitted) {
            this.emit({
              type: 'closed',
              code: exit.code,
              signal: exit.signal,
            })
          }
        },
      })
      this.runtime = runtime
      try {
        const hello = await withTimeout(
          runtime.start(),
          CONNECT_TIMEOUT_MS,
          () => backendError(
            'STARTUP_TIMEOUT',
            `dsh runtime did not become ready within ${CONNECT_TIMEOUT_MS}ms` +
              (runtime.diagnostics().length > 0 ? `: ${runtime.diagnostics().slice(-2000)}` : ''),
          ),
        )
        this.bridgeCapabilities = new Set(hello.capabilities)
      } catch (error) {
        runtime.kill('SIGTERM')
        await runtime.shutdown().catch(() => {})
        this.workspace?.cleanup()
        this.workspace = undefined
        this.runtime = undefined
        throw asBackendError(error)
      }
    })()
    this.starting = task
    task.catch(() => {
      this.starting = undefined
    })
    return task
  }

  async connect(): Promise<SessionInfo> {
    this.assertOpen()
    if (this.info !== undefined) return this.info
    await this.start()
    const runtime = this.runtime
    if (runtime === undefined) throw backendError('STARTUP_FAILED', 'the dsh runtime is not available')
    const result = await runtime.request('connect', {
      ...(this.options.resume === undefined ? {} : { resume: this.options.resume }),
      ...(this.options.provider === undefined ? {} : { provider: this.options.provider }),
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    }, CONNECT_TIMEOUT_MS)
    const info = normalizeSessionInfo(result)
    this.info = info
    this.emit({ type: 'ready', info })
    for (const message of this.startupWarnings) this.emit({ type: 'warning', message })
    this.startupWarnings = []
    return info
  }

  async send(text: string, mode: 'followup' | 'steer' = 'followup'): Promise<void> {
    this.assertOpen()
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw backendError('INVALID_ARGUMENT', 'send requires non-empty text')
    }
    if (mode !== 'followup' && mode !== 'steer') {
      throw backendError('INVALID_ARGUMENT', `unsupported send mode: ${String(mode)}`)
    }
    await this.requireRuntime().request('send', { text, mode, sessionId: this.info?.sessionId, attachmentId: this.info?.attachmentId })
  }

  async cancel(): Promise<void> {
    this.assertOpen()
    await this.requireRuntime().request('cancel')
  }

  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.assertOpen()
    if (typeof name !== 'string' || name.length === 0) {
      throw backendError('INVALID_ARGUMENT', 'command requires a name')
    }
    if (name === 'reload') return await this.reload()
    const capabilities = this.info?.capabilities ?? []
    if ((capabilities.length || this.bridgeCapabilities.size) && !capabilities.includes(name) && !this.bridgeCapabilities.has(name)) {
      throw backendError('UNSUPPORTED_COMMAND', `the runtime does not advertise control method: ${name}`)
    }
    const timeout = name === 'execute' || name === 'compact' ? COMMAND_TIMEOUT_MS
      : name === 'models' || name === 'model' || name === 'sessions' ||
          name === 'presets' || name === 'preset' || name === 'efforts' || name === 'effort'
        ? CATALOG_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    const result = await this.requireRuntime().request('command', { name, args }, requestTimeout(timeout))
    if (name === 'new' || name === 'resume') {
      const info = normalizeSessionInfo(result)
      this.info = info
      this.emit({ type: 'ready', info })
      return info
    }
    return result
  }

  /**
   * Refresh the private profile/home mirrors from the selected real sources,
   * then ask the native HMR queue to reconcile. The Agent/session is never
   * recreated; only DSH's own plugin/config generation changes.
   */
  private async reload(): Promise<unknown> {
    this.assertOpen()
    if (this.info === undefined) throw backendError('NOT_CONNECTED', 'connect() must resolve before reload')
    const install = this.install
    const helpers = this.helpers
    const workspace = this.workspace
    const home = this.nativeHome
    if (install === undefined || helpers === undefined || workspace === undefined || home === undefined) {
      throw backendError('NOT_CONNECTED', 'the dsh runtime workspace is not available')
    }
    // Re-plan before touching scratch: an invalid/removed profile leaves the
    // running composition untouched and reports the actionable error.
    const plan = planProfile({
      native: helpers.profile,
      installAnchor: install.packageJsonPath,
      home,
      ...(this.options.profile === undefined ? {} : { profile: this.options.profile }),
    })
    // The --patch overlay is launch-time immutable in DSH's profile context.
    // A newly inserted/reidentified frontend row cannot be suppressed live.
    if (this.plan !== undefined && suppressionKey(this.plan) !== suppressionKey(plan)) {
      throw backendError(
        'PROFILE_UNSUPPORTED',
        'the selected DSH profile changed its application-frontend patch rows; restart dsh-tui to apply that composition safely',
      )
    }
    syncWorkspace({ workspace, plan, native: helpers.profile })
    this.plan = plan
    const runtime = this.requireRuntime()
    const result = await runtime.request('command', { name: 'reload', args: {} }, requestTimeout(COMMAND_TIMEOUT_MS))
    const record = object(result) ?? {}
    const info = record.info === undefined ? undefined : normalizeSessionInfo(record.info)
    const warnings = [
      ...plan.warnings,
      ...(Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === 'string') : []),
    ]
    const pending = Array.isArray(record.pending) ? record.pending : []
    const restartReason = typeof record.restartReason === 'string' ? record.restartReason : undefined
    if (info !== undefined) {
      this.info = info
      this.emit({ type: 'ready', info })
    }
    return {
      available: record.available === true,
      warnings,
      pending,
      ...(restartReason === undefined ? {} : { restartReason }),
      ...(info === undefined ? {} : { info }),
    }
  }

  async respond(id: string, value: unknown): Promise<void> {
    this.assertOpen()
    if (typeof id !== 'string' || id.length === 0) {
      throw backendError('INVALID_ARGUMENT', 'respond requires a decision id')
    }
    await this.requireRuntime().request('respond', { id, value })
  }

  async close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const task = (async () => {
      this.closed = true
      const runtime = this.runtime
      if (runtime !== undefined) {
        await runtime.shutdown()
      }
      this.workspace?.cleanup()
      this.workspace = undefined
      this.runtime = undefined
      this.starting = undefined
      this.info = undefined
      this.codec = undefined
      this.bridgeCapabilities.clear()
      if (!this.closedEmitted) {
        this.emit({ type: 'closed', code: 0, signal: null })
      }
    })()
    this.closing = task
    return task
  }

  private requireRuntime(): RuntimeProcess {
    const runtime = this.runtime
    if (runtime === undefined) {
      throw backendError('NOT_CONNECTED', 'connect() must resolve before this operation')
    }
    return runtime
  }
}

/** Await a promise with a caller-provided failure instead of stack traces. */
async function withTimeout<T>(promise: Promise<T>, ms: number, failure: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure()), ms)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
