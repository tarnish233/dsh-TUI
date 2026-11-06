import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  defaults, SettingsStore, TOOL_SETTING_KEYS,
  type Settings,
} from '../src/config.ts'
import { toolPreferences } from '../src/ui/tool-view.ts'
import {
  clearToolExpansion, isToolExpanded, requestToolExpansion, retainToolExpansion,
  setToolExpanded, toolExpansionKey, toolGroupExpansionKey,
} from '../src/ui/tool-expansion.ts'

async function fixture(run: (store: SettingsStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tools-config-'))
  try { await run(new SettingsStore(directory), join(directory, 'settings.json')) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test('Tools defaults match the accepted preview and diff roster in one flat settings object', () => {
  assert.deepEqual(toolPreferences({}), {
    groupTools: true, expandTools: false,
    expandedInputMaxLines: 5, expandedOutputMaxLines: 10, toolLabelClip: 0,
    diffViewMode: 'auto', diffIndicatorMode: 'bars', diffSplitMinWidth: 120,
    editDiffCollapsedLines: 24, writeDiffCollapsedLines: 0, diffWordWrap: true,
  })
  assert.equal(TOOL_SETTING_KEYS.length, 11)
  assert.equal(new Set(TOOL_SETTING_KEYS).size, TOOL_SETTING_KEYS.length)
  assert.ok(!Object.hasOwn(defaults, 'mode'))
  assert.ok(!Object.hasOwn(defaults, 'expandedPreviewMaxLines'), 'TaskList cap is not a generic tools preference')
})

test('legacy expandTools files keep their preference and gain only missing Tools defaults', async () => {
  await fixture(async (store, path) => {
    await writeFile(path, JSON.stringify({ expandTools: true, showThinking: true }))
    assert.deepEqual(store.reload(), [])
    assert.deepEqual(store.get(), { ...defaults, expandTools: true, showThinking: true })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { expandTools: true, showThinking: true }, 'a read never migrates or rewrites the file')
  })
})

test('all Tools preferences persist together and concurrent updates preserve unrelated settings', async () => {
  await fixture(async (store, path) => {
    const patch: Partial<Settings> = {
      groupTools: false, expandTools: true,
      expandedInputMaxLines: 20, expandedOutputMaxLines: 80, toolLabelClip: 120,
      diffViewMode: 'split', diffIndicatorMode: 'classic', diffSplitMinWidth: 140,
      editDiffCollapsedLines: 0, writeDiffCollapsedLines: 36, diffWordWrap: false,
    }
    await Promise.all([store.set(patch), store.set({ thinkingPreviewLines: 5 }), store.set({ autoTitle: false })])
    assert.deepEqual(store.get(), { ...defaults, ...patch, thinkingPreviewLines: 5, autoTitle: false })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), store.get())
    assert.deepEqual(store.reload(), [])
  })
})

test('Tools integer boundaries accept zero diff summaries and explicit custom values', async () => {
  await fixture(async (store) => {
    await store.set({ expandedInputMaxLines: 1, expandedOutputMaxLines: 5_000, toolLabelClip: 8, diffSplitMinWidth: 40, editDiffCollapsedLines: 0, writeDiffCollapsedLines: 500 })
    assert.equal(store.get().expandedInputMaxLines, 1)
    assert.equal(store.get().expandedOutputMaxLines, 5_000)
    await store.set({ toolLabelClip: 0, diffSplitMinWidth: 300 })
    assert.equal(store.get().toolLabelClip, 0)
    assert.equal(store.get().diffSplitMinWidth, 300)
  })
})

const invalid: ReadonlyArray<[string, unknown]> = [
  ['groupTools', 'on'], ['expandTools', 1], ['diffWordWrap', null],
  ['expandedInputMaxLines', 0], ['expandedInputMaxLines', 1.5],
  ['expandedOutputMaxLines', 5_001], ['expandedOutputMaxLines', -1],
  ['toolLabelClip', 7], ['toolLabelClip', 501],
  ['diffSplitMinWidth', 39], ['diffSplitMinWidth', 301],
  ['editDiffCollapsedLines', -1], ['writeDiffCollapsedLines', 501],
  ['diffViewMode', 'plan'], ['diffIndicatorMode', 'rainbow'],
]
for (const [key, value] of invalid) {
  test(`invalid ${key}=${JSON.stringify(value)} is rejected before writing and a queued valid update still works`, async () => {
    await fixture(async (store, path) => {
      await store.set({ thinkingPreviewLines: 5 })
      const before = await readFile(path, 'utf8')
      await assert.rejects(store.set({ [key]: value } as Partial<Settings>), new RegExp(key))
      assert.equal(await readFile(path, 'utf8'), before)
      assert.deepEqual(store.get(), { ...defaults, thinkingPreviewLines: 5 })
      await store.set({ groupTools: false })
      assert.equal(store.get().groupTools, false)
    })
  })
}

test('a bad external Tools value preserves live settings and is never overwritten', async () => {
  await fixture(async (store, path) => {
    await store.set({ expandedOutputMaxLines: 80 })
    const broken = JSON.stringify({ groupTools: true, expandedOutputMaxLines: '80' })
    await writeFile(path, broken)
    assert.match(store.reload().join('\n'), /expandedOutputMaxLines/)
    assert.equal(store.get().expandedOutputMaxLines, 80)
    await assert.rejects(store.set({ groupTools: false }), /Refusing/)
    assert.equal(await readFile(path, 'utf8'), broken)
  })
})

test('unknown tool-like setting names are warnings, not aliases or a second configuration hierarchy', async () => {
  await fixture(async (store, path) => {
    await writeFile(path, JSON.stringify({ tools: { grouped: false }, mode: 'compact', groupTools: false }))
    assert.deepEqual(store.reload(), ['Unknown setting: tools', 'Unknown setting: mode'])
    assert.equal(store.get().groupTools, false)
  })
})

test('tool preference resolution preserves explicit off/zero values without mutating the caller', () => {
  const input = { groupTools: false, expandTools: true, toolLabelClip: 0, writeDiffCollapsedLines: 0, diffWordWrap: false }
  const before = { ...input }
  assert.deepEqual(toolPreferences(input), { ...toolPreferences({}), ...input })
  assert.deepEqual(input, before)
})

test('disclosure state is keyed by call/anchor, retained narrowly and globally resettable', () => {
  clearToolExpansion()
  try {
    const call = toolExpansionKey('a'), group = toolGroupExpansionKey('a')
    assert.notEqual(call, group)
    assert.equal(isToolExpanded(call, true), true)
    setToolExpanded(call, false)
    setToolExpanded(group, true)
    assert.equal(isToolExpanded(call, true), false)
    assert.equal(isToolExpanded(group), true)
    retainToolExpansion(new Set([call]))
    assert.equal(isToolExpanded(group), false)
    clearToolExpansion()
    assert.equal(isToolExpanded(call, true), true)
  } finally { clearToolExpansion() }
})

test('standalone disclosure asks for viewport anchoring before the flip and only requests a repaint', () => {
  clearToolExpansion()
  try {
    const key = toolExpansionKey('anchor'), seen: string[] = []
    requestToolExpansion({
      onViewportAnchor: expanding => { seen.push(`${expanding}:${isToolExpanded(key)}`) },
      onRenderRequest: () => { seen.push(`render:${isToolExpanded(key)}`) },
    }, key, true)
    assert.deepEqual(seen, ['true:false', 'render:true'])
  } finally { clearToolExpansion() }
})

test('an owning transcript receives one expansion request and owns the mutation/anchor policy', () => {
  clearToolExpansion()
  try {
    const key = toolGroupExpansionKey('owner'), calls: string[] = []
    requestToolExpansion({
      onToolExpansionRequest: (target, expanded) => { calls.push(`${target}:${expanded}`) },
      onViewportAnchor: () => { assert.fail('owner coordinates the anchor') },
      onRenderRequest: () => { assert.fail('owner coordinates repaint') },
    }, key, true)
    assert.deepEqual(calls, [`${key}:true`])
    assert.equal(isToolExpanded(key), false, 'the bridge must not flip it twice')
  } finally { clearToolExpansion() }
})
