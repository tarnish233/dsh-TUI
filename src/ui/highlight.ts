/**
 * Bounded code highlighting for Pi TUI Markdown code blocks, loaded lazily.
 *
 * Adapted from agent_tui (MIT) src/ui/highlight.ts and its cc-dark palette.
 * Unlike the streaming renderer, this module refuses to highlight large or
 * very long code blocks and reuses a small LRU by code+language, so a token
 * update cannot re-run highlight.js on already-stable code.
 *
 * Lazy contract
 * -------------
 * `theme.ts` (and therefore every UI surface) imports this facade, and this
 * facade imports **no** highlight.js code: startup only pays for the palette in
 * `highlight-palette.ts`. The grammars live in `highlight-runtime.ts` and are
 * reached through exactly one dynamic import:
 *
 * - `idle`: nothing is loaded. `highlightCode` returns `plainHighlightLines`
 *   (byte-identical to the unstyled rows the eager implementation produced for
 *   an unknown language) and starts the single load.
 * - `loading`: concurrent calls return the same fallback and never start a
 *   second import.
 * - `ready`: real syntax colors. The fallback rows were never cached, so no
 *   stale unstyled line can survive; the generation counter and the subscriber
 *   notification are how the Markdown owners drop their *own* line caches (a
 *   `Markdown` instance caches rendered lines by `text`+`width` independently
 *   of any block cache).
 * - `failed`: the load failed once. Highlighting stays on the fallback
 *   permanently, nothing throws, and no retry storm starts. A host that wants
 *   to retry calls {@link ensureHighlightRuntime} again after a reset.
 *
 * `whenHighlightRuntimeReady` is the awaitable shape of the same load; it is
 * used by tests and by a parent that wants to warm the grammars while an
 * overlay is open. No debug UI reads these functions.
 */
import { plainHighlightLines } from './highlight-palette.ts'
import type { HighlightRuntime } from './highlight-runtime.ts'

export type { HighlightRuntime } from './highlight-runtime.ts'

/** `idle` before the first code block, then one of the three settled states. */
export type HighlightRuntimeState = 'idle' | 'loading' | 'ready' | 'failed'

/** What a subscriber learns when the load settles. */
export interface HighlightRuntimeEvent {
  readonly state: 'ready' | 'failed'
  /** Increments once per successful load; use it to stamp derived caches. */
  readonly generation: number
}

/** One load attempt. The default imports the grammar module. */
export type HighlightRuntimeLoader = () => Promise<HighlightRuntime>

const MAX_HIGHLIGHT_CHARS = 6000
const MAX_HIGHLIGHT_LINES = 200
const MAX_CACHE_ENTRIES = 64
/** Highlighted rows by `lang\0code`. Never populated from the fallback path. */
const cache = new Map<string, string[]>()

const defaultLoader: HighlightRuntimeLoader = () => import('./highlight-runtime.ts').then(module => module.highlightRuntime)
let loader: HighlightRuntimeLoader = defaultLoader

let state: HighlightRuntimeState = 'idle'
let runtime: HighlightRuntime | undefined
let generation = 0
let importCount = 0
let inflight: Promise<void> | undefined
/** Identifies the current attempt, so a reset can never be overwritten. */
let epoch = 0
const listeners = new Set<(event: HighlightRuntimeEvent) => void>()

/**
 * Highlight one code block, or return plain styled rows while the grammars are
 * not loaded / the block is too large.
 *
 * The returned array length matches the input line count. Cache hits return the
 * identical array, so a repaint never re-runs a grammar.
 */
export function highlightCode(code: string, lang?: string): string[] {
  if (code.length > MAX_HIGHLIGHT_CHARS || code.split('\n').length > MAX_HIGHLIGHT_LINES) return plainHighlightLines(code)
  const loaded = runtime
  if (loaded === undefined) {
    // The fallback is deliberately not cached: a cached unstyled row would
    // outlive the load and repaint as "highlighted" forever.
    void ensureHighlightRuntime()
    return plainHighlightLines(code)
  }
  const key = `${lang ?? ''}\u0000${code}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    // Refresh LRU position.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const lines = loaded.highlight(code, lang)
  cache.set(key, lines)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return lines
}

/**
 * Start the one load (or join the running one) and resolve when it settles.
 *
 * Never rejects: a failed load is reported through the state and the
 * subscribers, because a renderer frame must not throw over a missing grammar.
 */
export function ensureHighlightRuntime(): Promise<void> {
  if (state === 'ready' || state === 'failed') return Promise.resolve()
  const running = inflight
  if (running !== undefined) return running
  state = 'loading'
  importCount += 1
  // The loader is invoked synchronously (the dynamic `import()` is asynchronous
  // by itself), so the attempt is observable in the same turn and a loader that
  // throws synchronously still becomes a rejection instead of escaping a frame.
  let attempt: Promise<HighlightRuntime>
  try {
    attempt = Promise.resolve(loader())
  } catch {
    attempt = Promise.reject(new Error('the highlight runtime loader failed'))
  }
  const attemptEpoch = epoch
  const pending = attempt
    .then(
      loaded => {
        // An attempt that was superseded (only the test seam can do that) must
        // not revive a reset module.
        if (epoch !== attemptEpoch) return
        runtime = loaded
        state = 'ready'
        generation += 1
        inflight = undefined
        notify('ready')
      },
      () => {
        if (epoch !== attemptEpoch) return
        runtime = undefined
        state = 'failed'
        inflight = undefined
        notify('failed')
      },
    )
  inflight = pending
  return pending
}

/** Awaitable form of {@link ensureHighlightRuntime} (prefetch + wait). */
export function whenHighlightRuntimeReady(): Promise<void> {
  return ensureHighlightRuntime()
}

/** Current load state; `ready` is the only state that paints syntax colors. */
export function highlightRuntimeState(): HighlightRuntimeState {
  return state
}

/** True once the grammar module is loaded and usable. */
export function isHighlightRuntimeReady(): boolean {
  return runtime !== undefined
}

/** Successful loads so far (0 or 1 in practice; diagnostics/tests). */
export function highlightGeneration(): number {
  return generation
}

/** Loader invocations so far. Exactly one per settled attempt (tests). */
export function highlightRuntimeImportCount(): number {
  return importCount
}

/**
 * Listen for the settled load.
 *
 * The listener runs once, after the state is final, with the generation that
 * produced it. A throwing listener cannot break the loader or the other
 * listeners. The returned function disposes the subscription; owners must call
 * it from `dispose()` so a dead view never repaints another one's frame.
 */
export function subscribeHighlightRuntime(listener: (event: HighlightRuntimeEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Live subscriber count (tests/diagnostics only).
 *
 * A view or dialog must release its subscription on dispose; asserting the count
 * proves the disposal itself instead of relying on the `disposed` guard inside
 * the listener.
 */
export function highlightRuntimeSubscriberCount(): number {
  return listeners.size
}

function notify(state: HighlightRuntimeEvent['state']): void {
  const event: HighlightRuntimeEvent = { state, generation }
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // A subscriber is display-only; a broken one must not fail the load.
    }
  }
}

/** Test/diagnostic hook; not used by the renderer. */
export function highlightCacheSize(): number {
  return cache.size
}

/** Test/diagnostic hook; not used by the renderer. */
export function clearHighlightCache(): void {
  cache.clear()
}

/**
 * Test seam: replace the loader (or pass `undefined` for the real one).
 *
 * Narrow on purpose — the production path has exactly one loader and no UI
 * switch for it.
 */
export function setHighlightRuntimeLoaderForTests(next?: HighlightRuntimeLoader): void {
  loader = next ?? defaultLoader
}

/**
 * Test seam: back to the pre-import state (`idle`, no runtime, no listeners, no
 * cache, the real loader). Test files run in their own process, so this only
 * exists to exercise the state machine's transitions in one file.
 */
export function resetHighlightRuntimeForTests(): void {
  epoch += 1
  state = 'idle'
  runtime = undefined
  generation = 0
  importCount = 0
  inflight = undefined
  loader = defaultLoader
  listeners.clear()
  cache.clear()
}