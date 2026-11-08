import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaults, SETTINGS_FORMAT_VERSION, SettingsStore, type Settings } from '../src/config.ts'

async function fixture(run: (store: SettingsStore, file: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-terminal-settings-'))
  try { await run(new SettingsStore(directory), join(directory, 'settings.json'), directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test('terminal defaults enable native status/title and conservative automatic notifications, not DSH policies', () => {
  assert.equal(defaults.terminalStatus, true)
  assert.equal(defaults.terminalTitle, true)
  assert.equal(defaults.terminalNotifications, 'auto')
  for (const key of ['autoTitle', 'permission', 'plan', 'model', 'provider', 'terminalProfile', 'auth']) {
    assert.equal(Object.hasOwn(defaults, key), false, key + ' remains DSH-owned')
  }
})

test('terminal settings read/reload remains side-effect free and independent of retired autoTitle', async () => {
  await fixture(async (store, file) => {
    const original = JSON.stringify({ formatVersion: SETTINGS_FORMAT_VERSION, autoTitle: false, terminalTitle: true, terminalStatus: false, terminalNotifications: 'off' })
    await writeFile(file, original)
    assert.deepEqual(store.reload(), [])
    assert.equal(store.get().terminalTitle, true)
    assert.equal(store.get().terminalStatus, false)
    assert.equal(store.get().terminalNotifications, 'off')
    assert.equal(await readFile(file, 'utf8'), original)
    assert.equal(Object.hasOwn(store.getOverrides(), 'autoTitle'), false)
  })
})

test('terminal preferences save sparsely, serialize and reset only their own overrides', async () => {
  await fixture(async (store, file, directory) => {
    await writeFile(file, JSON.stringify({ formatVersion: SETTINGS_FORMAT_VERSION, screen: 'inline', futurePreference: 'keep' }))
    assert.deepEqual(store.reload(), ['Unknown setting: futurePreference'])
    await Promise.all([
      store.set({ terminalTitle: false }),
      store.set({ terminalStatus: false }),
      store.set({ terminalNotifications: 'always' }),
    ])
    assert.deepEqual(new SettingsStore(directory).get(), { ...defaults, screen: 'inline', terminalTitle: false, terminalStatus: false, terminalNotifications: 'always' })
    const values: Partial<Settings> = { terminalTitle: false, terminalStatus: false, terminalNotifications: 'always' }
    for (const key of Object.keys(values) as (keyof Settings)[]) {
      await store.reset(key)
      const saved: unknown = JSON.parse(await readFile(file, 'utf8'))
      assert.ok(saved !== null && typeof saved === 'object' && !Array.isArray(saved))
      assert.equal(Object.hasOwn(saved, key), false)
      assert.equal(store.get()[key], defaults[key])
      assert.equal((saved as Record<string, unknown>).futurePreference, 'keep')
      assert.equal((saved as Record<string, unknown>).screen, 'inline')
    }
    assert.deepEqual(store.getOverrides(), { screen: 'inline' })
  })
})

for (const [key, value] of [
  ['terminalStatus', 'true'], ['terminalStatus', 0], ['terminalTitle', null],
  ['terminalTitle', 'enabled'], ['terminalNotifications', true], ['terminalNotifications', 'unfocused'],
] as const) {
  test(`invalid terminal preference ${key}=${String(value)} refuses a save and preserves valid state`, async () => {
    await fixture(async (store, file) => {
      await store.set({ screen: 'inline', terminalNotifications: 'off' })
      const before = await readFile(file, 'utf8')
      await assert.rejects(store.set({ [key]: value } as Partial<Settings>), new RegExp(key))
      assert.equal(await readFile(file, 'utf8'), before)
      assert.deepEqual(store.get(), { ...defaults, screen: 'inline', terminalNotifications: 'off' })
      await store.set({ terminalStatus: false })
      assert.equal(store.get().terminalStatus, false, 'a rejected write does not poison the next save')
    })
  })
}

test('an external invalid terminal preference never overwrites disk or the last usable renderer settings', async () => {
  await fixture(async (store, file) => {
    await store.set({ terminalTitle: false, terminalNotifications: 'off' })
    const usable = store.get()
    for (const invalid of [{ terminalNotifications: 'future-channel' }, { terminalStatus: 1 }, { terminalTitle: [] }]) {
      const original = JSON.stringify({ formatVersion: SETTINGS_FORMAT_VERSION, ...invalid })
      await writeFile(file, original)
      assert.match(store.reload().join('\n'), /Settings not applied/)
      assert.deepEqual(store.get(), usable)
      await assert.rejects(store.reset('terminalTitle'), /Refusing to overwrite invalid settings/)
      assert.equal(await readFile(file, 'utf8'), original)
    }
  })
})
