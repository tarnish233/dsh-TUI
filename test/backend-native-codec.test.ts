import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadNativeHelpers } from '../src/backend/native-codec.ts'
import { resolveDshInstall } from '../src/backend/discover.ts'
import type { JsonRecord } from '../src/backend/types.ts'

let anchor: string | undefined
try { anchor = resolveDshInstall().packageJsonPath } catch { /* native-only tests skip */ }

test('missing public DSH codecs fail startup instead of installing a mirror', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'missing-dsh-codec-'))
  const file = join(directory, 'package.json')
  await writeFile(file, JSON.stringify({ name: 'isolated-no-dsh', type: 'module' }))
  try {
    await assert.rejects(loadNativeHelpers(file), (error: unknown) => (error as { code?: string }).code === 'STARTUP_FAILED')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('public DSH incremental assembler owns incomplete output and closed-block delta rejection', { skip: !anchor }, async () => {
  const { transcriptCodec } = await loadNativeHelpers(anchor!)
  const live = transcriptCodec.createStream()
  live.push({ type: 'block-start', index: 0, blockType: 'text' })
  live.push({ type: 'text-delta', index: 0, text: 'native prefix 中文 ' })
  assert.equal(live.snapshot().text, 'native prefix 中文 ', 'open blocks are visible before finish')
  live.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'native prefix 中文 ' } })
  live.push({ type: 'text-delta', index: 0, text: 'late invalid delta' })
  assert.equal(live.snapshot().text, 'native prefix 中文 ')
  live.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
  live.push({ type: 'tool-call-delta', index: 1, id: 'call', name: 'read', argumentsDelta: '{"file_path":"x"}' })
  assert.deepEqual(live.snapshot().toolNames, ['read'])
  assert.deepEqual(live.snapshot(true).toolNames, [], 'interruption uses native safe-prefix rules, not executable tool proposals')
})

test('durable packed streams use native validation, assembly and interruption rules', { skip: !anchor }, async () => {
  const { transcriptCodec } = await loadNativeHelpers(anchor!)
  const records: JsonRecord[] = [
    { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'text-chunks', time0: 2, index: 0, dt: [1], texts: ['native ', 'packed'] },
    { type: 'chunk', time: 4, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'native packed' } } },
  ]
  assert.equal(transcriptCodec.assemble(records).text, 'native packed')
  assert.equal(transcriptCodec.assemble(records, true).text, 'native packed')
  assert.throws(() => transcriptCodec.assemble([{ type: 'text-chunks', index: 0, texts: ['invalid-without-timestamps'] }]), TypeError)
})

test('surface classification and home paths come from public native exports', { skip: !anchor }, async () => {
  const native = await loadNativeHelpers(anchor!)
  const event = { type: 'tool/result', seq: 1, time: 1, data: {} }
  assert.equal(native.transcriptCodec.surfaceKind({ ...event, surfaceOp: 'append' }), 'append')
  assert.equal(native.transcriptCodec.surfaceKind({ ...event, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] }), 'replace')
  assert.equal(native.transcriptCodec.surfaceKind({ type: 'tool/call', seq: 2, data: {} }), 'none', 'log-only lifecycle is not discarded as a model replacement')
  assert.ok(native.resolveHome('~/.dsh-native-audit').endsWith('/.dsh-native-audit'))
  assert.ok(!native.resolveHome('~/.dsh-native-audit').includes('/~/'))
})
