import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaults, SETTINGS_FORMAT_VERSION, SettingsStore, type Settings } from '../src/config.ts'

async function fixture(run: (store: SettingsStore, file: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-modal-settings-'))
  try { await run(new SettingsStore(directory), join(directory, 'settings.json'), directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test('modal display defaults preserve existing agent/image/terminal behavior and remain local only', () => {
  assert.equal(defaults.showSubagentProgress, true)
  assert.equal(defaults.groupSubagentMessages, true)
  assert.equal(defaults.imagePreview, 'auto')
  assert.equal(defaults.copyOnSelect, true)
  assert.equal(defaults.queueCollapsed, false)
  assert.equal(defaults.reducedMotion, false)
  for (const forbidden of ['model', 'provider', 'permission', 'plan', 'skillDirs', 'vision', 'maxAgents']) {
    assert.equal(Object.hasOwn(defaults, forbidden), false)
  }
})

test('fresh sparse settings keep Tools and Agents grouping independent', async () => {
  await fixture(async (store, file, directory) => {
    await store.set({ groupTools: false })
    assert.equal(store.get().groupTools, false)
    assert.equal(store.get().groupSubagentMessages, true)
    assert.deepEqual(store.getOverrides(), { groupTools: false })
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { groupTools: false, formatVersion: SETTINGS_FORMAT_VERSION })
    assert.equal(new SettingsStore(directory).get().groupSubagentMessages, true)
  })
})

test('legacy coupled grouping is snapshotted once, without any write on read', async () => {
  await fixture(async (store, file, directory) => {
    const original = JSON.stringify({ groupTools: false, screen: 'inline', harmlessFuture: { note: 'retain' } })
    await writeFile(file, original)
    assert.deepEqual(store.reload(), ['Unknown setting: harmlessFuture'])
    assert.equal(store.get().groupSubagentMessages, false)
    assert.equal(await readFile(file, 'utf8'), original)
    await store.set({ imagePreview: 'text' })
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(saved, { groupTools: false, screen: 'inline', harmlessFuture: { note: 'retain' }, groupSubagentMessages: false, imagePreview: 'text', formatVersion: SETTINGS_FORMAT_VERSION })
    await store.set({ groupTools: true })
    assert.equal(store.get().groupSubagentMessages, false, 'there is no permanent Tools fallback after migration')
    assert.equal(new SettingsStore(directory).get().groupSubagentMessages, false)
    await store.set({ groupTools: false })
    await store.reset('groupSubagentMessages')
    const reset = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(Object.hasOwn(reset, 'groupSubagentMessages'), false)
    assert.equal(reset.groupTools, false)
    assert.equal(store.get().groupSubagentMessages, true, 'unset restores the Agents default even while Tools is off')
    assert.equal(new SettingsStore(directory).get().groupSubagentMessages, true)
    assert.deepEqual(reset.harmlessFuture, { note: 'retain' })
  })
})

test('resetting a legacy Agents preference first migrates, then deletes that one override', async () => {
  await fixture(async (store, file, directory) => {
    await writeFile(file, JSON.stringify({ groupTools: false, showThinking: true }))
    store.reload()
    await store.reset('groupSubagentMessages')
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { groupTools: false, showThinking: true, formatVersion: SETTINGS_FORMAT_VERSION })
    assert.equal(new SettingsStore(directory).get().groupSubagentMessages, true)
    assert.equal(store.get().showThinking, true)
  })
})

test('settings edits and resets serialize while preserving unrelated overrides and unknown fields', async () => {
  await fixture(async (store, file, directory) => {
    await writeFile(file, JSON.stringify({ formatVersion: SETTINGS_FORMAT_VERSION, showThinking: true, unknown: ['keep', 4] }))
    store.reload()
    await Promise.all([
      store.set({ showSubagentProgress: false }),
      store.set({ copyOnSelect: false, queueCollapsed: true }),
      store.reset('showThinking'),
      store.set({ reducedMotion: true }),
    ])
    await store.flush()
    assert.deepEqual(new SettingsStore(directory).get(), { ...defaults, showSubagentProgress: false, copyOnSelect: false, queueCollapsed: true, reducedMotion: true })
    const data = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(data.unknown, ['keep', 4])
    assert.equal(Object.hasOwn(data, 'showThinking'), false)
    assert.deepEqual(store.getOverrides(), { showSubagentProgress: false, copyOnSelect: false, queueCollapsed: true, reducedMotion: true })
  })
})

test('each new preference resets to its own default and deletes only its key', async () => {
  await fixture(async (store, file) => {
    const values: Partial<Settings> = { showSubagentProgress: false, groupSubagentMessages: false, imagePreview: 'text', copyOnSelect: false, queueCollapsed: true, reducedMotion: true }
    await store.set({ ...values, screen: 'inline' })
    for (const key of Object.keys(values) as (keyof Settings)[]) {
      await store.reset(key)
      assert.equal(store.get()[key], defaults[key])
      const data = JSON.parse(await readFile(file, 'utf8'))
      assert.equal(Object.hasOwn(data, key), false)
      assert.equal(data.screen, 'inline')
    }
  })
})

for (const [key, value] of [
  ['showSubagentProgress', 'false'], ['groupSubagentMessages', 0], ['copyOnSelect', null],
  ['queueCollapsed', 'on'], ['reducedMotion', 1], ['imagePreview', 'vision-off'],
] as const) {
  test(`invalid display preference ${key} is rejected without a disk or optimistic change`, async () => {
    await fixture(async (store, file) => {
      await store.set({ screen: 'inline' })
      const before = await readFile(file, 'utf8')
      await assert.rejects(store.set({ [key]: value } as Partial<Settings>), new RegExp(key))
      assert.equal(await readFile(file, 'utf8'), before)
      assert.deepEqual(store.get(), { ...defaults, screen: 'inline' })
      await store.set({ reducedMotion: true })
      assert.equal(store.get().reducedMotion, true, 'a rejected save does not poison the next write')
    })
  })
}

test('malformed or unknown-version files refuse reset, preserving last valid memory and disk', async () => {
  await fixture(async (store, file) => {
    await store.set({ copyOnSelect: false })
    for (const broken of ['{broken', JSON.stringify({ formatVersion: 99, copyOnSelect: true })]) {
      await writeFile(file, broken)
      assert.match(store.reload().join('\n'), /Settings not applied/)
      assert.equal(store.get().copyOnSelect, false)
      await assert.rejects(store.reset('copyOnSelect'), /Refusing/)
      assert.equal(await readFile(file, 'utf8'), broken)
    }
  })
})
