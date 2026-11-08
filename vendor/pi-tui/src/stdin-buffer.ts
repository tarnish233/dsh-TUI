/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "events";

const ESC = "\x1b";
const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
/** Bounded hold for a recognized non-expected reply before it is discarded. */
const DEFAULT_REPLY_TIMEOUT_MS = 2000;
/** Shorter bounded hold for a reply the owner is actively waiting for (OSC 7501 query). */
const DEFAULT_EXPECTED_REPLY_TIMEOUT_MS = 1200;
/** A reply that grows past this is not a reply; it is dropped instead of buffered forever. */
const DEFAULT_MAX_REPLY_BYTES = 8192;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
// Color and program-status OSC replies, XTVersion, and Kitty graphics replies.
// Until their header is complete, the input may be batched legacy Alt keystrokes.
const TERMINAL_REPLY_HEADER_PATTERN = /^\x1b(?:\](?:1[01];|4;\d{1,3};|7501;\?)|P>\||_G(?:[a-z]=\d+,)*[a-z]=\d+;)/;

function isControlString(data: string): boolean {
	return data.startsWith(`${ESC}]`) || data.startsWith(`${ESC}P`) || data.startsWith(`${ESC}_`);
}

/**
 * Check if a string is a complete escape sequence or needs more data
 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI sequences: ESC [
	if (afterEsc.startsWith("[")) {
		// Check for old-style mouse sequence: ESC[M + 3 bytes
		if (afterEsc.startsWith("[M")) {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC sequences: ESC ]
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// SS3 sequences: ESC O
	if (afterEsc.startsWith("O")) {
		// ESC O followed by a single character
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta key sequences: ESC followed by a single character
	if (afterEsc.length === 1) {
		return "complete";
	}

	// Unknown escape sequence - treat as complete
	return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// Need at least ESC [ and one more character
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
	// This includes all letters and several special characters
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// Special handling for SGR mouse sequences
		// Format: ESC[<B;X;Ym or ESC[<B;X;YM
		if (payload.startsWith("<")) {
			// Must have format: <digits;digits;digits[Mm]
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			if (mouseMatch) {
				return "complete";
			}
			// If it ends with M or m but doesn't match the pattern, still incomplete
			if (lastChar === "M" || lastChar === "m") {
				// Check if we have the right structure
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
					return "complete";
				}
			}

			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC sequences end with ST (ESC \) or BEL (\x07)
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Split accumulated buffer into complete sequences
 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		// Try to extract a sequence starting at this position
		if (remaining.startsWith(ESC)) {
			const terminalReply = isControlString(remaining) && TERMINAL_REPLY_HEADER_PATTERN.test(remaining);
			// Find the end of this escape sequence
			let seqEnd = 1;
			while (seqEnd <= remaining.length) {
				if (terminalReply && seqEnd > 2) {
					const char = remaining[seqEnd - 1];
					if (char === "\x18" || char === "\x1a") {
						// CAN and SUB cancel the string, not subsequent keyboard input.
						pos += seqEnd;
						break;
					}
					if (char === ESC && seqEnd < remaining.length && remaining[seqEnd] !== "\\") {
						// A new escape sequence aborts an unterminated reply. Keep a
						// trailing ESC buffered until we can distinguish it from ST.
						pos += seqEnd - 1;
						break;
					}
				}
				const candidate = remaining.slice(0, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "complete") {
					// WezTerm with enable_kitty_keyboard sends the Escape key press as a
					// raw '\x1b' byte (simple text path in encode_kitty, ignoring
					// DISAMBIGUATE_ESCAPE_CODES) and the release as a full Kitty CSI-u
					// sequence. These arrive concatenated as '\x1b\x1b[27;...u'.
					// The buffer would normally treat '\x1b\x1b' as a complete meta-key
					// sequence (ESC + single char), leaving '[27;...u' to be typed as
					// plain text. If the character immediately following '\x1b\x1b'
					// would begin a new escape sequence, emit only the first ESC and
					// restart from the second.
					if (candidate === "\x1b\x1b") {
						const nextChar = remaining[seqEnd];
						if (
							nextChar === "[" || // CSI
							nextChar === "]" || // OSC
							nextChar === "O" || // SS3
							nextChar === "P" || // DCS
							nextChar === "_" // APC
						) {
							sequences.push(ESC);
							pos += 1;
							break;
						}
					}
					sequences.push(candidate);
					pos += seqEnd;
					break;
				} else if (status === "incomplete") {
					seqEnd++;
				} else {
					// Should not happen when starting with ESC
					sequences.push(candidate);
					pos += seqEnd;
					break;
				}
			}

			if (seqEnd > remaining.length) {
				return { sequences, remainder: remaining };
			}
		} else {
			// Not an escape sequence - take a single character
			sequences.push(remaining[0]!);
			pos++;
		}
	}

	return { sequences, remainder: "" };
}

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for an incomplete keyboard or mouse sequence
	 * (default: 50ms). Strings with a recognized terminal reply header wait for
	 * their terminator instead, so delayed replies cannot become keypresses.
	 * Ambiguous legacy Alt-key input still uses this timeout.
	 */
	timeout?: number;
	/**
	 * Maximum time to wait after a lone ESC before treating it as Escape
	 * (default: 10ms). Increase for high-latency Alt+key input (SSH).
	 */
	escapeTimeout?: number;
	/**
	 * Reply headers that may still arrive split across reads, for example a program
	 * status query reply (`ESC ] 7501 ; ?`) whose first chunk ends inside the header.
	 * While the buffer is a strict prefix of one of these, it is held for `replyTimeout`
	 * instead of being flushed as legacy keys. The provider should return an empty list
	 * when no reply is outstanding, so ordinary Alt+key input keeps its short deadline.
	 */
	expectedReplyPrefixes?: () => readonly string[];
	/**
	 * Bounded wait for a recognized terminal reply that started but never terminated
	 * (default 2000ms). On expiry the payload is *discarded*, not turned into keys, and
	 * input stays discarded until the reply terminator or the same finite deadline.
	 */
	replyTimeout?: number;
	/**
	 * Shorter bounded wait for a reply the owner is actively expecting, for example the
	 * OSC 7501 support reply (default 1200ms). Same fail-closed behaviour on expiry.
	 */
	expectedReplyTimeout?: number;
	/** Maximum bytes buffered/discarded for one reply (default 8192). */
	maxReplyBytes?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private readonly escapeTimeoutMs: number;
	private pasteMode: boolean = false;
	private pasteBuffer: string = "";
	private pendingKittyPrintableCodepoint: number | undefined;
	private readonly expectedReplyPrefixes: () => readonly string[];
	private readonly replyTimeoutMs: number;
	private readonly expectedReplyTimeoutMs: number;
	private readonly maxReplyBytes: number;
	/** A recognized reply failed closed: discard until its terminator or the cleanup deadline. */
	private quarantineTerminator: "osc" | "st" | null = null;
	private quarantineTimer: ReturnType<typeof setTimeout> | null = null;
	private quarantineBytes = 0;
	private quarantineCarry = "";

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
		this.escapeTimeoutMs = options.escapeTimeout ?? DEFAULT_ESCAPE_TIMEOUT_MS;
		this.expectedReplyPrefixes = options.expectedReplyPrefixes ?? (() => []);
		this.replyTimeoutMs = options.replyTimeout ?? DEFAULT_REPLY_TIMEOUT_MS;
		this.expectedReplyTimeoutMs = options.expectedReplyTimeout ?? DEFAULT_EXPECTED_REPLY_TIMEOUT_MS;
		this.maxReplyBytes = options.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES;
	}

	public process(data: string | Buffer): void {
		// Clear any pending timeout
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}

		// A recognized reply that failed closed discards its payload instead of replaying it
		// as keys. The quarantine ends at the reply terminator, at the finite cleanup deadline,
		// or as soon as the user starts a bracketed paste.
		if (this.quarantineTerminator) {
			this.consumeQuarantine(str);
			return;
		}

		this.buffer += str;

		if (this.pasteMode) {
			this.pasteBuffer += this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.emitDataSequence(sequence);
				}
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.emitDataSequence(sequence);
		}

		if (this.buffer.length > 0) {
			if (this.isRecognizedReply(this.buffer)) {
				// A recognized reply never becomes editor text: it is held while it can still
				// complete, then discarded (fail closed) instead of replayed as keys.
				if (Buffer.byteLength(this.buffer, "utf8") > this.maxReplyBytes) {
					this.startQuarantine(this.buffer);
					return;
				}
				const expected = this.isExpectedReplyPrefix(this.buffer);
				this.timeout = setTimeout(
					() => this.expireReplyHold(),
					expected ? this.expectedReplyTimeoutMs : this.replyTimeoutMs,
				);
				return;
			}
			// Only a recognizable reply header, or a prefix of a reply that is still expected,
			// establishes a delimited string. Other input, including Alt+] followed by text,
			// keeps its normal bounded recovery.
			const timeoutMs = this.buffer === ESC ? this.escapeTimeoutMs : this.timeoutMs;
			this.timeout = setTimeout(() => {
				this.flushPendingRecovery();
			}, timeoutMs);
		}
	}

	/** A recognized reply header, or a prefix of a reply the owner is still waiting for. */
	private isRecognizedReply(buffer: string): boolean {
		return TERMINAL_REPLY_HEADER_PATTERN.test(buffer) || this.isExpectedReplyPrefix(buffer);
	}

	/** The reply did not terminate in time: discard it and everything up to its terminator. */
	private expireReplyHold(): void {
		if (!this.buffer) return;
		this.startQuarantine(this.buffer);
	}

	/**
	 * Fail closed on one unparseable reply.
	 *
	 * The payload is dropped, never re-emitted as keys, and further input is discarded until
	 * the reply's own terminator arrives or the finite cleanup deadline passes. Nothing is
	 * accumulated while quarantined, so a hostile or stalled reply cannot grow memory, and
	 * ordinary typing resumes right after the quarantine ends.
	 */
	private startQuarantine(payload: string): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		this.quarantineTerminator = payload.startsWith(`${ESC}]`) ? "osc" : "st";
		this.quarantineBytes = 0;
		this.quarantineCarry = "";
		if (this.quarantineTimer) clearTimeout(this.quarantineTimer);
		this.quarantineTimer = setTimeout(() => this.endQuarantine(), this.replyTimeoutMs);
		// Never hold the process open for a reply that is already being discarded.
		this.quarantineTimer.unref?.();
	}

	private consumeQuarantine(chunk: string): void {
		const data = this.quarantineCarry + chunk;
		this.quarantineCarry = "";
		// Quarantine stores no payload. Saturating this counter must not end
		// the delimiter guard: another large chunk still belongs to the reply.
		this.quarantineBytes = Math.min(this.maxReplyBytes, this.quarantineBytes + Buffer.byteLength(data, "utf8"));

		// A user paste is not reply payload; leave quarantine and honour it.
		const pasteStart = data.indexOf(BRACKETED_PASTE_START);
		const terminator = this.findReplyTerminator(data);
		const terminatorIndex = terminator ? terminator.index : -1;
		if (pasteStart !== -1 && (terminatorIndex === -1 || pasteStart < terminatorIndex)) {
			const rest = data.slice(pasteStart);
			this.endQuarantine();
			this.process(rest);
			return;
		}
		if (terminator) {
			const rest = data.slice(terminator.index + terminator.length);
			this.endQuarantine();
			if (rest.length > 0) this.process(rest);
			return;
		}
		// A split ST (ESC then `\`) must not look like a fresh Escape key.
		if (data.endsWith(ESC)) this.quarantineCarry = ESC;
	}

	private findReplyTerminator(data: string): { index: number; length: number } | undefined {
		const st = data.indexOf(`${ESC}\\`);
		if (this.quarantineTerminator === "osc") {
			const bel = data.indexOf("\x07");
			if (bel !== -1 && (st === -1 || bel < st)) return { index: bel, length: 1 };
		}
		return st === -1 ? undefined : { index: st, length: 2 };
	}

	private endQuarantine(): void {
		if (this.quarantineTimer) {
			clearTimeout(this.quarantineTimer);
			this.quarantineTimer = null;
		}
		this.quarantineTerminator = null;
		this.quarantineBytes = 0;
		this.quarantineCarry = "";
	}

	/** Flush the held buffer back into the input path, keeping the Alt prefix recoverable. */
	private flushPendingRecovery(): void {
		const flushed = this.flush();

		for (const sequence of flushed) {
			if (sequence.length > 2 && isControlString(sequence)) {
				// Recover the Alt key and reparse its tail so batched text,
				// Enter, and control keys are not swallowed as one event.
				this.emitDataSequence(sequence.slice(0, 2));
				this.process(sequence.slice(2));
			} else {
				this.emitDataSequence(sequence);
			}
		}
	}

	/**
	 * True when the buffer could still grow into an expected reply header.
	 *
	 * Only a strict prefix counts, and only while the owner reports that a reply is
	 * outstanding: an ordinary Alt+] keeps its short escape deadline otherwise.
	 */
	private isExpectedReplyPrefix(buffer: string): boolean {
		if (buffer.length < 2) return false;
		for (const prefix of this.expectedReplyPrefixes()) {
			if (prefix.length > buffer.length && prefix.startsWith(buffer)) return true;
		}
		return false;
	}

	private emitDataSequence(sequence: string): void {
		// Complete control strings need the same byte cap as held fragments.
		// A large response arriving in one read is not keyboard input either.
		if (this.isRecognizedReply(sequence) && Buffer.byteLength(sequence, "utf8") > this.maxReplyBytes) return;
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	flush(): string[] {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.endQuarantine();
		this.buffer = "";
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}
