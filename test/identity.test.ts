import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const RETIRED = [['dsh', 'pi', 'tui'].join('-'), 'dsh' + 'PiTui', 'Dsh' + 'PiTui', ['DSH', 'PI', 'TUI'].join('_')]
const TEXT = /\.(?:ts|js|mjs|py|md|yml|yaml|json)$/

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', '__pycache__'].includes(entry.name)) return []
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && TEXT.test(entry.name) ? [path] : []
  })
}

test('the application has one package, command, service and source identity', () => {
  const files = [
    ...['src', 'test', 'scripts', 'bin', 'docs', 'assets'].flatMap(directory => sourceFiles(join(ROOT, directory))),
    ...['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md', 'CHANGELOG.md', 'AGENTS.md', 'LICENSE', 'THIRD_PARTY_LICENSES.md', 'cordis.patch.yml', '.gitignore'].map(name => join(ROOT, name)),
  ]
  for (const path of files) {
    const source = readFileSync(path, 'utf8')
    for (const name of RETIRED) assert.ok(!source.includes(name), `${path.slice(ROOT.length)} retains an old application identity`)
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    name?: unknown; private?: unknown; bin?: unknown; exports?: Record<string, unknown>; imports?: Record<string, unknown>;
    publishConfig?: { access?: unknown }
  }
  assert.equal(manifest.name, '@tarnish233/dsh-tui')
  assert.equal(manifest.private, false, 'the npm plugin package must be publicly installable')
  assert.equal(manifest.publishConfig?.access, 'public')
  assert.deepEqual(manifest.bin, { 'dsh-tui': './bin/dsh-tui.mjs' })
  assert.ok(manifest.exports?.['./startup'])
  assert.ok(manifest.exports?.['./launcher-check'])
  assert.equal(manifest.imports?.['#pi-tui'], './vendor/pi-tui/dist/index.js')
  assert.equal(existsSync(join(ROOT, 'bin', RETIRED[0]! + '.mjs')), false)
})

test('native bundle entries and lifecycle services use the same application identity', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const launcher = readFileSync(join(ROOT, 'assets/launcher.patch.yml'), 'utf8')
  const options = readFileSync(join(ROOT, 'src/plugin/options.ts'), 'utf8')
  const plugin = readFileSync(join(ROOT, 'src/plugin/index.ts'), 'utf8')
  const startup = readFileSync(join(ROOT, 'src/plugin/startup.ts'), 'utf8')
  assert.match(patch, /id: file-reference-local\s+name: '@deepseek-ai\/dsh-file-reference-local'/)
  assert.doesNotMatch(patch, /@deepseek-ai\/dsh-client-ui-reference/, 'the terminal mounts the Host provider, never the Web frontend')
  assert.match(patch, /name: '@tarnish233\/dsh-tui\/startup'/)
  assert.match(patch, /name: '@tarnish233\/dsh-tui'/)
  assert.match(launcher, /name: '@tarnish233\/dsh-tui\/launcher-check'/)
  assert.match(options, /STARTUP_SERVICE = 'dshTuiStartup'/)
  assert.match(plugin, /provide = 'dshTui'/)
  assert.match(startup, /ctx\.get\('dshTui'\)/)
})
