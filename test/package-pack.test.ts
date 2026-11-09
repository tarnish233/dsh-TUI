import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }

/** Copy only source inputs; never let an old local build satisfy the pack. */
function sourceOnlyCopy(destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const name of [
    'package.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'cordis.patch.yml',
    'THIRD_PARTY_LICENSES.md',
    'README.md',
    'LICENSE',
  ]) copyFileSync(join(ROOT, name), join(destination, name))
  for (const name of ['src', 'bin', 'assets', 'vendor/pi-tui']) {
    cpSync(join(ROOT, name), join(destination, name), {
      recursive: true,
      filter: source => !['dist', 'node_modules', '.cache', '__pycache__'].includes(basename(source)),
    })
  }
  // Dependencies are test inputs, not package contents. Linking the existing
  // installation keeps this check offline and avoids reading any user npmrc.
  symlinkSync(join(ROOT, 'node_modules'), join(destination, 'node_modules'), 'dir')
}

test('pnpm pack builds a source-only checkout and ships runnable native entries', { timeout: 120_000 }, t => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-tui-pack-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const source = join(temporary, 'source')
  const output = join(temporary, 'tarballs')
  const home = join(temporary, 'home')
  mkdirSync(output, { recursive: true })
  mkdirSync(home, { recursive: true })
  sourceOnlyCopy(source)
  assert.equal(existsSync(join(source, 'lib')), false, 'the source copy starts without the app build')
  assert.equal(existsSync(join(source, 'vendor/pi-tui/dist')), false, 'the source copy starts without the vendored build')

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    DSH_HOME: join(home, 'dsh'),
    TMPDIR: tmpdir(),
    CI: '1',
    NO_COLOR: '1',
    NPM_CONFIG_USERCONFIG: devNull,
    npm_config_userconfig: devNull,
    DSH_TELEMETRY_DISABLED: '1',
  }
  execFileSync('pnpm', ['pack', '--pack-destination', output], {
    cwd: source,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const archives = readdirSync(output).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1, 'pack writes exactly one tarball')
  const archive = join(output, archives[0]!)
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n')
  for (const required of [
    'package/lib/cli.js',
    'package/lib/plugin/index.js',
    'package/lib/plugin/index.d.ts',
    'package/vendor/pi-tui/dist/index.js',
    'package/vendor/pi-tui/dist/index.d.ts',
    'package/bin/dsh-tui.mjs',
    'package/cordis.patch.yml',
  ]) assert.ok(entries.includes(required), `the tarball contains ${required}`)

  const unpacked = join(temporary, 'unpacked')
  mkdirSync(unpacked)
  execFileSync('tar', ['-xzf', archive, '-C', unpacked])
  const packageRoot = join(unpacked, 'package')
  symlinkSync(join(ROOT, 'node_modules'), join(packageRoot, 'node_modules'), 'dir')
  const version = execFileSync(process.execPath, ['bin/dsh-tui.mjs', '--version'], {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
  }).trim()
  assert.equal(version, MANIFEST.version, 'the packed public CLI executes against its own compiled entries')
})
