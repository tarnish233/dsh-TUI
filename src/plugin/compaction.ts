/**
 * Native compaction reasoning-effort inheritance.
 *
 * DSH's own `dsh-compaction-basic` summarizer replays the conversation through
 * one `ctx.llm.stream()` call with `purpose: 'compaction'`. It copies the
 * provider and model from the latest durable request header but omits that
 * header's `reasoningEffort`. Providers that bind a transport flag to the
 * effort — for example a thinking switch that is only valid when an explicit
 * effort is present — reject the summarization call even though the identical
 * normal turn succeeded seconds earlier.
 *
 * This module installs one narrow, same-process listener on DSH's public
 * `llm/stream` waterfall. For a compaction request only, when no effort is
 * already present and the summarization target is the exact latest durable
 * request's provider/model, it re-dispatches the identical request through the
 * public `ctx.llm.stream()` seam with that exact effort added. Every other
 * field — messages, tools, `toolHistory`, `maxTokens`, `sessionId`, `purpose`,
 * `signal` and the warm prefix-cache alignment they produce — is copied by
 * reference, so the replayed prefix stays byte-identical. A configured
 * summarizer target that differs from the latest durable route receives no
 * effort: an effort from another model is never an inherited default. With no
 * prior explicit effort the request is left untouched, so native model
 * defaults still apply.
 *
 * Nothing here forks DSH compaction, patches a module or class, edits an
 * installation, hardcodes a provider/model list or touches normal turns. The
 * listener is fiber-owned and disposed with the plugin, so HMR reloads neither
 * stack listeners nor leak them. Re-dispatch terminates because the copied
 * request already carries the effort and the listener fails closed to `next()`
 * on any validation error.
 *
 * @module dsh-tui/plugin/compaction
 */

/** Event name of DSH's waterfall around every streaming model call. */
const STREAM_EVENT = 'llm/stream'
/** The sole auxiliary request purpose this bridge may rewrite. */
const COMPACTION_PURPOSE = 'compaction'
/** Effect label so Cordis logs which plugin owns the listener. */
const EFFECT_LABEL = 'dsh-tui.compaction-reasoning-effort'

/**
 * Minimal structural view of the host Cordis context.
 *
 * Only the three public members this bridge uses are named, so mounting the
 * plugin needs no import from `@deepseek-ai/dsh-llm` and remains valid across
 * compatible DSH versions. {@link installCompactionReasoningEffort} accepts the
 * live context as `unknown` and validates these members at runtime.
 */
export interface CompactionSeamHost {
  /** Resolve one mounted native service (`llm`, `sessions`). */
  get(name: string): unknown
  /** Register a fiber-owned event listener; returns its disposer. */
  on(
    name: string,
    listener: (options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>,
    options?: { readonly global?: boolean; readonly prepend?: boolean },
  ): unknown
  /** Run a registration inside a Cordis effect so plugin unload disposes it. */
  effect?(callback: () => (() => void) | void, label?: string): unknown
}

/** Optional diagnostics; never stdout while a TUI is active. */
export interface CompactionSeamOptions {
  /** Receives one redaction-safe warning if the seam degrades. */
  warn?(message: string): void
  /**
   * Who owns the listener's lifetime.
   *
   * `'host'` (default) registers this install inside a host `effect`, so host
   * fiber unload removes it even when the caller drops the returned disposer.
   * `'caller'` registers the listener directly and hands back its disposer for
   * a caller that already runs this install inside its own `ctx.effect`; that
   * keeps one owner and one disposal instead of a nested second effect.
   */
  effectOwner?: 'host' | 'caller'
}

/** Narrow an unknown value to a plain record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Accept only a non-empty string identity. */
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the effort DSH logged with its latest durable request for one session,
 * but only when that request used the exact target this call is summarizing
 * with.
 *
 * `session.requestHeader()` folds the session's own `request/header` events, so
 * the answer comes from DSH's durable log state rather than a TUI-side cache:
 * it is exactly the header the normal turn used, and exactly the header value
 * `summarizeWithLlm` reads when it resolves its fallback target.
 *
 * @param host - live Cordis context carrying `sessions`.
 * @param sessionId - request `sessionId` from the compaction call.
 * @param provider - summarization provider from the compaction call.
 * @param model - summarization model from the compaction call.
 * @returns the durable effort for that exact route, or undefined.
 */
function durableEffort(host: CompactionSeamHost, sessionId: string, provider: string, model: string): string | undefined {
  let session: unknown
  try {
    const sessions = record(host.get('sessions'))
    const get = sessions?.get
    if (sessions === undefined || typeof get !== 'function') return undefined
    session = Reflect.apply(get, sessions, [sessionId])
  } catch {
    return undefined
  }
  const target = record(session)
  const requestHeader = target?.requestHeader
  if (target === undefined || typeof requestHeader !== 'function') return undefined
  let header: unknown
  try {
    header = Reflect.apply(requestHeader, target, [])
  } catch {
    return undefined
  }
  const durable = record(header)
  const config = record(durable?.config)
  if (config === undefined || config.provider !== provider || config.model !== model) return undefined
  // Effective adapter defaults are logged too, but are not a caller's explicit
  // selection. Leave them to the native adapter for this auxiliary request.
  if (record(durable?.adapterDefaults)?.reasoningEffort === true) return undefined
  return identifier(config.reasoningEffort)
}

/**
 * Build the re-dispatch copy for one compaction request, or undefined when the
 * request needs no correction.
 *
 * The copy is a new plain object so DSH's documented immutability contract for
 * request inputs is respected; nested arrays (messages, tools, `toolHistory`)
 * are the same references, which is what keeps the provider prefix cache warm.
 *
 * @param host - live Cordis context.
 * @param options - the exact request DSH handed to the waterfall.
 * @returns the request to re-dispatch, or undefined to continue the chain.
 */
function inheritedRequest(host: CompactionSeamHost, options: unknown): Record<string, unknown> | undefined {
  const request = record(options)
  if (request === undefined || request.purpose !== COMPACTION_PURPOSE) return undefined
  // An explicit effort, including a summarizer configured with one, is authoritative.
  if (request.reasoningEffort !== undefined) return undefined
  const provider = identifier(request.provider)
  const model = identifier(request.model)
  const sessionId = identifier(request.sessionId)
  if (provider === undefined || model === undefined || sessionId === undefined) return undefined
  const effort = durableEffort(host, sessionId, provider, model)
  if (effort === undefined) return undefined
  return { ...request, reasoningEffort: effort }
}

/**
 * Install the compaction effort bridge on one live host context.
 *
 * The listener is outermost on the waterfall, so the corrected request is the
 * only one the adapter and every inner middleware observe; the abandoned outer
 * chain never reaches the adapter. It is registered globally so compaction
 * issued from a scoped agent context is covered too, and it degrades to
 * `next()` for every request it does not fully validate.
 *
 * Lifetime is never dropped: with `effectOwner: 'host'` the listener lives in a
 * host effect, and with `effectOwner: 'caller'` the caller owns the returned
 * disposer inside its own effect. A host without `effect` still gets a
 * removable listener either way, so no `llm/stream` hook can outlive its owner.
 *
 * @param host - live Cordis context of the mounted TUI plugin; only the public
 *   `get`/`on`/`effect` members are touched, so the mount site needs no cast.
 * @param options - optional warning sink and effect ownership.
 * @returns an idempotent disposer that removes the listener; when the host owns
 *   the effect, fiber unload removes it as well and the second call is a no-op.
 */
export function installCompactionReasoningEffort(host: unknown, options: CompactionSeamOptions = {}): () => void {
  const seam = record(host)
  if (seam === undefined || typeof seam.get !== 'function' || typeof seam.on !== 'function') return () => {}
  const target = seam as unknown as CompactionSeamHost
  let warned = false
  const warn = (message: string): void => {
    if (warned) return
    warned = true
    try {
      options.warn?.(message)
    } catch {
      /* diagnostics must never break native dispatch */
    }
  }
  const listener = (request: unknown, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> => {
    let inherited: Record<string, unknown> | undefined
    try {
      inherited = inheritedRequest(target, request)
    } catch {
      inherited = undefined
    }
    if (inherited === undefined) return next()
    try {
      const llm = record(target.get('llm'))
      const stream = llm?.stream
      if (llm === undefined || typeof stream !== 'function') return next()
      // Re-enter DSH's public stream seam with the same request plus the one
      // inherited field. No adapter, retry or audit path is bypassed.
      return Reflect.apply(stream, llm, [inherited]) as AsyncIterable<unknown>
    } catch {
      // Never echo a native rejection: it may quote provider request detail.
      warn('dsh-tui could not inherit the compaction reasoning effort; the native request continues unchanged')
      return next()
    }
  }
  let listenerDisposer: (() => void) | undefined
  const register = (): (() => void) => {
    let detach: () => void
    try {
      const dispose = target.on(STREAM_EVENT, listener, { global: true, prepend: true })
      detach = typeof dispose === 'function' ? dispose as () => void : () => {}
    } catch {
      warn('dsh-tui could not observe native compaction requests; compaction keeps the native defaults')
      detach = () => {}
    }
    // One listener, one detach: a caller-owned effect and later fiber teardown
    // may both reach this disposer.
    let released = false
    listenerDisposer = () => {
      if (released) return
      released = true
      detach()
    }
    return listenerDisposer
  }
  if ((options.effectOwner ?? 'host') === 'host' && typeof target.effect === 'function') {
    try {
      const dispose = target.effect(() => register(), EFFECT_LABEL)
      if (typeof dispose === 'function') return dispose as () => void
      // The effect ran but handed back no disposer; keep serving the listener it
      // registered instead of registering a second one.
      return listenerDisposer ?? register()
    } catch {
      /* an effect that failed before registering still gets one owned listener */
      return listenerDisposer ?? register()
    }
  }
  return register()
}