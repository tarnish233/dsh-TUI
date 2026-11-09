/**
 * Terminal-output lease contract.
 *
 * The proven defect: native provider plugins log through plain
 * `console.error`/`console.warn`, so a periodic successful model listing is
 * written to fd 2 and overwrites the focused editor row. The lease captures the
 * JavaScript writers, classifies/sanitizes/stores every line in a bounded
 * private log, and leaves the renderer its own writer.
 *
 * Every test here is offline and synthetic: temporary directories only,
 * recording replacements for the streams' `write` functions (never the stream
 * objects, so `console.*` keeps its own error handling) and one child process
 * whose real fd 1/fd 2 are inspected. No user profile, credential, session,
 * model call, PTY, clipboard or desktop control is involved.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createTerminalOutputLease,
  TERMINAL_DIAGNOSTIC_LOG,
  type TerminalDiagnosticRecord,
  type TerminalOutputLease,
} from '../src/backend/terminal-output.ts'

const SECRET = 'sk-live-SECRET-abc123'
const TOKEN = 'tok_999'
const LISTING_OK = '[llm-fixture] model listing from https://example.invalid/models loaded 2 model(s), skipped 0 row(s)'
const LISTING_FAILED = '[llm-fixture] model listing from https://example.invalid/models failed (synthetic); using the bundled catalog'
const FATAL = 'dsh: fatal load failure: synthetic fatal diagnostic'
/**
 * The exact Node diagnostic the installed DSH PTC runtime triggers once per
 * process (`stripTypeScriptTypes` in `node:module`, Node v26.13.0). Node writes
 * the warning and its companion hint in ONE stderr write.
 */
const STRIP_TYPES_WARNING =
  '(node:59500) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time'
const TRACE_HINT = '(Use `node --trace-warnings ...` to show where the warning was created)'
const STRIP_TYPES_WRITE = `${STRIP_TYPES_WARNING}\n${TRACE_HINT}\n`
/** A native `installFailLoud` write: one multiline `util.inspect` diagnostic. */
const FATAL_WRITE = `${FATAL}\n  code: "ENOENT",\n  Authorization: Bearer abc.def.ghi\n  at file:///synthetic/entry.js:1:1\n`

/**
 * Record what reaches the terminal without printing it into the test log.
 *
 * Only the stream's `write` function is replaced; the stream object itself stays
 * the real one, so `console.*` keeps its `listenerCount`/`once`/`removeListener`
 * error handling. The lease installs on top of these recorders and restores
 * them on `restore()`.
 */
async function withTerminalSinks<T>(
  body: (sinks: { stdout: string[]; stderr: string[] }) => Promise<T>,
): Promise<T> {
  const sinks = { stdout: [] as string[], stderr: [] as string[] }
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const recorder = (chunks: string[]) =>
    function recorded(this: unknown, chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
      if (typeof done === 'function') queueMicrotask(() => (done as (error?: Error | null) => void)())
      return true
    }
  process.stdout.write = recorder(sinks.stdout) as typeof process.stdout.write
  process.stderr.write = recorder(sinks.stderr) as typeof process.stderr.write
  try {
    return await body(sinks)
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
}

/** Per-test temporary home: the only place a lease may write. */
interface Sandbox {
  root: string
  directory: string
  logPath: string
  records: TerminalDiagnosticRecord[]
  fatals: string[]
  log: () => Promise<string>
  dispose: () => Promise<void>
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-terminal-output-'))
  const directory = join(root, 'private', 'diagnostics')
  const records: TerminalDiagnosticRecord[] = []
  const fatals: string[] = []
  return {
    root,
    directory,
    logPath: join(directory, TERMINAL_DIAGNOSTIC_LOG),
    records,
    fatals,
    log: () => readFile(join(directory, TERMINAL_DIAGNOSTIC_LOG), 'utf8'),
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

/** Create a lease over a sandbox; records/fatals are collected on the sandbox. */
async function leaseFor(box: Sandbox, onFatal?: (text: string) => void): Promise<TerminalOutputLease> {
  return createTerminalOutputLease({
    directory: box.directory,
    onRecord: record => box.records.push(record),
    ...(onFatal === undefined ? {} : { onFatal }),
  })
}

/** Run a body with an installed lease, always restoring and closing. */
async function withInstalled<T>(lease: TerminalOutputLease, body: () => Promise<T>): Promise<T> {
  lease.install()
  try {
    return await body()
  } finally {
    lease.restore()
    await lease.close()
  }
}

/** Records whose text mentions one marker, so unrelated stream noise cannot affect an assertion. */
function recordsAbout(records: TerminalDiagnosticRecord[], marker: string): TerminalDiagnosticRecord[] {
  return records.filter(record => record.text.includes(marker))
}

test('the lease owns one private log in a private directory', async () => {
  const box = await sandbox()
  try {
    const lease = await leaseFor(box)
    assert.equal(lease.logPath, box.logPath)
    assert.equal((await stat(box.directory)).mode & 0o777, 0o700, 'the diagnostic directory is app-private')
    assert.equal((await stat(lease.logPath)).mode & 0o777, 0o600, 'the diagnostic log is owner-only')
    await lease.close()
  } finally {
    await box.dispose()
  }
})

test('a failed log open rejects before any stream is patched', async () => {
  const box = await sandbox()
  try {
    // A regular file where the lease needs a directory: mkdir fails, not install.
    const blocker = join(box.root, 'blocker')
    await writeFile(blocker, 'not a directory')
    const before = process.stderr.write
    await assert.rejects(
      createTerminalOutputLease({ directory: join(blocker, 'diagnostics') }),
      (error: unknown) => error instanceof Error && /cannot open|ENOTDIR|not a directory/i.test(error.message),
    )
    assert.equal(process.stderr.write, before, 'a failed lease never patches the terminal')
  } finally {
    await box.dispose()
  }
})

test('the known periodic successful model listing is routine, stored, and never reaches the terminal', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        console.error(LISTING_OK)
        await lease.flush()
      })
      assert.deepEqual(sinks.stderr, [], 'a routine listing must not be written to the terminal')
      assert.deepEqual(sinks.stdout, [])
    })
    const routine = recordsAbout(box.records, 'model listing')
    assert.equal(routine.length, 1)
    assert.equal(routine[0]?.kind, 'routine')
    assert.equal(routine[0]?.channel, 'stderr')
    assert.equal(routine[0]?.text, LISTING_OK)
    assert.match(await box.log(), /model listing from https:\/\/example\.invalid\/models loaded 2 model\(s\), skipped 0 row\(s\)/)
  } finally {
    await box.dispose()
  }
})

test('the known Node stripTypeScriptTypes experimental warning and its paired hint are routine and log-only', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        // One write, exactly like Node's own `process.emitWarning` path.
        process.stderr.write(STRIP_TYPES_WRITE)
        await lease.flush()
      })
      assert.deepEqual(sinks.stderr, [], 'the known Node noise never reaches the terminal or a notice')
      assert.deepEqual(sinks.stdout, [])
    })
    const warning = recordsAbout(box.records, 'ExperimentalWarning: stripTypeScriptTypes')
    assert.equal(warning.length, 1)
    assert.equal(warning[0]?.kind, 'routine', 'successful native TS stripping is not a native failure')
    assert.equal(warning[0]?.channel, 'stderr')
    assert.equal(warning[0]?.text, STRIP_TYPES_WARNING, 'the stored text keeps the original wording')
    const hint = recordsAbout(box.records, 'trace-warnings')
    assert.equal(hint.length, 1)
    assert.equal(hint[0]?.kind, 'routine', 'the hint paired with this warning is demoted with it')
    const log = await box.log()
    assert.match(log, /info stderr: \(node:59500\) ExperimentalWarning: stripTypeScriptTypes/, 'bytes stay in the bounded log')
    assert.match(log, /info stderr: \(Use `node --trace-warnings \.\.\.`/, 'the paired hint is stored too')
  } finally {
    await box.dispose()
  }
})

test('the known Node warning is recognized across split writes, PIDs and Buffer chunks', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        // Fragmented: the warning line arrives in three writes, then the hint in two.
        process.stderr.write('(node:1) ExperimentalWarning: stripTypeScript')
        process.stderr.write(Buffer.from('Types is an experimental feature and might chang', 'utf8'))
        process.stderr.write('e at any time\n(Use `node --trace-')
        process.stderr.write('warnings ...` to show where the warning was created)\n')
        await lease.flush()
      })
      assert.deepEqual(sinks.stderr, [])
    })
    const warning = recordsAbout(box.records, 'ExperimentalWarning: stripTypeScriptTypes')
    assert.equal(warning.length, 1, 'split writes are one complete line')
    assert.equal(warning[0]?.kind, 'routine')
    assert.equal(warning[0]?.text, '(node:1) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time')
    assert.equal(recordsAbout(box.records, 'trace-warnings')[0]?.kind, 'routine', 'the split hint stays paired')
  } finally {
    await box.dispose()
  }
})

test('an intervening warning closes the pairing window, and a later hint stays visible', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        process.stderr.write(`${STRIP_TYPES_WARNING}\n`)
        process.stderr.write('fixture-provider-refresh failed: upstream 503\n')
        process.stderr.write(`${TRACE_HINT}\n`)
        await lease.flush()
      })
      assert.deepEqual(sinks.stderr, [])
    })
    assert.equal(recordsAbout(box.records, 'ExperimentalWarning: stripTypeScriptTypes')[0]?.kind, 'routine')
    assert.equal(recordsAbout(box.records, 'fixture-provider-refresh')[0]?.kind, 'warning', 'a provider failure stays visible')
    const hint = recordsAbout(box.records, 'trace-warnings')[0]
    assert.equal(hint?.kind, 'warning', 'a hint that does not directly continue the known warning stays visible')
  } finally {
    await box.dispose()
  }
})

test('a standalone hint, another experimental API, or a different wording stay warnings', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        // No known warning before it: this hint belongs to some other warning.
        process.stderr.write(`${TRACE_HINT}\n`)
        process.stderr.write('(node:9) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\n')
        process.stderr.write('(node:9) ExperimentalWarning: stripTypeScriptTypes is an experimental feature\n')
        process.stderr.write('(node:9) ExperimentalWarning: sqlite is an experimental feature and might change at any time\n')
        await lease.flush()
      })
      assert.deepEqual(sinks.stderr, [])
    })
    assert.equal(
      recordsAbout(box.records, 'trace-warnings')[0]?.kind,
      'warning',
      'a standalone companion hint is never blanket-suppressed',
    )
    const experimental = box.records.filter(record => record.text.includes('ExperimentalWarning'))
    assert.equal(experimental.length, 3)
    for (const record of experimental) {
      assert.equal(record.kind, 'warning', `other experimental API wording stays visible: ${record.text}`)
    }
  } finally {
    await box.dispose()
  }
})

test('the real public stripTypeScriptTypes warning is either demoted as known noise or surfaced, never dropped', async () => {
  // Offline: Node's own API, one temporary log, no provider/network/filesystem work.
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        stripTypeScriptTypes('const probe: number = 1')
        // Node writes the warning on a later tick; the capture must span it.
        for (let attempt = 0; attempt < 20 && box.records.length === 0; attempt += 1) {
          await new Promise(resolve => setImmediate(resolve))
        }
        await lease.flush()
      })
      assert.deepEqual(sinks.stderr, [], 'a captured warning never paints over the renderer terminal')
    })
    const noise = box.records.filter(record => record.text.includes('stripTypeScriptTypes'))
    // A future Node may stabilize the API and stop warning: nothing to classify.
    if (noise.length === 0) return
    const exactWording =
      /^\([^\s()]{1,64}:\d{1,10}\) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time$/
    const log = await box.log()
    for (const record of noise) {
      assert.equal(record.channel, 'stderr')
      assert.equal(log.includes(record.text), true, 'the emitted bytes stay in the bounded log')
      assert.equal(
        record.kind,
        exactWording.test(record.text) ? 'routine' : 'warning',
        `classification follows the documented policy for: ${record.text}`,
      )
    }
    const hintKind = noise.every(record => record.kind === 'routine') ? 'routine' : 'warning'
    for (const record of box.records.filter(candidate => candidate.text.includes('trace-warnings'))) {
      assert.equal(record.kind, hintKind, 'the companion hint follows the warning it belongs to')
    }
  } finally {
    await box.dispose()
  }
})

test('the known Node noise never hides a following fatal or a second unpaired hint', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box, text => box.fatals.push(text))
      await withInstalled(lease, async () => {
        process.stderr.write(STRIP_TYPES_WRITE)
        // The window is one line: this second hint has no known warning before it.
        process.stderr.write(`${TRACE_HINT}\n`)
        process.stderr.write(`${FATAL_WRITE}`)
        await lease.flush()
      })
      const forwarded = sinks.stderr.join('')
      assert.match(forwarded, /fatal load failure: synthetic fatal diagnostic/, 'a fatal diagnostic is still forwarded')
      assert.equal(forwarded.includes('stripTypeScriptTypes'), false, 'the routine line is never forwarded')
      assert.equal(forwarded.includes('trace-warnings'), false)
    })
    assert.equal(recordsAbout(box.records, 'trace-warnings').length, 2)
    assert.equal(
      recordsAbout(box.records, 'trace-warnings')[1]?.kind,
      'warning',
      'the pairing window is exactly one line, so no state accumulates',
    )
    const fatal = recordsAbout(box.records, 'fatal load failure')
    assert.equal(fatal[0]?.kind, 'fatal', 'fatal restoration/forwarding is unaffected')
    assert.equal(box.fatals.length, 1, 'the fatal hook still runs exactly once')
  } finally {
    await box.dispose()
  }
})

test('listing failures and unknown text stay warnings; nothing is silently discarded', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        console.error(LISTING_FAILED)
        console.warn('fixture-unknown-warning: catalog refresh skipped')
        process.stdout.write('fixture-stdout-note\n')
        process.stdout.write('fixture-stdout-failure: retry failed for provider\n')
        await lease.flush()
      })
    })
    const failed = recordsAbout(box.records, 'model listing')
    assert.equal(failed.length, 1)
    assert.equal(failed[0]?.kind, 'warning', 'a listing failure is not the routine success line')
    assert.equal(recordsAbout(box.records, 'fixture-unknown-warning')[0]?.kind, 'warning')
    const stdoutNote = recordsAbout(box.records, 'fixture-stdout-note')[0]
    assert.equal(stdoutNote?.channel, 'stdout')
    assert.equal(stdoutNote?.kind, 'routine', 'generic stdout chatter is log-only, never a transcript warning')
    assert.equal(
      recordsAbout(box.records, 'fixture-stdout-failure')[0]?.kind,
      'warning',
      'a stdout line that reports a failure is still surfaced',
    )
    assert.match(await box.log(), /model listing from https:\/\/example\.invalid\/models failed/)
  } finally {
    await box.dispose()
  }
})

test('captured lines are sanitized: ANSI/control text removed, credentials redacted', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        process.stderr.write(`\u001b[31m\u001b[1mfixture-colored\u001b[0m Authorization: Bearer abc.def.ghi api_key=qwerty987 ${SECRET} token=${TOKEN}\n`)
        process.stderr.write('fixture-controls\tbell\u0007done\r\n')
        await lease.flush()
      })
      assert.deepEqual(sinks.stderr, [], 'sanitized diagnostics never reach the terminal')
    })
    const colored = recordsAbout(box.records, 'fixture-colored')[0]
    assert.ok(colored, 'the colored line is recorded')
    assert.equal(colored.kind, 'warning')
    assert.equal(colored.text.includes('\u001b'), false, 'no escape bytes are stored')
    assert.equal(colored.text.includes('qwerty987'), false)
    assert.equal(colored.text.includes('abc.def.ghi'), false)
    assert.equal(colored.text.includes(SECRET), false)
    assert.equal(colored.text.includes(TOKEN), false)
    assert.match(colored.text, /Authorization: \[redacted\]/)
    assert.equal(recordsAbout(box.records, 'fixture-controls')[0]?.text, 'fixture-controls belldone')
    const log = await box.log()
    for (const value of [SECRET, TOKEN, 'abc.def.ghi', 'qwerty987', '\u001b']) {
      assert.equal(log.includes(value), false, `the private log must not contain ${JSON.stringify(value)}`)
    }
  } finally {
    await box.dispose()
  }
})

test('a native fatal diagnostic restores the terminal before it is forwarded to stderr', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const originalWrite = process.stderr.write
      let terminalReleasedInHook = false
      const lease = await leaseFor(box, text => {
        box.fatals.push(text)
        // The hook must see a normal terminal: capture is released before it runs,
        // so terminal-restore sequences can be written directly.
        terminalReleasedInHook = process.stderr.write === originalWrite
        process.stderr.write(`FATAL-HOOK: ${text.length > 0 ? 'released' : 'empty'}\n`)
      })
      await withInstalled(lease, async () => {
        process.stderr.write(`${FATAL}\n`)
        await lease.flush()
      })
      assert.equal(terminalReleasedInHook, true, 'onFatal sees the terminal already released')
      assert.equal(sinks.stderr[0], 'FATAL-HOOK: released\n', 'the release hook owns the terminal first')
      assert.equal(sinks.stderr[1], `${FATAL}\n`, 'the sanitized fatal line stays visible afterwards')
      assert.deepEqual(sinks.stdout, [])
    })
    const fatal = recordsAbout(box.records, 'fatal load failure')[0]
    assert.ok(fatal)
    assert.equal(fatal.kind, 'fatal')
    assert.equal(fatal.channel, 'stderr')
    assert.equal(box.fatals.length, 1)
    assert.match(await box.log(), /fatal stderr: dsh: fatal load failure: synthetic fatal diagnostic/)
  } finally {
    await box.dispose()
  }
})

test('restore is synchronous and idempotent, and never clobbers another writer', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box)
      const originalWrite = process.stderr.write
      lease.install()
      assert.notEqual(process.stderr.write, originalWrite)
      lease.restore()
      lease.restore()
      assert.equal(process.stderr.write, originalWrite, 'the pre-lease writer is restored exactly once')

      const collected: string[] = []
      process.stderr.write('after-restore\n')
      assert.deepEqual(sinks.stderr, ['after-restore\n'], 'post-restore output is not captured')

      // Another component that patches after this lease must survive its restore.
      const foreign = ((chunk: string) => {
        collected.push(chunk)
        return true
      }) as unknown as typeof process.stderr.write
      process.stderr.write = foreign
      lease.install()
      assert.notEqual(process.stderr.write, foreign, 'install wraps the writer that is current')
      lease.restore()
      assert.equal(process.stderr.write, foreign, 'a writer installed on top is not clobbered')
      process.stderr.write = originalWrite
      assert.deepEqual(collected, [])
      await lease.close()
    })
  } finally {
    await box.dispose()
  }
})

test('double install does not stack capture; one restore detaches it', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box)
      const originalWrite = process.stderr.write
      lease.install()
      lease.install()
      process.stderr.write('fixture-single-capture\n')
      await lease.flush()
      assert.equal(recordsAbout(box.records, 'fixture-single-capture').length, 1, 'one write, one record')
      assert.deepEqual(sinks.stderr, [])
      lease.restore()
      assert.equal(process.stderr.write, originalWrite)
      await lease.close()
    })
  } finally {
    await box.dispose()
  }
})

test('install after close is refused instead of silently capturing nothing', async () => {
  const box = await sandbox()
  try {
    const lease = await leaseFor(box)
    lease.install()
    await lease.close()
    assert.throws(() => lease.install(), /closed terminal output lease/)
    await lease.close()
  } finally {
    await box.dispose()
  }
})

test('buffers, encodings, callbacks and invalid chunks keep stream semantics', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      const settled: string[] = []
      await withInstalled(lease, async () => {
        assert.equal(
          process.stderr.write(Buffer.from('fixture-buffer-line\n', 'utf8'), 'utf8', () => settled.push('buffer')),
          true,
          'a captured write is never backpressured',
        )
        assert.equal(process.stderr.write('fixture-callback-line\n', () => settled.push('callback')), true)
        assert.throws(
          () => process.stdout.write(42 as unknown as string),
          (error: unknown) => error instanceof TypeError,
          'an invalid chunk still fails like a real stream',
        )
        await lease.flush()
      })
      assert.deepEqual(settled.sort(), ['buffer', 'callback'], 'every write callback settles exactly once')
    })
    assert.equal(recordsAbout(box.records, 'fixture-buffer-line')[0]?.text, 'fixture-buffer-line')
    assert.equal(recordsAbout(box.records, 'fixture-callback-line')[0]?.text, 'fixture-callback-line')
  } finally {
    await box.dispose()
  }
})

test('a partial line is recorded on restore instead of being dropped', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      lease.install()
      process.stderr.write('fixture-unterminated-tail')
      lease.restore()
      await lease.flush()
      await lease.close()
    })
    const tail = recordsAbout(box.records, 'fixture-unterminated-tail')
    assert.equal(tail.length, 1)
    assert.equal(tail[0]?.text, 'fixture-unterminated-tail')
  } finally {
    await box.dispose()
  }
})

test('an over-long line is dropped whole, never stored as a partial credential line', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        const padding = 'y'.repeat(70 * 1024)
        process.stderr.write(`fixture-overlong ${padding} tail token=${TOKEN}\n`)
        process.stderr.write('fixture-after-overlong\n')
        await lease.flush()
      })
    })
    const marker = recordsAbout(box.records, 'dropped an over-long diagnostic line')
    assert.equal(marker.length, 1)
    assert.equal(marker[0]?.kind, 'warning')
    assert.equal(recordsAbout(box.records, 'fixture-overlong').length, 0, 'no partial prefix of the dropped line is reported')
    assert.equal(recordsAbout(box.records, 'fixture-after-overlong')[0]?.text, 'fixture-after-overlong')
    const log = await box.log()
    assert.equal(log.includes('yyyy'), false, 'no fragment of the dropped line is stored')
    assert.equal(log.includes(TOKEN), false)
  } finally {
    await box.dispose()
  }
})

test('the private log stays bounded with at most one rotated generation', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        const padding = 'z'.repeat(1000)
        for (let round = 0; round < 14; round += 1) {
          for (let line = 0; line < 100; line += 1) {
            process.stderr.write(`fixture-volume ${round}-${line} ${padding}\n`)
          }
          await lease.flush()
        }
      })
    })
    const current = await stat(box.logPath)
    const rotated = await stat(`${box.logPath}.1`)
    assert.ok(current.size <= 1024 * 1024, `current generation bounded, saw ${current.size}`)
    assert.ok(rotated.size <= 1024 * 1024, `rotated generation bounded, saw ${rotated.size}`)
    assert.ok(rotated.size > 0, 'the single rotated generation holds the earlier lines')
  } finally {
    await box.dispose()
  }
})

test('a failing disk sink never raises and reports exactly one truthful warning', async () => {
  const box = await sandbox()
  try {
    const lease = await leaseFor(box)
    // Make every further open/rotation of the log fail: the path becomes a
    // symlink and the rotation target is a symlink too. The lease's already-open
    // descriptor keeps working, so the failure is hit at rotation time.
    const victim = join(box.root, 'victim-log')
    await unlink(box.logPath)
    await symlink(victim, box.logPath)
    await symlink(join(box.root, 'victim-rotation'), `${box.logPath}.1`)
    const padding = 'p'.repeat(1000)
    let threw = false
    try {
      lease.install()
      try {
        for (let round = 0; round < 14; round += 1) {
          for (let line = 0; line < 100; line += 1) {
            process.stderr.write(`fixture-sink-fail ${round}-${line} ${padding}\n`)
          }
          await lease.flush()
        }
        process.stderr.write('fixture-sink-after-failure\n')
        await lease.flush()
      } catch {
        threw = true
      } finally {
        lease.restore()
      }
    } finally {
      await lease.close()
    }
    assert.equal(threw, false, 'a sink failure is contained, not rethrown into the writer')
    assert.ok(recordsAbout(box.records, 'fixture-sink-fail').length > 0, 'diagnostics still reach the application')
    assert.equal(recordsAbout(box.records, 'fixture-sink-after-failure').length, 1, 'capture stays safe after the failure')

    const failures = recordsAbout(box.records, 'diagnostic storage failed')
    assert.equal(failures.length, 1, 'one warning, however many writes fail afterwards')
    assert.equal(failures[0]?.kind, 'warning')
    assert.match(failures[0]?.text ?? '', /further terminal diagnostics may not be persisted/)
    // No false log success: nothing was ever created through the refused targets.
    await assert.rejects(readFile(victim, 'utf8'))
    await assert.rejects(readFile(join(box.root, 'victim-rotation'), 'utf8'))
  } finally {
    await box.dispose()
  }
})

test('a sink that logs synchronously is contained instead of recursing', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      let echoes = 0
      const lease = await createTerminalOutputLease({
        directory: box.directory,
        onRecord: record => {
          box.records.push(record)
          if (echoes < 3) {
            echoes += 1
            console.error('fixture-sink-echo')
          }
        },
      })
      await withInstalled(lease, async () => {
        process.stderr.write('fixture-sink-trigger\n')
        await lease.flush()
      })
      assert.equal(echoes, 1, 'the synchronous echo never re-enters the record sink')
      assert.deepEqual(sinks.stderr, [])
    })
    assert.equal(recordsAbout(box.records, 'fixture-sink-trigger').length, 1)
    assert.equal(recordsAbout(box.records, 'fixture-sink-echo').length, 0)
  } finally {
    await box.dispose()
  }
})

test('a burst larger than the in-memory queue is dropped with a note, not grown without bound', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        const padding = 'q'.repeat(1000)
        for (let line = 0; line < 700; line += 1) {
          process.stderr.write(`fixture-burst ${line} ${padding}\n`)
        }
        await lease.flush()
      })
    })
    const log = await box.log()
    assert.match(log, /diagnostic line\(s\) dropped \(bounded log queue\)/, 'dropped lines are noted')
    assert.ok((await stat(box.logPath)).size <= 1024 * 1024)
  } finally {
    await box.dispose()
  }
})

test('an over-long line is discarded until its newline, so a split credential tail never leaks', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        // The over-long line arrives in three writes: the credential sits in the
        // continuation, after the first write already exceeded the line bound.
        process.stderr.write(`fixture-oversplit ${'y'.repeat(70 * 1024)}`)
        process.stderr.write(` continuation Authorization: Bearer abc.def.ghi ${SECRET}`)
        process.stderr.write(' tail-end\n')
        process.stderr.write('fixture-next-line\n')
        await lease.flush()
      })
    })
    const markers = recordsAbout(box.records, 'dropped an over-long diagnostic line')
    assert.equal(markers.length, 1, 'exactly one marker for one over-long line')
    for (const leaked of ['fixture-oversplit', 'continuation', 'tail-end', 'abc.def.ghi', SECRET]) {
      assert.equal(recordsAbout(box.records, leaked).length, 0, `no fragment of the over-long line is reported: ${leaked}`)
      assert.equal((await box.log()).includes(leaked), false, `no fragment of the over-long line is stored: ${leaked}`)
    }
    assert.equal(recordsAbout(box.records, 'fixture-next-line')[0]?.text, 'fixture-next-line', 'the next line is a normal diagnostic again')
  } finally {
    await box.dispose()
  }
})

test('each over-long line gets exactly one marker, including one still open at restore', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        process.stderr.write(`fixture-oversplit-a ${'y'.repeat(70 * 1024)}\n`)
        process.stderr.write(`fixture-oversplit-b ${'z'.repeat(70 * 1024)}\n`)
        process.stderr.write(`fixture-oversplit-open ${'w'.repeat(70 * 1024)}`)
        await lease.flush()
      })
    })
    assert.equal(recordsAbout(box.records, 'dropped an over-long diagnostic line').length, 3)
    assert.equal(recordsAbout(box.records, 'fixture-oversplit').length, 0)
  } finally {
    await box.dispose()
  }
})

test('a multiline native fatal diagnostic keeps its whole sanitized remainder visible', async () => {
  const box = await sandbox()
  const fatalWrite = [
    `${FATAL}`,
    '  code: "ENOENT",',
    '  syscall: "open",',
    `  Authorization: Bearer abc.def.ghi ${SECRET}`,
    '  at file:///synthetic/entry.js:1:1',
    '',
  ].join('\n')
  try {
    await withTerminalSinks(async sinks => {
      const originalWrite = process.stderr.write
      let releasedInHook = false
      const lease = await leaseFor(box, text => {
        box.fatals.push(text)
        releasedInHook = process.stderr.write === originalWrite
        process.stderr.write('FATAL-HOOK\n')
      })
      await withInstalled(lease, async () => {
        process.stderr.write(fatalWrite)
        process.stderr.write('fixture-after-fatal\n')
        await lease.flush()
      })
      assert.equal(releasedInHook, true)
      assert.equal(sinks.stderr[0], 'FATAL-HOOK\n', 'the hook runs before any forwarded line')
      assert.equal(sinks.stderr[1], `${FATAL}\n`, 'the fatal line follows the hook')
      assert.deepEqual(
        sinks.stderr.slice(2),
        [
          'code: "ENOENT",\n',
          'syscall: "open",\n',
          'Authorization: [redacted] [redacted]\n',
          'at file:///synthetic/entry.js:1:1\n',
          'fixture-after-fatal\n',
        ],
        'the whole diagnostic remainder stays visible on the restored terminal',
      )
    })
    const fatalRecords = box.records.filter(record => record.kind === 'fatal')
    assert.equal(fatalRecords.length, 5, 'the fatal line and its continuation are recorded as fatal')
    assert.equal(fatalRecords[0]?.text, FATAL)
    const joined = fatalRecords.map(record => record.text).join('\n')
    for (const leaked of ['abc.def.ghi', SECRET]) assert.equal(joined.includes(leaked), false)
    const log = await box.log()
    assert.match(log, /syscall: "open"/)
    assert.equal(log.includes(SECRET), false)
  } finally {
    await box.dispose()
  }
})

test('a second lease cannot stack a capture, and its renderer writer still reaches the terminal', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const first = await leaseFor(box)
      const second = await leaseFor(box)
      first.install()
      const firstPatch = process.stderr.write
      assert.throws(() => second.install(), /another terminal output lease is already capturing/)
      assert.equal(process.stderr.write, firstPatch, 'the active capture is untouched by the refused install')
      assert.equal(recordsAbout(box.records, 'FIRST-CAPTURE').length, 0)

      // The refused lease's renderer writer must target the real terminal, not the active capture.
      process.stderr.write('FIRST-CAPTURE\n')
      second.terminalWrite('SECOND-FRAME')
      first.restore()
      assert.deepEqual(sinks.stdout, ['SECOND-FRAME'], 'a refused lease still writes the renderer frame to the terminal')
      assert.equal(recordsAbout(box.records, 'SECOND-FRAME').length, 0, 'renderer bytes never become diagnostics')
      assert.equal(recordsAbout(box.records, 'FIRST-CAPTURE').length, 1)

      second.install()
      process.stderr.write('SECOND-CAPTURE\n')
      second.restore()
      assert.equal(recordsAbout(box.records, 'SECOND-CAPTURE').length, 1, 'the lease installs once the first one released')
      await first.close()
      await second.close()
    })
  } finally {
    await box.dispose()
  }
})

test('renderer terminal errors propagate instead of being swallowed', async () => {
  const box = await sandbox()
  try {
    const originalWrite = process.stdout.write
    process.stdout.write = (() => {
      throw new Error('synthetic dead terminal')
    }) as unknown as typeof process.stdout.write
    try {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        assert.throws(() => lease.terminalWrite('frame'), /synthetic dead terminal/)
      })
    } finally {
      process.stdout.write = originalWrite
    }
  } finally {
    await box.dispose()
  }
})

test('unknown string encodings are rejected like Node and never captured', async () => {
  const box = await sandbox()
  try {
    const lease = await leaseFor(box)
    lease.install()
    try {
      assert.throws(() => process.stderr.write('fixture-bad-encoding\n', 'not-an-encoding' as BufferEncoding), /Unknown encoding/)
      assert.throws(() => process.stderr.write('fixture-alias-encoding\n', 'buffer' as BufferEncoding), /Unknown encoding/)
      assert.throws(() => process.stderr.write(Buffer.from('fixture-buffer-bad\n'), 'nope' as BufferEncoding), /Unknown encoding/)
      // A valid encoding on a Buffer is accepted and never reinterprets the bytes.
      process.stderr.write(Buffer.from('fixture-buffer-latin1 多\n'), 'latin1')
      await lease.flush()
    } finally {
      lease.restore()
      await lease.close()
    }
    for (const leaked of ['fixture-bad-encoding', 'fixture-alias-encoding', 'fixture-buffer-bad']) {
      assert.equal(recordsAbout(box.records, leaked).length, 0, `${leaked} must not be captured`)
    }
    assert.equal(recordsAbout(box.records, 'fixture-buffer-latin1')[0]?.text, 'fixture-buffer-latin1 多')
  } finally {
    await box.dispose()
  }
})

test('renderer bytes use the dedicated writer and are never treated as diagnostics', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async sinks => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        lease.terminalWrite('RENDERER-FRAME')
        process.stderr.write('fixture-native-diagnostic\n')
        await lease.flush()
      })
      assert.deepEqual(sinks.stdout, ['RENDERER-FRAME'], 'the renderer writer still reaches the terminal')
    })
    assert.equal(recordsAbout(box.records, 'RENDERER-FRAME').length, 0, 'renderer bytes never enter diagnostics')
    assert.equal(recordsAbout(box.records, 'fixture-native-diagnostic').length, 1)
  } finally {
    await box.dispose()
  }
})

test('UTF-8 bytes split across Buffer writes are reassembled, not re-decoded per chunk', async () => {
  const box = await sandbox()
  const text = 'fixture-多字节-café-😀-line'
  const bytes = Buffer.from(`${text}\n`, 'utf8')
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      const settled: string[] = []
      await withInstalled(lease, async () => {
        // One byte per write: every multi-byte character is split across writes.
        for (const byte of bytes) {
          process.stderr.write(Buffer.from([byte]), 'latin1', () => settled.push('chunk'))
        }
        await lease.flush()
      })
      assert.equal(settled.length, bytes.length, 'each byte write settles its own callback')
    })
    const record = recordsAbout(box.records, 'fixture-')
    assert.equal(record.length, 1, 'the split sequence is one line, not replacements per chunk')
    assert.equal(record[0]?.text, text, 'a chunk encoding argument never reinterprets Buffer bytes')
  } finally {
    await box.dispose()
  }
})

test('a credential line split across writes is redacted as one complete line', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        process.stderr.write('fixture-split-token Authorization: Bearer abc')
        process.stderr.write('.def.ghi\n')
        process.stderr.write(Buffer.from('fixture-split-key sk-live-SEC', 'utf8'))
        process.stderr.write('RET-abc123\n')
        await lease.flush()
      })
    })
    const token = recordsAbout(box.records, 'fixture-split-token')[0]
    assert.ok(token)
    assert.equal(token.text.includes('abc.def.ghi'), false, 'no fragment of a split credential is stored')
    const key = recordsAbout(box.records, 'fixture-split-key')[0]
    assert.ok(key)
    assert.equal(key.text.includes('RET-abc123'), false)
    const log = await box.log()
    for (const value of ['abc.def.ghi', 'RET-abc123']) {
      assert.equal(log.includes(value), false, `the private log must not contain ${value}`)
    }
  } finally {
    await box.dispose()
  }
})

test('a string chunk after held bytes keeps write order, and an incomplete tail is not lost', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      await withInstalled(lease, async () => {
        process.stderr.write(Buffer.from('fixture-order-', 'utf8'))
        process.stderr.write('a\n')
        // First two bytes of a three-byte character, then restore before the tail arrives.
        process.stderr.write(Buffer.from('fixture-truncated-', 'utf8'))
        process.stderr.write(Buffer.from([0xe5, 0xa4]))
        await lease.flush()
      })
    })
    assert.equal(recordsAbout(box.records, 'fixture-order')[0]?.text, 'fixture-order-a')
    const truncated = recordsAbout(box.records, 'fixture-truncated')
    assert.equal(truncated.length, 1, 'an incomplete byte tail is still recorded, never dropped in silence')
    assert.match(truncated[0]?.text ?? '', /^fixture-truncated-/)
  } finally {
    await box.dispose()
  }
})

test('a symlinked log target is refused instead of followed or repaired', async () => {
  const box = await sandbox()
  try {
    await mkdir(box.directory, { recursive: true, mode: 0o700 })
    const victim = join(box.root, 'unrelated-file')
    await writeFile(victim, 'untouched', 'utf8')
    await symlink(victim, box.logPath)
    await assert.rejects(leaseFor(box), /symlink as the private terminal diagnostic log/)
    assert.equal(await readFile(victim, 'utf8'), 'untouched', 'the symlink target is never appended to')
  } finally {
    await box.dispose()
  }
})

test('a non-regular log target and an insecure existing log are refused, not chmodded', async () => {
  const box = await sandbox()
  try {
    await mkdir(box.logPath, { recursive: true, mode: 0o700 })
    await assert.rejects(leaseFor(box), /non-regular file as the private terminal diagnostic log/)
    await rm(box.logPath, { recursive: true, force: true })

    await writeFile(box.logPath, 'preexisting\n', { mode: 0o644 })
    await chmod(box.logPath, 0o644)
    await assert.rejects(leaseFor(box), /not owner-only/)
    assert.equal((await stat(box.logPath)).mode & 0o777, 0o644, 'an existing mode is never quietly rewritten')
    assert.equal(await readFile(box.logPath, 'utf8'), 'preexisting\n', 'an unrelated file is never appended to')
  } finally {
    await box.dispose()
  }
})

test('a diagnostic directory writable by other users is refused', async () => {
  const box = await sandbox()
  try {
    await mkdir(box.directory, { recursive: true, mode: 0o700 })
    await chmod(box.directory, 0o777)
    await assert.rejects(leaseFor(box), /writable by other users/)
  } finally {
    await box.dispose()
  }
})

test('a symlinked rotation target is never replaced; the log still stays bounded', async () => {
  const box = await sandbox()
  try {
    await withTerminalSinks(async () => {
      const lease = await leaseFor(box)
      const victim = join(box.root, 'rotation-target')
      await writeFile(victim, 'untouched', 'utf8')
      await symlink(victim, `${box.logPath}.1`)
      await withInstalled(lease, async () => {
        const padding = 'w'.repeat(1000)
        for (let round = 0; round < 14; round += 1) {
          for (let line = 0; line < 100; line += 1) {
            process.stderr.write(`fixture-rotation ${round}-${line} ${padding}\n`)
          }
          await lease.flush()
        }
      })
      assert.equal(await readFile(victim, 'utf8'), 'untouched', 'an unrelated rotation target is never written')
      assert.ok((await stat(box.logPath)).size <= 1024 * 1024, 'truncation keeps the current generation bounded')
    })
  } finally {
    await box.dispose()
  }
})

test('real fd 1/fd 2: captured JS writes stay off the terminal, restore re-enables them', async () => {
  const box = await sandbox()
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/backend/terminal-output.ts', import.meta.url))).href
  const script = join(box.root, 'child.mjs')
  const report = join(box.root, 'report.json')
  try {
    await mkdir(join(box.root, 'home'), { recursive: true })
    await writeFile(script, CHILD_SCRIPT, 'utf8')
    const result = await runChild(script, {
      PATH: process.env.PATH ?? '',
      HOME: join(box.root, 'home'),
      DSH_HOME: join(box.root, 'home', 'dsh'),
      LEASE_MODULE: moduleUrl,
      LEASE_DIR: box.directory,
      LEASE_REPORT: report,
    })
    assert.equal(result.code, 0, `child failed: ${result.stderr}`)

    // Nothing captured may reach the terminal; the renderer writer and post-restore
    // writes must.
    assert.match(result.stdout, /RENDERER-FRAME/)
    assert.doesNotMatch(result.stdout, /CAPTURED-STDOUT|CAPTURED-STDERR|model listing/)
    assert.doesNotMatch(result.stdout, new RegExp(SECRET))
    assert.doesNotMatch(result.stderr, /CAPTURED-STDERR|model listing/)
    assert.doesNotMatch(result.stderr, new RegExp(SECRET))
    assert.ok(result.stderr.includes(`${FATAL}\n`), 'the sanitized fatal diagnostic is still visible on fd 2')
    assert.ok(result.stderr.includes('code: "ENOENT",\n'), 'the fatal diagnostic remainder is visible too')
    assert.ok(result.stderr.includes('at file:///synthetic/entry.js:1:1\n'))
    assert.ok(result.stderr.includes('AFTER-FATAL'), 'restore returns the terminal to the process')
    assert.equal(result.stderr.includes('abc.def.ghi'), false, 'no credential fragment is forwarded')
    const order = ['FATAL-HOOK', FATAL, 'code: "ENOENT",', 'Authorization: [redacted]', 'at file:///synthetic/entry.js:1:1', 'AFTER-FATAL']
      .map(marker => result.stderr.indexOf(marker))
    assert.deepEqual([...order].sort((left, right) => left - right), order, 'hook, then the whole diagnostic, then later writes')
    assert.equal(order.every(index => index >= 0), true)

    const summary = JSON.parse(await readFile(report, 'utf8')) as {
      records: TerminalDiagnosticRecord[]
      logPath: string
    }
    assert.equal(summary.logPath, box.logPath)
    const kinds = new Map(summary.records.map(record => [record.text.slice(0, 24), record.kind]))
    assert.equal(kinds.get(LISTING_OK.slice(0, 24)), 'routine')
    assert.equal(kinds.get('CAPTURED-STDERR'), 'warning')
    assert.equal(kinds.get('CAPTURED-STDOUT'), 'routine')
  } finally {
    await box.dispose()
  }
})

/** Child program: exercises the lease against the real process streams. */
const CHILD_SCRIPT = `
import { writeFile } from 'node:fs/promises'

const { createTerminalOutputLease } = await import(process.env.LEASE_MODULE)
const records = []
const lease = await createTerminalOutputLease({
  directory: process.env.LEASE_DIR,
  onRecord: record => records.push(record),
  onFatal: () => {
    process.stderr.write('FATAL-HOOK\\n')
  },
})

lease.install()
lease.terminalWrite('RENDERER-FRAME')
process.stdout.write('CAPTURED-STDOUT\\n')
process.stderr.write('CAPTURED-STDERR\\n')
console.error(${JSON.stringify(LISTING_OK)})
process.stderr.write('Authorization: Bearer abc.def.ghi ${SECRET}\\n')
process.stderr.write(${JSON.stringify(FATAL_WRITE)})
process.stderr.write('AFTER-FATAL\\n')
await lease.flush()
await lease.close()
await writeFile(process.env.LEASE_REPORT, JSON.stringify({ records, logPath: lease.logPath }))
`

/** Spawn a private child and collect its real pipes. */
function runChild(script: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (data: string) => { stdout += data })
    child.stderr.on('data', (data: string) => { stderr += data })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    timer.unref()
  })
}
