/**
 * Explicit opt-in real-provider smoke.
 *
 * Routes come only from native DSH configuration: the selected `--profile`'s
 * `cordis.patch.yml`, the home `cordis.patch.yml` and `$DSH_HOME/.credentials.yaml`.
 * Nothing here reads Pi models.json/auth.json, and no credential is copied or
 * written. Set DSH_TUI_LIVE_PROFILE to the profile whose routes you configured.
 * Sessions/caches persist in the native DSH home exactly as any `dsh` run.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { DshBackend } from '../src/backend/index.ts'
import type { BackendEvent } from '../src/backend/types.ts'
import { VirtualTerminal, delay } from '../test/helpers/terminal.ts'

const defaults = [
  'cloudagent/deepseek-v4.1-flash-1017',
]
const prompt = '不要调用任何工具，不要解释任务。请用纯文本输出20行终端交互建议，每行至少15个汉字，每行以 stream-check- 加两位数字编号开头。不要添加开头结尾，不要使用 Markdown 代码块。'
const redact = (value: string) => value.replace(/\bBearer\s+[^\s]+/gi, 'Bearer <redacted>').replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>').replace(/((?:api[_-]?key|token|secret|password|authorization)\s*["']?\s*[:=]\s*["']?)\S+/gi, '$1<redacted>')

const env = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

if (env('DSH_TUI_LIVE', 'DSH_PI_TUI_LIVE') !== '1') {
  process.stdout.write('Opt in with DSH_TUI_LIVE=1; sends one bounded real prompt per selected provider/API.\n')
} else {
  const routes = env('DSH_TUI_LIVE_MODELS', 'DSH_PI_TUI_LIVE_MODELS')?.split(',').map(route => route.trim()).filter(Boolean) ?? defaults
  const profile = env('DSH_TUI_LIVE_PROFILE', 'DSH_PI_TUI_LIVE_PROFILE')
  const home = env('DSH_TUI_LIVE_DSH_HOME', 'DSH_PI_TUI_LIVE_DSH_HOME')
  for (const route of routes) {
    const separator = route.indexOf('/')
    if (separator < 1 || separator === route.length - 1) throw new Error('Expected provider/model in DSH_TUI_LIVE_MODELS')
    const provider = route.slice(0, separator), model = route.slice(separator + 1)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-live-provider-'))
    const cwd = join(directory, 'workspace')
    await mkdir(cwd)
    // An explicit DSH home only isolates DSH data; it never supplies routes.
    const backend = new DshBackend({ cwd, provider, model, ...(home === undefined ? {} : { home }), ...(profile === undefined ? {} : { profile }) })
    const terminal = new VirtualTerminal(100, 32)
    const app = new App({ backend, cwd, configDir: join(directory, 'tui'), terminal, screen: 'inline', registerSignals: false })
    const textTimes: number[] = []
    const errors: string[] = []
    const paintedLengths = new Set<number>()
    let text = '', origin = 0, started = false, settled = false, toolRequested = false
    let complete!: () => void
    const done = new Promise<void>(resolve => { complete = resolve })
    let timer: NodeJS.Timeout | undefined
    let sampler: NodeJS.Timeout | undefined
    backend.onEvent((event: BackendEvent) => {
      if (!origin) return
      if (event.type === 'status' && event.status === 'running') started = true
      if (event.type === 'stream_chunk' && event.chunk.type === 'text-delta' && typeof event.chunk.text === 'string' && event.chunk.text) {
        text += event.chunk.text
        textTimes.push(Math.round(performance.now() - origin))
      }
      if (event.type === 'error') { errors.push(redact(event.message)); if (event.fatal) complete() }
      if (event.type === 'decision') { void backend.respond(event.request.id, { cancelled: true }).catch(() => {}); void backend.cancel().catch(() => {}) }
      if (event.type === 'stream_chunk' && event.chunk.type === 'tool-call-delta') {
        toolRequested = true; void backend.cancel().catch(() => {})
      }
      if (event.type === 'status' && event.status === 'idle' && started) { settled = true; complete() }
    })
    try {
      await app.start()
      if (!app.session) throw new Error('DSH did not connect')
      origin = performance.now()
      sampler = setInterval(() => {
        const live = app.store.items.find(item => item.kind === 'attempt' && item.status === 'streaming')
        if (settled || !app.isBusy || live?.kind !== 'attempt') return
        const marker = live.text.match(/stream-check-\d{2,}/)?.[0]
        if (marker && terminal.document().includes(marker)) paintedLengths.add(live.text.length)
      }, 16)
      await app.submit(prompt)
      await Promise.race([done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('provider smoke timed out after 90s')), 90000) })])
      await delay(35); await terminal.flush()
      const result = {
        route, profile: profile ?? null, provider: app.session.provider, model: app.session.model,
        totalMs: Math.round(performance.now() - origin),
        firstTextMs: textTimes[0], textSpanMs: textTimes.length ? textTimes.at(-1)! - textTimes[0]! : null,
        textChunks: textTimes.length, characters: text.length,
        partialPaintsBeforeIdle: paintedLengths.size,
        minPaintedCharacters: paintedLengths.size ? Math.min(...paintedLengths) : null,
        maxPaintedCharacters: paintedLengths.size ? Math.max(...paintedLengths) : null,
        outputMatchesPrompt: /stream-check-\d{2,}/.test(text), settled, toolRequested, errors,
      }
      process.stdout.write(JSON.stringify(result) + '\n')
      if (errors.length || toolRequested || !settled || paintedLengths.size < 2 || !result.outputMatchesPrompt) process.exitCode = 1
    } catch (error) {
      process.stdout.write(JSON.stringify({ route, profile, error: redact(error instanceof Error ? error.message : String(error)), errors, textChunks: textTimes.length, partialPaintsBeforeIdle: paintedLengths.size }) + '\n')
      process.exitCode = 1
    } finally {
      if (timer) clearTimeout(timer)
      if (sampler) clearInterval(sampler)
      await app.shutdown(); terminal.dispose(); await backend.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
}
