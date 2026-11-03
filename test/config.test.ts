import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaults, KeybindingsStore, PromptHistory, SettingsStore } from '../src/config.ts'

test('settings are independent, validated and atomically saved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-config-'))
  try {
    const store = new SettingsStore(dir)
    assert.deepEqual(store.get(), defaults)
    await Promise.all([store.set({ expandTools: true }), store.set({ showThinking: true })])
    assert.deepEqual(new SettingsStore(dir).get(), { ...defaults, expandTools: true, showThinking: true })
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'settings.json'))).mode & 0o777, 0o600)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('invalid settings never get overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-config-'))
  try {
    const file = join(dir, 'settings.json')
    await writeFile(file, '{broken')
    const store = new SettingsStore(dir)
    assert.equal(store.warnings.length, 1)
    await assert.rejects(store.set({ showThinking: true }), /Refusing/)
    assert.equal(await readFile(file, 'utf8'), '{broken')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('settings reload applies a valid file and preserves the last valid value on a broken edit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-config-'))
  try {
    const file = join(dir, 'settings.json')
    const store = new SettingsStore(dir)
    await store.set({ showThinking: true })
    await writeFile(file, JSON.stringify({ showThinking: false, expandTools: true }))
    assert.deepEqual(store.reload(), [])
    assert.deepEqual(store.get(), { ...defaults, showThinking: false, expandTools: true })
    await writeFile(file, '{broken')
    assert.match(store.reload().join('\n'), /Settings not applied/)
    assert.deepEqual(store.get(), { ...defaults, showThinking: false, expandTools: true }, 'the live value survives a bad edit')
    await assert.rejects(store.set({ showThinking: true }), /Refusing/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('history scope, duplicates, bounded recall and invalid-file preservation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-history-'))
  try {
    const a = new PromptHistory('/project-a', dir)
    await a.add('hello 中文')
    await a.add('hello 中文')
    assert.deepEqual(a.entries(), ['hello 中文'])
    assert.deepEqual(new PromptHistory('/project-b', dir).entries(), [])
    assert.deepEqual(new PromptHistory('/project-a', dir).entries(), ['hello 中文'])
    await writeFile(join(dir, 'history.json'), 'not json')
    const bad = new PromptHistory('/project-a', dir)
    await bad.add('draft')
    assert.equal(await readFile(join(dir, 'history.json'), 'utf8'), 'not json')
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('keyboard overrides save atomically, stay minimal and preserve unrelated concurrent changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-keys-'))
  try {
    const file = join(dir, 'keybindings.json')
    await writeFile(file, JSON.stringify({ 'list.next': ['down', 'ctrl+n'] }))
    const store = new KeybindingsStore(dir)
    await Promise.all([
      store.set('editor.move.line-start', ['ctrl+q'], () => {}),
      store.set('app.model.select', ['alt+m'], () => {}),
    ])
    const data = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(data, { 'list.next': ['down', 'ctrl+n'], 'editor.move.line-start': ['ctrl+q'], 'app.model.select': ['alt+m'] })
    await store.set('editor.move.line-start', undefined, () => {})
    const reset = new KeybindingsStore(dir).read()
    assert.equal(Object.hasOwn(reset, 'editor.move.line-start'), false, 'reset removes only the override, not a copy of the defaults')
    assert.deepEqual(reset['list.next'], ['down', 'ctrl+n'])
    assert.deepEqual(reset['app.model.select'], ['alt+m'])
    await store.set('app.model.select', null, () => {})
    await store.flush()
    assert.equal(JSON.parse(await readFile(file, 'utf8'))['app.model.select'], null)
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('keyboard saves refuse invalid files and failed validation without changing stored bindings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-bad-keys-'))
  try {
    const file = join(dir, 'keybindings.json'), store = new KeybindingsStore(dir)
    await writeFile(file, '{broken')
    await assert.rejects(store.set('app.model.select', ['ctrl+q'], () => {}))
    assert.equal(await readFile(file, 'utf8'), '{broken')
    await writeFile(file, JSON.stringify({ 'app.model.select': 'alt+p' }))
    const before = await readFile(file, 'utf8')
    await assert.rejects(store.set('app.model.select', ['ctrl+q'], () => { throw new Error('Shortcut conflict') }), /Shortcut conflict/)
    assert.equal(await readFile(file, 'utf8'), before)
    await store.set('editor.move.line-start', ['ctrl+q'], () => {})
    assert.equal(new KeybindingsStore(dir).read()['app.model.select'], 'alt+p', 'retry reads the latest file instead of caching a failed write')
    await writeFile(file, JSON.stringify({ 'app.model.select': { invalid: true } }))
    await assert.rejects(store.set('editor.move.line-start', undefined, () => {}), /Invalid keybindings value/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
