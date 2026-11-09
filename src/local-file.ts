/** Explicit frontend file input. Native DSH owns admission and durable storage. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EncodedFileInput } from './backend/types.ts'

/** Frontend transfer-memory budget, not a native file/model permission rule. */
export const LOCAL_FILE_TRANSFER_BYTES = 32 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

export function localFilePath(argument: string, cwd: string): string {
  let path = argument.trim()
  if (path === '') throw new Error('Choose a local file path to attach.')
  const quote = path[0]
  if (quote === '"' || quote === "'") {
    if (path.length < 2 || path.at(-1) !== quote) throw new Error('The local file path has an unmatched quote.')
    path = path.slice(1, -1)
  } else path = path.replace(/\\ /g, ' ')
  if (path === '' || path.includes('\0')) throw new Error('The local file path is empty or invalid.')
  if (path.startsWith('file:')) {
    const url = new URL(path)
    if (url.hostname !== '' && url.hostname !== 'localhost') throw new Error('Only local file URLs can be attached.')
    path = fileURLToPath(url)
  }
  if (path === '~') path = homedir()
  else if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2))
  return resolve(cwd, path)
}

/**
 * Read only the explicitly named regular local file, with a bounded allocation.
 * Nonblocking open avoids hanging on devices/FIFOs; handle.stat fences a path
 * replacement. No shell, glob expansion, provider I/O or durable TUI byte cache.
 */
export async function readLocalFileInput(argument: string, cwd: string, signal?: AbortSignal): Promise<EncodedFileInput> {
  if (signal?.aborted) throw new Error('File attachment was cancelled.')
  const path = localFilePath(argument, cwd)
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Attach a regular local file, not a directory, device or pipe.')
    if (stat.size > LOCAL_FILE_TRANSFER_BYTES) throw new Error('This local input exceeds the 32 MiB frontend transfer budget; no file was uploaded.')
    const chunks: Buffer[] = []
    let bytes = 0
    while (true) {
      if (signal?.aborted) throw new Error('File attachment was cancelled.')
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
      const result = await handle.read(chunk, 0, CHUNK_BYTES, null)
      if (result.bytesRead === 0) break
      bytes += result.bytesRead
      if (bytes > LOCAL_FILE_TRANSFER_BYTES) throw new Error('The local file grew beyond the 32 MiB frontend transfer budget; no file was uploaded.')
      chunks.push(chunk.subarray(0, result.bytesRead))
    }
    if (signal?.aborted) throw new Error('File attachment was cancelled.')
    return { name: basename(path), data: Buffer.concat(chunks, bytes).toString('base64') }
  } finally {
    await handle.close()
  }
}
