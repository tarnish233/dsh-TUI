/**
 * Live output-token and rate projection for the working indicator.
 *
 * DSH owns tokenization, provider usage and the settled per-instruction
 * numbers: the footer's rate and TTFT come from DSH's native `sessionStats`
 * projection, never from this module. What remains here is the *live* view the
 * editor border needs while a turn is still streaming — an immediate estimate
 * of how much output is arriving right now. Text/reasoning/tool-argument
 * deltas provide that estimate (CJK 1 token, other characters / 4) until an
 * attempt's provider `usage.outputTokens` arrives, which is authoritative for
 * that attempt. Attempts are summed across the steps of one turn, then reset
 * when the next turn starts.
 *
 * There is deliberately no local "settled" fold, footer rate or TTFT here:
 * duplicating DSH's sessionStats in the TUI was the bug. Unknown values stay
 * 0 / empty; nothing is invented.
 *
 * The delta estimate and compact count/duration formatting follow
 * pi-cc-extensions (MIT), adapted to DSH's `usage.outputTokens` stream.
 *
 * @module dsh-tui/state/output-stats
 */
import type { JsonRecord } from '../backend/types.ts'

interface AttemptStats {
  estimated: number
  usage: number
}

interface TokenSample {
  at: number
  tokens: number
}

const CJK_CHARS = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g
const LIVE_WINDOW_MS = 1_000
const MIN_RATE_SPAN_MS = 250

function estimateTokens(text: string): number {
  if (text === '') return 0
  const cjk = text.match(CJK_CHARS)?.length ?? 0
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

function deltaOf(chunk: JsonRecord): string {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return typeof chunk.text === 'string' ? chunk.text : ''
  }
  if (chunk.type === 'tool-call-delta') {
    return typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
  }
  return ''
}

function outputUsageOf(chunk: JsonRecord): number {
  if (chunk.type !== 'usage') return 0
  const usage = chunk.usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return 0
  const output = (usage as JsonRecord).outputTokens
  return typeof output === 'number' && Number.isFinite(output) && output > 0 ? Math.round(output) : 0
}

/** One attempt's contribution: provider usage when known, else the estimate. */
const contribution = (attempt: AttemptStats): number => attempt.usage > 0 ? attempt.usage : attempt.estimated

/** One turn's live output-token projection and rate samples. */
export class OutputTracker {
  private turn: number | undefined
  private startedAt = 0
  private readonly attempts = new Map<string, AttemptStats>()
  private samples: TokenSample[] = []
  /** First sample still inside the live window; see `prune`. */
  private sampleStart = 0
  /**
   * The folded `total()`. Kept in step with `attempts` in `chunk`, so folding one
   * delta costs one update instead of two full sums per chunk.
   */
  private totalValue = 0

  /** Start a new turn when its number changes; a repeated event is a no-op. */
  beginTurn(turn: number | undefined, at = Date.now()): void {
    if (this.turn === turn) return
    this.reset(turn, at)
  }

  /** Clear the turn projection. */
  reset(turn: number | undefined = undefined, at = 0): void {
    this.turn = turn
    this.startedAt = at
    this.attempts.clear()
    this.samples = []
    this.sampleStart = 0
    this.totalValue = 0
  }

  /** Register an attempt before its first chunk. */
  start(turn: number | undefined, attemptId: string, at = Date.now()): void {
    this.beginTurn(turn, at)
    if (!this.attempts.has(attemptId)) this.attempts.set(attemptId, { estimated: 0, usage: 0 })
  }

  /** Fold one stream chunk into the current attempt. */
  chunk(attemptId: string, chunk: JsonRecord, at = Date.now()): void {
    let attempt = this.attempts.get(attemptId)
    if (attempt === undefined) {
      attempt = { estimated: 0, usage: 0 }
      this.attempts.set(attemptId, attempt)
    }
    const before = contribution(attempt)
    const delta = deltaOf(chunk)
    if (delta !== '') attempt.estimated += estimateTokens(delta)
    const usage = outputUsageOf(chunk)
    if (usage > attempt.usage) attempt.usage = usage
    const after = contribution(attempt)
    if (after === before) return
    this.totalValue += after - before
    if (after > before) this.sample(at, this.totalValue)
  }

  total(): number {
    return this.totalValue
  }

  get startTime(): number {
    return this.startedAt
  }

  /**
   * Live window rate when enough recent tokens exist; otherwise the average
   * over this turn. Returns 0 before the first token or during the first
   * 250ms, where a rate would be misleading. Streaming presentation only — the
   * settled footer numbers belong to DSH's sessionStats.
   */
  rate(now = Date.now()): number {
    const total = this.total()
    if (total === 0 || this.startedAt === 0) return 0
    const elapsed = now - this.startedAt
    if (elapsed < MIN_RATE_SPAN_MS) return 0
    this.prune(now - LIVE_WINDOW_MS)
    if (this.samples.length - this.sampleStart >= 2) {
      const first = this.samples[this.sampleStart]!
      const last = this.samples[this.samples.length - 1]!
      const span = last.at - first.at
      if (span >= MIN_RATE_SPAN_MS && last.tokens > first.tokens) {
        const live = ((last.tokens - first.tokens) * 1000) / span
        if (live > 0) return live
      }
    }
    return (total * 1000) / elapsed
  }

  /**
   * Advance the window start instead of shifting the array: `rate` runs on every
   * render and must not reallocate the history it only reads.
   */
  private prune(cutoff: number): void {
    while (this.samples.length - this.sampleStart > 1 && this.samples[this.sampleStart]!.at < cutoff) {
      this.sampleStart += 1
    }
  }

  private sample(at: number, tokens: number): void {
    this.samples.push({ at, tokens })
    this.prune(at - LIVE_WINDOW_MS)
    // Bound the array without touching the window: drop the prefix `prune`
    // already retired once it is as large as the live part.
    if (this.sampleStart >= 32 && this.sampleStart * 2 >= this.samples.length) {
      this.samples = this.samples.slice(this.sampleStart)
      this.sampleStart = 0
    }
  }
}

/** Compact token count used inside the editor border. */
export function formatOutputTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 10_000) return (value / 1_000).toFixed(1) + 'k'
  if (value < 1_000_000) return Math.round(value / 1_000) + 'k'
  if (value < 10_000_000) return (value / 1_000_000).toFixed(1) + 'M'
  return Math.round(value / 1_000_000) + 'M'
}

/** `3s`, `2m 3s`, `1h 2m 3s`; sub-second returns an empty string. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000)
  if (total < 1) return ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return hours + 'h ' + minutes + 'm ' + seconds + 's'
  if (minutes > 0) return minutes + 'm ' + seconds + 's'
  return seconds + 's'
}

/** `21 tok/s` or `1.2k tok/s`. */
export function formatOutputRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return ''
  const value = rate >= 1_000 ? (rate / 1_000).toFixed(1) + 'k' : String(Math.round(rate))
  return value + ' tok/s'
}