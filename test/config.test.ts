import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configDirectory, defaults, KeybindingsStore, PromptHistory, PromptHistoryStore, SETTINGS_FORMAT_VERSION, SettingsStore } from '../src/config.ts'

test('TUI configuration defaults to ~/.dsh-tui independently of XDG_CONFIG_HOME', () => {
  const expected = join(homedir(), '.dsh-tui')
  assert.equal(configDirectory({}), expected)
  assert.equal(configDirectory({ XDG_CONFIG_HOME: join(tmpdir(), 'fixture-xdg') }), expected)
})

test('new and partial settings default to fullscreen without overwriting an explicit screen preference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-screen-default-'))
  try {
    assert.equal(defaults.screen, 'fullscreen')
    assert.equal(new SettingsStore(directory).get().screen, 'fullscreen')
    const path = join(directory, 'settings.json')
    await writeFile(path, JSON.stringify({ showThinking: true }))
    assert.equal(new SettingsStore(directory).get().screen, 'fullscreen')
    await writeFile(path, JSON.stringify({ screen: 'inline', showThinking: true }))
    assert.equal(new SettingsStore(directory).get().screen, 'inline')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('explicit TUI configuration directory environment override stays compatible', () => {
  const directory = join(tmpdir(), 'fixture-config-override')
  assert.equal(configDirectory({ DSH_TUI_CONFIG_DIR: directory }), directory)
  assert.equal(configDirectory({
    DSH_TUI_CONFIG_DIR: directory,
    XDG_CONFIG_HOME: join(tmpdir(), 'fixture-xdg'),
  }), directory)
})

test('default stores use ~/.dsh-tui under a temporary home without migrating legacy files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-default-home-'))
  try {
    const xdg = join(home, '.config')
    const legacy = join(xdg, 'dsh-tui')
    const cwd = join(home, 'workspace')
    await mkdir(legacy, { recursive: true })
    const legacyFiles: Record<string, string> = {
      'settings.json': JSON.stringify({ screen: 'fullscreen', expandTools: true }),
      'keybindings.json': JSON.stringify({ 'app.model.select': ['ctrl+q'] }),
      'history.json': JSON.stringify({ [cwd]: ['legacy recall'] }),
    }
    for (const [name, content] of Object.entries(legacyFiles)) await writeFile(join(legacy, name), content)
    const configUrl = new URL('../src/config.ts', import.meta.url).href
    const source = `
      import assert from 'node:assert/strict';
      import { homedir } from 'node:os';
      import { join } from 'node:path';
      import { configDirectory, defaults, KeybindingsStore, PromptHistory, SettingsStore } from ${JSON.stringify(configUrl)};
      // Assert isolation before constructing any default store or writing files.
      assert.equal(homedir(), ${JSON.stringify(home)});
      assert.equal(configDirectory(), join(homedir(), '.dsh-tui'));
      const settings = new SettingsStore();
      assert.deepEqual(settings.get(), defaults);
      await settings.set({ showThinking: true });
      const bindings = new KeybindingsStore();
      assert.deepEqual(bindings.read(), {});
      await bindings.set('app.model.select', ['alt+m'], () => {});
      const history = new PromptHistory(${JSON.stringify(cwd)});
      assert.deepEqual(history.entries(), []);
      await history.add('temporary recall');
    `
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg }
    delete env.DSH_TUI_CONFIG_DIR
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env, cwd: home, encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    const directory = join(home, '.dsh-tui')
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')), { formatVersion: SETTINGS_FORMAT_VERSION, showThinking: true }, 'only the changed override is stored; runtime defaults stay implicit')
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'keybindings.json'), 'utf8')), { 'app.model.select': ['alt+m'] })
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'history.json'), 'utf8')), { [cwd]: ['temporary recall'] })
    for (const [name, content] of Object.entries(legacyFiles)) assert.equal(await readFile(join(legacy, name), 'utf8'), content)
  } finally { await rm(home, { recursive: true, force: true }) }
})

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
    assert.match(bad.warnings.join('\n'), /History not applied/)
    await assert.rejects(bad.add('draft'))
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

test('settings writes re-read disk at save time and never overwrite an external broken edit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-settings-write-'))
  try {
    const file = join(dir, 'settings.json')
    const store = new SettingsStore(dir)
    await store.set({ showThinking: true })
    assert.equal(store.get().showThinking, true)
    // An external edit breaks the file after the store loaded a usable value.
    await writeFile(file, '{ externally broken')
    await assert.rejects(store.set({ expandTools: true }), /Refusing/)
    assert.equal(await readFile(file, 'utf8'), '{ externally broken', 'the malformed file is preserved')
    assert.deepEqual(store.get(), { ...defaults, showThinking: true }, 'the last usable value stays live and no optimistic update happened')
    // Repairing the file allows the next queued write to succeed.
    await writeFile(file, JSON.stringify({ showThinking: true }))
    await store.set({ expandTools: true })
    assert.deepEqual(new SettingsStore(dir).get(), { ...defaults, showThinking: true, expandTools: true })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('legacy autoTitle is silently ignored on load/reload and removed only by a normal save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-settings-title-'))
  try {
    const file = join(dir, 'settings.json')
    for (const formatVersion of [undefined, 1, SETTINGS_FORMAT_VERSION]) {
      for (const autoTitle of [false, true, null, 'retired-value']) {
        const original = JSON.stringify({ autoTitle, showThinking: true, formatVersion })
        await writeFile(file, original)
        const store = new SettingsStore(dir)
        assert.deepEqual(store.warnings, [], 'a retired preference is not a configuration error')
        assert.deepEqual(store.reload(), [], 'reload does not repeat a migration notice')
        assert.equal(Object.hasOwn(store.get(), 'autoTitle'), false)
        assert.equal(Object.hasOwn(store.getOverrides(), 'autoTitle'), false)
        assert.equal(store.get().showThinking, true)
        assert.equal(await readFile(file, 'utf8'), original, 'reads never rewrite the file')
        await store.set({ showThinking: false })
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { showThinking: false, formatVersion: SETTINGS_FORMAT_VERSION })
        assert.deepEqual(new SettingsStore(dir).warnings, [])
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('ignoring legacy autoTitle does not hide unknown settings or discard them during cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-settings-title-unknown-'))
  try {
    const file = join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ autoTitle: false, unrelated: 'keep', showThinking: true }))
    const store = new SettingsStore(dir)
    assert.deepEqual(store.warnings, ['Unknown setting: unrelated'])
    assert.deepEqual(store.reload(), ['Unknown setting: unrelated'])
    await store.set({ showThinking: false })
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { unrelated: 'keep', showThinking: false, formatVersion: SETTINGS_FORMAT_VERSION })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('ignoring legacy autoTitle still reports invalid active settings and refuses to overwrite them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-settings-title-invalid-'))
  try {
    const file = join(dir, 'settings.json')
    for (const invalid of [{ showThinking: 'invalid' }, { formatVersion: 99 }]) {
      const original = JSON.stringify({ autoTitle: false, ...invalid })
      await writeFile(file, original)
      const store = new SettingsStore(dir)
      assert.equal(store.warnings.length, 1)
      assert.match(store.warnings[0]!, /^Settings not applied:/)
      await assert.rejects(store.set({ expandTools: true }), /Refusing to overwrite invalid settings/)
      assert.equal(await readFile(file, 'utf8'), original)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('shared recall preserves A-B-A, same-cwd chronology, nonconsecutive repeats and other cwd updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-recall-shared-'))
  try {
    const a = new PromptHistory('/project-a', dir)
    const b = new PromptHistory('/project-b', dir)
    await a.add('A one')
    await b.add('B one')
    await a.add('A two')
    assert.deepEqual(a.entries(), ['A one', 'A two'])
    assert.deepEqual(b.entries(), ['B one'])
    assert.deepEqual(new PromptHistory('/project-a', dir).entries(), ['A one', 'A two'])

    const first = new PromptHistory('/project-c', dir)
    const second = new PromptHistory('/project-c', dir)
    await first.add('A')
    await second.add('B')
    await first.add('C')
    await second.add('A')
    assert.deepEqual(new PromptHistory('/project-c', dir).entries(), ['A', 'B', 'C', 'A'], 'same-cwd serialized order and nonconsecutive repeats are kept')
    assert.deepEqual(first.entries(), ['A', 'B', 'C', 'A'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a fresh recall view validates an externally malformed file, keeps usable memory and rejects the save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-recall-bad-'))
  const dir = join(root, 'nested', 'config')
  try {
    const store = new PromptHistory('/project-a', dir)
    await store.add('usable entry')
    const file = join(dir, 'history.json')
    await writeFile(file, 'not json')
    const view = new PromptHistory('/project-a', dir)
    assert.match(view.warnings.join('\n'), /History not applied/)
    assert.deepEqual(view.entries(), ['usable entry'], 'last usable in-memory entries survive validation')
    await assert.rejects(view.add('new prompt'), /JSON/)
    assert.equal(await readFile(file, 'utf8'), 'not json', 'a malformed recall file is never overwritten')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('recall writes into a fresh nested config directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-recall-nested-'))
  try {
    const dir = join(root, 'deep', 'config')
    const history = new PromptHistory('/project-a', dir)
    await history.add('created nested')
    const data = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'))
    assert.deepEqual(data['/project-a'], ['created nested'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
