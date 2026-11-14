import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { nativeArguments, delegateToNativeDsh } from '../src/cli.ts'
import { optionsFromFlags, tuiCommand, DEFAULT_PROFILE, type TuiFlags } from '../src/plugin/options.ts'
import { VERSION } from '../src/version.ts'

const bin = fileURLToPath(new URL('../bin/dsh-tui.mjs', import.meta.url))
const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 10_000 })

function parse(args: string[]) {
  const command = tuiCommand(true).exitOverride().configureOutput({ writeOut() {}, writeErr() {} })
  let value: ReturnType<typeof optionsFromFlags> | undefined
  command.action((prompt: string[]) => { value = optionsFromFlags(command.opts<TuiFlags>(), prompt, command) })
  command.parse(args, { from: 'user' })
  return value!
}

test('compatibility alias help/version requires no DSH profile or terminal', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /native DSH profile/)
  assert.match(help.stdout, /--profile <name>/)
  assert.equal(run(['--version']).stdout.trim(), VERSION)
})

test('package metadata and the shared application version agree', () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest !== null && typeof manifest === 'object' && 'version' in manifest && 'private' in manifest)
  assert.equal(manifest.version, VERSION, 'src/version.ts must move together with package.json')
  assert.equal(manifest.private, true, 'a local version marker does not publish the package')
})

test('default native profile remains dsh-tui by user decision', () => {
  assert.equal(DEFAULT_PROFILE, 'dsh-tui')
  assert.deepEqual(nativeArguments(['--fullscreen']), ['--profile', 'dsh-tui', '--fullscreen'])
})

test('the alias forwards application arguments verbatim and removes only its own flags', () => {
  const args = ['--profile', 'custom', '--dsh=/tmp/native-dsh', '--dsh-home', '/tmp/native-home', '--fullscreen', '--resume', 'session-id', 'prompt text']
  assert.deepEqual(nativeArguments(args, 'custom'), ['--profile', 'custom', '--fullscreen', '--resume', 'session-id', 'prompt text'])
  assert.deepEqual(nativeArguments(['--', '--profile', 'literal prompt']), ['--profile', 'dsh-tui', '--', '--profile', 'literal prompt'])
})

test('screen flags are optional and preserve explicit inline/fullscreen selection', () => {
  assert.equal(parse([]).screen, undefined, 'no synthetic flag overrides a saved preference')
  assert.deepEqual(nativeArguments([]), ['--profile', 'dsh-tui'])
  assert.equal(parse(['--inline']).screen, 'inline')
  assert.equal(parse(['--fullscreen']).screen, 'fullscreen')
  assert.match(run(['--help']).stdout, /Fullscreen is the default/)
})

test('resume stays explicit: bare/empty values open the picker and ids attach exactly', () => {
  assert.equal(parse(['--resume']).resumePicker, true)
  assert.equal(parse(['--resume=']).resumePicker, true)
  assert.equal(parse(['-r', 'exact-session']).resume, 'exact-session')
  assert.equal(parse(['--resume=exact-session']).resume, 'exact-session')
  assert.equal(parse([]).resumePicker, undefined)
})

test('model flags describe a native tuple without introducing catalogs or credentials', () => {
  const value = parse(['--model', 'provider/model/with/slash'])
  assert.equal(value.provider, 'provider')
  assert.equal(value.model, 'model/with/slash')
})

test('normal alias invocation refuses a non-interactive terminal before launching DSH', () => {
  const result = run(['--dsh', '/definitely/missing/dsh'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /interactive terminal/)
})

test('removed Pi model-file flags fail with native configuration guidance', () => {
  const result = run(['--models-file', '/not/read/models.json'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /native DSH profile/)
})

test('continue and a second mode setter are not reintroduced', () => {
  for (const args of [['--continue'], ['-c'], ['--mode', 'plan']]) {
    const result = run(args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unknown option/)
  }
})

test('conflicting terminal modes reject before constructing the UI', () => {
  assert.throws(() => parse(['--inline', '--fullscreen']), /Choose --inline or --fullscreen/)
})

/**
 * Run the delegation step with `execve` refusing to replace the process, and
 * capture only its own stderr lines. Restores the process afterwards.
 */
function withRefusedExecve(executable: string, argv: readonly string[]): { lines: string[]; exitCode: number | undefined } {
  const execve = process.execve
  const write = process.stderr.write
  const previousExitCode = process.exitCode
  const lines: string[] = []
  try {
    process.execve = () => { throw new Error('EPERM: operation not permitted') }
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true }) as typeof write
    process.exitCode = undefined
    delegateToNativeDsh({ executable, argv, env: { PATH: process.env.PATH } })
    return { lines: lines.map(line => line.trimEnd()), exitCode: process.exitCode }
  } finally {
    process.execve = execve
    process.stderr.write = write
    process.exitCode = previousExitCode
  }
}

test('a refused execve delegates to a child with one controlled line and no raw stack', { skip: process.platform === 'win32' }, () => {
  const missing = fileURLToPath(new URL('./missing-native-dsh', import.meta.url))
  const { lines, exitCode } = withRefusedExecve(missing, ['--profile', 'dsh-tui'])
  assert.equal(lines.length, 2, `exactly two diagnostics, got ${JSON.stringify(lines)}`)
  assert.match(lines[0]!, /could not replace this process with native DSH/)
  assert.match(lines[1]!, /Could not launch native DSH/)
  assert.equal(lines.some(line => /EPERM|^\s+at /.test(line)), false, 'the refused native error is never echoed')
  assert.equal(exitCode, 1, 'a failed fallback reports a controlled failure, not a crash')
})

test('a refused execve still delegates the whole application and keeps its exit code', { skip: process.platform === 'win32' }, () => {
  const { lines, exitCode } = withRefusedExecve('true', ['--profile', 'dsh-tui'])
  assert.deepEqual(lines, ['dsh-tui: could not replace this process with native DSH; delegating to a child process instead.'])
  assert.equal(exitCode, 0, 'the child exit code is the alias exit code')
})
