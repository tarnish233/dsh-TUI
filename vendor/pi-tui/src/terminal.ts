import * as fs from "node:fs";
import * as path from "node:path";
import { setKittyProtocolActive } from "./keys.ts";
import { isNativeModifierPressed } from "./native-modifiers.ts";
import { getNativePlatformHelper } from "./native-platform.ts";
import {
	formatProgramStatus,
	isProgramStatusReply,
	downgradeProgramStatus,
	normalizeProgramStatusId,
	parseProgramStatusSupport,
	PROGRAM_STATUS_MAX_RECORDS,
	PROGRAM_STATUS_QUERY,
	type ProgramStatus,
	type ProgramStatusCapabilities,
} from "./program-status.ts";
import { StdinBuffer } from "./stdin-buffer.ts";
import { replaceControlCharacters } from "./utils.ts";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0\x07";
const NATIVE_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u`;
const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";
const FOCUS_REPORTING_ENABLE = "\x1b[?1004h";
const FOCUS_REPORTING_DISABLE = "\x1b[?1004l";
/** Bounded wait for a fragmented or never-terminated OSC 7501 reply. */
const PROGRAM_STATUS_REPLY_TIMEOUT_MS = 1000;
const FOCUS_REPORT_GAINED = "\x1b[I";
const FOCUS_REPORT_LOST = "\x1b[O";
/** xterm window-title stack: push, pop. Ghostty parses and ignores both. */
const TITLE_STACK_PUSH = "\x1b[22;0t";
const TITLE_STACK_POP = "\x1b[23;0t";
const MAX_TITLE_STACK_DEPTH = 8;

export type KeyboardProtocolNegotiationSequence =
	| { type: "kitty-flags"; flags: number }
	| { type: "device-attributes" };

export function parseKeyboardProtocolNegotiationSequence(
	sequence: string,
): KeyboardProtocolNegotiationSequence | undefined {
	const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
	if (kittyFlags) {
		return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1]!, 10) };
	}
	if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
		return { type: "device-attributes" };
	}
	return undefined;
}

function isKeyboardProtocolNegotiationSequencePrefix(sequence: string): boolean {
	return sequence === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}

export function isAppleTerminalSession(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}

/**
 * Refresh terminal dimensions on POSIX platforms by sending SIGWINCH to this process.
 * Best-effort: some environments (restricted seccomp or LSM policies) return EACCES
 * for `kill(2)`; in that case the dimensions refresh is skipped rather than crashing.
 */
export function refreshTerminalDimensions(): void {
	if (process.platform === "win32" || process.pid <= 0) return;
	try {
		process.kill(process.pid, "SIGWINCH");
	} catch {
		// Signal delivery not permitted in this environment; ignore.
	}
}

// Some Apple Terminal setups send ESC+CR (Alt+Enter) for Shift+Enter (#11559).
function isNativeShiftEnterCandidate(data: string): boolean {
	return data === "\r" || data === "\x1b\r";
}

export function normalizeNativeShiftEnterInput(
	data: string,
	shouldDetectNativeShiftEnter: boolean,
	isShiftPressed: boolean,
): string {
	if (shouldDetectNativeShiftEnter && isNativeShiftEnterCandidate(data) && isShiftPressed) {
		return NATIVE_SHIFT_ENTER_SEQUENCE;
	}
	return data;
}

export function normalizeAppleTerminalInput(data: string, isAppleTerminal: boolean, isShiftPressed: boolean): string {
	return normalizeNativeShiftEnterInput(data, isAppleTerminal, isShiftPressed);
}

/**
 * Minimal terminal interface for TUI
 */
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(): void;

	/**
	 * Synchronously restore terminal modes from a process `exit` handler when stop() did not run.
	 * Writes `before`, then this terminal's own mode resets, then `after`.
	 */
	restoreOnExit?(before: string, after: string): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;

	/**
	 * Report one complete OSC 7501 record (OSC 7501). Only written to terminals that support it;
	 * the bounded record set is re-sent when support is confirmed or the terminal restarts.
	 */
	setProgramStatus(status: ProgramStatus): void;

	/**
	 * Whether the attached terminal answered the OSC 7501 support query (or `PI_PROGRAM_STATUS=1`).
	 * Optional: a terminal implementation without this member is treated as unsupported.
	 */
	readonly programStatusSupported?: boolean;

	/**
	 * Observe OSC 7501 support transitions (negotiation, stop/restart). The listener is called with
	 * the current value on subscribe, and returns an unsubscribe function.
	 */
	onProgramStatusSupportChange?(listener: (supported: boolean) => void): () => void;

	/** Last focus report from the terminal; `undefined` until the terminal reports one. */
	readonly terminalFocused?: boolean;

	/** Observe terminal focus reports (`CSI I` / `CSI O`). Returns an unsubscribe function. */
	onFocusChange?(listener: (focused: boolean) => void): () => void;

	/** Request focus reporting (DECSET 1004) from the attached terminal. */
	setFocusReporting?(enabled: boolean): void;

	/** Push the window title onto the terminal's title stack. */
	saveTitle?(): void;

	/** Pop the window title from the terminal's title stack. */
	restoreTitle?(): void;
}

/** Options for {@link ProcessTerminal}. */
export interface ProcessTerminalOptions {
	/**
	 * Sink for every terminal write: rendered frames, cursor/clear/title/progress
	 * sequences, protocol negotiation and capability queries.
	 *
	 * Defaults to `process.stdout.write`. Pass the original terminal writer when
	 * the host temporarily routes JS `process.stdout`/`process.stderr` elsewhere;
	 * TUI output keeps reaching the real terminal without a second terminal
	 * abstraction.
	 */
	write?: (data: string) => void;
}

const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;

/**
 * Resolve how long to wait for the rest of an escape sequence before
 * dispatching a lone ESC as the Escape key. Legacy Alt+key input is ESC plus
 * another byte, so high-latency transports need a longer reassembly window.
 */
export function resolveEscapeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PI_TUI_ESC_TIMEOUT);
	if (Number.isFinite(configured) && configured > 0) {
		return configured;
	}
	if (env.SSH_CONNECTION || env.SSH_TTY) {
		return DEFAULT_SSH_ESCAPE_TIMEOUT_MS;
	}
	return DEFAULT_ESCAPE_TIMEOUT_MS;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private keyboardProtocolPushed = false;
	/** DA1 replies owed to keyboard protocol queries. Later DA1 replies answer other queries and are forwarded. */
	private pendingKeyboardProtocolDeviceAttributes = 0;
	private keyboardProtocolNegotiationBuffer = "";
	private keyboardProtocolBufferFlushTimer?: ReturnType<typeof setTimeout>;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private progressInterval?: ReturnType<typeof setInterval>;
	/** Last requested legacy progress state, so a policy change can re-sync without a frame. */
	private progressRequested = false;
	/** Whether the legacy OSC 9;4 progress sequence is currently on. */
	private progressActive = false;
	/**
	 * Host policy for the legacy OSC 9;4 fallback: `undefined` follows negotiation, `true` always
	 * allows it, `false` never writes it. See `setProgressFallback`.
	 */
	private progressFallback?: boolean;
	/**
	 * Complete OSC 7501 record snapshots by record key (root = ""), kept across stop() so start()
	 * can replay the currently valid records. Bounded by PROGRAM_STATUS_MAX_RECORDS, LRU eviction.
	 */
	private readonly programStatusRecords = new Map<string, ProgramStatus>();
	/** Advertised state/kind subset from the terminal's support reply, when one arrived. */
	private programStatusCapabilities?: ProgramStatusCapabilities;
	/** Whether the terminal confirmed OSC 7501 support since the last start(), or `PI_PROGRAM_STATUS=1`. */
	private programStatusSupportedValue = false;
	/** A support reply with usable capabilities arrived; rich presentation owns progress. */
	private programStatusNegotiated = false;
	/** The support query was sent and its DA1 sentinel has not arrived yet. */
	private programStatusQueryPending = false;
	private readonly programStatusSupportListeners = new Set<(supported: boolean) => void>();
	/** Last value delivered to support listeners, so transitions are notified exactly once. */
	private notifiedProgramStatusSupported = false;
	private readonly focusChangeListeners = new Set<(focused: boolean) => void>();
	private _terminalFocused?: boolean;
	private focusReportingRequested = false;
	/** DECSET 1004 is currently owned by this terminal instance. */
	private focusReportingActive = false;
	private titleStackDepth = 0;
	/**
	 * Terminal ownership was handed back (stop() or the emergency exit path). Status, progress,
	 * focus and title writes are refused until start() re-attaches, so a late event cannot write
	 * escape sequences to a terminal this instance no longer owns.
	 */
	private released = false;
	private readonly writeOutput: (data: string) => void;
	private writeLogPath = (() => {
		const env = process.env.PI_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		return env;
	})();

	constructor(options: ProcessTerminalOptions = {}) {
		this.writeOutput = options.write ?? ((data) => process.stdout.write(data));
	}

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this._modifyOtherKeysActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		// Idempotent attach: a second start() without an intervening stop() must not add a
		// second stdin/stdout wiring. Overwriting stdinBuffer/stdinDataHandler used to leak the
		// previous 'data' listener (every key dispatched twice) and re-capture wasRaw while the
		// terminal was already raw, so the following stop() left raw mode on. A different owner
		// must stop() this terminal before starting it, so the input path stays single-owner.
		if (this.stdinDataHandler) return;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		// Re-attached: status, progress, focus and title writes are allowed again.
		this.released = false;
		this._terminalFocused = undefined;

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		this.writeOutput("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only, best-effort.
		refreshTerminalDimensions();

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Query Kitty keyboard protocol and fall back to modifyOtherKeys when DA confirms no Kitty response.
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();

		// The requested focus-reporting mode is re-armed on every attach; stop() hands it back.
		this.syncFocusReporting();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({
			escapeTimeout: resolveEscapeTimeoutMs(),
			// A fragmented program-status reply may be split inside its header, including a
			// pause longer than the 50ms sequence timeout. Only the pending query window uses
			// the longer bounded reply hold, so an ordinary Alt+] keeps its escape deadline.
			expectedReplyPrefixes: () => (this.programStatusQueryPending ? [PROGRAM_STATUS_QUERY] : []),
			expectedReplyTimeout: PROGRAM_STATUS_REPLY_TIMEOUT_MS,
		});

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			// The generic sequence timeout may have delivered a partial CSI prefix
			// into the existing negotiation buffer. Reassemble short focus reports
			// there too, without a second reader or extending the lone-Escape delay.
			const reassembledFocus = this.keyboardProtocolNegotiationBuffer + sequence;
			if (reassembledFocus === FOCUS_REPORT_GAINED || reassembledFocus === FOCUS_REPORT_LOST) {
				this.clearKeyboardProtocolNegotiationBuffer();
				this.handleFocusReport(reassembledFocus === FOCUS_REPORT_GAINED);
				return;
			}
			// Focus reports are terminal replies, never text: consume them before any key path so a
			// leaked DECSET 1004 cannot type "I"/"O" into the editor. A stale CSI prefix must not
			// flush into the editor after the report.
			if (sequence === FOCUS_REPORT_GAINED || sequence === FOCUS_REPORT_LOST) {
				this.clearKeyboardProtocolNegotiationBuffer();
				this.handleFocusReport(sequence === FOCUS_REPORT_GAINED);
				return;
			}
			if (isProgramStatusReply(sequence)) {
				this.handleProgramStatusSupportReply(sequence);
				return;
			}
			const negotiation = this.readKeyboardProtocolNegotiationSequence(sequence);
			if (negotiation === "pending") {
				this.scheduleKeyboardProtocolNegotiationBufferFlush();
				return; // Wait briefly for the rest of a split Kitty response.
			}
			if (negotiation && this.handleKeyboardProtocolNegotiationSequence(negotiation.parsed)) {
				return;
			}

			this.forwardInputSequence(negotiation?.sequence ?? sequence);
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable it if available.
	 *
	 * Kitty's progressive enhancement detection requires requesting the desired
	 * flags before querying them. The trailing DA query is a sentinel supported by
	 * terminals that do not know Kitty keyboard protocol; receiving DA before a
	 * Kitty response enables modifyOtherKeys fallback without a startup timeout.
	 *
	 * The requested flags are:
	 * - 1 = disambiguate escape codes
	 * - 2 = report event types (press/repeat/release)
	 * - 4 = report alternate keys (shifted key, base layout key)
	 *
	 * The OSC 7501 program status query shares the DA sentinel: a terminal that supports it replies
	 * before DA. `PI_PROGRAM_STATUS=1` or `0` skips the query.
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.keyboardProtocolPushed = true;
		this.pendingKeyboardProtocolDeviceAttributes += 1;
		this.clearKeyboardProtocolNegotiationBuffer();
		const programStatusOverride = process.env.PI_PROGRAM_STATUS;
		this.programStatusCapabilities = undefined;
		this.programStatusNegotiated = false;
		this.programStatusSupportedValue = programStatusOverride === "1";
		this.programStatusQueryPending = programStatusOverride !== "1" && programStatusOverride !== "0";
		const programStatusQuery = this.programStatusQueryPending ? PROGRAM_STATUS_QUERY : "";
		this.writeOutput(`${KITTY_KEYBOARD_PROTOCOL_QUERY}${programStatusQuery}${DEVICE_ATTRIBUTES_QUERY}`);
		this.maybeReplayProgramStatus();
		this.notifyProgramStatusSupport();
	}

	private handleKeyboardProtocolNegotiationSequence(
		negotiationSequence: KeyboardProtocolNegotiationSequence,
	): boolean {
		this.clearKeyboardProtocolNegotiationBuffer();
		if (negotiationSequence.type === "device-attributes") {
			if (this.pendingKeyboardProtocolDeviceAttributes === 0) return false;
			this.pendingKeyboardProtocolDeviceAttributes -= 1;
			// The last owed DA answers the latest query, which got no program status reply first. Earlier DA
			// replies belong to queries from before a restart.
			if (this.pendingKeyboardProtocolDeviceAttributes === 0) this.programStatusQueryPending = false;
		}
		if (negotiationSequence.type === "kitty-flags") {
			if (negotiationSequence.flags !== 0) {
				this.disableModifyOtherKeys();
				if (!this._kittyProtocolActive) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);
				}
			} else {
				this.enableModifyOtherKeys();
			}
			return true;
		}

		if (!this._kittyProtocolActive) {
			this.enableModifyOtherKeys();
		}
		return true;
	}

	/** Returns the parsed negotiation reply with its full (possibly reassembled) sequence. */
	private readKeyboardProtocolNegotiationSequence(
		sequence: string,
	): { parsed: KeyboardProtocolNegotiationSequence; sequence: string } | "pending" | undefined {
		if (this.keyboardProtocolNegotiationBuffer) {
			const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;
			const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
			if (negotiationSequence) {
				this.clearKeyboardProtocolNegotiationBuffer();
				return { parsed: negotiationSequence, sequence: bufferedSequence };
			}
			if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
				this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);
				return "pending";
			}
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}

		const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
		if (negotiationSequence) return { parsed: negotiationSequence, sequence };
		if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
			this.setKeyboardProtocolNegotiationBuffer(sequence);
			return "pending";
		}
		return undefined;
	}

	private setKeyboardProtocolNegotiationBuffer(sequence: string): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = sequence;
	}

	private clearKeyboardProtocolNegotiationBuffer(): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = "";
	}

	private flushKeyboardProtocolNegotiationBufferAsInput(): void {
		if (!this.keyboardProtocolNegotiationBuffer) return;
		const sequence = this.keyboardProtocolNegotiationBuffer;
		this.clearKeyboardProtocolNegotiationBuffer();
		this.forwardInputSequence(sequence);
	}

	private scheduleKeyboardProtocolNegotiationBufferFlush(): void {
		if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer) return;
		this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
			this.keyboardProtocolBufferFlushTimer = undefined;
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
	}

	private clearKeyboardProtocolNegotiationBufferFlushTimer(): void {
		if (!this.keyboardProtocolBufferFlushTimer) return;
		clearTimeout(this.keyboardProtocolBufferFlushTimer);
		this.keyboardProtocolBufferFlushTimer = undefined;
	}

	private forwardInputSequence(sequence: string): void {
		if (!this.inputHandler) return;
		const shouldDetectNativeShiftEnter =
			isNativeShiftEnterCandidate(sequence) && (isAppleTerminalSession() || process.platform === "win32");
		const input = normalizeNativeShiftEnterInput(
			sequence,
			shouldDetectNativeShiftEnter,
			shouldDetectNativeShiftEnter && isNativeModifierPressed("shift"),
		);
		this.inputHandler(input);
	}

	private enableModifyOtherKeys(): void {
		if (this._kittyProtocolActive || this._modifyOtherKeysActive) return;
		this.writeOutput("\x1b[>4;2m");
		this._modifyOtherKeysActive = true;
	}

	private disableModifyOtherKeys(): void {
		if (!this._modifyOtherKeysActive) return;
		this.writeOutput("\x1b[>4;0m");
		this._modifyOtherKeysActive = false;
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			getNativePlatformHelper()?.enableVirtualTerminalInput?.();
		} catch {
			// Native helper not available — Shift+Tab won't be distinguishable from Tab.
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (shouldDisableKittyProtocol) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			this.writeOutput("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		// Idempotent detach: nothing to restore when start() never attached. Writing mode resets
		// in that case would toggle protocol state (bracketed paste, keyboard protocol, progress)
		// on a terminal this instance does not own, including after an earlier stop().
		if (!this.stdinDataHandler) return;
		// After restoreOnExit() the terminal has already been handed back: stop() must still
		// detach handlers, timers and raw mode, but it must not write a single visible byte.
		const outputAllowed = !this.released;
		if (this.clearProgressInterval() && outputAllowed) {
			this.writeOutput(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
		this.progressActive = false;
		// Remove the whole record tree while stopped, for example after exit or while suspended.
		// start() replays the records that are still current once support is confirmed again.
		if (outputAllowed) this.clearProgramStatusOutput();
		this.programStatusSupportedValue = false;
		this.programStatusNegotiated = false;
		this.programStatusCapabilities = undefined;
		this.programStatusQueryPending = false;
		// Hand back every mode this instance owns before giving up the terminal.
		if (outputAllowed) {
			this.disableFocusReporting();
			this.popTitleStack();
		} else {
			this.focusReportingActive = false;
			this.titleStackDepth = 0;
		}
		this._terminalFocused = undefined;
		// Support listeners may request progress/status. Relinquish their write
		// permission first so a re-entrant callback cannot restart a heartbeat.
		this.released = true;
		this.notifyProgramStatusSupport();

		// Disable bracketed paste mode (the emergency path already emitted its own reset bytes)
		if (outputAllowed) this.writeOutput("\x1b[?2004l");

		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (shouldDisableKittyProtocol) {
			if (outputAllowed) this.writeOutput("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (outputAllowed) this.disableModifyOtherKeys();
		else this._modifyOtherKeysActive = false;

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	restoreOnExit(before: string, after: string): void {
		let sequence = before;
		// Stop the keepalive first: a running OSC 9;4 interval would otherwise keep writing into
		// a terminal this instance no longer owns.
		if (this.clearProgressInterval()) sequence += TERMINAL_PROGRESS_CLEAR_SEQUENCE;
		if (this.programStatusSupportedValue && this.programStatusRecords.size > 0) {
			sequence += formatProgramStatus({ state: "clear" }) ?? "";
		}
		if (this.focusReportingActive) sequence += FOCUS_REPORTING_DISABLE;
		for (let i = 0; i < this.titleStackDepth; i++) sequence += TITLE_STACK_POP;
		this.titleStackDepth = 0;
		this.progressActive = false;
		this.focusReportingActive = false;
		this.released = true;
		sequence += "\x1b[?2004l";
		if (this.keyboardProtocolPushed || this._kittyProtocolActive) sequence += "\x1b[<u";
		if (this._modifyOtherKeysActive) sequence += "\x1b[>4;0m";
		sequence += after;
		try {
			// The injected writer may be asynchronous (e.g. Windows TTYs) and would not flush during exit.
			// This emergency renderer-owned exit output intentionally bypasses it and writes the real fd
			// synchronously so terminal modes are restored even when JS stdout/stderr are intercepted.
			fs.writeSync(process.stdout.fd, sequence);
		} catch {
			// The terminal may already be gone.
		}
	}

	write(data: string): void {
		this.writeOutput(data);
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			this.writeOutput(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.writeOutput(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		this.writeOutput("\x1b[?25l");
	}

	showCursor(): void {
		this.writeOutput("\x1b[?25h");
	}

	clearLine(): void {
		this.writeOutput("\x1b[K");
	}

	clearFromCursor(): void {
		this.writeOutput("\x1b[J");
	}

	clearScreen(): void {
		this.writeOutput("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	setTitle(title: string): void {
		if (this.released) return;
		// OSC 0;title BEL - set terminal window title. A BEL or ESC in the title would end the sequence early and
		// send the rest to the terminal as escape sequences (session names come from session files).
		this.writeOutput(`\x1b]0;${replaceControlCharacters(title)}\x07`);
	}

	setProgramStatus(status: ProgramStatus): void {
		const id = normalizeProgramStatusId(status.id);
		// An invalid id drops the whole report: falling back to the root record would let a caller
		// silently overwrite the program's own state.
		if (id === null) return;

		if (status.state === "clear") {
			if (id === undefined) {
				this.programStatusRecords.clear();
			} else {
				const descendantPrefix = `${id}/`;
				for (const key of [...this.programStatusRecords.keys()]) {
					if (key === id || key.startsWith(descendantPrefix)) this.programStatusRecords.delete(key);
				}
			}
			if (!this.released && this.programStatusSupported) {
				const sequence = formatProgramStatus(id === undefined ? { state: "clear" } : { state: "clear", id });
				if (sequence !== undefined) this.writeOutput(sequence);
			}
			return;
		}

		// A complete snapshot replaces the addressed record; re-inserting keeps Map order as LRU.
		const record: ProgramStatus = { ...status };
		if (id === undefined) delete record.id;
		else record.id = id;
		const key = id ?? "";
		this.programStatusRecords.delete(key);
		this.programStatusRecords.set(key, record);
		while (this.programStatusRecords.size > PROGRAM_STATUS_MAX_RECORDS) {
			const oldest = this.programStatusRecords.keys().next().value;
			if (oldest === undefined) break;
			this.programStatusRecords.delete(oldest);
		}
		this.writeProgramStatusRecord(record);
	}

	get programStatusSupported(): boolean {
		return this.programStatusSupportedValue;
	}

	onProgramStatusSupportChange(listener: (supported: boolean) => void): () => void {
		this.programStatusSupportListeners.add(listener);
		// Deliver the current value so a consumer never races the startup negotiation.
		try {
			listener(this.programStatusSupportedValue);
		} catch {
			// Host listener code must not break the input path.
		}
		return () => {
			this.programStatusSupportListeners.delete(listener);
		};
	}

	get terminalFocused(): boolean | undefined {
		return this._terminalFocused;
	}

	onFocusChange(listener: (focused: boolean) => void): () => void {
		this.focusChangeListeners.add(listener);
		return () => {
			this.focusChangeListeners.delete(listener);
		};
	}

	setFocusReporting(enabled: boolean): void {
		if (this.focusReportingRequested === enabled) return;
		this.focusReportingRequested = enabled;
		this.syncFocusReporting();
	}

	saveTitle(): void {
		// Title-stack operations belong to an attached terminal only; Ghostty 1.4.0 parses and
		// ignores both, so callers must keep an explicit title fallback.
		if (!this.stdinDataHandler || this.released) return;
		if (this.titleStackDepth >= MAX_TITLE_STACK_DEPTH) return;
		this.writeOutput(TITLE_STACK_PUSH);
		this.titleStackDepth += 1;
	}

	restoreTitle(): void {
		if (!this.stdinDataHandler || this.released) return;
		// Never pop a stack entry this instance did not push.
		if (this.titleStackDepth === 0) return;
		this.writeOutput(TITLE_STACK_POP);
		this.titleStackDepth -= 1;
	}

	/**
	 * Host policy for the legacy OSC 9;4 progress fallback.
	 *
	 * `enabled: true` keeps OSC 9;4 available even after a terminal negotiated OSC 7501
	 * (for an emulator whose GUI still needs legacy progress). `enabled: false` suppresses it
	 * unconditionally. Without a call the
	 * fallback is automatic: allowed until a usable support reply is negotiated.
	 */
	setProgressFallback(enabled: boolean): void {
		if (this.progressFallback === enabled) return;
		this.progressFallback = enabled;
		this.syncProgress();
	}

	private get legacyProgressAllowed(): boolean {
		if (this.progressFallback !== undefined) return this.progressFallback;
		return !this.programStatusNegotiated;
	}

	/** Write one complete record, shaped for the advertised capability subset. */
	private writeProgramStatusRecord(record: ProgramStatus): void {
		if (this.released || !this.programStatusSupportedValue) return;
		const shaped = this.programStatusCapabilities
			? downgradeProgramStatus(record, this.programStatusCapabilities)
			: record;
		if (!shaped) return;
		const sequence = formatProgramStatus(shaped);
		if (sequence !== undefined) this.writeOutput(sequence);
	}

	/** Replay the currently valid records into a terminal that just confirmed support. */
	private maybeReplayProgramStatus(): void {
		if (this.released || !this.programStatusSupportedValue) return;
		for (const record of this.programStatusRecords.values()) this.writeProgramStatusRecord(record);
	}

	private handleProgramStatusSupportReply(sequence: string): void {
		// DA1 ended the current query, or no query was issued. Never let a late,
		// unsolicited or previous owner's reply enable reporting for this attach.
		if (!this.programStatusQueryPending || this.released) return;
		this.programStatusQueryPending = false;
		const override = process.env.PI_PROGRAM_STATUS;
		const capabilities = parseProgramStatusSupport(sequence);
		if (override === "0") {
			this.programStatusCapabilities = undefined;
			this.setProgramStatusSupported(false);
			return;
		}
		if (capabilities) {
			this.programStatusCapabilities = capabilities;
			this.programStatusNegotiated = true;
			// Legacy progress must stop before the first rich record, so a terminal that maps
			// OSC 9;4 onto the root record cannot wipe the report that follows.
			this.suppressLegacyProgress();
			this.setProgramStatusSupported(true);
			return;
		}
		// A reply whose advertised states this build cannot use must not claim support.
		if (override !== "1") {
			this.programStatusCapabilities = undefined;
			this.programStatusNegotiated = false;
			this.setProgramStatusSupported(false);
		}
	}

	private setProgramStatusSupported(next: boolean): void {
		if (this.programStatusSupportedValue === next) {
			this.notifyProgramStatusSupport();
			return;
		}
		this.programStatusSupportedValue = next;
		if (!next) this.programStatusNegotiated = false;
		if (next) this.maybeReplayProgramStatus();
		this.notifyProgramStatusSupport();
	}

	private notifyProgramStatusSupport(): void {
		if (this.notifiedProgramStatusSupported === this.programStatusSupportedValue) return;
		this.notifiedProgramStatusSupported = this.programStatusSupportedValue;
		for (const listener of [...this.programStatusSupportListeners]) {
			try {
				listener(this.programStatusSupportedValue);
			} catch {
				// Host listener code must not break the input path.
			}
		}
	}

	private handleFocusReport(focused: boolean): void {
		if (this._terminalFocused === focused) return;
		this._terminalFocused = focused;
		for (const listener of [...this.focusChangeListeners]) {
			try {
				listener(focused);
			} catch {
				// Host listener code must not break the input path.
			}
		}
	}

	private syncFocusReporting(): void {
		if (!this.stdinDataHandler || this.released) return;
		if (this.focusReportingRequested && !this.focusReportingActive) {
			this.writeOutput(FOCUS_REPORTING_ENABLE);
			this.focusReportingActive = true;
		} else if (!this.focusReportingRequested && this.focusReportingActive) {
			this.writeOutput(FOCUS_REPORTING_DISABLE);
			this.focusReportingActive = false;
		}
	}

	private disableFocusReporting(): void {
		if (!this.focusReportingActive) return;
		this.writeOutput(FOCUS_REPORTING_DISABLE);
		this.focusReportingActive = false;
	}

	/** Pop every title-stack entry this instance pushed. */
	private popTitleStack(): void {
		while (this.titleStackDepth > 0) {
			this.writeOutput(TITLE_STACK_POP);
			this.titleStackDepth -= 1;
		}
	}

	/** One clear for the whole record tree; the root clear removes descendants too. */
	private clearProgramStatusOutput(): void {
		if (!this.programStatusSupportedValue || this.programStatusRecords.size === 0) return;
		const sequence = formatProgramStatus({ state: "clear" });
		if (sequence !== undefined) this.writeOutput(sequence);
	}

	setProgress(active: boolean): void {
		this.progressRequested = active;
		this.syncProgress();
	}

	/**
	 * Reconcile the legacy OSC 9;4 progress sequence with the current policy.
	 *
	 * Repeated frame-path calls are idempotent: nothing is written when the requested state did not
	 * change, and the keepalive interval is bounded to one timer while active.
	 */
	private syncProgress(): void {
		if (this.released) return;
		if (!this.legacyProgressAllowed) {
			this.suppressLegacyProgress();
			return;
		}
		if (this.progressRequested === this.progressActive) return;
		this.progressActive = this.progressRequested;
		if (this.progressActive) {
			// OSC 9;4;3 - indeterminate progress
			this.writeOutput(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					this.writeOutput(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
				this.progressInterval.unref?.();
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			this.writeOutput(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	/** Drop a running legacy progress report once rich status owns progress. */
	private suppressLegacyProgress(): void {
		if (this.released) return;
		if (!this.progressActive && !this.progressInterval) return;
		this.clearProgressInterval();
		this.progressActive = false;
		this.writeOutput(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
