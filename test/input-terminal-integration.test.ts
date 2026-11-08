/**
 * Terminal integration seam: OSC 7501 program status, focus reports, the window-title
 * stack, legacy progress policy and fragmented-reply reassembly.
 *
 * Offline only: no model, backend, credential, user profile, clipboard or user TTY. The
 * terminal-level cases run in a private `script -q` PTY child with temporary homes; the
 * parser/serializer cases are pure in-process module calls.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const programStatus = (await import(
	new URL("../vendor/pi-tui/src/program-status.ts", import.meta.url).href
)) as {
	formatProgramStatus(status: Record<string, unknown>): string | undefined
	parseProgramStatusSupport(sequence: string): { states: Set<string>; kinds: Set<string> } | undefined
	downgradeProgramStatus(
		status: Record<string, unknown>,
		capabilities: { states: Set<string>; kinds: Set<string> },
	): Record<string, unknown> | undefined
	normalizeProgramStatusId(id: string | undefined): string | undefined | null
	isProgramStatusReply(sequence: string): boolean
	PROGRAM_STATUS_QUERY: string
	PROGRAM_STATUS_MAX_RECORDS: number
	PROGRAM_STATUS_LIMITS: { sequenceBytes: number; messageBytes: number; titleBytes: number; idBytes: number }
}
const { formatProgramStatus, parseProgramStatusSupport, downgradeProgramStatus, normalizeProgramStatusId } =
	programStatus

const stdinBufferModule = (await import(new URL("../vendor/pi-tui/src/stdin-buffer.ts", import.meta.url).href)) as {
	StdinBuffer: new (options?: Record<string, unknown>) => {
		process(data: string | Buffer): void
		getBuffer(): string
		destroy(): void
		on(event: "data" | "paste", handler: (value: string) => void): void
	}
}

const FULL_REPLY =
	"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\"

const ROOT = mkdtempSync(join(tmpdir(), "dsh-input-terminal-integration-"))
const HOME_DIR = join(ROOT, "home")
const DSH_HOME_DIR = join(ROOT, "dsh-home")
mkdirSync(HOME_DIR, { recursive: true })
mkdirSync(DSH_HOME_DIR, { recursive: true })

test.after(() => {
	rmSync(ROOT, { recursive: true, force: true })
})

function count(text: string, needle: string): number {
	return text.split(needle).length - 1
}

// ---------------------------------------------------------------------------------------------
// Protocol encoding and capability parsing (pure)
// ---------------------------------------------------------------------------------------------

test("records carry id/title/progress and stay inside the specification limits", () => {
	const sequence = formatProgramStatus({
		state: "blocked",
		id: "agents/one",
		app: "dsh-tui",
		kind: "permission",
		progress: 40,
		title: "Agent 1",
		message: "approve the deploy",
	})
	assert.equal(
		sequence,
		"\x1b]7501;state=blocked:id=agents/one:app=dsh-tui:kind=permission:progress=40" +
			`:title=${Buffer.from("Agent 1").toString("base64")}` +
			`:msg=${Buffer.from("approve the deploy").toString("base64")}\x1b\\`,
	)
	assert.ok(Buffer.byteLength(sequence!) <= programStatus.PROGRAM_STATUS_LIMITS.sequenceBytes)

	const longTitle = "т".repeat(400)
	const longMessage = "m".repeat(4000)
	const bounded = formatProgramStatus({ state: "idle", title: longTitle, message: longMessage })!
	const titleField = bounded.split(":title=")[1]!.split(":msg=")[0]!
	const messageField = bounded.split(":msg=")[1]!.replace("\x1b\\", "")
	assert.ok(Buffer.from(titleField, "base64").length <= programStatus.PROGRAM_STATUS_LIMITS.titleBytes)
	assert.ok(Buffer.from(messageField, "base64").length <= programStatus.PROGRAM_STATUS_LIMITS.messageBytes)
	assert.ok(Buffer.byteLength(bounded) <= programStatus.PROGRAM_STATUS_LIMITS.sequenceBytes)

	// State-scoped keys are omitted where the specification ignores them.
	const idle = formatProgramStatus({ state: "idle", kind: "auth", progress: 50 })!
	assert.ok(!idle.includes("kind="))
	assert.ok(!idle.includes("progress="))
	// Out-of-range and non-integer percentages are dropped, never rounded into a fake value.
	assert.ok(!formatProgramStatus({ state: "working", progress: 101 })!.includes("progress="))
	assert.ok(!formatProgramStatus({ state: "working", progress: 12.5 })!.includes("progress="))
})

test("an invalid id drops the report instead of falling back to the root record", () => {
	assert.equal(normalizeProgramStatusId(undefined), undefined)
	assert.equal(normalizeProgramStatusId("agents/one"), "agents/one")
	for (const invalid of ["", "a//b", "/a", "a/", "a/b/c/d/e/f/g/h/i", "x".repeat(33), "bad id", "a b/c"]) {
		assert.equal(normalizeProgramStatusId(invalid), null, `invalid id must be rejected: ${invalid}`)
	}
	assert.equal(formatProgramStatus({ state: "working", id: "a//b" }), undefined)
	assert.equal(formatProgramStatus({ state: "clear", id: "bad id" }), undefined)
	assert.equal(formatProgramStatus({ state: "clear" }), "\x1b]7501;state=clear\x1b\\")
	assert.equal(formatProgramStatus({ state: "clear", id: "agents" }), "\x1b]7501;state=clear:id=agents\x1b\\")
})

test("capability parsing is conservative and never turns an unusable advertisement into support", () => {
	assert.deepEqual([...parseProgramStatusSupport(FULL_REPLY)!.states], ["idle", "working", "done", "blocked", "error"])
	assert.deepEqual([...parseProgramStatusSupport(FULL_REPLY)!.kinds], ["permission", "question", "auth"])
	// A reply without lists means the fixed defaults.
	const defaults = parseProgramStatusSupport("\x1b]7501;?\x1b\\")!
	assert.equal(defaults.states.size, 5)
	assert.equal(defaults.kinds.size, 3)
	// A subset is kept verbatim; unknown values and pairs are ignored.
	const subset = parseProgramStatusSupport("\x1b]7501;?:states=idle,working:future=yes\x07")!
	assert.deepEqual([...subset.states], ["idle", "working"])
	// Nothing usable: not support.
	assert.equal(parseProgramStatusSupport("\x1b]7501;?:states=brand-new\x1b\\"), undefined)
	// A pair list without the optional leading colon is still an advertisement of `idle`.
	assert.deepEqual([...parseProgramStatusSupport("\x1b]7501;?states=idle\x1b\\")!.states], ["idle"])
	assert.equal(parseProgramStatusSupport("\x1b]11;rgb:0000/0000/0000\x07"), undefined)
})

test("downgrade maps unsupported states conservatively and drops unusable keys", () => {
	const idleWorking: { states: Set<string>; kinds: Set<string> } = { states: new Set(["idle", "working"]), kinds: new Set<string>() }
	const blocked = downgradeProgramStatus(
		{ state: "blocked", kind: "permission", progress: 30, message: "waiting" },
		idleWorking,
	)!
	assert.equal(blocked.state, "working")
	assert.equal(blocked.kind, undefined)
	assert.equal(blocked.progress, 30)
	assert.equal(downgradeProgramStatus({ state: "done" }, idleWorking)!.state, "idle")
	assert.equal(downgradeProgramStatus({ state: "error" }, idleWorking)!.state, "idle")
	assert.equal(downgradeProgramStatus({ state: "working" }, { states: new Set<string>(), kinds: new Set<string>() }), undefined)
	assert.equal(downgradeProgramStatus({ state: "clear" }, { states: new Set<string>(), kinds: new Set<string>() })!.state, "clear")
})

// ---------------------------------------------------------------------------------------------
// Stdin reassembly of fragmented / malformed replies
// ---------------------------------------------------------------------------------------------

test("lone Escape keeps its configured deadline", async () => {
	const buffer = new stdinBufferModule.StdinBuffer({ escapeTimeout: 20, timeout: 40, replyTimeout: 500 })
	const data: string[] = []
	buffer.on("data", (value) => data.push(value))
	buffer.process("\x1b")
	assert.deepEqual(data, [])
	await new Promise((resolve) => setTimeout(resolve, 60))
	assert.deepEqual(data, ["\x1b"])
	buffer.destroy()
})

test("an expected reply reassembles across a pause longer than the sequence timeout", async () => {
	const buffer = new stdinBufferModule.StdinBuffer({
		escapeTimeout: 10,
		timeout: 20,
		replyTimeout: 500,
		expectedReplyPrefixes: () => [programStatus.PROGRAM_STATUS_QUERY],
	})
	const data: string[] = []
	buffer.on("data", (value) => data.push(value))
	// Split inside the header, with an SSH-like pause well past the 20ms sequence timeout.
	buffer.process("\x1b]750")
	await new Promise((resolve) => setTimeout(resolve, 80))
	assert.deepEqual(data, [], "a fragmented internet reply header must not become Alt+] text")
	buffer.process("1;?:states=idle,working\x1b\\")
	assert.deepEqual(data, ["\x1b]7501;?:states=idle,working\x1b\\"])
	buffer.destroy()
})

test("an unterminated reply fails closed and stays bounded in time and memory", async () => {
	const bounded = new stdinBufferModule.StdinBuffer({
		timeout: 20,
		expectedReplyTimeout: 60,
		replyTimeout: 100,
		maxReplyBytes: 64,
		expectedReplyPrefixes: () => [programStatus.PROGRAM_STATUS_QUERY],
	})
	const boundedData: string[] = []
	bounded.on("data", (value) => boundedData.push(value))
	bounded.process("\x1b]750")
	await new Promise((resolve) => setTimeout(resolve, 220))
	assert.deepEqual(boundedData, [], "a stalled reply is discarded, never replayed as keys")
	bounded.process("a")
	assert.deepEqual(boundedData, ["a"], "ordinary keys resume after the finite cleanup deadline")
	bounded.destroy()

	const oversized = new stdinBufferModule.StdinBuffer({ replyTimeout: 10_000, maxReplyBytes: 64 })
	const oversizedData: string[] = []
	oversized.on("data", (value) => oversizedData.push(value))
	oversized.process(`\x1b]7501;?${"x".repeat(200)}`)
	assert.equal(oversized.getBuffer(), "", "an oversized reply is quarantined, not accumulated")
	assert.deepEqual(oversizedData, [])
	oversized.destroy()
})

test("pasted focus reports and capability replies stay literal paste content", () => {
	const buffer = new stdinBufferModule.StdinBuffer({ expectedReplyPrefixes: () => [programStatus.PROGRAM_STATUS_QUERY] })
	const data: string[] = []
	const pastes: string[] = []
	buffer.on("data", (value) => data.push(value))
	buffer.on("paste", (value) => pastes.push(value))
	buffer.process("\x1b[200~\x1b[I\n\x1b]7501;?:states=idle\x1b\\\x1b[201~")
	assert.deepEqual(data, [])
	assert.deepEqual(pastes, ["\x1b[I\n\x1b]7501;?:states=idle\x1b\\"])
	buffer.destroy()
})

// ---------------------------------------------------------------------------------------------
// Attached-terminal behavior (private PTY child)
// ---------------------------------------------------------------------------------------------

/** Run an inline ES module in a private PTY, with temp homes and a result file. */
function runInPty(source: string, name: string): { output: string; result: Record<string, unknown> } {
	const streamPath = join(ROOT, `${name}.stream`)
	const resultPath = join(ROOT, `${name}.json`)
	const args = [process.execPath, "--input-type=module", "-e", source, resultPath]
	const command =
		process.platform === "darwin"
			? ["-q", streamPath, ...args]
			: ["-q", "-c", args.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" "), streamPath]
	const proc = spawnSync("/usr/bin/script", command, {
		cwd: process.cwd(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 90_000,
		env: {
			...process.env,
			HOME: HOME_DIR,
			DSH_HOME: DSH_HOME_DIR,
			XDG_CONFIG_HOME: join(HOME_DIR, ".config"),
			PI_PROGRAM_STATUS: "",
			PI_TUI_WRITE_LOG: "",
		},
	})
	if (proc.error) {
		throw new Error(`terminal integration PTY test needs a POSIX 'script': ${proc.error.message}`)
	}
	const output = readFileSync(streamPath, "utf8")
	assert.equal(proc.status, 0, `PTY child exit status (stream tail: ${output.slice(-600)})`)
	return { output, result: JSON.parse(readFileSync(resultPath, "utf8")) }
}

const PTY_PROBE = `
import { ProcessTerminal } from "./vendor/pi-tui/src/terminal.ts"
import { writeFileSync } from "node:fs"

const resultPath = process.argv.at(-1)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const writes = []
const input = []
const support = []
const focus = []
const terminal = new ProcessTerminal({ write: (data) => writes.push(data) })
terminal.onProgramStatusSupportChange((value) => support.push(value))
terminal.onFocusChange((value) => focus.push(value))
terminal.setFocusReporting(true)

const seen = () => writes.join("")
const since = (mark) => writes.slice(mark).join("")

// --- phase 1: records before negotiation stay off the wire; fragmented reply replays them ---
terminal.setProgramStatus({ state: "working", app: "dsh-tui", message: "root working" })
terminal.setProgramStatus({ state: "working", id: "agents/one", app: "dsh-tui", title: "Agent 1", progress: 40 })
const preAttach = seen()
terminal.start((data) => input.push(data), () => {})
const startMark = 0
await sleep(30)
const beforeReply = since(startMark)
const replyMark = writes.length
process.stdin.emit("data", "\\x1b]750")
await sleep(120)
process.stdin.emit("data", "1;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\\x1b\\\\")
await sleep(30)
const afterReply = since(replyMark)
const supportedAfterReply = terminal.programStatusSupported

// --- progress policy: negotiated rich status suppresses legacy OSC 9;4 ---
const suppressMark = writes.length
terminal.setProgress(true)
terminal.setProgress(true)
const suppressed = since(suppressMark)
terminal.setProgressFallback(true)
const fallbackOn = since(suppressMark)
terminal.setProgressFallback(false)
const fallbackOff = since(suppressMark)

// --- focus reports are consumed, never typed; paste content is untouched ---
const focusMark = writes.length
const inputMark = input.length
process.stdin.emit("data", "\\x1b[I")
process.stdin.emit("data", "\\x1b[I")
process.stdin.emit("data", "\\x1b[O")
await sleep(20)
const focusAfterReports = [...focus]
const focusInput = input.slice(inputMark)
process.stdin.emit("data", "\\x1b[200~\\x1b[I \\x1b]7501;?\\x1b\\\\\\x1b[201~")
await sleep(20)
const focusAfterPaste = focus.length
const pasteInput = input.slice(inputMark)
const focusFocused = terminal.terminalFocused

// --- title stack: balanced pushes/pops, no writes after stop ---
terminal.saveTitle()
terminal.saveTitle()
terminal.restoreTitle()
const titleMarks = { pushes: writes.join("").split("\x1b[22;0t").length - 1 }
const titleMark = writes.length
terminal.stop()
const stopWrites = since(titleMark)
const stoppedMark = writes.length
const stoppedInput = input.length
terminal.setProgramStatus({ state: "idle", app: "dsh-tui" })
terminal.setProgress(true)
terminal.saveTitle()
terminal.setFocusReporting(false)
await sleep(20)
const afterStop = since(stoppedMark)
const inputAfterStop = input.length - stoppedInput

// --- phase 2: restart stays silent until support is re-negotiated, then replays ---
terminal.start((data) => input.push(data), () => {})
const restartMark = writes.length
await sleep(20)
const restarted = since(restartMark)
terminal.setFocusReporting(true)
const reArmed = since(restartMark)
process.stdin.emit("data", "\\x1b[?1;2c")
await sleep(20)
const daOnly = terminal.programStatusSupported
const daMark = writes.length
terminal.setProgramStatus({ state: "working", app: "dsh-tui", message: "should not be written" })
const afterDa = since(daMark)
const replayMark = writes.length
process.stdin.emit("data", ${JSON.stringify(FULL_REPLY)})
await sleep(30)
const restartReplay = since(replayMark)
terminal.stop()

// --- phase 3: records cleared while stopped are not replayed ---
terminal.setProgramStatus({ state: "clear" })
terminal.start((data) => input.push(data), () => {})
const staleMark = writes.length
process.stdin.emit("data", ${JSON.stringify(FULL_REPLY)})
await sleep(30)
const staleReplay = since(staleMark)
// Publish one record, then leave through the emergency path.
terminal.setProgramStatus({ state: "done", app: "dsh-tui", message: "finished" })
terminal.saveTitle()
terminal.restoreOnExit("\\x1b[?25h", "\\x1b]0;PTY-RESTORE\\x07")
terminal.stop()

writeFileSync(resultPath, JSON.stringify({
  preAttach,
  beforeReply,
  afterReply,
  supportedAfterReply,
  suppressed,
  fallbackOn,
  fallbackOff,
  focusAfterReports,
  focusInput,
  focusAfterPaste,
  pasteInput,
  focusFocused,
  stopWrites,
  titlePushes: titleMarks.pushes,
  titlePops: writes.join("").split("\x1b[23;0t").length - 1,
  afterStop,
  inputAfterStop,
  restarted,
  reArmed,
  restartReplay,
  daOnly,
  afterDa,
  staleReplay,
  support,
  stoppedAfterEmergency: terminal.programStatusSupported,
}))
process.exit(0)
`

test("private PTY: negotiation, replay, focus, title stack, progress policy and emergency restore", () => {
	const { output, result } = runInPty(PTY_PROBE, "integration")
	const asString = (value: unknown) => String(value ?? "")

	// Nothing about program status may reach a terminal before support is negotiated.
	assert.ok(!asString(result.preAttach).includes("7501"), "records stay off the wire before support")
	assert.ok(!asString(result.beforeReply).includes("7501;state="), "startup replay waits for the reply")
	assert.ok(count(asString(result.beforeReply), "\x1b]7501;?") === 1, "the support query is sent once")

	// Fragment reassembly: the reply is consumed as a reply and never becomes editor text.
	const afterReply = asString(result.afterReply)
	assert.equal(count(afterReply, "\x1b]7501;state=working"), 2, "root and child records are replayed")
	assert.ok(afterReply.includes("id=agents/one"), "the child record keeps its id")
	assert.ok(afterReply.includes("title="), "the child title survives the round trip")
	assert.ok(!asString(result.beforeReply).includes("state=clear"))
	assert.equal(result.supportedAfterReply, true)

	// Legacy OSC 9;4: suppressed after negotiation, restored and re-suppressed by policy.
	assert.equal(asString(result.suppressed), "", "no legacy progress while rich status is negotiated")
	assert.equal(count(asString(result.fallbackOn), "\x1b]9;4;3\x07"), 1, "explicit fallback re-enables OSC 9;4")
	assert.equal(count(asString(result.fallbackOff), "\x1b]9;4;0\x07"), 1, "policy off clears it once")
	assert.equal(count(asString(result.fallbackOff), "\x1b]9;4;3\x07"), 1, "repeated frames never re-send")
	assert.equal(count(asString(result.fallbackOff), "\x1b]9;4;0\x07"), 1)

	// Focus reports are terminal facts, not keys, and never penetrate paste.
	assert.deepEqual(result.focusAfterReports, [true, false], "duplicate focus reports are not re-notified")
	assert.deepEqual(result.focusInput, [], "focus reports never reach the editor")
	assert.equal(result.focusAfterPaste, 2, "focus inside paste is not a report")
	assert.equal(asString(result.pasteInput), "\x1b[200~\x1b[I \x1b]7501;?\x1b\\\x1b[201~", "paste stays literal")
	assert.ok(typeof result.focusFocused === "boolean")

	// Title stack is balanced and hands everything back on stop.
	assert.equal(result.titlePushes, 2, "two title pushes")
	assert.equal(result.titlePops, 2, "one explicit restore plus one pop on stop")
	assert.equal(count(asString(result.stopWrites), "\x1b[22;0t"), 0)
	assert.ok(asString(result.stopWrites).includes("\x1b]7501;state=clear"), "stop clears the record tree once")
	assert.equal(count(asString(result.stopWrites), "\x1b]7501;state=clear"), 1)
	assert.ok(asString(result.stopWrites).includes("\x1b[?1004l"), "focus reporting is handed back")

	// No writes and no input after ownership is relinquished.
	assert.equal(asString(result.afterStop), "", "late status/progress/title/focus calls write nothing")
	assert.equal(result.inputAfterStop, 0)

	// Restart: silent until support is re-negotiated, then the valid records are replayed.
	const restarted = asString(result.restarted)
	assert.ok(!restarted.includes("7501;state="), "restart does not replay before renegotiation")
	assert.ok(!restarted.includes("\x1b[?1004h"), "a focus mode disabled while stopped stays off")
	assert.ok(asString(result.reArmed).includes("\x1b[?1004h"), "re-enabling focus reporting after attach writes the mode")
	assert.equal(result.daOnly, false, "a DA1-only terminal is not claimed as supporting OSC 7501")
	assert.equal(asString(result.afterDa), "", "no record is written to a non-supporting terminal")
	assert.equal(count(asString(result.restartReplay), "\x1b]7501;state=working"), 2, "restart replays valid records")
	assert.equal(asString(result.staleReplay), "", "cleared records are not replayed")

	// Emergency exit restores modes through the real fd.
	assert.ok(output.includes("\x1b]7501;state=clear"), "emergency exit clears the status")
	assert.ok(output.includes("\x1b[?1004l"), "emergency exit disables focus reporting")
	assert.ok(output.includes("\x1b[23;0t"), "emergency exit pops the title stack")
	assert.ok(output.includes("\x1b[?2004l"), "emergency exit disables bracketed paste")
	assert.ok(output.includes("PTY-RESTORE"), "the caller's restore bytes still follow")

	// Support transitions are delivered in order: unknown → negotiated → stopped → negotiated.
	const support = result.support as boolean[]
	assert.deepEqual(support.slice(0, 3), [false, true, false])
})