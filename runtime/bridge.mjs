/**
 * DSH runtime bridge plugin for the dsh-pi-tui backend.
 *
 * Mounted as one ordinary Cordis row inside an isolated, private DSH profile.
 * It owns exactly one root Agent (DSH owns the session, tools, approvals and
 * durable log) and exposes a small NDJSON control plane to the TUI process:
 *
 *   parent -> bridge   on stdin (fd 0), one JSON request per line
 *   bridge -> parent   on fd 3, one JSON message per line
 *
 * stdout/stderr belong to DSH diagnostics; they are never used for protocol
 * frames, so a chatty plugin cannot corrupt the UI channel.
 *
 * Live assistant tokens come from `agent/assistant-stream` (process-local,
 * frame ordered). Durable settlements arrive through `session/event` with
 * their native surface metadata (`surfaceOp`, `sourceEventSeqs`). Nothing here
 * invents optimistic text: a `committed` stream end always names the durable
 * seq DSH actually committed.
 *
 * Human commands are NOT reimplemented here: `commands`/`execute` delegate to
 * the mounted native `ctx.commands` registry, including its `command/run` and
 * `command/done` audit records and pairing id. Model/tool/permission/session
 * semantics stay in DSH; this module only transports and forwards decisions.
 *
 * @module dsh-pi-tui/runtime/bridge
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-pi-tui-bridge'
export const inject = ['agentPresets', 'agents', 'llm', 'sessions', 'sessionPersistence']

/** Control-plane wire version (hello.protocolVersion). */
export const PROTOCOL_VERSION = 2

const PROTOCOL_FD = 3
const MAX_LINE_BYTES = 8 * 1024 * 1024
const MAX_SNAPSHOT_EVENTS = 8000
const SNAPSHOT_BYTE_BUDGET = 4 * 1024 * 1024
const IDLE_SETTLE_TIMEOUT_MS = 15000
const COMMAND_DRAIN_TIMEOUT_MS = 15000
const CANCEL_COMMAND_DRAIN_TIMEOUT_MS = 5000
const MAX_CACHED_TOOL_CALLS = 2048

/** Stable command capability list; runtime-only entries are filtered per boot. */
const BASE_CAPABILITIES = ['stream', 'followup', 'steer', 'cancel', 'new', 'resume', 'state']

/**
 * Official DSH agent-preset declarations from the installed web bundle. The
 * bridge registers only the ids the selected profile has not declared itself,
 * using the package's own patch files instead of copying their tool sets.
 */
const UPSTREAM_PRESET_IDS = ['standard', 'ptc', 'minimal', 'cordis']
const YAML_JS_TAG = 'tag:yaml.org,2002:js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (typeof process.env.DSH_PI_TUI_BRIDGE !== 'string') {
    // Not launched by our backend: stay completely inert.
    return
  }
  let config
  try {
    config = JSON.parse(process.env.DSH_PI_TUI_BRIDGE)
  } catch (error) {
    failFatal(`invalid DSH_PI_TUI_BRIDGE config: ${String(error)}`)
    return
  }
  const bridge = new Bridge(ctx, config)
  bridge.start()
}

/** Emit a fatal protocol error on the control channel, then exit. */
function failFatal(message) {
  try {
    writeSync(PROTOCOL_FD, `${JSON.stringify({ t: 'fatal', error: { message } })}\n`)
  } catch {
    /* parent already gone */
  }
  process.exitCode = 1
}

/** JSON-safe clone with a depth/size guard; returns undefined when unsupported. */
function jsonSafe(value) {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function textOfBlock(block) {
  if (block === null || typeof block !== 'object') return ''
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  return ''
}

function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  return content.map(textOfBlock).filter((part) => part.length > 0).join('\n')
}

/** Parse one JSON-encoded tool-argument string; undefined when it is not JSON. */
function parseToolArguments(value) {
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.arguments === 'string') {
    try {
      return JSON.parse(value.arguments)
    } catch {
      return undefined
    }
  }
  return undefined
}

function errorMessage(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  const safe = jsonSafe(error)
  if (safe !== undefined && typeof safe.message === 'string') return safe.message
  return String(error)
}

function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** UTF-8 size of one wire value; JSON round-trips are the actual frame cost. */
function wireBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    return 0
  }
}

/**
 * Build the wire shape of one durable event, preserving DSH's own surface
 * metadata instead of flattening it. `toolPresentation` is an ephemeral view
 * derived from the exact native tool definition and is never written back.
 */
function sessionEventWire(event, toolPresentation) {
  // DSH validates native events. Preserve the complete JSON envelope instead
  // of maintaining another lossy field whitelist here.
  const wire = jsonSafe(event) ?? {}
  if (toolPresentation !== undefined) wire.toolPresentation = toolPresentation
  return wire
}

/**
 * Ephemeral tool-card projection over the mounted native tool registry.
 *
 * Only `tools.get(name, agent)` plus the tool's own pure `presentCall` /
 * `presentResult` are used: no tool is re-executed, no file is read, and no
 * result content is replaced. Call metadata is cached so a `tool/result` card
 * can carry its pending call view during live streaming and snapshot replay.
 */
export class ToolPresentation {
  constructor(tools, agent) {
    this.tools = tools
    this.agent = agent
    this.calls = new Map()
  }

  /** Drop cached call metadata; called when the owned Agent is replaced. */
  reset() {
    this.calls.clear()
  }

  /**
   * @param {{type?: string, data?: unknown}} event - one durable session event.
   * @returns `{call?, result?}` native view, or undefined when no card applies.
   */
  of(event) {
    if (this.tools === undefined || this.agent === undefined) return undefined
    const data = event?.data
    if (data === null || typeof data !== 'object') return undefined
    if (event.type === 'tool/call') return this.callView(data)
    if (event.type === 'tool/result') return this.resultView(data)
    return undefined
  }

  callView(data) {
    if (typeof data.name !== 'string' || data.callId === undefined) return undefined
    const args = parseToolArguments(data)
    const definition = this.definitionOf(data.name)
    const call = callViewOf(definition, args)
    this.remember(String(data.callId), { name: data.name, args, call })
    return call === undefined ? undefined : { call }
  }

  resultView(data) {
    const message = data.message !== null && typeof data.message === 'object' ? data.message : undefined
    const callId = message?.toolCallId ?? message?.source?.callId
    if (callId === undefined) return undefined
    const cached = this.calls.get(String(callId))
    if (cached === undefined) return undefined
    const definition = this.definitionOf(cached.name)
    const result = resultViewOf(definition, cached.args, message, data.meta)
    if (cached.call === undefined && result === undefined) return undefined
    return {
      ...(cached.call === undefined ? {} : { call: cached.call }),
      ...(result === undefined ? {} : { result }),
    }
  }

  definitionOf(name) {
    try {
      return this.tools.get(name, this.agent)
    } catch {
      return undefined
    }
  }

  remember(callId, entry) {
    this.calls.set(callId, entry)
    if (this.calls.size <= MAX_CACHED_TOOL_CALLS) return
    const oldest = this.calls.keys().next()
    if (!oldest.done) this.calls.delete(oldest.value)
  }
}

function callViewOf(definition, args) {
  if (typeof definition?.presentCall !== 'function') return undefined
  try {
    return jsonSafe(definition.presentCall(args))
  } catch {
    return undefined
  }
}

function resultViewOf(definition, args, message, meta) {
  if (typeof definition?.presentResult !== 'function') return undefined
  const content = Array.isArray(message?.content) ? message.content : []
  try {
    return jsonSafe(definition.presentResult(args, {
      content,
      isError: message?.isError === true,
      ...(meta === undefined ? {} : { meta }),
    }))
  } catch {
    return undefined
  }
}

/**
 * Resolve one public DSH package export from the installed package anchor.
 * Uses the parent-provided `dshPackageJsonPath` (or the compatible
 * `agentModuleUrl`) so no project/global layout is assumed.
 *
 * @param {string | undefined} anchor - absolute file path or file URL.
 * @param {string} specifier - public package specifier.
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
async function importDshExport(anchor, specifier) {
  if (typeof anchor !== 'string' || anchor.length === 0) return undefined
  try {
    const requireFromAnchor = createRequire(anchor)
    const resolved = requireFromAnchor.resolve(specifier)
    const mod = await import(pathToFileURL(resolved).href)
    return mod
  } catch {
    return undefined
  }
}

class Bridge {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.out = null
    this.buffer = ''
    this.current = null
    this.selection = null
    this.installModelSelection = undefined
    this.createUserMessage = undefined
    this.toolPresentation = undefined
    this.ready = false
    this.closed = false
    this.switching = Promise.resolve()
    this.pendingDecisions = new Map()
    this.activeCommands = new Map()
    this.presetDisposers = new Map()
    this.presetServiceRef = undefined
    this.presetAnchor = undefined
    this.presetRegistrationError = undefined
    this.decisionSeq = 0
    this.eventSeq = 0
    this.disposers = []
  }

  start() {
    try {
      this.out = PROTOCOL_FD
      this.bindInput()
      this.init().catch((error) => {
        this.emitFatal(`bridge init failed: ${errorMessage(error)}`)
      })
    } catch (error) {
      this.emitFatal(`bridge start failed: ${errorMessage(error)}`)
    }
  }

  // ---------------------------------------------------------------- transport

  bindInput() {
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => this.onChunk(chunk))
    process.stdin.on('end', () => {
      // Parent disappeared: stop work rather than leaving an orphan agent.
      void this.shutdown('stdin closed')
    })
    process.stdin.on('error', () => {
      void this.shutdown('stdin error')
    })
  }

  onChunk(chunk) {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
      this.emitFatal('control line exceeded the protocol limit')
      this.buffer = ''
      return
    }
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index === -1) return
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim().length === 0) continue
      this.onLine(line)
    }
  }

  onLine(line) {
    let request
    try {
      request = JSON.parse(line)
    } catch (error) {
      this.send({ t: 'protocol', error: { message: `malformed request JSON: ${errorMessage(error)}` } })
      return
    }
    if (request === null || typeof request !== 'object' || typeof request.method !== 'string') {
      this.send({ t: 'protocol', error: { message: 'malformed request: expected {id, method}' } })
      return
    }
    const id = request.id
    if (typeof id !== 'number' && typeof id !== 'string') {
      this.send({ t: 'protocol', error: { message: 'malformed request: missing request id' } })
      return
    }
    const params = request.params !== null && typeof request.params === 'object' ? request.params : {}
    void this.handle(id, request.method, params).then(
      (result) => this.send({ t: 'res', id, ok: true, result: result === undefined ? null : result }),
      (error) => this.send({
        t: 'res',
        id,
        ok: false,
        error: { message: errorMessage(error), code: typeof error?.code === 'string' ? error.code : 'BACKEND_ERROR' },
      }),
    )
  }

  send(message) {
    if (this.out === null) return
    try {
      writeSync(this.out, `${JSON.stringify(message)}\n`)
    } catch {
      // The parent is gone; nothing useful can be delivered.
      this.out = null
    }
  }

  emitEvent(event) {
    this.eventSeq += 1
    this.send({ t: 'event', seq: this.eventSeq, event })
  }

  emitFatal(message, code) {
    this.send({ t: 'event', event: { type: 'error', message, fatal: true, ...(code ? { code } : {}) } })
    this.send({ t: 'fatal', error: { message, ...(code ? { code } : {}) } })
  }

  // ------------------------------------------------------------------- setup

  async init() {
    const agentModuleUrl = this.config.agentModuleUrl
    if (typeof agentModuleUrl === 'string' && agentModuleUrl.length > 0) {
      try {
        const mod = await import(agentModuleUrl)
        if (typeof mod.installModelSelection === 'function') this.installModelSelection = mod.installModelSelection
      } catch {
        this.installModelSelection = undefined
      }
    }
    // Native model-message construction and public helpers come from the
    // installed package, not from a local mirror of their shapes.
    const anchor = typeof this.config.dshPackageJsonPath === 'string' && this.config.dshPackageJsonPath.length > 0
      ? this.config.dshPackageJsonPath
      : agentModuleUrl
    this.presetAnchor = anchor
    const llm = await importDshExport(anchor, '@deepseek-ai/dsh-llm')
    if (typeof llm?.createUserMessage === 'function') this.createUserMessage = llm.createUserMessage
    await this.ensurePresetRoster(anchor)
    this.bindRuntimeEvents()
    this.bindAnswerers()
    this.ready = true
    this.send({
      t: 'hello',
      bridge: 'dsh-pi-tui-bridge',
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: this.capabilities(),
      hasModelSelection: this.installModelSelection !== undefined,
    })
  }

  capabilities() {
    const caps = [...BASE_CAPABILITIES]
    if (typeof this.ctx.llm?.listProviders === 'function') caps.push('models')
    if (this.tryGet('sessionQuery') !== undefined) caps.push('sessions')
    if (this.tryGet('permissionPresets') !== undefined) caps.push('permissions')
    if (this.presetService() !== undefined) caps.push('presets', 'preset')
    if (typeof this.ctx.llm?.resolveModelInfo === 'function') caps.push('efforts', 'effort')
    const hmr = this.tryGet('hmr')
    if (typeof hmr?.runExclusive === 'function' && typeof hmr?.reconcileProfile === 'function') caps.push('reload')
    if (this.commandRuntime() !== undefined) {
      caps.push('commands', 'execute')
      // Compatibility alias for the previous `compact` command name; the
      // native `/compact` registry entry remains the only implementation.
      caps.push('compact')
    }
    caps.push('dequeue')
    if (this.installModelSelection !== undefined) caps.push('model')
    return caps
  }

  /** The mounted native agent-preset roster, when this composition has one. */
  presetService() {
    const presets = this.tryGet('agentPresets')
    return typeof presets?.list === 'function' && typeof presets?.select === 'function'
      ? presets
      : undefined
  }

  /**
   * Register the installed DSH bundle's own preset declarations for every id
   * the selected profile has not declared. Profile declarations win, matching
   * the native web surface; preset child plugins are activated by the native
   * registry, never copied or reimplemented here.
   *
   * @param {string | undefined} anchor - installed DSH package manifest.
   */
  async ensurePresetRoster(anchor) {
    const presets = this.presetService()
    if (presets === undefined || typeof presets.register !== 'function') return
    // HMR can replace the registry service. Its old disposers belong to the
    // disposed service; start a fresh id map on the new identity.
    if (this.presetServiceRef !== presets) {
      this.presetServiceRef = presets
      this.presetDisposers.clear()
    }
    try {
      const loader = this.tryGet('loader')
      const declared = new Set()
      for (const entry of loader?.entries?.() ?? []) {
        if (entry.disabled || entry.options?.name !== '@deepseek-ai/dsh-agent-preset') continue
        const id = entry.options?.config?.id
        if (typeof id === 'string' && id.length > 0) declared.add(id)
      }
      const existing = new Set()
      if (typeof presets.list === 'function') {
        for (const row of await presets.list()) if (typeof row?.id === 'string') existing.add(row.id)
      }
      // A profile declaration now owns an id previously supplied by the TUI.
      // Yield it before registering missing official ids.
      for (const [id, dispose] of [...this.presetDisposers]) {
        if (!declared.has(id)) continue
        try { await dispose() } catch { /* old registry disposal is best effort */ }
        this.presetDisposers.delete(id)
        existing.delete(id)
      }
      const yaml = await importDshExport(anchor, 'yaml')
      const parse = yaml?.parse ?? yaml?.default?.parse
      if (typeof parse !== 'function') throw new Error('the installed DSH install does not expose yaml.parse')
      const requireFromAnchor = typeof anchor === 'string' && anchor.length > 0 ? createRequire(anchor) : undefined
      if (requireFromAnchor === undefined) throw new Error('no installed DSH package anchor for preset declarations')
      for (const id of UPSTREAM_PRESET_IDS) {
        if (declared.has(id) || existing.has(id)) continue
        try {
          const path = requireFromAnchor.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`)
          const definition = readPresetPatch(parse, path)
          const dispose = await presets.register(definition)
          this.presetDisposers.set(id, dispose)
        } catch (error) {
          this.ctx.logger?.warn?.(`dsh-pi-tui: agent preset ${id} was not registered: ${errorMessage(error)}`)
        }
      }
    } catch (error) {
      this.presetRegistrationError = errorMessage(error)
      this.ctx.logger?.warn?.(`dsh-pi-tui: agent-preset registration skipped: ${this.presetRegistrationError}`)
    }
  }

  /**
   * Reconcile the native profile/home configuration through DSH's HMR queue.
   * Called only after the backend copied real profile/home edits into scratch.
   * The current Agent and transcript are never recreated.
   */
  async reloadRuntime() {
    if (this.current === null) throw codedError('no live session', 'NO_SESSION')
    if (this.current.agent.status === 'running' ||
        this.activeCommands.size > 0 ||
        this.pendingDecisions.size > 0 ||
        this.current.agent.inbox.nextTurn.length > 0 ||
        this.current.agent.inbox.nextStep.length > 0) {
      throw codedError('wait for the current turn, queued input or native command to finish before reloading', 'BUSY')
    }
    let hmr = this.tryGet('hmr')
    // HMR initializes after DSH's appReady boundary, which can land just after
    // the bridge hello. Wait briefly so an immediate /reload still works.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (typeof hmr?.runExclusive === 'function' && typeof hmr?.reconcileProfile === 'function') break
      await new Promise((resolve) => setTimeout(resolve, 100))
      hmr = this.tryGet('hmr')
    }
    if (typeof hmr?.runExclusive !== 'function' || typeof hmr?.reconcileProfile !== 'function') {
      throw codedError('the runtime mounted no profile HMR service; restart dsh-tui to apply configuration changes', 'CAPABILITY_UNAVAILABLE')
    }
    let result
    try {
      result = await hmr.runExclusive(() => hmr.reconcileProfile())
    } catch (error) {
      throw codedError(errorMessage(error), typeof error?.code === 'string' ? error.code : 'RELOAD_FAILED')
    }
    // The registry may have been replaced by the recomposition. Restore the
    // TUI-supplied official presets before any later /new resolves them.
    if (this.presetAnchor !== undefined) await this.ensurePresetRoster(this.presetAnchor)
    this.resetToolPresentation()
    return {
      available: true,
      ...(jsonSafe(result) ?? {}),
      info: await this.sessionInfo({ includeSnapshot: false }),
    }
  }

  /** The mounted native human-command registry, when this composition has one. */
  commandRuntime() {
    const commands = this.tryGet('commands')
    return typeof commands?.list === 'function' && typeof commands?.execute === 'function'
      ? commands
      : undefined
  }

  /** Native tool-card presenter for the exact owned Agent; rebuilt on switch. */
  resetToolPresentation() {
    const agent = this.current?.agent
    const tools = this.tryGet('tools')
    this.toolPresentation = agent !== undefined && tools !== undefined
      ? new ToolPresentation(tools, agent)
      : undefined
  }

  tryGet(key) {
    try {
      return this.ctx.get(key)
    } catch {
      return undefined
    }
  }

  bindRuntimeEvents() {
    const ctx = this.ctx
    this.disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (this.current === null || agent !== this.current.agent) return
      this.onStreamFrame(agent, frame)
    }))
    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (this.current === null || session !== this.current.agent.session) return
      this.emitEvent({
        type: 'session_event',
        sessionId: session.id,
        event: sessionEventWire(event, this.toolPresentation?.of(event)),
      })
    }))
    // Read the native projection change feed instead of folding sandbox and
    // approval events into a second UI-owned permission state.
    const projections = this.tryGet('sessionProjections')
    if (typeof projections?.onChanged === 'function') {
      this.disposers.push(projections.onChanged((session, key, value) => {
        if (this.current === null || session !== this.current.agent.session || key !== 'permissions') return
        this.emitEvent({ type: 'permissions', sessionId: session.id, value: jsonSafe(value) })
      }))
    }
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      if (this.current === null || agent !== this.current.agent) return
      this.emitEvent({ type: 'status', sessionId: agent.session.id, status })
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      if (this.current === null || agent !== this.current.agent) return
      this.emitEvent({ type: 'error', message: `agent error: ${errorMessage(error)}` })
    }))
  }

  bindAnswerers() {
    const ctx = this.ctx
    this.disposers.push(ctx.on('approval/request', (request, next) => {
      if (this.current === null || request.agent !== this.current.agent) return next()
      return this.askApproval(request)
    }))
    this.disposers.push(ctx.on('user-questions/request', (request, next) => {
      if (this.current === null || request.agent !== this.current.agent) return next()
      return this.askQuestions(request)
    }))
  }

  // ---------------------------------------------------------------- stream

  onStreamFrame(agent, frame) {
    const sessionId = agent.session.id
    if (frame.type === 'start') {
      this.emitEvent({
        type: 'stream_start',
        sessionId,
        attemptId: String(frame.attemptId),
        revision: frame.revision,
        turn: frame.turn,
        step: frame.step,
      })
      return
    }
    if (frame.type === 'chunk') {
      this.emitEvent({
        type: 'stream_chunk',
        sessionId,
        attemptId: String(frame.attemptId),
        revision: frame.revision,
        index: frame.index,
        chunk: jsonSafe(frame.chunk) ?? {},
        time: frame.time,
      })
      return
    }
    if (frame.type === 'end') {
      const outcome = frame.outcome?.kind === 'committed' ? 'committed' : 'abandoned'
      this.emitEvent({
        type: 'stream_end',
        sessionId,
        attemptId: String(frame.attemptId),
        revision: frame.revision,
        outcome,
        ...(outcome === 'committed' ? { seq: frame.outcome.seq } : {}),
        index: frame.index,
        ...(outcome === 'committed' ? { eventType: frame.outcome.eventType } : {}),
      })
    }
  }

  // -------------------------------------------------------------- decisions

  nextDecisionId(kind) {
    this.decisionSeq += 1
    return `${kind}-${process.pid}-${this.decisionSeq}`
  }

  askApproval(request) {
    const id = this.nextDecisionId('approval')
    const title = `Approve ${request.toolName ?? 'tool'}`
    const message = typeof request.reason === 'string'
      ? request.reason
      : typeof request.displayReason?.en === 'string' ? request.displayReason.en : undefined
    this.emitEvent({
      type: 'decision',
      sessionId: this.current.agent.session.id,
      request: {
        id,
        kind: 'approval',
        title,
        ...(message === undefined ? {} : { message }),
        options: [
          { label: 'Allow once', description: 'Permit exactly this action.', value: 'allowed-once' },
          { label: 'Reject', description: 'Decline the action.', value: 'rejected' },
        ],
        meta: {
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
        },
      },
    })
    return this.awaitDecision(id, 'approval', request.signal).then(
      (value) => normalizeApprovalOutcome(value),
      () => 'cancelled',
    )
  }

  askQuestions(request) {
    const id = this.nextDecisionId('question')
    const questions = Array.isArray(request.questions) ? request.questions : []
    this.emitEvent({
      type: 'decision',
      sessionId: this.current.agent.session.id,
      request: {
        id,
        kind: 'question',
        title: questions[0]?.header ?? 'Question',
        questions: questions.map((question) => ({
          ...(typeof question.id === 'string' ? { id: question.id } : {}),
          ...(question.intent === undefined ? {} : { intent: jsonSafe(question.intent) }),
          question: typeof question.detail === 'string' && question.detail.length > 0
            ? `${question.question}\n\n${question.detail}`
            : question.question,
          ...(question.header === undefined ? {} : { header: question.header }),
          ...(question.multiSelect === true ? { multiSelect: true } : {}),
          options: (question.options ?? []).map((option) => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
            ...(option.preview === undefined ? {} : { preview: option.preview }),
          })),
        })),
        meta: {
          questionIds: questions.map((question) => question.id),
          ...(request.wait?.callId === undefined ? {} : { callId: request.wait.callId }),
        },
      },
    })
    return this.awaitDecision(id, 'question', request.signal).then(
      (value) => normalizeAskAnswer(questions, value),
      (error) => {
        const abort = new Error(errorMessage(error))
        abort.name = 'UserQuestionError'
        abort.code = 'ASK_ABORTED'
        throw abort
      },
    )
  }

  awaitDecision(id, kind, signal) {
    return new Promise((resolve, reject) => {
      const entry = {
        kind,
        signal,
        resolve: (value) => {
          this.settleDecision(id)
          resolve(value)
        },
        reject: (error) => {
          this.settleDecision(id)
          reject(error)
        },
        onAbort: undefined,
      }
      entry.onAbort = () => {
        if (kind === 'question') entry.reject(codedError('question cancelled', 'ASK_ABORTED'))
        else entry.resolve(undefined)
      }
      this.pendingDecisions.set(id, entry)
      if (signal !== undefined) {
        if (signal.aborted) entry.onAbort()
        else signal.addEventListener('abort', entry.onAbort, { once: true })
      }
    })
  }

  /** Remove one pending decision once and announce its closure exactly once. */
  settleDecision(id) {
    const entry = this.pendingDecisions.get(id)
    if (entry === undefined) return
    this.pendingDecisions.delete(id)
    try {
      entry.signal?.removeEventListener?.('abort', entry.onAbort)
    } catch {
      /* signal already gone */
    }
    // Emitted before the promise settles so the UI release precedes any
    // dependent durable event that the decision unblocks.
    this.emitEvent({ type: 'decision_closed', sessionId: this.current?.agent.session.id ?? '', id })
  }

  respond(id, value) {
    const entry = this.pendingDecisions.get(id)
    if (entry === undefined) {
      throw codedError(`unknown or already settled decision: ${id}`, 'STALE_DECISION')
    }
    this.pendingDecisions.delete(id)
    this.emitEvent({ type: 'decision_closed', sessionId: this.current?.agent.session.id ?? '', id })
    if (isCancelledValue(value)) {
      if (entry.kind === 'approval') entry.resolve(undefined)
      else entry.reject(codedError('question cancelled', 'ASK_ABORTED'))
      return { id, settled: true, cancelled: true }
    }
    entry.resolve(value)
    return { id, settled: true }
  }

  closePendingDecisions(reason, sessionId = this.current?.agent.session.id ?? '') {
    for (const [id, entry] of [...this.pendingDecisions]) {
      this.pendingDecisions.delete(id)
      try {
        entry.signal?.removeEventListener?.('abort', entry.onAbort)
      } catch {
        /* signal already gone */
      }
      this.emitEvent({ type: 'decision_closed', sessionId, id })
      if (entry.kind === 'approval') entry.resolve(undefined)
      else entry.reject(codedError(reason, 'ASK_ABORTED'))
    }
  }


  // --------------------------------------------------------------- sessions

  async resolveRoute(loggedRoute) {
    const requestedProvider = typeof this.config.provider === 'string' ? this.config.provider : undefined
    const requestedModel = typeof this.config.model === 'string' ? this.config.model : undefined
    if (requestedProvider !== undefined && requestedModel !== undefined) {
      return { provider: requestedProvider, model: requestedModel }
    }
    if (loggedRoute?.config?.provider !== undefined && loggedRoute?.config?.model !== undefined) {
      const effort = loggedRoute.config.reasoningEffort
      return {
        provider: loggedRoute.config.provider,
        model: loggedRoute.config.model,
        ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
      }
    }
    const defaults = this.tryGet('agentDefaultModel')?.currentSelection?.()
    if (defaults?.provider !== undefined && defaults?.model !== undefined) {
      return {
        provider: defaults.provider,
        model: defaults.model,
        ...(typeof defaults.reasoningEffort === 'string' ? { reasoningEffort: defaults.reasoningEffort } : {}),
      }
    }
    // No route is invented here: picking the first provider that happens to
    // advertise models would silently rewrite the user's routing choice. DSH
    // reports the actionable missing-route/credential failure instead.
    return undefined
  }

  installSelection(agentCtx, initial) {
    if (this.installModelSelection === undefined) {
      this.selection = null
      return
    }
    this.selection = { current: initial, assembled: undefined }
    this.installModelSelection(agentCtx, this.selection)
  }

  /**
   * Read the agent preset recorded by a persisted session's projection.
   * A preset-free session returns undefined; the preset is never guessed from
   * the current default for a resume.
   *
   * @param {string} sessionId - persisted session identity.
   * @returns {Promise<string | undefined>}
   */
  async loggedPreset(sessionId) {
    const query = this.tryGet('sessionQuery')
    if (typeof query?.observeSession !== 'function') return undefined
    let observation
    try {
      observation = await query.observeSession(sessionId, { projectionMode: 'all' })
      const value = observation?.projections?.values?.agentPreset
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    } finally {
      try {
        if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]()
        else observation?.dispose?.()
      } catch {
        /* observation lease cleanup is best effort */
      }
    }
  }

  /** The preset the live Agent currently runs, from the native projection. */
  currentPreset() {
    const agent = this.current?.agent
    if (agent === undefined) return undefined
    try {
      const value = this.tryGet('sessionProjections')?.stateOf?.(agent.session, 'agentPreset')
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      /* projection not mounted */
    }
    try {
      const value = this.presetService()?.composedPreset?.(agent.ctx)
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      /* preset-free composition */
    }
    return undefined
  }

  /** Whether no turn has started, using the native turn-boundary projection. */
  isBlankSession() {
    const session = this.current?.agent.session
    if (session === undefined) return false
    try {
      const boundary = this.tryGet('sessionProjections')?.stateOf?.(session, 'turnBoundary')
      return boundary === undefined || (boundary.openTurnStartSeq === null && boundary.lastTurn === 0)
    } catch {
      return false
    }
  }

  /**
   * Resolve one optional preset id through the native roster. The returned
   * composition setup mounts the exact current revision before publication.
   *
   * @param {string | undefined} id - explicit id, or the roster default.
   * @returns {Promise<{presets: object, id: string} | undefined>}
   */
  async presetComposition(id) {
    const presets = this.presetService()
    if (presets === undefined) {
      if (id !== undefined) throw codedError('the runtime mounted no agent-preset roster', 'CAPABILITY_UNAVAILABLE')
      return undefined
    }
    const resolved = await presets.resolve(id)
    if (typeof resolved?.id !== 'string' || resolved.id.length === 0) {
      throw codedError(`the agent-preset roster returned no id for ${JSON.stringify(id ?? 'default')}`, 'PRESET_INVALID')
    }
    if (typeof resolved.broken === 'string' && resolved.broken.length > 0) {
      throw codedError(`agent preset ${JSON.stringify(resolved.id)} is unavailable: ${resolved.broken}`, 'PRESET_INVALID')
    }
    return { presets, id: resolved.id }
  }

  async openAgent(kind, sessionId, presetId) {
    const agents = this.ctx.agents
    const cwd = this.config.cwd
    if (kind === 'resume') {
      const recorded = await this.loggedPreset(sessionId)
      // A preset-free persisted session still needs a model-facing composition
      // now that host-plane tool rows belong to presets. DSH's own API
      // controller resolves the roster default in this case.
      const composition = await this.presetComposition(recorded)
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        setup: async (agentCtx, agent) => {
          const logged = agent.session.requestHeader?.()
          const initial = routeFromLogged(logged)
          this.installSelection(agentCtx, initial)
          this.currentRoute = initial
          if (composition !== undefined) await composition.presets.mount(agentCtx, composition.id)
        },
      })
      this.current = { handle, agent: handle.agent, kind, attachmentId: randomUUID() }
      this.resetToolPresentation()
      await this.refreshRouteFromSession()
      return
    }
    const route = await this.resolveRoute(undefined)
    this.currentRoute = route
    const composition = await this.presetComposition(presetId)
    const handle = await agents.create({
      sessionId,
      meta: {
        cwd,
        ...(composition === undefined ? {} : { agentPreset: composition.id }),
      },
      ...(route === undefined ? {} : { agentOptions: { provider: route.provider, model: route.model } }),
      setup: async (agentCtx) => {
        this.installSelection(agentCtx, route)
        if (composition !== undefined) await composition.presets.mount(agentCtx, composition.id)
      },
    })
    this.current = { handle, agent: handle.agent, kind, attachmentId: randomUUID() }
    this.resetToolPresentation()
  }

  async refreshRouteFromSession() {
    const logged = this.current?.agent.session.requestHeader?.()
    const route = routeFromLogged(logged)
    if (route !== undefined) {
      this.currentRoute = route
      if (this.selection !== null) this.selection.current = route
    }
  }

  async closeCurrent(reason) {
    const current = this.current
    if (current === undefined || current === null) return
    const sessionId = current.agent.session.id
    this.current = null
    this.resetToolPresentation()
    this.closePendingDecisions(reason, sessionId)
    try {
      current.agent.cancel({ kind: 'user' })
    } catch {
      /* already idle */
    }
    try {
      await withTimeout(current.agent.whenIdle(), IDLE_SETTLE_TIMEOUT_MS, 'agent drain')
    } catch {
      /* proceed with teardown */
    }
    try {
      await this.ctx.sessions.flush(current.agent.session)
    } catch {
      /* persistence failure surfaces on the next resume; keep closing */
    }
    try {
      await current.handle.dispose()
    } catch {
      /* disposal is best effort during shutdown */
    }
  }

  async switchSession(kind, params) {
    const task = async () => {
      await this.closeCurrent('session switched')
      if (kind === 'resume') {
        const sessionId = params.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw codedError('resume requires a non-empty sessionId', 'INVALID_ARGS')
        }
        await this.openAgent('resume', sessionId)
      } else {
        const sessionId = typeof params.sessionId === 'string' && params.sessionId.length > 0
          ? params.sessionId
          : randomUUID()
        const preset = typeof params.preset === 'string' && params.preset.trim().length > 0
          ? params.preset.trim()
          : undefined
        await this.openAgent('new', sessionId, preset)
      }
      return await this.sessionInfo({ includeSnapshot: true })
    }
    const run = this.switching.then(task, task)
    this.switching = run.then(() => undefined, () => undefined)
    return run
  }

  async sessionInfo({ includeSnapshot }) {
    const agent = this.current?.agent
    if (agent === undefined) throw codedError('no live session', 'NO_SESSION')
    const session = agent.session
    const route = await this.routeOf(agent)
    const presets = this.tryGet('permissionPresets')
    let permissions
    if (presets !== undefined) {
      try {
        permissions = { currentValue: presets.current(session) }
      } catch {
        permissions = undefined
      }
    }
    const preset = this.currentPreset()
    const info = {
      attachmentId: this.current.attachmentId,
      sessionId: session.id,
      cwd: this.config.cwd,
      provider: route?.provider ?? agent.options?.provider ?? '',
      model: route?.model ?? agent.options?.model ?? '',
      ...(typeof route?.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(preset === undefined ? {} : { preset }),
      ...(permissions === undefined ? {} : { permissions }),
      capabilities: this.capabilities(),
    }
    if (includeSnapshot === true) {
      const snapshot = await this.snapshotOf(session.id)
      if (snapshot === undefined) {
        info.snapshotUnavailable = true
      } else {
        info.events = snapshot.events
        info.truncated = snapshot.truncated
        info.totalEvents = snapshot.totalEvents
        if (snapshot.omittedEvents > 0) info.omittedEvents = snapshot.omittedEvents
        info.snapshotBytes = snapshot.bytes
      }
    }
    return info
  }

  /**
   * Durable snapshot from the native session-query service (never the
   * deprecated in-session accessor). The newest window that fits the UTF-8
   * byte and event-count budgets is returned in ascending seq order with its
   * native surface metadata. Omissions are reported, never hidden by mutating
   * durable text.
   *
   * @param {string} sessionId - logical session id.
   * @returns {Promise<{events: object[], truncated: boolean, totalEvents: number, omittedEvents: number, bytes: number} | undefined>}
   */
  async snapshotOf(sessionId) {
    const query = this.tryGet('sessionQuery')
    if (typeof query?.readSession !== 'function') return undefined
    const log = await query.readSession(sessionId)
    const raw = Array.isArray(log?.events) ? log.events : []
    // Replay tool call metadata over the complete log so a kept result still
    // carries the call card it was paired with, without re-running any tool.
    const presentation = this.toolPresentation
    const wire = raw.map((event) => sessionEventWire(event, presentation?.of(event)))
    const kept = []
    let bytes = 0
    for (let index = wire.length - 1; index >= 0; index -= 1) {
      const event = wire[index]
      const size = wireBytes(event) + 1
      if (kept.length >= MAX_SNAPSHOT_EVENTS) break
      if (bytes + size > SNAPSHOT_BYTE_BUDGET) break
      kept.push(event)
      bytes += size
    }
    kept.reverse()
    return {
      events: kept,
      truncated: kept.length < wire.length,
      totalEvents: wire.length,
      omittedEvents: wire.length - kept.length,
      bytes,
    }
  }

  async routeOf(_agent) {
    if (this.selection !== null && this.selection.current !== undefined) return this.selection.current
    return this.currentRoute
  }

  // ---------------------------------------------------------------- methods

  async handle(id, method, params) {
    if (this.closed && method !== 'close') {
      throw codedError('backend runtime is closing', 'CLOSED')
    }
    if (!this.ready && method !== 'ping') {
      throw codedError('backend runtime is still starting', 'NOT_READY')
    }
    switch (method) {
      case 'ping':
        return { pong: true, ready: this.ready }
      case 'connect': {
        if (this.current !== null) return await this.sessionInfo({ includeSnapshot: false })
        if (typeof params.provider === 'string' && params.provider.length > 0) this.config.provider = params.provider
        if (typeof params.model === 'string' && params.model.length > 0) this.config.model = params.model
        const resume = typeof params.resume === 'string' && params.resume.length > 0
          ? params.resume
          : typeof this.config.resume === 'string' && this.config.resume.length > 0 ? this.config.resume : undefined
        return await this.switchSession(resume === undefined ? 'new' : 'resume', { sessionId: resume })
      }
      case 'send':
        return this.onSend(params)
      case 'cancel':
        return this.onCancel()
      case 'respond':
        return this.respond(String(params.id ?? ''), params.value)
      case 'command':
        return await this.onCommand(id, String(params.name ?? ''), params.args ?? {})
      case 'commands':
        return this.onCommands()
      case 'execute':
        return await this.onExecute(id, params)
      case 'abort':
        return this.onAbort(params)
      case 'close':
        await this.shutdown('client requested close')
        return { closed: true }
      default:
        throw codedError(`unknown bridge method: ${method}`, 'UNKNOWN_METHOD')
    }
  }

  async onSend(params) {
    if (this.current === null) throw codedError('no live session', 'NO_SESSION')
    this.assertAttachment(params)
    const text = params.text
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw codedError('send requires non-empty text', 'INVALID_ARGS')
    }
    if (typeof this.createUserMessage !== 'function') {
      throw codedError(
        'cannot create a native user message: the installed @deepseek-ai/dsh-llm export could not be resolved',
        'CAPABILITY_UNAVAILABLE',
      )
    }
    const mode = params.mode === 'steer' ? 'steer' : 'followup'
    const message = this.createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (mode === 'steer') this.current.agent.steer(message)
    else this.current.agent.followup(message)
    return { messageId: message.id, mode, queue: mode === 'steer' ? 'next-step' : 'next-turn' }
  }

  async onCancel() {
    if (this.current === null) return { cancelled: false, pendingDecisions: 0, activeCommands: 0 }
    const current = this.current
    const pending = this.pendingDecisions.size
    this.closePendingDecisions('cancelled', current.agent.session.id)
    // Transport cancellation: abort this session's in-flight native commands,
    // then let native Agent.cancel own the agent-level interruption.
    const active = this.abortActiveCommands('command cancelled', current.agent.session.id)
    if (active > 0) await this.drainCommands(CANCEL_COMMAND_DRAIN_TIMEOUT_MS)
    current.agent.cancel({ kind: 'user' })
    return { cancelled: true, pendingDecisions: pending, activeCommands: active }
  }

  /** Effective native command descriptors for the owned Agent. */
  onCommands() {
    if (this.current === null) throw codedError('no live session', 'NO_SESSION')
    const commands = this.commandRuntime()
    if (commands === undefined) {
      throw codedError('the runtime mounted no human-command registry', 'CAPABILITY_UNAVAILABLE')
    }
    return commands.list(this.current.agent).map((descriptor) => ({
      ...(descriptor.definitionId === undefined ? {} : { definitionId: String(descriptor.definitionId) }),
      name: descriptor.name,
      description: descriptor.description,
      ...(descriptor.input === undefined
        ? {}
        : { input: { hint: descriptor.input.hint, ...(descriptor.input.attachments === true ? { attachments: true } : {}) } }),
    }))
  }

  /**
   * Execute one native slash-command line for the owned Agent.
   * DSH mints the pairing id and appends `command/run` / `command/done`; this
   * transport only owns the request id and its cancellation signal.
   */
  async onExecute(requestId, params) {
    if (this.current === null) throw codedError('no live session', 'NO_SESSION')
    const commands = this.commandRuntime()
    if (commands === undefined) {
      throw codedError('the runtime mounted no human-command registry', 'CAPABILITY_UNAVAILABLE')
    }
    const line = params.line
    if (typeof line !== 'string' || line.trim().length === 0) {
      throw codedError('execute requires a non-empty command line', 'INVALID_ARGS')
    }
    if (!line.trimStart().startsWith('/')) throw codedError('execute requires a slash command line', 'INVALID_ARGS')
    const controller = new AbortController()
    let settle
    const settled = new Promise((resolve) => { settle = resolve })
    const entry = { requestId, controller, settled, sessionId: this.current.agent.session.id }
    this.activeCommands.set(String(requestId), entry)
    try {
      const execution = await commands.execute(this.current.agent, line, [], controller.signal)
      if (execution === undefined) {
        const name = line.trimStart().slice(1).split(/\s/, 1)[0]
        throw codedError(`unknown or malformed command: /${name}`, 'UNSUPPORTED_COMMAND')
      }
      return jsonSafe({
        commandId: execution.commandId,
        result: execution.result,
      })
    } finally {
      this.activeCommands.delete(String(requestId))
      settle()
    }
  }

  /** Abort one active native command by its transport request id. */
  onAbort(params) {
    const target = params.id
    if (typeof target !== 'number' && typeof target !== 'string') {
      throw codedError('abort requires the target request id', 'INVALID_ARGS')
    }
    const entry = this.activeCommands.get(String(target))
    if (entry === undefined) return { aborted: false }
    entry.controller.abort(codedError('command aborted by the client', 'ABORTED'))
    return { aborted: true }
  }

  /** Abort every active native command, optionally only for one session. */
  abortActiveCommands(reason, sessionId) {
    let count = 0
    for (const entry of this.activeCommands.values()) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue
      if (entry.controller.signal.aborted) continue
      entry.controller.abort(codedError(reason, 'ABORTED'))
      count += 1
    }
    return count
  }

  /** Wait (bounded) for active native commands to settle after cancellation. */
  async drainCommands(timeoutMs) {
    const pending = [...this.activeCommands.values()].map((entry) => entry.settled)
    if (pending.length === 0) return
    try {
      await withTimeout(Promise.allSettled(pending), timeoutMs, 'native command drain')
    } catch {
      /* a handler that ignores its signal must not block teardown forever */
    }
  }

  async onCommand(requestId, name, args) {
    if (this.current === null && !['new', 'resume', 'sessions', 'models', 'presets'].includes(name)) throw codedError('no live session', 'NO_SESSION')
    switch (name) {
      case 'models':
        return await this.listModels()
      case 'sessions':
        return await this.listSessions(args)
      case 'commands':
        return this.onCommands()
      case 'execute':
        return await this.onExecute(requestId, { line: args.line })
      case 'new':
        return await this.switchSession('new', { preset: args.preset })
      case 'resume':
        return await this.switchSession('resume', { sessionId: args.sessionId })
      case 'model':
        return await this.setModel(args)
      case 'presets':
        return await this.listPresets()
      case 'preset':
        return await this.setPreset(args)
      case 'efforts':
        return await this.listEfforts()
      case 'effort':
        return await this.setEffort(args)
      case 'permissions':
        return this.permissions()
      case 'compact':
        // Compatibility alias: the native `/compact` registry entry is the
        // only implementation, including its argument checks and audit pair.
        return await this.onExecute(requestId, { line: '/compact' + (typeof args.id === 'string' && args.id ? ' ' + args.id : '') })
      case 'state':
        return await this.state()
      case 'reload':
        return await this.reloadRuntime()
      case 'dequeue':
        this.assertAttachment(args)
        return this.dequeue()
      default:
        throw codedError(`unsupported command: ${name}`, 'UNSUPPORTED_COMMAND')
    }
  }

  async listModels() {
    const llm = this.ctx.llm
    if (typeof llm?.listProviders !== 'function') {
      throw codedError('the runtime mounted no LLM provider catalog', 'CAPABILITY_UNAVAILABLE')
    }
    const items = []
    const problems = []
    for (const provider of llm.listProviders()) {
      let models
      try {
        models = await withTimeout(llm.listModels(provider.id), 8000, `listModels(${provider.id})`)
      } catch (error) {
        problems.push(`${provider.id}: ${errorMessage(error)}`)
        continue
      }
      for (const model of models) {
        items.push({
          id: `${provider.id}/${model.id}`,
          provider: provider.id,
          model: model.id,
          label: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
          ...(typeof model.description === 'string' ? { description: model.description } : {}),
        })
      }
    }
    if (items.length === 0) {
      throw codedError(
        `no model routes are available${problems.length > 0 ? ` (${problems.join('; ')})` : ''}; ` +
          'store a DSH credential or configure a provider, or pass provider/model explicitly',
        'MODELS_UNAVAILABLE',
      )
    }
    return items
  }

  async listSessions(args) {
    const query = this.tryGet('sessionQuery')
    if (query === undefined) {
      throw codedError('the runtime mounted no session query service', 'CAPABILITY_UNAVAILABLE')
    }
    const limit = clampInteger(args.limit, 30, 1, 200)
    const records = await query.listSessions()
    const visible = records
      .filter((record) => record.header.origin !== 'subagent')
      .slice(0, limit)
    let titles = []
    try {
      titles = await query.readTitleSnapshots(visible.map((record) => record.header.id))
    } catch {
      titles = []
    }
    // Native batch titles nest as {sessionId,status,value:{session,title?}};
    // align by id instead of assuming the same positional shape.
    const titlesById = new Map()
    for (const observation of Array.isArray(titles) ? titles : []) {
      if (observation?.status !== 'fulfilled') continue
      const title = observation.value?.title?.title
      if (typeof title === 'string' && title.length > 0) titlesById.set(observation.sessionId, title)
    }
    return visible.map((record) => ({
      id: record.header.id,
      title: titlesById.get(record.header.id) ?? null,
      cwd: record.header.cwd ?? '',
      // SessionHeader carries createdAt only; there is no activity timestamp in
      // the base composition, so the field is named for what it is.
      createdAt: record.header.createdAt,
      live: record.live === true,
    }))
  }

  async setModel(args) {
    const current = this.current
    const selection = this.selection
    if (this.installModelSelection === undefined) {
      throw codedError(
        'model switching is unavailable: the runtime agent package could not be loaded',
        'CAPABILITY_UNAVAILABLE',
      )
    }
    const llm = this.ctx.llm
    const models = await this.listModels()
    const wanted = typeof args.id === 'string' ? args.id : undefined
    const wantedProvider = typeof args.provider === 'string' ? args.provider : undefined
    const wantedModel = typeof args.model === 'string' ? args.model : undefined
    let entry
    if (wanted !== undefined) {
      entry = models.find((item) => item.id === wanted)
      if (entry === undefined) {
        const separator = wanted.indexOf('/')
        if (separator > 0) {
          const provider = wanted.slice(0, separator)
          const model = wanted.slice(separator + 1)
          entry = models.find((item) => item.provider === provider && item.model === model)
        }
      }
    } else if (wantedProvider !== undefined && wantedModel !== undefined) {
      entry = models.find((item) => item.provider === wantedProvider && item.model === wantedModel)
    }
    if (entry === undefined) {
      throw codedError(
        `unknown model: ${wanted ?? `${wantedProvider ?? '?'}/${wantedModel ?? '?'}`}`,
        'UNKNOWN_MODEL',
      )
    }
    let resolved
    try {
      resolved = await withTimeout(llm.resolveModelInfo(entry.provider, entry.model), 8000, 'resolveModelInfo')
    } catch (error) {
      throw codedError(`model route ${entry.id} is unavailable: ${errorMessage(error)}`, 'MODEL_UNAVAILABLE')
    }
    if (this.current !== current || this.selection !== selection) throw codedError('the Agent attachment changed during model selection', 'STALE_SESSION')
    if (selection === null) {
      throw codedError('this session has no model selection slot', 'CAPABILITY_UNAVAILABLE')
    }
    // Keep an explicit level when the target model offers it; otherwise use
    // the target's adapter default. The effort never silently survives into a
    // route that does not understand it.
    const previousEffort = selection.current?.reasoningEffort
    const reasoning = resolved?.reasoning
    const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
    const effort = typeof previousEffort === 'string' && efforts.some((level) => level.id === previousEffort)
      ? previousEffort
      : reasoning?.defaultEffort
    selection.current = {
      provider: entry.provider,
      model: entry.model,
      ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
    }
    this.currentRoute = selection.current
    return {
      ...entry,
      ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
    }
  }

  /** Read-only agent-preset roster plus the current session/binding state. */
  async listPresets() {
    const presets = this.presetService()
    if (presets === undefined) {
      throw codedError('the runtime mounted no agent-preset roster', 'CAPABILITY_UNAVAILABLE')
    }
    const roster = await presets.list()
    const current = this.currentPreset()
    let defaultId
    try {
      defaultId = typeof presets.defaultId === 'string' ? presets.defaultId : undefined
    } catch {
      defaultId = undefined
    }
    return jsonSafe({
      current: current ?? null,
      blank: this.isBlankSession(),
      ...(defaultId === undefined ? {} : { default: defaultId }),
      presets: (Array.isArray(roster) ? roster : []).map((row) => ({
        ...row,
        current: row.id === current,
        ...(defaultId === row.id ? { isDefault: true } : {}),
      })),
    })
  }

  /**
   * Apply one preset to the current blank session. A started session returns
   * `locked` instead of mutating its composition; the TUI stages that choice
   * for the next `/new` and keeps this session's tools and prompt intact.
   */
  async setPreset(args) {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0) throw codedError('preset requires a non-empty id', 'INVALID_ARGS')
    const presets = this.presetService()
    if (presets === undefined) {
      throw codedError('the runtime mounted no agent-preset roster', 'CAPABILITY_UNAVAILABLE')
    }
    const current = this.current
    if (current === null) throw codedError('no live session', 'NO_SESSION')
    if (!this.isBlankSession()) {
      return { id, current: this.currentPreset() ?? null, locked: true }
    }
    const resolved = await presets.resolve(id)
    if (typeof resolved?.id !== 'string' || resolved.id.length === 0) {
      throw codedError(`the agent-preset roster returned no id for ${JSON.stringify(id)}`, 'PRESET_INVALID')
    }
    if (typeof resolved.broken === 'string' && resolved.broken.length > 0) {
      throw codedError(`agent preset ${JSON.stringify(id)} is unavailable: ${resolved.broken}`, 'PRESET_INVALID')
    }
    if (this.current !== current) throw codedError('the Agent attachment changed during preset selection', 'STALE_SESSION')
    try {
      await withTimeout(presets.select(current.agent, resolved.id), 15000, 'agent preset selection')
    } catch (error) {
      if (error?.code === 'agent-preset/locked') return { id: resolved.id, current: this.currentPreset() ?? null, locked: true }
      throw codedError(errorMessage(error), typeof error?.code === 'string' ? error.code : 'PRESET_SELECTION_FAILED')
    }
    if (this.current !== current) throw codedError('the Agent attachment changed during preset selection', 'STALE_SESSION')
    this.resetToolPresentation()
    return await this.sessionInfo({ includeSnapshot: false })
  }

  /** Read the selectable reasoning levels for the current provider/model route. */
  async listEfforts() {
    const llm = this.ctx.llm
    const route = await this.routeOf(this.current?.agent)
    if (route === undefined) throw codedError('this session has no model route', 'NO_ROUTE')
    if (typeof llm?.resolveModelInfo !== 'function') {
      throw codedError('the runtime mounted no model metadata resolver', 'CAPABILITY_UNAVAILABLE')
    }
    let resolved
    try {
      resolved = await withTimeout(llm.resolveModelInfo(route.provider, route.model), 8000, 'resolveModelInfo')
    } catch (error) {
      throw codedError(`model route ${route.provider}/${route.model} is unavailable: ${errorMessage(error)}`, 'MODEL_UNAVAILABLE')
    }
    const reasoning = resolved?.reasoning
    const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
    const selected = this.selection?.current?.reasoningEffort
    const effective = typeof selected === 'string' ? selected : reasoning?.defaultEffort
    return jsonSafe({
      provider: route.provider,
      model: route.model,
      ...(typeof selected === 'string' ? { reasoningEffort: selected } : {}),
      ...(typeof reasoning?.defaultEffort === 'string' ? { defaultEffort: reasoning.defaultEffort } : {}),
      ...(typeof effective === 'string' ? { effectiveEffort: effective } : {}),
      available: reasoning !== undefined && efforts.length > 0,
      efforts: efforts.map((level) => ({
        id: String(level.id),
        name: typeof level.name === 'string' && level.name.length > 0 ? level.name : String(level.id),
        ...(typeof level.description === 'string' ? { description: level.description } : {}),
      })),
    })
  }

  /** Apply one adapter-owned reasoning level to the current route. */
  async setEffort(args) {
    const current = this.current
    const selection = this.selection
    if (this.installModelSelection === undefined) {
      throw codedError(
        'reasoning-effort switching is unavailable: the runtime agent package could not be loaded',
        'CAPABILITY_UNAVAILABLE',
      )
    }
    if (selection === null) throw codedError('this session has no model selection slot', 'CAPABILITY_UNAVAILABLE')
    const route = selection.current ?? this.currentRoute
    if (route === undefined) throw codedError('this session has no model route', 'NO_ROUTE')
    const llm = this.ctx.llm
    if (typeof llm?.resolveModelInfo !== 'function') {
      throw codedError('the runtime mounted no model metadata resolver', 'CAPABILITY_UNAVAILABLE')
    }
    let resolved
    try {
      resolved = await withTimeout(llm.resolveModelInfo(route.provider, route.model), 8000, 'resolveModelInfo')
    } catch (error) {
      throw codedError(`model route ${route.provider}/${route.model} is unavailable: ${errorMessage(error)}`, 'MODEL_UNAVAILABLE')
    }
    const reasoning = resolved?.reasoning
    if (reasoning === undefined) {
      throw codedError(`model route ${route.provider}/${route.model} exposes no reasoning levels`, 'EFFORT_UNAVAILABLE')
    }
    const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
    const wanted = args.id
    let requested
    if (wanted === undefined || wanted === null || wanted === '' || wanted === 'default') {
      requested = undefined
    } else if (typeof wanted === 'string') {
      const match = efforts.find((level) => String(level.id) === wanted)
      if (match === undefined) {
        throw codedError(
          `unknown reasoning effort ${JSON.stringify(wanted)} for ${route.provider}/${route.model}; ` +
            `available: ${efforts.map((level) => String(level.id)).join(', ') || '(none)'}`,
          'UNKNOWN_EFFORT',
        )
      }
      requested = String(match.id)
    } else {
      throw codedError('effort id must be a string or null', 'INVALID_ARGS')
    }
    if (this.current !== current || this.selection !== selection) {
      throw codedError('the Agent attachment changed during effort selection', 'STALE_SESSION')
    }
    selection.current = {
      provider: route.provider,
      model: route.model,
      ...(requested === undefined ? {} : { reasoningEffort: requested }),
    }
    this.currentRoute = selection.current
    const effective = requested ?? (typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : undefined)
    return {
      provider: route.provider,
      model: route.model,
      ...(requested === undefined ? {} : { reasoningEffort: requested }),
      ...(effective === undefined ? {} : { effectiveEffort: effective }),
    }
  }

  /** Read-only picker data. All switches execute the native `/permission` command. */
  permissions() {
    const presets = this.tryGet('permissionPresets')
    if (presets === undefined) {
      throw codedError('the runtime mounted no permission-preset service', 'CAPABILITY_UNAVAILABLE')
    }
    return jsonSafe({
      ...presets.catalog(),
      currentValue: presets.current(this.current.agent.session),
    })
  }

  async state() {
    const agent = this.current.agent
    const session = agent.session
    const route = await this.routeOf(agent)
    const presets = this.tryGet('permissionPresets')
    let permissions
    if (presets !== undefined) {
      try {
        permissions = { currentValue: presets.current(session) }
      } catch {
        permissions = undefined
      }
    }
    let usage = null
    const meter = this.tryGet('tokenMeter')
    const contextWindow = session.requestContext?.()?.contextWindow
    if (meter !== undefined && typeof meter.measure === 'function') {
      try {
        const measured = meter.measure(session)
        usage = {
          used: measured.totalTokens,
          ...(typeof contextWindow === 'number' ? { size: contextWindow } : {}),
        }
      } catch {
        usage = null
      }
    }
    const preset = this.currentPreset()
    return {
      sessionId: session.id,
      cwd: this.config.cwd,
      provider: route?.provider ?? agent.options?.provider ?? '',
      model: route?.model ?? agent.options?.model ?? '',
      ...(typeof route?.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(preset === undefined ? {} : { preset }),
      ...(permissions === undefined ? {} : { permissions }),
      status: agent.status,
      pending: {
        nextTurn: agent.inbox.nextTurn.length,
        nextStep: agent.inbox.nextStep.length,
      },
      usage,
    }
  }

  /** Wire correlation only: the target must still be the same native Agent. */
  assertAttachment(params) {
    const current = this.current
    if (!current) throw codedError('no live session', 'NO_SESSION')
    if ((typeof params.sessionId === 'string' && params.sessionId !== current.agent.session.id) ||
        (typeof params.attachmentId === 'string' && params.attachmentId !== current.attachmentId)) {
      throw codedError('the DSH Agent attachment changed before this request could be applied', 'STALE_SESSION')
    }
  }

  dequeue() {
    const agent = this.current.agent
    const removed = []
    for (const [target, messages] of [['next-turn', agent.inbox.nextTurn], ['next-step', agent.inbox.nextStep]]) {
      for (const message of [...messages]) {
        // UI recall must not discard injected context or unsupported attachments.
        if (message.source?.kind !== 'user' || !Array.isArray(message.content) || !message.content.every(block => block?.type === 'text')) continue
        if (agent.inbox.remove(message.id)) removed.push({ text: messageText(message), target, messageId: message.id })
      }
    }
    return removed
  }

  // -------------------------------------------------------------- shutdown

  async shutdown(reason) {
    if (this.closed) return
    this.closed = true
    for (const dispose of this.disposers.splice(0)) {
      try {
        await dispose()
      } catch {
        /* listener disposal is best effort */
      }
    }
    // Abort and drain in-flight native commands before the Agent is torn down,
    // so a compaction (or any handler) settles its audit pair rather than
    // being orphaned by the process ending.
    const aborted = this.abortActiveCommands(reason)
    if (aborted > 0) await this.drainCommands(COMMAND_DRAIN_TIMEOUT_MS)
    await this.switching
    await this.closeCurrent(reason)
    for (const dispose of this.presetDisposers.values()) {
      try {
        await dispose()
      } catch {
        /* preset unregistration is best effort during shutdown */
      }
    }
    this.presetDisposers.clear()
    this.send({ t: 'bye', reason })
    // Crash handling and process shutdown belong to DSH's own launcher: it
    // owns the tree, exit codes and disposal. This bridge only releases its
    // own control channel and requests an orderly exit.
    try {
      this.ctx.get('appExit')?.(0)
    } catch {
      /* launcher already shutting down */
    }
    try {
      process.stdin.pause()
      process.stdin.destroy()
    } catch {
      /* stdin already gone */
    }
  }
}

// ------------------------------------------------------------------ helpers

/** Read one official preset patch row without evaluating its `!!js` children. */
function readPresetPatch(parse, path) {
  const patches = parse(readFileSync(path, 'utf8'), {
    customTags: [{
      tag: YAML_JS_TAG,
      resolve: (value) => ({ __jsExpr: value }),
    }],
  })
  if (Array.isArray(patches) && patches.length === 1) {
    const row = patches[0]?.insert?.[0]
    if (row?.name === '@deepseek-ai/dsh-agent-preset' &&
        typeof row.config?.id === 'string' && Array.isArray(row.config.plugins)) {
      return row.config
    }
  }
  throw new Error(`invalid upstream preset declaration: ${path}`)
}

function routeFromLogged(logged) {
  const config = logged?.config
  if (config === undefined || typeof config.provider !== 'string' || typeof config.model !== 'string') {
    return undefined
  }
  return {
    provider: config.provider,
    model: config.model,
    ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
  }
}

export function normalizeApprovalOutcome(value) {
  if (value === undefined || value === null) return 'cancelled'
  if (typeof value === 'string') {
    if (value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable') {
      return value
    }
    return 'cancelled'
  }
  if (typeof value === 'object') {
    if (value.cancelled === true) return 'cancelled'
    const outcome = value.outcome ?? value.value
    if (outcome === 'allowed-once' || outcome === 'rejected' || outcome === 'cancelled') return outcome
    if (value.allow === true) return 'allowed-once'
    if (value.reject === true) return 'rejected'
  }
  return 'cancelled'
}

export function normalizeAskAnswer(questions, value) {
  if (value === null || typeof value !== 'object') {
    throw codedError('question answer must be {answers: (string|string[])[]}', 'INVALID_ANSWER')
  }
  const list = Array.isArray(value) ? value : value.answers
  if (!Array.isArray(list)) {
    throw codedError('question answer must carry an answers array', 'INVALID_ANSWER')
  }
  if (list.length !== questions.length) {
    throw codedError(
      `question answer must name each of ${questions.length} questions exactly once`,
      'INVALID_ANSWER',
    )
  }
  return {
    answers: questions.map((question, index) => {
      const raw = list[index]
      const labels = new Set((question.options ?? []).map((option) => option.label))
      const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
      const selected = []
      let custom
      for (const entry of values) {
        if (typeof entry !== 'string' || entry.length === 0) continue
        if (labels.size === 0 || labels.has(entry)) selected.push(entry)
        else custom = custom === undefined ? entry : `${custom}\n${entry}`
      }
      return {
        id: question.id,
        selected,
        ...(custom === undefined ? {} : { custom }),
      }
    }),
  }
}

function isCancelledValue(value) {
  if (value === null || typeof value !== 'object') return false
  return value.cancelled === true || value.outcome === 'cancelled'
}

function clampInteger(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

function withTimeout(promise, ms, label) {
  if (promise === undefined || promise === null) return Promise.resolve(promise)
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(codedError(`${label} timed out after ${ms}ms`, 'TIMEOUT')), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}
