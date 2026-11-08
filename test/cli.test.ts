import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { nativeArguments } from '../src/cli.ts'
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

test('v0.1.4 package metadata and the shared application version agree', () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest !== null && typeof manifest === 'object' && 'version' in manifest && 'private' in manifest)
  assert.equal(VERSION, '0.1.4')
  assert.equal(manifest.version, VERSION)
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
