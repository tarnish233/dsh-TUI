// Hermetic native diagnostic emitter; no provider/credential/network access.
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-tui-test-native-diagnostics'
export const inject = ['cmdlineArgs']

export async function apply(ctx, config) {
  const profile = ctx.get('profileContext')
  const nativeRequire = createRequire(profile.installAnchor)
  const { createModelListingCache } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-llm-deepseek')).href)
  const settings = { url: 'https://api.deepseek.com/models', timeoutMs: 2000, maxAgeMs: 0 }
  const cache = createModelListingCache(ctx, 'llm-deepseek-account', 'diagnostic-fixture-only', {
    settings: () => settings,
    credential: async () => 'synthetic-diagnostic-fixture-token',
    load: async () => ({ entries: [{ id: 'fixture-model-a' }, { id: 'fixture-model-b' }], skipped: 0 }),
  })
  let serial = 0
  let running = false
  const act = async request => {
    if (request.kind === 'listing') {
      await cache.view(settings)
    } else if (request.kind === 'warning') {
      console.warn('[fixture-native-warning] refresh failed: synthetic diagnostic warning')
    } else if (request.kind === 'stdout') {
      console.log('[fixture-native-stdout] ordinary synthetic chatter')
    } else if (request.kind === 'partial-secret') {
      process.stderr.write('warning: api_')
      process.stderr.write('key="synthetic-private-diagnostic-marker"\n')
    } else if (request.kind === 'fatal') {
      setTimeout(() => { throw new Error('synthetic-native-fatal-diagnostic') }, 0)
    }
    await writeFile(config.ack, JSON.stringify({ serial: request.serial, kind: request.kind }) + '\n')
  }
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (running) return
      running = true
      void (async () => {
        let request
        try { request = JSON.parse(await readFile(config.control, 'utf8')) } catch { return }
        if (!request || !Number.isInteger(request.serial) || request.serial <= serial) return
        serial = request.serial
        await act(request)
      })().finally(() => { running = false })
    }, 25)
    timer.unref()
    return () => clearInterval(timer)
  }, 'hermetic native diagnostic emitter')
}
