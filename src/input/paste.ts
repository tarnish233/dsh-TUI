/**
 * Bracketed-paste framing for the CC editor.
 *
 * Pi's editor buffers `ESC[200~ ... ESC[201~` itself, but only when the start
 * marker arrives whole in one `handleInput` chunk. Terminals, SSH and tmux can
 * fragment the marker, and pasted bytes must never be interpreted as keys or
 * chords. This filter reassembles start/end markers across chunks and yields
 * tokenised input:
 *
 *   [{ kind: "keys", data }, { kind: "paste", text }, ...]
 *
 * A trailing fragment that could become `ESC[200~` is held until the next
 * chunk, the hold deadline or an explicit `flush()`, so `ESC[2` + `00~hello` is
 * still a paste. A lone ESC is dispatched immediately as Escape because it is
 * far more common than a one-byte-first fragmented paste marker.
 *
 * The hold is always bounded: when no further chunk arrives within
 * `holdTimeoutMs` (the same 50 ms order the terminal reply reassembler uses) the
 * held bytes are released as ordinary keys through `onHoldTimeout`. A held
 * prefix therefore cannot swallow the next keystroke indefinitely or require an
 * external flush, and `isHolding`/`pendingBytes` let the host's paste protection
 * see that bytes are still in flight.
 */

export type PasteToken = { kind: "keys"; data: string } | { kind: "paste"; text: string }

export const BRACKETED_PASTE_START = "\x1b[200~"
export const BRACKETED_PASTE_END = "\x1b[201~"

/** Default lifetime of a held paste-marker prefix (match `stdin-buffer.ts`). */
export const DEFAULT_PASTE_HOLD_TIMEOUT_MS = 50

export interface BracketedPasteFilterOptions {
  /** How long a fragmented paste-marker prefix may wait for the next chunk. */
  holdTimeoutMs?: number
  /** Release sink for held bytes whose deadline expires (dispatched as keys). */
  onHoldTimeout?: (data: string) => void
}

export class BracketedPasteFilter {
  private pending = ""
  private buffer = ""
  private pasting = false
  private holdTimer: ReturnType<typeof setTimeout> | undefined
  private readonly holdTimeoutMs: number
  private readonly onHoldTimeout: ((data: string) => void) | undefined

  constructor(options: BracketedPasteFilterOptions = {}) {
    const requested = Number(options.holdTimeoutMs ?? DEFAULT_PASTE_HOLD_TIMEOUT_MS)
    this.holdTimeoutMs =
      Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_PASTE_HOLD_TIMEOUT_MS
    this.onHoldTimeout = options.onHoldTimeout
  }

  get isPasting(): boolean {
    return this.pasting
  }

  /** True while a possible paste-marker prefix is held back for the next chunk. */
  get isHolding(): boolean {
    return this.pending.length > 0
  }

  get pendingBytes(): string {
    return this.pending
  }

  reset(): void {
    this.clearHoldTimer()
    this.pending = ""
    this.buffer = ""
    this.pasting = false
  }

  push(data: string): PasteToken[] {
    return this.consume(data, true)
  }

  /** Emit held bytes as normal keys (end of input / explicit flush). */
  flush(): PasteToken[] {
    return this.consume("", false)
  }

  private consume(data: string, allowHold: boolean): PasteToken[] {
    this.clearHoldTimer()
    const tokens = this.consumeChunks(data, allowHold)
    if (this.pending.length > 0) this.armHoldTimer()
    return tokens
  }

  private armHoldTimer(): void {
    if (!this.onHoldTimeout || this.holdTimeoutMs <= 0) return
    if (this.holdTimer !== undefined) return
    const timer = setTimeout(() => {
      this.holdTimer = undefined
      this.expireHold()
    }, this.holdTimeoutMs)
    // Never keep the process alive for a held paste prefix.
    if (typeof timer.unref === "function") timer.unref()
    this.holdTimer = timer
  }

  private clearHoldTimer(): void {
    if (this.holdTimer === undefined) return
    clearTimeout(this.holdTimer)
    this.holdTimer = undefined
  }

  /**
   * Deadline expired: the held bytes were not a fragmented paste marker after
   * all, so they are released as ordinary keys. `pending` is cleared first so a
   * re-entrant `push()` from the sink cannot see stale bytes.
   */
  private expireHold(): void {
    const held = this.pending
    this.pending = ""
    if (held.length === 0) return
    this.onHoldTimeout?.(held)
  }

  private consumeChunks(data: string, allowHold: boolean): PasteToken[] {
    const tokens: PasteToken[] = []
    let input = this.pending + data
    this.pending = ""
    while (input.length > 0) {
      if (this.pasting) {
        this.buffer += input
        input = ""
        const endIndex = this.buffer.indexOf(BRACKETED_PASTE_END)
        if (endIndex === -1) return tokens
        const text = this.buffer.slice(0, endIndex)
        input = this.buffer.slice(endIndex + BRACKETED_PASTE_END.length)
        this.buffer = ""
        this.pasting = false
        tokens.push({ kind: "paste", text })
        continue
      }
      const startIndex = input.indexOf(BRACKETED_PASTE_START)
      if (startIndex === -1) {
        const hold = allowHold ? this.heldSuffixLength(input) : 0
        const emit = input.slice(0, input.length - hold)
        if (hold > 0) this.pending = input.slice(input.length - hold)
        if (emit.length > 0) tokens.push({ kind: "keys", data: emit })
        input = ""
        continue
      }
      const keys = input.slice(0, startIndex)
      if (keys.length > 0) tokens.push({ kind: "keys", data: keys })
      input = input.slice(startIndex + BRACKETED_PASTE_START.length)
      this.pasting = true
      this.buffer = ""
    }
    return tokens
  }

  private heldSuffixLength(input: string): number {
    const max = Math.min(BRACKETED_PASTE_START.length - 1, input.length)
    for (let length = max; length >= 2; length -= 1) {
      if (BRACKETED_PASTE_START.startsWith(input.slice(input.length - length))) {
        return length
      }
    }
    return 0
  }
}