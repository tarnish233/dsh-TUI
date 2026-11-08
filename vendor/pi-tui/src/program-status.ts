/**
 * Program Status Protocol (OSC 7501): a program tells the terminal whether it is idle, working,
 * blocked on the user, done, or failed. The terminal keeps one complete record per id.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status (revision 0.4, 2026-10-10)
 *
 * Every limit below is a hard cap from the specification. A report that breaks one of them is
 * discarded whole, so encoding refuses to emit it instead of letting a terminal drop it silently.
 */

import { replaceControlCharacters } from "./utils.ts";

/** A real record state. `clear` is a removal request, not a state. */
export type ProgramStatusState = "idle" | "working" | "blocked" | "done" | "error";

/** What a blocked program waits for. */
export type ProgramStatusKind = "permission" | "question" | "auth";

/**
 * One complete OSC 7501 record.
 *
 * Each report replaces the addressed record completely, so a caller that wants to keep `app`,
 * `title` or a message must include it in every report. Omitting `id` addresses the root record.
 */
export interface ProgramStatus {
	/** `clear` removes the addressed record and every record beneath it. */
	state: ProgramStatusState | "clear";
	/**
	 * Record path: `[A-Za-z0-9_.+-]{1,32}` segments joined by `/`, at most 8 levels and 128 bytes.
	 * An invalid id drops the whole report; it must never fall back to the root record.
	 */
	id?: string;
	/** Stable program name, `[A-Za-z0-9_.+-]{1,32}`. Other values are omitted. */
	app?: string;
	/** What a blocked record waits for. Omitted for other states. */
	kind?: ProgramStatusKind;
	/** Percentage (0-100) for `working` or `blocked`. Omitted for other states. */
	progress?: number;
	/** Short human-readable label. Base64 on the wire; 192 decoded bytes at most. */
	title?: string;
	/** One human-readable line. Base64 on the wire; 2048 decoded bytes at most. */
	message?: string;
}

/**
 * What a terminal advertised in its reply to the support query.
 *
 * A reply without a `states` pair means the fixed default set, and a reply without `kinds` means
 * every kind. Only values this build understands are kept.
 */
export interface ProgramStatusCapabilities {
	readonly states: ReadonlySet<ProgramStatusState>;
	readonly kinds: ReadonlySet<ProgramStatusKind>;
}

/** Feature detection query. A supporting terminal replies with the same body plus capability lists. */
export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";

/** States every terminal that answers `?` supports when it omits the `states` pair. */
export const PROGRAM_STATUS_DEFAULT_STATES: readonly ProgramStatusState[] = [
	"idle",
	"working",
	"done",
	"blocked",
	"error",
];

/** Kinds every terminal that answers `?` supports when it omits the `kinds` pair. */
export const PROGRAM_STATUS_DEFAULT_KINDS: readonly ProgramStatusKind[] = ["permission", "question", "auth"];

/** Bounded record store: the specification requires at least 64 and allows 256. */
export const PROGRAM_STATUS_MAX_RECORDS = 64;

/** Exact specification limits. Every one counts bytes, not characters. */
export const PROGRAM_STATUS_LIMITS = {
	/** Whole sequence, `ESC ]` through the terminator. */
	sequenceBytes: 4096,
	keyBytes: 16,
	/** `msg`, decoded and base64 encoded. */
	messageBytes: 2048,
	messageEncodedBytes: 2732,
	/** `title`, decoded and base64 encoded. */
	titleBytes: 192,
	titleEncodedBytes: 256,
	appBytes: 32,
	idBytes: 128,
	idSegmentBytes: 32,
	idDepth: 8,
} as const;

const PROGRAM_STATUS_PREFIX = "\x1b]7501;";
const PROGRAM_STATUS_SUFFIX = "\x1b\\";
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const ID_SEGMENT_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;

/**
 * The reply to {@link PROGRAM_STATUS_QUERY}. Later spec revisions may add pairs after the `?`.
 * A terminal that does not support the protocol never sends this.
 */
export function isProgramStatusReply(sequence: string): boolean {
	return /^\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)$/.test(sequence);
}

/**
 * Parse the terminal's support reply.
 *
 * Returns `undefined` when the sequence is not a support reply or when the advertised `states`
 * list contains no state this build understands: an unusable advertisement must not be reported as
 * support, or every later report would be a silent no-op.
 */
export function parseProgramStatusSupport(sequence: string): ProgramStatusCapabilities | undefined {
	const match = sequence.match(/^\x1b\]7501;\?([^\x07\x1b]*)(?:\x07|\x1b\\)$/);
	if (!match) return undefined;

	let states: Set<ProgramStatusState> | undefined;
	let kinds: Set<ProgramStatusKind> | undefined;
	// Values cannot contain `:` or `;`, so a plain split is the whole grammar.
	for (const pair of match[1]!.split(":")) {
		const separator = pair.indexOf("=");
		if (separator <= 0) continue;
		const key = pair.slice(0, separator).trim();
		const value = pair.slice(separator + 1).trim();
		if (key === "states") {
			states = new Set<ProgramStatusState>();
			for (const token of value.split(",")) {
				const state = token.trim();
				if (isProgramStatusState(state)) states.add(state);
			}
		} else if (key === "kinds") {
			kinds = new Set<ProgramStatusKind>();
			for (const token of value.split(",")) {
				const kind = token.trim();
				if (isProgramStatusKind(kind)) kinds.add(kind);
			}
		}
		// Unknown pairs belong to later revisions and must be ignored.
	}

	if (states && states.size === 0) return undefined;
	return {
		states: states ?? new Set(PROGRAM_STATUS_DEFAULT_STATES),
		kinds: kinds ?? new Set(PROGRAM_STATUS_DEFAULT_KINDS),
	};
}

export function isProgramStatusState(value: string): value is ProgramStatusState {
	return value === "idle" || value === "working" || value === "blocked" || value === "done" || value === "error";
}

export function isProgramStatusKind(value: string): value is ProgramStatusKind {
	return value === "permission" || value === "question" || value === "auth";
}

/**
 * Validate a record id.
 *
 * Returns `undefined` for an absent id (the root record), the id itself when valid, and `null` when
 * the id is malformed. `null` means "drop the whole report": falling back to the root record would
 * let a bug overwrite the program's own state.
 */
export function normalizeProgramStatusId(id: string | undefined): string | undefined | null {
	if (id === undefined) return undefined;
	const segments = id.split("/");
	if (segments.length === 0 || segments.length > PROGRAM_STATUS_LIMITS.idDepth) return null;
	if (Buffer.byteLength(id, "utf8") > PROGRAM_STATUS_LIMITS.idBytes) return null;
	for (const segment of segments) {
		if (!ID_SEGMENT_PATTERN.test(segment)) return null;
	}
	return id;
}

/** The record key for a validated id: the root record is the empty string. */
export function programStatusRecordKey(id: string | undefined): string {
	return id ?? "";
}

/** Conservative downgrade order. A state the terminal does not know never becomes a false success. */
const STATE_FALLBACKS: Record<ProgramStatusState, readonly ProgramStatusState[]> = {
	idle: ["idle"],
	working: ["working", "idle"],
	blocked: ["blocked", "working", "idle"],
	done: ["done", "idle"],
	error: ["error", "idle"],
};

/**
 * Shape one record for the capabilities a terminal advertised.
 *
 * `undefined` means the terminal cannot express this record at all; the caller must not write it.
 * A `clear` request is always expressible.
 */
export function downgradeProgramStatus(
	status: ProgramStatus,
	capabilities: ProgramStatusCapabilities,
): ProgramStatus | undefined {
	if (status.state === "clear") return status;

	let state: ProgramStatusState | undefined;
	for (const candidate of STATE_FALLBACKS[status.state]) {
		if (capabilities.states.has(candidate)) {
			state = candidate;
			break;
		}
	}
	if (state === undefined) return undefined;

	const downgraded: ProgramStatus = { ...status, state };
	if (state !== "blocked") delete downgraded.kind;
	else if (status.kind !== undefined && !capabilities.kinds.has(status.kind)) delete downgraded.kind;

	if (state !== "working" && state !== "blocked") delete downgraded.progress;
	else if (
		status.progress === undefined ||
		!Number.isInteger(status.progress) ||
		status.progress < 0 ||
		status.progress > 100
	) {
		delete downgraded.progress;
	}
	return downgraded;
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}

/** Base64 of a single-line, control-character-free, byte-limited value; empty means omit the key. */
function encodeText(text: string | undefined, maxDecodedBytes: number): string {
	if (text === undefined) return "";
	const sanitized = truncateUtf8(replaceControlCharacters(text).trim(), maxDecodedBytes);
	if (sanitized.length === 0) return "";
	return Buffer.from(sanitized, "utf8").toString("base64");
}

function bodyFits(body: string): boolean {
	return PROGRAM_STATUS_PREFIX.length + body.length + PROGRAM_STATUS_SUFFIX.length <= PROGRAM_STATUS_LIMITS.sequenceBytes;
}

/**
 * Encode one complete record.
 *
 * Returns `undefined` when the report must not be sent: an invalid id (never a root fallback) or a
 * body that cannot fit the sequence limit even after the optional text is dropped.
 */
export function formatProgramStatus(status: ProgramStatus): string | undefined {
	const id = normalizeProgramStatusId(status.id);
	if (id === null) return undefined;

	const pairs = [`state=${status.state}`];
	if (id !== undefined) pairs.push(`id=${id}`);
	if (status.app !== undefined && APP_PATTERN.test(status.app)) pairs.push(`app=${status.app}`);
	if (status.state === "blocked" && status.kind !== undefined) pairs.push(`kind=${status.kind}`);
	if (
		(status.state === "working" || status.state === "blocked") &&
		status.progress !== undefined &&
		Number.isInteger(status.progress) &&
		status.progress >= 0 &&
		status.progress <= 100
	) {
		pairs.push(`progress=${status.progress}`);
	}

	let body = pairs.join(":");
	if (!bodyFits(body)) return undefined;

	const title = encodeText(status.title, PROGRAM_STATUS_LIMITS.titleBytes);
	if (title) {
		const candidate = `${body}:title=${title}`;
		if (bodyFits(candidate)) body = candidate;
	}

	const message = encodeText(status.message, PROGRAM_STATUS_LIMITS.messageBytes);
	if (message) {
		const candidate = `${body}:msg=${message}`;
		if (bodyFits(candidate)) body = candidate;
	}

	return `${PROGRAM_STATUS_PREFIX}${body}${PROGRAM_STATUS_SUFFIX}`;
}