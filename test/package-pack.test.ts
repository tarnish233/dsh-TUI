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
import { createRequire } from 'node:module'
import { devNull, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
const NATIVE_PREBUILDS = [
  'package/vendor/pi-tui/native/darwin/prebuilds/darwin-arm64/darwin-platform.node',
  'package/vendor/pi-tui/native/darwin/prebuilds/darwin-x64/darwin-platform.node',
  'package/vendor/pi-tui/native/linux/prebuilds/linux-arm64/linux-platform-x11.node',
  'package/vendor/pi-tui/native/linux/prebuilds/linux-x64/linux-platform-x11.node',
  'package/vendor/pi-tui/native/win32/prebuilds/win32-arm64/win32-platform.node',
  'package/vendor/pi-tui/native/win32/prebuilds/win32-x64/win32-platform.node',
]
const NATIVE_SOURCES = [
  'package/vendor/pi-tui/native/napi.h',
  'package/vendor/pi-tui/native/clipboard.h',
  'package/vendor/pi-tui/native/darwin/build.sh',
  'package/vendor/pi-tui/native/darwin/src/darwin-platform.m',
  'package/vendor/pi-tui/native/linux/build.sh',
  'package/vendor/pi-tui/native/linux/src/linux-platform-x11.c',
  'package/vendor/pi-tui/native/win32/build.mjs',
  'package/vendor/pi-tui/native/win32/src/win32-platform.c',
]

/**
 * The vendored native helper this platform would load, mirroring
 * `vendor/pi-tui/src/native-platform.ts`. Undefined where no prebuild exists.
 */
function currentPrebuild(): string | undefined {
  const { platform, arch } = process
  if (arch !== 'x64' && arch !== 'arm64') return undefined
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') return undefined
  const suffix = platform === 'linux' ? '-x11' : ''
  return `vendor/pi-tui/native/${platform}/prebuilds/${platform}-${arch}/${platform}-platform${suffix}.node`
}

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

test('pnpm and npm pack a source-only checkout and ship runnable native entries', { timeout: 120_000 }, t => {
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
    ...NATIVE_PREBUILDS,
    'package/bin/dsh-tui.mjs',
    'package/cordis.patch.yml',
  ]) assert.ok(entries.includes(required), `the tarball contains ${required}`)
  // Only prebuilt binaries publish: native sources, headers and build scripts
  // stay repository inputs and are never regenerated from an installed tarball.
  for (const excluded of NATIVE_SOURCES) {
    assert.equal(entries.includes(excluded), false, `the tarball excludes native source ${excluded}`)
  }

  // The actual npm publish packer has different files-glob semantics from
  // pnpm. Run it with scripts disabled against the already-built source copy
  // so this regression stays offline while still checking the publish file list.
  const npmOutput = join(temporary, 'npm-tarballs')
  mkdirSync(npmOutput)
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', npmOutput], {
    cwd: source,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const npmArchives = readdirSync(npmOutput).filter(name => name.endsWith('.tgz'))
  assert.equal(npmArchives.length, 1, 'npm pack writes exactly one tarball')
  const npmEntries = execFileSync('tar', ['-tzf', join(npmOutput, npmArchives[0]!)], { encoding: 'utf8' }).split('\n')
  for (const required of NATIVE_PREBUILDS) assert.ok(npmEntries.includes(required), `npm publish includes ${required}`)
  for (const excluded of NATIVE_SOURCES) assert.equal(npmEntries.includes(excluded), false, `npm publish excludes native source ${excluded}`)

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

  // Packaging smoke only: the archive's own binary for this platform must load
  // through a public resolver. No clipboard/display call is made here.
  const prebuild = currentPrebuild()
  if (prebuild !== undefined) {
    const packed = join(packageRoot, prebuild)
    assert.ok(existsSync(packed), `this platform's prebuild is packed: ${prebuild}`)
    const helper = createRequire(join(packageRoot, 'vendor/pi-tui/dist/index.js'))(packed) as Record<string, unknown> | null
    assert.ok(helper !== null && typeof helper === 'object', 'the packed prebuild is a loadable native module')
    assert.equal(typeof helper.getText, 'function', 'the packed prebuild exposes its text clipboard entry')
    assert.equal(typeof helper.getImage, 'function', 'the packed prebuild exposes its image clipboard entry')
  }
})
