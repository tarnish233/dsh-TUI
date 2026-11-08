import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { PromptHistory, SETTINGS_FORMAT_VERSION, SettingsStore } from '../src/config.ts'

const execute = promisify(execFile)
const configUrl = new URL('../src/config.ts', import.meta.url).href

async function writeInProcess(directory: string, cwd: string, entries: string[]) {
  const script = `import { PromptHistory } from ${JSON.stringify(configUrl)};\n` +
    `const history = new PromptHistory(${JSON.stringify(cwd)}, ${JSON.stringify(directory)});\n` +
    `for (const text of ${JSON.stringify(entries)}) await history.add(text);\nawait history.flush();\n`
  await execute(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 })
}

// Parent-owned filesystem acceptance, independent of the feature developer's
// unit tests. All settings and recall files live under throwaway directories.
test('parent config acceptance: external malformed settings survive save with last good state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-settings-'))
  try {
    const settings = new SettingsStore(directory)
    await settings.set({ showThinking: false })
    await writeFile(settings.path, '{external-malformed-settings')
    await assert.rejects(settings.set({ showThinking: true }))
    assert.equal(await readFile(settings.path, 'utf8'), '{external-malformed-settings')
    assert.equal(settings.get().showThinking, false)
    await writeFile(settings.path, JSON.stringify({ screen: 'fullscreen', showThinking: true }))
    await settings.set({ expandTools: true })
    assert.deepEqual(JSON.parse(await readFile(settings.path, 'utf8')), {
      formatVersion: SETTINGS_FORMAT_VERSION, screen: 'fullscreen', expandTools: true, showThinking: true,
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('parent recall acceptance: a fresh nested directory is created and A-B-A cwd views retain both histories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-recall-'))
  try {
    const config = join(directory, 'fresh', 'nested')
    const a = new PromptHistory('/parent/workspace-a', config)
    await a.add('a-first')
    const b = new PromptHistory('/parent/workspace-b', config)
    await b.add('b-first')
    await a.add('a-second')
    const value = JSON.parse(await readFile(a.path, 'utf8')) as Record<string, string[]>
    assert.deepEqual(value['/parent/workspace-a'], ['a-first', 'a-second'])
    assert.deepEqual(value['/parent/workspace-b'], ['b-first'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('parent recall acceptance: a different process writing the same cwd preserves disk chronology and nonconsecutive repeats', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-recall-process-'))
  const cwd = '/parent/shared-cwd'
  try {
    const local = new PromptHistory(cwd, directory)
    await local.add('A')
    await writeInProcess(directory, cwd, ['B'])
    await local.add('C')
    await local.add('A')
    const value = JSON.parse(await readFile(local.path, 'utf8')) as Record<string, string[]>
    assert.deepEqual(value[cwd], ['A', 'B', 'C', 'A'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('parent recall acceptance: two processes serialize same-cwd appends without duplicate or lost entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-recall-concurrent-'))
  const cwd = '/parent/concurrent-cwd'
  try {
    const history = new PromptHistory(cwd, directory)
    await history.add('initial')
    const left = Array.from({ length: 5 }, (_, index) => 'left-' + index)
    const right = Array.from({ length: 5 }, (_, index) => 'right-' + index)
    await Promise.all([writeInProcess(directory, cwd, left), writeInProcess(directory, cwd, right)])
    const value = JSON.parse(await readFile(history.path, 'utf8')) as Record<string, string[]>
    assert.equal(value[cwd]?.length, 11)
    assert.equal(new Set(value[cwd]).size, 11)
    assert.deepEqual(value[cwd]?.filter(text => text.startsWith('left-')), left)
    assert.deepEqual(value[cwd]?.filter(text => text.startsWith('right-')), right)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('parent recall acceptance: malformed external history is visible on a new view and never overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-recall-invalid-'))
  try {
    const history = new PromptHistory('/parent/invalid-cwd', directory)
    await history.add('last-valid')
    await writeFile(history.path, '{external-malformed-history')
    const later = new PromptHistory('/parent/invalid-cwd', directory)
    assert.ok(later.warnings.length > 0, 'a shared cache must not hide a malformed external edit')
    await assert.rejects(later.add('new-not-saved'))
    assert.equal(await readFile(history.path, 'utf8'), '{external-malformed-history')
    assert.ok(later.entries().includes('last-valid'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
