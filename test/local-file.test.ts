import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LOCAL_FILE_TRANSFER_BYTES, localFilePath, readLocalFileInput } from '../src/local-file.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-local-file-'))
  return { directory, async close() { await rm(directory, { recursive: true, force: true }) } }
}

test('explicit local-file paths support quotes, escaped spaces and local file URLs without shell expansion', async () => {
  const f = await fixture()
  try {
    const file = join(f.directory, 'fixture 中文 file.bin')
    assert.equal(localFilePath('"fixture 中文 file.bin"', f.directory), file)
    assert.equal(localFilePath("'fixture 中文 file.bin'", f.directory), file)
    assert.equal(localFilePath('fixture\\ 中文\\ file.bin', f.directory), file)
    assert.equal(localFilePath(pathToFileURL(file).href, f.directory), file)
    assert.throws(() => localFilePath('file://untrusted-host/a', f.directory), /local file/)
    assert.throws(() => localFilePath('"unclosed', f.directory), /unmatched/)
    assert.throws(() => localFilePath('\0', f.directory), /invalid/)
    assert.equal(localFilePath('*.txt', f.directory), join(f.directory, '*.txt'), 'no glob or shell evaluation')
  } finally { await f.close() }
})

test('local input returns exact canonical bytes and basename; empty files are valid', async () => {
  const f = await fixture()
  try {
    const bytes = Uint8Array.from([0, 1, 2, 3, 254, 255])
    await writeFile(join(f.directory, 'bytes.bin'), bytes)
    await writeFile(join(f.directory, 'empty.txt'), '')
    const input = await readLocalFileInput('bytes.bin', f.directory)
    assert.equal(input.name, 'bytes.bin')
    assert.deepEqual(Buffer.from(input.data, 'base64'), Buffer.from(bytes))
    assert.equal(input.data, Buffer.from(input.data, 'base64').toString('base64'))
    assert.deepEqual(await readLocalFileInput('empty.txt', f.directory), { name: 'empty.txt', data: '' })
    assert.equal(Object.hasOwn(input, 'path'), false, 'no local path crosses the backend seam')
  } finally { await f.close() }
})

test('frontend transfer budget and non-file/cancel failure stop before native staging', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.directory, 'directory'))
    await assert.rejects(readLocalFileInput('directory', f.directory), /regular local file/)
    const file = await open(join(f.directory, 'sparse-large.bin'), 'w')
    try { await file.truncate(LOCAL_FILE_TRANSFER_BYTES + 1) } finally { await file.close() }
    await assert.rejects(readLocalFileInput('sparse-large.bin', f.directory), /frontend transfer budget/)
    const signal = new AbortController(); signal.abort()
    await assert.rejects(readLocalFileInput('not-opened.bin', f.directory, signal.signal), /cancelled/)
  } finally { await f.close() }
})
