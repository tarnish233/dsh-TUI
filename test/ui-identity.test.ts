// Application identity regression for the frontend-owned surface.
//
// The user requires one complete rename: the retired dsh+pi identity
// spellings (package, service, class and env-var composites) become
// dsh-tui / dshTui / DshTui / DSH_TUI. This test guards the files the frontend
// owner owns (src/ui, src/state, src/demo.ts, its docs and its tests) so a
// stale identity cannot creep back in through a doc comment, a service name or
// a copy-pasted module header.
//
// It deliberately does NOT scan parent/other-owner files (src/plugin,
// src/app.ts, src/cli.ts, package manifests, backend): those keep their own
// rename acceptance. It also never forbids upstream attribution — `pi-tui`,
// `@earendil-works/pi-tui`, `pi-cc-extensions`, Claude Code and the private
// `#pi-tui` seam keep their real upstream names.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../src/version.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const TEST = join(ROOT, 'test')

/**
 * Retired composite identity spellings, assembled from parts so this guard does
 * not contain the very literals it forbids. `pi-tui` alone stays a valid
 * upstream name.
 */
const RETIRED = ['dsh' + '-pi-tui', 'dsh' + 'PiTui', 'Dsh' + 'PiTui', 'DSH' + '_PI_TUI'] as const

function files(directory: string, accept: (name: string) => boolean): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) { found.push(...files(full, accept)); continue }
    if (entry.isFile() && accept(entry.name)) found.push(full)
  }
  return found
}

const isSource = (name: string): boolean => /\.(?:ts|js|mjs)$/.test(name)
/** Every frontend-owned source file: all of src/ui, all of src/state, src/demo.ts. */
const frontendSources = (): string[] => [
  ...files(join(SRC, 'ui'), isSource),
  ...files(join(SRC, 'state'), isSource),
  join(SRC, 'demo.ts'),
]

const frontendTests = (): string[] => readdirSync(TEST)
  .filter(name => /^ui.*\.test\.ts$/.test(name))
  .map(name => join(TEST, name))

const frontendDocs = (): string[] => ['THEME.md', 'TOOLS.md', 'IMAGES.md', 'MOUSE.md', 'TOOLS-DIFF-ATTRIBUTION.md', 'NATIVE-DIAGNOSTICS.md']
  .map(name => join(ROOT, 'docs', name))

test('frontend sources, its tests and its docs carry no retired application identity', () => {
  const subject = [...frontendSources(), ...frontendTests(), ...frontendDocs()]
  assert.ok(frontendSources().length >= 30, 'the source walk actually covers src/ui and src/state')
  assert.ok(frontendTests().length > 0)
  for (const file of subject) {
    const source = readFileSync(file, 'utf8')
    for (const retired of RETIRED) {
      assert.ok(!source.includes(retired), `${file.slice(ROOT.length)} still uses the retired identity ${retired}`)
    }
  }
})

test('the visible application identity is dsh-tui and reads the shared release version', () => {
  const welcome = readFileSync(join(SRC, 'ui', 'welcome.ts'), 'utf8')
  assert.match(welcome, /const TAGLINE = 'DSH TUI · v' \+ VERSION/)
  assert.match(welcome, /import \{ VERSION \} from '\.\.\/version\.ts'/)
  assert.equal(VERSION, '0.2.0', 'the shared release identity stays 0.2.0')
})

test('frontend sources reach Pi TUI only through the private #pi-tui seam', () => {
  const seamViolation = /from\s+['"](?:@earendil-works\/pi-tui|pi-tui)['"]|from\s+['"][^'"]*vendor\/pi-tui/
  for (const file of frontendSources()) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, seamViolation, `${file.slice(ROOT.length)} bypasses the #pi-tui seam`)
  }
  const seamUsers = frontendSources().filter(file => readFileSync(file, 'utf8').includes("from '#pi-tui'"))
  assert.ok(seamUsers.length > 0, 'at least one frontend module renders through the vendored Pi TUI seam')
})