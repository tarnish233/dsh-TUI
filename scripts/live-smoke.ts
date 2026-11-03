/** Explicit opt-in. Uses an already configured native DSH home/profile; never copies credentials. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshBackend } from '../src/backend/index.ts'
import type { BackendEvent } from '../src/backend/types.ts'

const live = process.env.DSH_TUI_LIVE ?? process.env.DSH_PI_TUI_LIVE
if (live !== '1') {
  process.stdout.write('Opt in with DSH_TUI_LIVE=1; this sends one tiny prompt using your native DSH configuration.\n')
} else {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-live-workspace-'))
  const profile = process.env.DSH_TUI_LIVE_PROFILE ?? process.env.DSH_PI_TUI_LIVE_PROFILE
  const provider = process.env.DSH_TUI_LIVE_PROVIDER ?? process.env.DSH_PI_TUI_LIVE_PROVIDER
  const model = process.env.DSH_TUI_LIVE_MODEL ?? process.env.DSH_PI_TUI_LIVE_MODEL
  const backend = new DshBackend({ cwd, home: process.env.DSH_HOME, profile, provider, model })
  const events: BackendEvent[] = []
  let text = '', started = false, toolRequested = false
  let settle!: () => void
  const done = new Promise<void>(resolve => { settle = resolve })
  backend.onEvent(event => {
    events.push(event)
    if (event.type === 'status' && event.status === 'running') started = true
    if (event.type === 'stream_chunk' && event.chunk.type === 'text-delta' && typeof event.chunk.text === 'string') text += event.chunk.text
    if (event.type === 'session_event' && event.event.type === 'tool/call') {
      toolRequested = true
      void backend.cancel().catch(() => {})
    }
    if ((event.type === 'status' && event.status === 'idle' && started) || event.type === 'closed' || (event.type === 'error' && event.fatal)) settle()
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const info = await backend.connect()
    events.length = 0
    await backend.send('只回复 dsh-tui-ok，不要调用任何工具。')
    await Promise.race([done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('live smoke timed out')), 90000) })])
    const errors = events.filter(event => event.type === 'error')
    process.stdout.write(JSON.stringify({ provider: info.provider, model: info.model, text, toolRequested, textChunks: events.filter(event => event.type === 'stream_chunk' && event.chunk.type === 'text-delta').length, errors }, null, 2) + '\n')
    if (!text.includes('dsh-tui-ok') || toolRequested || errors.length) process.exitCode = 1
  } catch (error) {
    process.stdout.write(JSON.stringify({ provider, model, error: error instanceof Error ? error.message : String(error) }) + '\n')
    process.exitCode = 1
  } finally {
    if (timer) clearTimeout(timer)
    await backend.close()
    await rm(cwd, { recursive: true, force: true })
  }
}
