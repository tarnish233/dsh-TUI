/**
 * JavaScript terminal-diagnostic isolation for the in-process native TUI.
 *
 * Native DSH plugins emit diagnostics that the TUI cannot reach through Cordis:
 * the shared provider listing cache hardcodes `console.error(tag, …)` /
 * `console.warn(tag, …)` (installed `dsh-llm-deepseek` `createModelListingCache`),
 * so a successful catalog refresh reaches fd 2 — the same terminal the renderer
 * owns — long after the editor is on screen. Nothing in `ctx.logger` can
 * intercept it.
 *
 * This module owns a narrow, explicit lease over the two *JavaScript* write
 * functions `process.stdout.write` and `process.stderr.write`. While installed,
 * every diagnostic passes through one bounded path:
 *
 * 1. complete lines are decoded — a `string` chunk passes through, a
 *    `Buffer`/`Uint8Array` chunk is reassembled by a per-channel
 *    `StringDecoder` (so a UTF-8 sequence split across writes is intact and the
 *    encoding argument never reinterprets bytes) — and write callbacks settle,
 * 2. ANSI escape sequences and control characters are stripped,
 * 3. `redactDiagnostic()` removes credential-shaped values,
 * 4. the line is classified and handed to `onRecord`,
 * 5. it is appended to one bounded private log (mode `0600` in a `0700`
 *    directory, at most one rotated generation).
 *
 * Apart from the native fatal diagnostic (below), nothing is forwarded to the
 * terminal. The renderer therefore needs its own writer,
 * {@link TerminalOutputLease.terminalWrite}, which always targets the real
 * pre-capture stdout writer and propagates its errors; renderer bytes never
 * enter the diagnostic path and this module never inspects them.
 *
 * A native fail-loud diagnostic (`<bin>: fatal load failure:` /
 * `<bin>: fatal uncaught exception:`) releases the capture first, so the
 * application's `onFatal` hook sees a normal terminal and can restore it
 * synchronously, and only then re-emits the sanitized line on the original
 * stderr writer. Forwarding after the hook keeps the fatal diagnostic visible
 * instead of swallowing it, and the native exit policy is untouched.
 *
 * Explicit limits — stated because they are easy to overclaim:
 *
 * - This is JavaScript-write interception, **not** descriptor isolation. Writes
 *   from a native addon, from a child process that inherited fd 1/fd 2, or from
 *   an independently opened `/dev/tty` bypass the lease completely.
 * - It is installed/restored by the application lifecycle. While installed,
 *   *all* same-process JS stdout/stderr text (including `console.*`) is treated
 *   as diagnostics; the renderer must use `terminalWrite`.
 * - Lines are not silently dropped: every accepted line is stored in the private
 *   log, and a bounded overflow is marked in it. What differs is only whether a
 *   line is *surfaced*: an unknown stderr line is a `warning` (native stderr is
 *   where failures are reported), while an unknown stdout line stays `routine`
 *   (log-only) unless it plainly reads as a warning/failure — generic
 *   `console.log` chatter must not flood a transcript. The known periodic
 *   successful model-listing line is always `routine`, as is one exact piece of
 *   Node's own startup noise: the `stripTypeScriptTypes` experimental warning
 *   (and only its own adjacent companion hint) that the installed DSH PTC
 *   runtime triggers once per process. Every other experimental warning keeps
 *   surfacing. Records are plain
 *   sanitized text: never serialized objects, stack/cause dumps, session data or
 *   image bytes.
 * - The private log is bounded in memory and on disk. An over-long line is
 *   dropped whole with a marker instead of being written partially, so a
 *   credential can never be stored as a truncated fragment.
 * - The log target is verified, not repaired: a symlink, a non-regular file, a
 *   non-owner-only mode or an unwritable directory fails the lease before any
 *   stream is patched. This module never chmods, appends to or renames over a
 *   target it did not create, and it never reads user credentials or config.
 * - Only one lease may capture per process (a `Symbol.for` marker, so a second
 *   module instance cannot stack a capture); a storage failure is reported once
 *   as one truthful warning while capture keeps working without persistence.
 *
 * @module dsh-tui/backend/terminal-output
 */
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { redactDiagnostic } from './errors.ts'

/** How the lease classifies one captured line. */
export type TerminalDiagnosticKind = 'routine' | 'warning' | 'fatal'

/** One sanitized diagnostic line, never the raw terminal bytes. */
export interface TerminalDiagnosticRecord {
  /** Which JavaScript stream the line was written to. */
  readonly channel: 'stdout' | 'stderr'
  /**
   * `routine` = known periodic success (or plain stdout chatter that is
   * log-only), `warning` = a diagnostic worth surfacing, `fatal` = native
   * fail-loud.
   */
  readonly kind: TerminalDiagnosticKind
  /** Sanitized single line: no ANSI/control characters, no credential values. */
  readonly text: string
}

/** Construction options for {@link createTerminalOutputLease}. */
export interface TerminalOutputLeaseOptions {
  /** Application-private directory for the diagnostic log (created `0700` if absent). */
  readonly directory: string
  /** Receives every captured diagnostic line, already sanitized. Never throws into the capture path. */
  readonly onRecord?: (record: TerminalDiagnosticRecord) => void
  /**
   * Called synchronously for a native fail-loud diagnostic, *before* the line is
   * forwarded to the original stderr. Capture is already released when the hook
   * runs, so it can write terminal-restore sequences; the application restores
   * its UI here and then either exits through the native policy or returns.
   */
  readonly onFatal?: (text: string) => void
}

/** The narrow handle the application lifecycle owns. */
export interface TerminalOutputLease {
  /** Absolute path of the private diagnostic log. */
  readonly logPath: string
  /** Original stdout writer for the renderer; never captured, never inspected. */
  terminalWrite(data: string): void
  /**
   * Start capturing JavaScript stdout/stderr writes. Idempotent (a double
   * install or HMR re-attach cannot stack a capture) and refused after `close()`.
   * Captured writes accept strings and `Buffer`/`Uint8Array`, settle their
   * callback once, and report success: nothing is forwarded, so a captured
   * writer is never backpressured.
   */
  install(): void
  /** Synchronously stop capturing. Idempotent and safe to call from `onFatal`. */
  restore(): void
  /** Resolve after queued lines reached the private log, or after a bounded wait. */
  flush(): Promise<void>
  /** Release capture (if still installed), flush, and close the log. Idempotent. */
  close(): Promise<void>
}

/** Log file name inside {@link TerminalOutputLeaseOptions.directory}. */
export const TERMINAL_DIAGNOSTIC_LOG = 'terminal-diagnostics.log'

/** Suffix of the single rotated generation. */
const ROTATED_SUFFIX = '.1'
/** Bound of one log generation; the rotated generation may add at most as much again. */
const MAX_LOG_BYTES = 1024 * 1024
/** A longer line is dropped whole (with a marker) rather than stored partially. */
const MAX_LINE_CHARS = 64 * 1024
/** Bounded in-memory write queue. */
const MAX_QUEUE_LINES = 512
const MAX_QUEUE_BYTES = 256 * 1024
/** One log append batch. */
const MAX_BATCH_BYTES = 64 * 1024
/** Waits stay bounded even when the private log is wedged. */
const FLUSH_TIMEOUT_MS = 1000
const CLOSE_TIMEOUT_MS = 1000

/**
 * Known periodic success from the native provider listing cache:
 * `[<owner>] model listing from <url> loaded <n> model(s), skipped <m> row(s)`.
 * That routine line is stored but never surfaced as a transcript diagnostic.
 * Failures of the same cache keep their own wording and stay `warning`.
 */
const ROUTINE_LISTING = /^(?:\[[^\]\n]{1,64}\]\s+)?model listing from \S+ loaded \d+ model\(s\), skipped \d+ row\(s\)$/

/**
 * Native fail-loud labels written by `installFailLoud(binName)`:
 * `<bin>: fatal load failure: …` / `<bin>: fatal uncaught exception: …`.
 */
const FATAL_LABEL = /^(?:[^\s:]{1,64}:\s+)?fatal (?:load failure|uncaught exception):/

/**
 * One exact Node experimental warning that is routine for this application.
 *
 * Origin (read-only inspection of the installed packages, Node v26.13.0): DSH's
 * `@deepseek-ai/dsh-ptc-runtime-node` imports `stripTypeScriptTypes` from
 * `node:module` for its TypeScript execution modes and Node itself emits
 * `(node:<pid>) ExperimentalWarning: stripTypeScriptTypes is an experimental
 * feature and might change at any time` on stderr the first time it runs — once
 * per process, as a direct `process.stderr.write`, i.e. inside this capture.
 * That is successful DSH function, not a DSH failure, so it is stored
 * (log-only) instead of becoming a transcript notice.
 *
 * The wording is matched exactly, not by prefix: any other experimental API,
 * any other experimental wording, and any future Node wording change stays a
 * `warning` (visible). The `(<title>:<pid>)` prefix varies per process and is
 * bounded, not wildcarded across the rest of the line.
 */
const NODE_STRIP_TYPES_WARNING = /^\([^\s()]{1,64}:\d{1,10}\) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time$/

/**
 * Node's companion hint, written in the *same* stderr write directly after a
 * warning unless `--trace-warnings` was passed. It carries no diagnostic value
 * by itself, so it is demoted only when it unambiguously continues
 * {@link NODE_STRIP_TYPES_WARNING} on the same stream with no line in between;
 * a standalone hint (belonging to any other warning) keeps surfacing.
 */
const NODE_TRACE_HINT = /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/

/** Marker used instead of a diagnostic line that exceeded {@link MAX_LINE_CHARS}. */
const OVERFLOW_MARKER = '[dsh-tui] dropped an over-long diagnostic line'

/**
 * Failure vocabulary that must surface even when it arrives on stdout. It is a
 * deliberately small word list: a generic `console.log` line stays log-only.
 */
const WARNING_TEXT = /\b(?:warn(?:ing)?|error|fail(?:ed|ure)?|exception|uncaught|denied|refused|panic|fatal|timeout|timed out)\b/i

/** Disable symlink following for the private log where the platform supports it. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

/** The subset of a stream `write()` this module must preserve. */
type StreamWrite = (...args: unknown[]) => boolean

const CHANNELS = ['stdout', 'stderr'] as const

type Channel = (typeof CHANNELS)[number]

/**
 * Process-wide capture marker, shared by every module instance of this file
 * (HMR, duplicated bundle). A second lease must not stack a capture on top of an
 * active one: its `terminalWrite` would otherwise target the other lease's patch.
 */
const ACTIVE_LEASE = Symbol.for('dsh-tui.terminal-output.active')

interface ActiveLease {
  readonly token: object
  readonly stdoutOriginal: StreamWrite
}

/** The capture currently installed in this process, whoever loaded this module. */
function activeLease(): ActiveLease | undefined {
  const value = (process as unknown as Record<symbol, unknown>)[ACTIVE_LEASE]
  return value !== null && typeof value === 'object' ? (value as ActiveLease) : undefined
}

/** Short failure text for a local setup error; never a stack or a payload dump. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  if (typeof error === 'string') return error
  return 'unknown error'
}

/** One lease-local setup failure with stable wording. */
function leaseFailure(message: string): Error {
  return new Error(`dsh-tui: ${message}`)
}

/**
 * Create (or validate) the application-private diagnostic directory.
 *
 * An existing directory is accepted only when it is a directory and not
 * group/other-writable; the mode of an existing directory is never changed.
 */
async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw leaseFailure(`cannot create the private terminal diagnostic directory: ${describeFailure(error)}`)
  }
  let stats
  try {
    stats = await lstat(directory)
  } catch (error) {
    throw leaseFailure(`cannot inspect the private terminal diagnostic directory: ${describeFailure(error)}`)
  }
  if (!stats.isDirectory()) throw leaseFailure('the private terminal diagnostic directory is not a directory')
  if ((stats.mode & 0o022) !== 0) throw leaseFailure('the private terminal diagnostic directory is writable by other users')
}

/**
 * Open the private log without trusting whatever is already at that path.
 *
 * An existing symlink, special file or non-owner-only file fails the lease
 * instead of being repaired: this module must never chmod, append to or
 * otherwise take ownership of a target it did not create.
 */
async function openPrivateLog(path: string): Promise<FileHandle> {
  let existing
  try {
    existing = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw leaseFailure(`cannot inspect the private terminal diagnostic log: ${describeFailure(error)}`)
    }
    existing = undefined
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) throw leaseFailure('refusing a symlink as the private terminal diagnostic log')
    if (!existing.isFile()) throw leaseFailure('refusing a non-regular file as the private terminal diagnostic log')
    if ((existing.mode & 0o077) !== 0) {
      throw leaseFailure('the existing private terminal diagnostic log is not owner-only; remove it or fix its mode')
    }
  }
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW, 0o600)
  } catch (error) {
    throw leaseFailure(`cannot open the private terminal diagnostic log: ${describeFailure(error)}`)
  }
  try {
    // Re-check the opened descriptor: it must be a regular, owner-only file.
    const stats = await handle.stat()
    if (!stats.isFile()) throw leaseFailure('refusing a non-regular file as the private terminal diagnostic log')
    if ((stats.mode & 0o077) !== 0) throw leaseFailure('the private terminal diagnostic log is not owner-only')
    return handle
  } catch (error) {
    await handle.close().catch(() => {})
    throw error instanceof Error && error.message.startsWith('dsh-tui:')
      ? error
      : leaseFailure(`cannot verify the private terminal diagnostic log: ${describeFailure(error)}`)
  }
}

/**
 * Decode one write chunk.
 *
 * `Buffer`/`Uint8Array` bytes are reassembled through a per-channel
 * `StringDecoder`: a multi-byte UTF-8 sequence split across writes stays intact
 * and the encoding never reinterprets bytes. A `string` chunk first flushes
 * bytes held from a previous byte chunk so the two kinds cannot reorder. An
 * unknown encoding is rejected exactly like Node's `write()`; the caller then
 * re-runs the original write so the platform's own error is produced.
 */
function decodeChunk(decoder: StringDecoder, chunk: unknown, encoding: string | undefined): string {
  if (encoding !== undefined && !Buffer.isEncoding(encoding)) throw new TypeError(`Unknown encoding: ${encoding}`)
  if (typeof chunk === 'string') {
    const held = decoder.end()
    return held.length > 0 ? held + chunk : chunk
  }
  if (chunk instanceof Uint8Array) {
    return decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  }
  throw new TypeError('The "chunk" argument must be of type string or an instance of Buffer or Uint8Array')
}

/** Skip one escape sequence starting at `start` (which holds ESC) and return the next index. */
function skipEscapeSequence(text: string, start: number): number {
  const introducer = text.charCodeAt(start + 1)
  if (Number.isNaN(introducer)) return start + 1
  if (introducer === 0x5b) {
    // CSI: `ESC [ … final-byte`
    let index = start + 2
    while (index < text.length) {
      const code = text.charCodeAt(index)
      index += 1
      if (code >= 0x40 && code <= 0x7e) break
    }
    return index
  }
  if (introducer === 0x5d || introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f) {
    // OSC / DCS / SOS / PM / APC: terminated by BEL or ST (`ESC \`).
    let index = start + 2
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code === 0x07) return index + 1
      if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2
      index += 1
    }
    return index
  }
  return start + 2
}

/** Remove ANSI escapes and control characters; tabs become spaces. */
function stripTerminalControls(text: string): string {
  let result = ''
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code === 0x1b) {
      index = skipEscapeSequence(text, index)
      continue
    }
    if (code === 0x09) {
      result += ' '
      index += 1
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      index += 1
      continue
    }
    result += text[index]
    index += 1
  }
  return result
}

/**
 * Whether a line is the one known routine Node warning this application accepts.
 * Node writes warnings to stderr; the same text on stdout is not demoted.
 */
function isRoutineNodeWarning(channel: Channel, text: string): boolean {
  return channel === 'stderr' && NODE_STRIP_TYPES_WARNING.test(text)
}

/**
 * Sanitize one captured line: strip terminal control text, trim, redact
 * credential-shaped values. Never returns a partial line.
 */
function sanitizeDiagnosticText(line: string): string {
  const stripped = stripTerminalControls(line).trim()
  if (stripped.length === 0) return ''
  // Never truncate here: a shortened line could split a credential value that
  // redaction then fails to recognize. Over-long lines are dropped whole by the
  // caller instead.
  return redactDiagnostic(stripped)
}

/**
 * Classify one sanitized line.
 *
 * - the native fail-loud label is always `fatal` (see {@link forwardFatal});
 * - the exact periodic successful model listing is always `routine`;
 * - the exact known Node `stripTypeScriptTypes` experimental warning, and its
 *   companion hint only while {@link NODE_TRACE_HINT} directly follows it on the
 *   same stream, are `routine` (log-only);
 * - unknown stderr is `warning`: native stderr is where failures are reported,
 *   so nothing there may be silently swallowed;
 * - unknown stdout is `routine` (log-only). Generic `console.log` chatter must
 *   not flood a transcript; a line that plainly reads as a warning/failure is
 *   still surfaced as `warning`.
 *
 * @param traceHintExpected - true only when the previous complete line on this
 *   channel was exactly the known Node warning (one-line adjacency window).
 */
function classify(channel: Channel, text: string, traceHintExpected: boolean): TerminalDiagnosticKind {
  if (FATAL_LABEL.test(text)) return 'fatal'
  if (ROUTINE_LISTING.test(text)) return 'routine'
  if (isRoutineNodeWarning(channel, text)) return 'routine'
  if (channel === 'stderr' && traceHintExpected && NODE_TRACE_HINT.test(text)) return 'routine'
  if (channel === 'stderr') return 'warning'
  return WARNING_TEXT.test(text) ? 'warning' : 'routine'
}

/**
 * Resolve after `ms`; used only for bounded waits.
 *
 * The timer is unref'd: a wait that lost its race must never keep the process
 * alive, while a real wait always has the pending sink work holding the loop.
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Create a terminal-output lease over one private directory.
 *
 * The private log is opened here, so a directory or file that cannot be opened
 * fails the lease *before* any stream is patched: the caller keeps its current
 * terminal behaviour and can report one clear startup diagnostic.
 *
 * @param options - private directory plus the diagnostic/fatal callbacks.
 * @returns the lease; `install()` is a separate, explicit step.
 * @throws TypeError when the directory is missing or a callback is not a function.
 * @throws Error when the private log cannot be opened.
 */
export async function createTerminalOutputLease(options: TerminalOutputLeaseOptions): Promise<TerminalOutputLease> {
  if (options === null || typeof options !== 'object') throw new TypeError('terminal output lease requires an options object')
  const { directory, onRecord, onFatal } = options
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('terminal output lease requires a non-empty private directory')
  }
  if (onRecord !== undefined && typeof onRecord !== 'function') throw new TypeError('onRecord must be a function')
  if (onFatal !== undefined && typeof onFatal !== 'function') throw new TypeError('onFatal must be a function')

  await ensurePrivateDirectory(directory)
  const logPath = join(directory, TERMINAL_DIAGNOSTIC_LOG)
  let handle: FileHandle | undefined = await openPrivateLog(logPath)
  let logSize = 0
  try {
    logSize = (await handle.stat()).size
  } catch {
    logSize = 0
  }

  let phase: 'ready' | 'installed' | 'restored' | 'closed' = 'ready'
  let rotated = false
  let ioFailed = false
  let queueLines: string[] = []
  let queueBytes = 0
  let droppedLines = 0
  let draining: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const token: object = {}
  const pending: Record<Channel, string> = { stdout: '', stderr: '' }
  const decoders: Record<Channel, StringDecoder> = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  // An over-long line is discarded up to the next newline: its continuation in
  // later writes must never be treated as a fresh diagnostic.
  const discarding: Record<Channel, boolean> = { stdout: false, stderr: false }
  /**
   * One-line adjacency window per channel for Node's companion trace hint. It is
   * a constant-size flag (no queue, no timer): set by the exact known Node
   * warning, cleared by the very next line on that channel, whatever it is.
   */
  const traceHintExpected: Record<Channel, boolean> = { stdout: false, stderr: false }
  const discardedChars: Record<Channel, number> = { stdout: 0, stderr: 0 }
  const discardPrefix: Record<Channel, string> = { stdout: '', stderr: '' }
  let stdoutOriginal: StreamWrite | undefined
  let stderrOriginal: StreamWrite | undefined
  let patchedStdout: StreamWrite | undefined
  let patchedStderr: StreamWrite | undefined
  /** True while a record sink runs: a synchronous write from it must not recurse. */
  let reporting = false

  /**
   * Settle a caller-supplied write callback the way a real stream would: later,
   * exactly once. Capture never reports an error, so the callback receives none.
   */
  function settle(callback: unknown): void {
    if (typeof callback !== 'function') return
    queueMicrotask(() => {
      ;(callback as (error?: Error | null) => void)()
    })
  }

  /** Append one already-sanitized line to the bounded queue. Never throws, never recurses. */
  function enqueue(line: string): void {
    if (phase === 'closed' || ioFailed) return
    const bytes = Buffer.byteLength(line) + 1
    if (bytes > MAX_QUEUE_BYTES || queueLines.length >= MAX_QUEUE_LINES || queueBytes + bytes > MAX_QUEUE_BYTES) {
      droppedLines += 1
      return
    }
    queueLines.push(line)
    queueBytes += bytes
    scheduleDrain()
  }

  /** Start one draining pass if none is in flight. */
  function scheduleDrain(): void {
    if (draining !== undefined || ioFailed) return
    // The pass promise must be published before its own `finally` can run, so
    // the cleanup is attached here rather than inside `drainAll`.
    const pass = drainAll()
    draining = pass
    void pass.then(
      () => settleDrain(pass),
      () => settleDrain(pass),
    )
  }

  /** Clear the in-flight marker of one finished pass and continue if work remains. */
  function settleDrain(pass: Promise<void>): void {
    if (draining === pass) draining = undefined
    if (queueLines.length > 0 && !ioFailed) scheduleDrain()
  }

  /**
   * Stop persisting after a sink failure: exactly one truthful warning record,
   * no log write of its own (that is the sink that just failed) and no recursion.
   */
  function failSink(): void {
    if (ioFailed) return
    ioFailed = true
    queueLines = []
    queueBytes = 0
    report({
      channel: 'stderr',
      kind: 'warning',
      text: '[dsh-tui] diagnostic storage failed; further terminal diagnostics may not be persisted',
    })
  }

  /** Drain the queue; a sink error stops the pipeline instead of logging again. */
  async function drainAll(): Promise<void> {
    try {
      while (queueLines.length > 0 && !ioFailed) {
        const batch: string[] = []
        let bytes = 0
        if (droppedLines > 0) {
          const note = `[dsh-tui] ${droppedLines} diagnostic line(s) dropped (bounded log queue)`
          droppedLines = 0
          batch.push(note)
          bytes += Buffer.byteLength(note) + 1
        }
        while (queueLines.length > 0) {
          const next = queueLines[0] as string
          const size = Buffer.byteLength(next) + 1
          if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) break
          queueLines.shift()
          queueBytes -= size
          batch.push(next)
          bytes += size
        }
        if (batch.length === 0) break
        await appendBatch(batch, bytes)
      }
    } catch {
      failSink()
    }
  }

  /** Append one batch, rotating or truncating first so the log stays bounded. */
  async function appendBatch(lines: string[], bytes: number): Promise<void> {
    if (handle === undefined) return
    if (logSize > 0 && logSize + bytes > MAX_LOG_BYTES) {
      if (!rotated) await rotateLog()
      else await truncateLog()
    }
    if (handle === undefined) return
    await handle.appendFile(`${lines.join('\n')}\n`, 'utf8')
    logSize += bytes
  }

  /**
   * Keep exactly one rotated generation; fall back to truncation, never growth.
   *
   * The rotation target is inspected first: a symlink or special file there is
   * never replaced, and the reopened log goes through the same validation as
   * the initial open.
   */
  async function rotateLog(): Promise<void> {
    rotated = true
    const current = handle
    handle = undefined
    try {
      if (current !== undefined) await current.close()
      const target = `${logPath}${ROTATED_SUFFIX}`
      let existing
      try {
        existing = await lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        existing = undefined
      }
      if (existing !== undefined) {
        if (existing.isSymbolicLink() || !existing.isFile()) throw leaseFailure('unsafe rotation target')
        await unlink(target)
      }
      await rename(logPath, target)
      handle = await openPrivateLog(logPath)
      logSize = 0
    } catch {
      try {
        const reopened = await openPrivateLog(logPath)
        handle = reopened
        await reopened.truncate(0)
        logSize = 0
      } catch {
        failSink()
      }
    }
  }

  /** Second overflow of one lease: truncate in place, still bounded. */
  async function truncateLog(): Promise<void> {
    if (handle === undefined) return
    try {
      await handle.truncate(0)
      logSize = 0
    } catch {
      failSink()
    }
  }

  /** Report and drop a line that exceeded the per-line bound: never a partial line. */
  function emitOverflowMarker(channel: Channel, chars: number, kind: TerminalDiagnosticKind = 'warning'): void {
    // A dropped line still breaks the known-warning/hint adjacency.
    traceHintExpected[channel] = false
    const record: TerminalDiagnosticRecord = {
      channel,
      kind,
      text: `${OVERFLOW_MARKER} (${chars} characters)`,
    }
    report(record)
    enqueue(`${kind === 'routine' ? 'info' : kind === 'fatal' ? 'fatal' : 'warn'} ${channel}: ${record.text}`)
    if (kind === 'fatal') forwardFatal(record.text)
  }

  /** Whether a bounded prefix of an over-long line is the native fail-loud label. */
  function looksFatal(line: string): boolean {
    try {
      return FATAL_LABEL.test(sanitizeDiagnosticText(line.slice(0, 256)))
    } catch {
      return false
    }
  }

  /** Hand one sanitized line to the application and the private log. Never throws. */
  function report(record: TerminalDiagnosticRecord): void {
    if (onRecord === undefined) return
    reporting = true
    try {
      onRecord(record)
    } catch {
      // A throwing sink must not recurse into the capture path or fail the writer.
    } finally {
      reporting = false
    }
  }

  /** Original stderr writer: the fatal diagnostic must land on an unpatched stream. */
  function originalStderrWrite(): StreamWrite {
    return stderrOriginal ?? (process.stderr.write as unknown as StreamWrite)
  }

  /** Write one already-sanitized line directly to the real stderr. */
  function writeToTerminal(text: string): void {
    try {
      Reflect.apply(originalStderrWrite(), process.stderr, [`${text}\n`])
    } catch {
      // The stream itself is failing; there is nowhere else that would not recurse.
    }
  }

  /**
   * Release the terminal around a native fail-loud diagnostic, then keep it
   * visible. The hook runs after the capture is released, so it can write
   * terminal-restore sequences, and before any forward.
   */
  function forwardFatal(text: string): void {
    restore()
    try {
      onFatal?.(text)
    } catch {
      // The restore contract belongs to the caller; never lose the fatal text.
    }
    writeToTerminal(text)
  }

  /**
   * Record and forward one continuation line of the native fatal diagnostic
   * (the rest of the same write: `util.inspect` output, cause chain, context).
   * Capture is already released, so this is a direct stderr write.
   */
  function forwardFatalContinuation(channel: Channel, rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    let text: string
    try {
      text = sanitizeDiagnosticText(line)
    } catch {
      return
    }
    if (text.length === 0) return
    // Bounded like every other record: never a partial credential fragment.
    if (text.length > MAX_LINE_CHARS) text = `${OVERFLOW_MARKER} (${text.length} characters)`
    report({ channel, kind: 'fatal', text })
    enqueue(`fatal ${channel}: ${text}`)
    writeToTerminal(text)
  }

  /** Classify, sanitize and route one complete line; returns its kind. */
  function emitLine(channel: Channel, rawLine: string): TerminalDiagnosticKind | undefined {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    let text: string
    try {
      text = sanitizeDiagnosticText(line)
    } catch {
      return undefined
    }
    if (text.length === 0) return undefined
    const kind = classify(channel, text, traceHintExpected[channel])
    // Only the exact known Node warning opens the hint window, and only until the
    // next complete line on this channel; every other line closes it.
    traceHintExpected[channel] = isRoutineNodeWarning(channel, text)
    report({ channel, kind, text })
    enqueue(`${kind === 'routine' ? 'info' : kind === 'fatal' ? 'fatal' : 'warn'} ${channel}: ${text}`)
    if (kind === 'fatal') forwardFatal(text)
    return kind
  }

  /** Start discarding one over-long line; only a bounded prefix is kept for the fatal check. */
  function beginDiscard(channel: Channel, firstChunk: string): void {
    discarding[channel] = true
    discardedChars[channel] = firstChunk.length
    discardPrefix[channel] = firstChunk.slice(0, 256)
    pending[channel] = ''
  }

  /** End the discarded line: exactly one marker, never any of its content. */
  function endDiscard(channel: Channel): void {
    const chars = discardedChars[channel]
    const prefix = discardPrefix[channel]
    discarding[channel] = false
    discardedChars[channel] = 0
    discardPrefix[channel] = ''
    emitOverflowMarker(channel, chars, looksFatal(prefix) ? 'fatal' : 'warning')
  }

  /**
   * Split captured text into complete lines.
   *
   * An over-long line is dropped as a whole — buffered, continued in later
   * writes, or already terminated — so a credential split across writes can
   * never be stored as a tail. The rest of a write that carried a native fatal
   * line is that diagnostic's continuation.
   */
  function ingest(channel: Channel, text: string): void {
    if (text.length === 0) return
    let remaining = text
    if (discarding[channel]) {
      const newline = remaining.indexOf('\n')
      if (newline === -1) {
        discardedChars[channel] += remaining.length
        return
      }
      discardedChars[channel] += newline
      remaining = remaining.slice(newline + 1)
      endDiscard(channel)
      if (remaining.length === 0) return
    }
    const parts = (pending[channel] + remaining).split('\n')
    pending[channel] = ''
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] as string
      if (index === parts.length - 1) {
        // Unterminated tail: kept, or discarded from here to the next newline.
        if (part.length > MAX_LINE_CHARS) beginDiscard(channel, part)
        else pending[channel] = part
        return
      }
      if (part.length > MAX_LINE_CHARS) {
        emitOverflowMarker(channel, part.length, looksFatal(part) ? 'fatal' : 'warning')
        continue
      }
      if (emitLine(channel, part) !== 'fatal') continue
      for (const tail of parts.slice(index + 1)) forwardFatalContinuation(channel, tail)
      return
    }
  }

  /** Build one patched `write` that captures and settles like the real stream. */
  function makePatched(channel: Channel, stream: NodeJS.WriteStream, original: StreamWrite): StreamWrite {
    return function patched(this: unknown, ...args: unknown[]): boolean {
      if (phase !== 'installed') return Reflect.apply(original, this ?? stream, args) as boolean
      const encodingOrCallback = args[1]
      if (reporting) {
        // A sink that logs synchronously is contained: settling the callback keeps
        // the stream contract while the line is counted, never re-captured.
        settle(typeof encodingOrCallback === 'function' ? encodingOrCallback : args[2])
        droppedLines += 1
        return true
      }
      let text: string
      try {
        const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
        text = decodeChunk(decoders[channel], args[0], encoding)
      } catch {
        // Invalid chunk or encoding: re-run the original write so the platform
        // produces its own error (ERR_INVALID_ARG_TYPE / ERR_UNKNOWN_ENCODING).
        return Reflect.apply(original, this ?? stream, args) as boolean
      }
      ingest(channel, text)
      const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : args[2]
      settle(callback)
      // Nothing is forwarded, so the capture path is never backpressured.
      return true
    }
  }

  /** Restore one stream only if this lease is still the active writer. */
  function restoreStream(stream: NodeJS.WriteStream, patched: StreamWrite | undefined, original: StreamWrite | undefined): void {
    if (patched === undefined || original === undefined) return
    try {
      const current = stream.write as unknown
      if (current === patched) stream.write = original as unknown as typeof stream.write
    } catch {
      // A frozen stream cannot be restored; never clobber another writer.
    }
  }

  /** Record the remaining partial lines so restore does not lose them. */
  function flushPendingLines(): void {
    for (const channel of CHANNELS) {
      if (discarding[channel]) endDiscard(channel)
      const rest = pending[channel]
      pending[channel] = ''
      if (rest.length === 0) continue
      if (rest.length > MAX_LINE_CHARS) emitOverflowMarker(channel, rest.length, looksFatal(rest) ? 'fatal' : 'warning')
      else emitLine(channel, rest)
    }
  }

  function install(): void {
    if (phase === 'installed') return
    if (phase === 'closed') throw new Error('dsh-tui: cannot install a closed terminal output lease')
    if (activeLease() !== undefined) {
      throw leaseFailure('another terminal output lease is already capturing stdout and stderr')
    }
    phase = 'installed'
    stdoutOriginal = process.stdout.write as unknown as StreamWrite
    stderrOriginal = process.stderr.write as unknown as StreamWrite
    patchedStdout = makePatched('stdout', process.stdout, stdoutOriginal)
    patchedStderr = makePatched('stderr', process.stderr, stderrOriginal)
    process.stdout.write = patchedStdout as unknown as typeof process.stdout.write
    process.stderr.write = patchedStderr as unknown as typeof process.stderr.write
    ;(process as unknown as Record<symbol, unknown>)[ACTIVE_LEASE] = { token, stdoutOriginal } satisfies ActiveLease
  }

  function restore(): void {
    if (phase !== 'installed') return
    phase = 'restored'
    restoreStream(process.stdout, patchedStdout, stdoutOriginal)
    restoreStream(process.stderr, patchedStderr, stderrOriginal)
    const active = activeLease()
    if (active !== undefined && active.token === token) {
      delete (process as unknown as Record<symbol, unknown>)[ACTIVE_LEASE]
    }
    patchedStdout = undefined
    patchedStderr = undefined
    // Bytes still held by a decoder are the tail of the last byte chunk.
    for (const channel of CHANNELS) {
      const tail = decoders[channel].end()
      if (tail.length > 0) ingest(channel, tail)
    }
    // Remaining partial lines are still real diagnostics: record them, bounded.
    flushPendingLines()
  }

  async function flush(): Promise<void> {
    if (ioFailed) return
    const deadline = Date.now() + FLUSH_TIMEOUT_MS
    scheduleDrain()
    while (!ioFailed && (queueLines.length > 0 || draining !== undefined)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      if (draining === undefined) {
        scheduleDrain()
        if (draining === undefined) return
      }
      await Promise.race([draining.catch(() => {}), sleep(remaining)])
    }
  }

  function close(): Promise<void> {
    if (closing !== undefined) return closing
    closing = (async () => {
      restore()
      phase = 'closed'
      await flush()
      const current = handle
      handle = undefined
      if (current !== undefined) {
        await Promise.race([current.close().catch(() => {}), sleep(CLOSE_TIMEOUT_MS)])
      }
    })()
    return closing
  }

  return {
    logPath,
    terminalWrite(data: string): void {
      // Always the real terminal writer: this lease's pre-capture writer, then an
      // active lease's pre-capture writer (another module instance), then the
      // current one. Terminal errors propagate: a dead terminal must not be
      // masked into a hang.
      const write = stdoutOriginal ?? activeLease()?.stdoutOriginal ?? (process.stdout.write as unknown as StreamWrite)
      Reflect.apply(write, process.stdout, [data])
    },
    install,
    restore,
    flush,
    close,
  }
}