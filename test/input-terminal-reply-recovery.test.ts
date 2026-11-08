/**
 * Terminal reply recovery: a recognized but stalled/oversized/split terminal reply must fail
 * closed (discard) instead of being reparsed as editor keys, and the terminal seam must stay
 * silent after it has handed the terminal back.
 *
 * Offline only: direct `StdinBuffer` cases run in-process, terminal cases run in a private
 * `script -q` child with temporary homes. No model, credential, profile or user-TTY access.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { StdinBuffer } = (await import(new URL("../vendor/pi-tui/src/stdin-buffer.ts", import.meta.url).href)) as {
	StdinBuffer: new (options?: Record<string, unknown>) => {
		process(data: string | Buffer): void
		flush(): string[]
		getBuffer(): string
		destroy(): void
		on(event: "data" | "paste", handler: (value: string) => void): void
	}
}

const ESC = "\x1b"
const ROOT = mkdtempSync(join(tmpdir(), "dsh-input-reply-recovery-"))
const HOME_DIR = join(ROOT, "home")
mkdirSync(join(HOME_DIR, ".config"), { recursive: true })

test.after(() => {
	rmSync(ROOT, { recursive: true, force: true })
})

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Recorder {
	data: string[]
	pastes: string[]
}

function recorder(): { buffer: InstanceType<typeof StdinBuffer>; seen: Recorder } {
	const seen: Recorder = { data: [], pastes: [] }
	const buffer = new StdinBuffer({
		timeout: 30,
		escapeTimeout: 15,
		replyTimeout: 100,
		expectedReplyTimeout: 80,
	}) as InstanceType<typeof StdinBuffer>
	buffer.on("data", (value) => seen.data.push(value))
	buffer.on("paste", (value) => seen.pastes.push(value))
	return { buffer, seen }
}

test("a stalled OSC colour reply is discarded, never typed, and typing resumes", async () => {
	const { buffer, seen } = recorder()
	// Recognized reply header (OSC 11 colour query reply) that never terminates.
	buffer.process(`${ESC}]11;rgb:1111/2222/3333`)
	await delay(160)
	assert.deepEqual(seen.data, [], "the stalled reply payload is not replayed as keys")
	buffer.process("secret")
	await delay(10)
	assert.deepEqual(seen.data, [], "input inside the quarantine window is discarded, not typed")
	buffer.process("\x07")
	buffer.process("xy")
	assert.deepEqual(seen.data, ["x", "y"], "typing resumes after the reply terminator")
	assert.equal(buffer.getBuffer(), "")
	buffer.destroy()
})

test("a stalled DCS/APC reply stays out of the editor and its split terminator is not Escape", async () => {
	const { buffer, seen } = recorder()
	buffer.process(`${ESC}P>|ghostty 1.4.0`)
	await delay(160)
	assert.deepEqual(seen.data, [], "DCS payload never becomes keys")
	buffer.process(`${ESC}`)
	buffer.process("\\")
	buffer.process("q")
	assert.deepEqual(seen.data, ["q"], "the split ST ends recovery without emitting Escape")

	const apc = recorder()
	apc.buffer.process(`${ESC}_Gi=1;OK`)
	await delay(160)
	assert.deepEqual(apc.seen.data, [], "APC payload never becomes keys")
	apc.buffer.process(`${ESC}\\`)
	apc.buffer.process("w")
	assert.deepEqual(apc.seen.data, ["w"])
	apc.buffer.destroy()
	buffer.destroy()
})

test("an oversized recognized reply is quarantined instead of truncated into text", async () => {
	const { buffer, seen } = recorder()
	buffer.process(`${ESC}]11;rgb:${"a".repeat(20_000)}`)
	await delay(20)
	assert.deepEqual(seen.data, [], "no chunk of an oversized reply reaches the editor")
	buffer.process(`${"b".repeat(4096)}\x07`)
	assert.deepEqual(seen.data, [], "the oversized tail is discarded with its terminator")
	buffer.process("ok")
	assert.deepEqual(seen.data, ["o", "k"], "typing resumes after the discard")
	buffer.destroy()
})

test("a fragmented reply tail completes normally, and a stalled expected reply fails closed", async () => {
	const { buffer, seen } = recorder()
	// Normal completion: header, pause beyond the sequence timeout, then the tail.
	buffer.process(`${ESC}]7501;?`)
	await delay(60)
	buffer.process(":states=idle,working\x07")
	assert.deepEqual(seen.data, [`${ESC}]7501;?:states=idle,working\x07`], "a completed reply is delivered whole")
	buffer.process("n")
	assert.deepEqual(seen.data.slice(1), ["n"])

	// Expected reply that never terminates: payload is discarded, not typed.
	const expected = new StdinBuffer({
		timeout: 30,
		escapeTimeout: 15,
		expectedReplyTimeout: 60,
		replyTimeout: 100,
		expectedReplyPrefixes: () => [`${ESC}]7501;?${ESC}\\`],
	}) as InstanceType<typeof StdinBuffer>
	const expectedData: string[] = []
	expected.on("data", (value) => expectedData.push(value))
	expected.process(`${ESC}]750`)
	await delay(140)
	assert.deepEqual(expectedData, [], "an unanswered expected reply never becomes Alt+] text")
	// The payload stays quarantined (fail closed) for the finite cleanup deadline.
	expected.process("k")
	await delay(120)
	assert.deepEqual(expectedData, [], "input inside the expected-reply quarantine is discarded")
	expected.process("u")
	assert.deepEqual(expectedData, ["u"], "ordinary keys resume after the cleanup deadline")
	expected.destroy()
	buffer.destroy()
})

test("a paste during reply recovery stays paste content", async () => {
	const { buffer, seen } = recorder()
	buffer.process(`${ESC}]11;rgb:0000/0000/0000`)
	await delay(160)
	buffer.process(`${ESC}[200~pasted text${ESC}[201~`)
	assert.deepEqual(seen.pastes, ["pasted text"])
	assert.deepEqual(seen.data, [])
	buffer.process("z")
	assert.deepEqual(seen.data, ["z"])
	buffer.destroy()
})

test("ordinary Escape/Alt timing is unchanged and keys after a completed reply still flow", async () => {
	const { buffer, seen } = recorder()
	buffer.process(ESC)
	await delay(40)
	assert.deepEqual(seen.data, [ESC], "a lone Escape keeps its escape deadline")
	buffer.process(`${ESC}a`)
	assert.deepEqual(seen.data, [ESC, `${ESC}a`], "legacy Alt+key still arrives as one sequence")
	buffer.process(`${ESC}]11;rgb:1111/1111/1111\x07`)
	assert.deepEqual(seen.data.at(-1), `${ESC}]11;rgb:1111/1111/1111\x07`)
	buffer.process("m")
	assert.deepEqual(seen.data.at(-1), "m", "keys after a completed reply are unaffected")
	buffer.destroy()
})

// ---------------------------------------------------------------------------------------------
// Attached terminal: keepalive shutdown, silent post-emergency stop, exact focus + orphan prefix
// ---------------------------------------------------------------------------------------------

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
			DSH_HOME: join(HOME_DIR, ".dsh"),
			XDG_CONFIG_HOME: join(HOME_DIR, ".config"),
			PI_PROGRAM_STATUS: "",
			PI_TUI_WRITE_LOG: "",
			PI_TUI_ESC_TIMEOUT: "15",
		},
	})
	if (proc.error) {
		throw new Error(`reply recovery PTY test needs a POSIX 'script': ${proc.error.message}`)
	}
	const output = readFileSync(streamPath, "utf8")
	assert.equal(proc.status, 0, `PTY child exit status (stream tail: ${output.slice(-600)})`)
	return { output, result: JSON.parse(readFileSync(resultPath, "utf8")) }
}

const PTY_PROBE = `
import { writeFileSync } from "node:fs"
import { ProcessTerminal } from "./vendor/pi-tui/src/terminal.ts"

const resultPath = process.argv.at(-1)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const writes = []
const input = []
const focus = []
const terminal = new ProcessTerminal({ write: (data) => writes.push(data) })
terminal.onFocusChange((value) => focus.push(value))
const emit = (data) => process.stdin.emit("data", data)
const reply = "\\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\\x1b\\\\"

terminal.start((data) => input.push(data), () => {})
emit(reply)
await sleep(30)

// Exact focus report while a stale CSI prefix is still held by the negotiation buffer.
emit("\\x1b[")
await sleep(70)
emit("\\x1b[I")
await sleep(200)
const focusList = [...focus]
const focusInput = [...input]

// Keepalive: legacy progress forced on, then the emergency handoff must stop it.
terminal.setProgressFallback(true)
terminal.setProgress(true)
await sleep(20)
const beforeRestore = writes.length
terminal.restoreOnExit("", "")
const afterRestore = writes.length
await sleep(1200)
const keepaliveAfterRestore = writes.length - afterRestore

// A later stop() must detach input/raw mode without emitting anything visible.
const lateInputStart = input.length
terminal.stop()
const afterStop = writes.length
const rawAfterStop = process.stdin.isRaw
emit("late-key")
await sleep(20)
const lateInput = input.length - lateInputStart
const supportedAfterStop = terminal.programStatusSupported
writeFileSync(resultPath, JSON.stringify({
  focusList,
  focusInput,
  beforeRestore,
  afterRestore,
  keepaliveAfterRestore,
  afterStop,
  rawAfterStop,
  lateInput,
  supportedAfterStop,
}))
process.exit(0)
`

test("private PTY: keepalive stops on handoff, post-emergency stop is silent and still detaches", () => {
	const { output, result } = runInPty(PTY_PROBE, "reply-recovery")

	assert.deepEqual(result.focusList, [true], "an exact focus report is delivered")
	const strayEscapes = (result.focusInput as string[]).filter((value) => String(value).startsWith("\x1b"))
	assert.deepEqual(strayEscapes, [], "a stale CSI prefix never reaches the editor after the report")

	// The emergency write bypasses the injected writer and is not followed by keepalive frames.
	assert.equal(result.afterRestore, result.beforeRestore, "the emergency path writes through the real fd only")
	assert.ok(output.includes("\x1b]9;4;0"), "the emergency path clears legacy progress")
	assert.ok(output.includes("\x1b[?2004l"), "the emergency path restores terminal modes")
	assert.equal(result.keepaliveAfterRestore, 0, "no OSC 9;4 keepalive survives the handoff")

	// stop() after the handoff: no visible writes, but input/raw ownership is released.
	assert.equal(result.afterStop, result.afterRestore, "stop after the emergency path writes nothing")
	assert.equal(result.rawAfterStop, false, "stop still restores raw mode")
	assert.equal(result.lateInput, 0, "stop still detaches the stdin handler")
	assert.equal(result.supportedAfterStop, false)
})