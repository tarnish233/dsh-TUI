/**
 * NDJSON control-plane framing between the TUI backend and its private DSH
 * runtime process.
 *
 * The runtime writes protocol frames on file descriptor 3 and reads requests
 * from stdin; DSH diagnostics keep stdout/stderr. A malformed line is reported,
 * never parsed optimistically.
 *
 * @module dsh-pi-tui/backend/protocol
 */
import type { BackendEvent, PermissionSelection, SessionEvent, SessionInfo } from './types.ts'

/** File descriptor the runtime writes protocol frames to. */
export const BRIDGE_FD = 3
/** Private wire version: frontend and runtime must agree before connecting. */
export const BRIDGE_PROTOCOL_VERSION = 2

/** Maximum size of one buffered protocol line before the decoder refuses it. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024

export interface BridgeError {
  message: string
  code?: string
}

export type BridgeRuntimeMessage =
  | { t: 'hello'; bridge: string; pid: number; capabilities: string[]; hasModelSelection: boolean; protocolVersion: number }
  | { t: 'event'; seq: number; event: BackendEvent }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: BridgeError }
  | { t: 'protocol'; error: BridgeError }
  | { t: 'fatal'; error: BridgeError }
  | { t: 'bye'; reason: string }

export interface BridgeRequest {
  t: 'req'
  id: number
  method: string
  params: Record<string, unknown>
}

/** Raised when the runtime sends a frame that violates the control contract. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** Encode one protocol frame; throws on values JSON cannot represent. */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

export type DecodedLine =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

/**
 * Incremental newline decoder. Partial lines stay buffered; oversized lines
 * fail closed so a runaway runtime cannot exhaust backend memory.
 */
export class LineDecoder {
  private buffer = ''
  private failed = false

  push(chunk: string): DecodedLine[] {
    if (this.failed) return []
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
      this.failed = true
      this.buffer = ''
      return [{ ok: false, error: `control line exceeded ${MAX_LINE_BYTES} bytes` }]
    }
    const out: DecodedLine[] = []
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index === -1) return out
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim().length === 0) continue
      try {
        out.push({ ok: true, value: JSON.parse(line) })
      } catch (error) {
        out.push({ ok: false, error: 'malformed control JSON' })
      }
    }
  }

  /** Flush a trailing non-newline-terminated line, if any. */
  flush(): DecodedLine[] {
    if (this.buffer.length === 0) return []
    const line = this.buffer
    this.buffer = ''
    try {
      return [{ ok: true, value: JSON.parse(line) }]
    } catch (error) {
      return [{ ok: false, error: 'malformed control JSON' }]
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ProtocolError(`runtime frame field "${field}" must be a string`)
  return value
}

function normalizePermissions(value: unknown): PermissionSelection {
  if (!isRecord(value) || typeof value.currentValue !== 'string' || !value.currentValue) {
    throw new ProtocolError('runtime permissions must contain a currentValue string')
  }
  return { currentValue: value.currentValue }
}

/** Validate one decoded runtime frame against the control contract. */
export function parseRuntimeMessage(value: unknown): BridgeRuntimeMessage {
  if (!isRecord(value)) throw new ProtocolError('runtime frame must be a JSON object')
  const tag = value.t
  switch (tag) {
    case 'hello': {
      if (value.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new ProtocolError(`unsupported runtime protocol version; expected ${BRIDGE_PROTOCOL_VERSION}`)
      if (!Array.isArray(value.capabilities)) throw new ProtocolError('hello.capabilities must be an array')
      for (const capability of value.capabilities) {
        if (typeof capability !== 'string') throw new ProtocolError('hello.capabilities entries must be strings')
      }
      return {
        t: 'hello',
        bridge: stringField(value.bridge, 'bridge'),
        pid: typeof value.pid === 'number' ? value.pid : 0,
        capabilities: value.capabilities as string[],
        hasModelSelection: value.hasModelSelection === true,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
      }
    }
    case 'event': {
      if (!isRecord(value.event) || typeof value.event.type !== 'string') {
        throw new ProtocolError('event frame must carry a typed event object')
      }
      return {
        t: 'event',
        seq: typeof value.seq === 'number' ? value.seq : 0,
        event: value.event.type === 'permissions' ? {
          type: 'permissions',
          sessionId: stringField(value.event.sessionId, 'sessionId'),
          value: normalizePermissions(value.event.value),
        } : value.event as BackendEvent,
      }
    }
    case 'res': {
      if (typeof value.id !== 'number') throw new ProtocolError('res.id must be a number')
      if (value.ok === true) return { t: 'res', id: value.id, ok: true, result: value.result }
      if (value.ok === false) {
        const error = isRecord(value.error) ? value.error : {}
        return {
          t: 'res',
          id: value.id,
          ok: false,
          error: {
            message: typeof error.message === 'string' ? error.message : 'runtime request failed',
            ...(typeof error.code === 'string' ? { code: error.code } : {}),
          },
        }
      }
      throw new ProtocolError('res.ok must be a boolean')
    }
    case 'protocol':
    case 'fatal': {
      const error = isRecord(value.error) ? value.error : {}
      return {
        t: tag,
        error: {
          message: typeof error.message === 'string' ? error.message : 'runtime protocol error',
          ...(typeof error.code === 'string' ? { code: error.code } : {}),
        },
      }
    }
    case 'bye':
      return { t: 'bye', reason: typeof value.reason === 'string' ? value.reason : '' }
    default:
      throw new ProtocolError(`unknown runtime frame tag: ${JSON.stringify(tag)}`)
  }
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value)) return false
  return typeof value.type === 'string' && typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq >= 0
}

/** Normalize the runtime's session info payload into the shared contract. */
export function normalizeSessionInfo(value: unknown): SessionInfo {
  if (!isRecord(value)) throw new ProtocolError('runtime session info must be an object')
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
    throw new ProtocolError('runtime session info has no sessionId')
  }
  const events = Array.isArray(value.events) ? value.events.filter(isSessionEvent) : undefined
  return {
    ...(typeof value.attachmentId === 'string' ? { attachmentId: value.attachmentId } : {}),
    sessionId: value.sessionId,
    cwd: typeof value.cwd === 'string' ? value.cwd : '',
    provider: typeof value.provider === 'string' ? value.provider : '',
    model: typeof value.model === 'string' ? value.model : '',
    ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
    ...(typeof value.preset === 'string' && value.preset.length > 0 ? { preset: value.preset } : {}),
    ...(value.permissions === undefined ? {} : { permissions: normalizePermissions(value.permissions) }),
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.filter((entry): entry is string => typeof entry === 'string')
      : [],
    ...(events === undefined ? {} : { events }),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(typeof value.totalEvents === 'number' ? { totalEvents: value.totalEvents } : {}),
  }
}