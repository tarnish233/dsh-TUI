import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { join, resolve } from 'node:path'
import type { App } from '../app.ts'
import type { DshHostContext } from '../backend/context.ts'
import type { TerminalDiagnosticRecord, TerminalOutputLease } from '../backend/terminal-output.ts'
import type { NativeDiagnosticProjection } from '../ui/native-diagnostics.ts'
import { redactDiagnostic } from '../backend/errors.ts'
import { installCompactionReasoningEffort } from './compaction.ts'
import { STARTUP_SERVICE, type TuiOptions } from './options.ts'
import type { TuiStartup } from './startup.ts'

export const name = 'dsh-tui'
export const inject = [STARTUP_SERVICE, 'agents', 'llm', 'sessions', 'sessionPersistence', 'agentPresets']
export const provide = 'dshTui'
export type Config = TuiOptions
export const Config = Schema.object({
  cwd: Schema.string(),
  screen: Schema.union(['inline', 'fullscreen']),
  configDir: Schema.string(),
  resume: Schema.string(),
  resumePicker: Schema.boolean(),
  provider: Schema.string(),
  model: Schema.string(),
  demo: Schema.boolean(),
  initialPrompt: Schema.string(),
})

const OTHER_SURFACES = new Set([
  '@deepseek-harness-tui/dsh-tui',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-acp',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
])

/** A profile chooses one frontend. Never rewrite or suppress another application. */
function assertSingleSurface(ctx: Context): void {
  const loader: unknown = ctx.get('loader')
  if (loader === null || typeof loader !== 'object' || !('entries' in loader) || typeof loader.entries !== 'function') return
  const entries: unknown = loader.entries()
  if (entries === null || typeof entries !== 'object' || !(Symbol.iterator in entries)) return
  for (const entry of entries as Iterable<unknown>) {
    if (entry === null || typeof entry !== 'object' || ('disabled' in entry && entry.disabled === true)) continue
    if (!('options' in entry) || entry.options === null || typeof entry.options !== 'object') continue
    const options = entry.options
    if (!('name' in options) || typeof options.name !== 'string') continue
    if (OTHER_SURFACES.has(options.name)) throw new Error(`DSH profile mounts another application frontend (${options.name}); select exactly one frontend with native DSH configuration.`)
  }
}

/** The native launcher owns the root; this plugin owns only its UI and native adapter resources. */
export function apply(ctx: Context, config: Config): void {
  const startup = ctx.get(STARTUP_SERVICE) as TuiStartup | undefined
  if (startup === undefined || ctx.appReady === undefined || ctx.appExit === undefined) {
    throw new Error('Launch dsh-tui through a native DSH profile with the startup plugin mounted')
  }
  const options: TuiOptions = { ...config, ...startup.options }
  // Owned effect: the plugin effect holds the listener disposer, so no host
  // shape (with or without its own `effect`) can leak an `llm/stream` hook. The
  // label stays distinct from the bridge's own effect label, so a nested second
  // owner (double disposal) is observable.
  ctx.effect(() => installCompactionReasoningEffort(ctx, {
    warn: message => ctx.logger.warn(message),
    effectOwner: 'caller',
  }), 'dsh-tui.compaction-bridge')
  if (startup.options.resumePicker) delete options.resume
  else if (startup.options.resume !== undefined) options.resumePicker = false
  let disposed = false
  let app: App | undefined
  let output: TerminalOutputLease | undefined
  let diagnostics: NativeDiagnosticProjection | undefined
  const earlyDiagnostics: TerminalDiagnosticRecord[] = []
  let closingOutput: Promise<void> | undefined
  let nativeExitRequested = false
  const requestExit = (code: number): void => {
    if (disposed || nativeExitRequested) return
    nativeExitRequested = true
    // Native DSH coalesces requests and owns the whole-tree deadline/code.
    ctx.appExit?.(code)
  }
  const closeOutput = (): Promise<void> => {
    diagnostics?.dispose()
    output?.restore()
    return closingOutput ??= (output?.close() ?? Promise.resolve()).catch(() => {
      // Capture has been restored and no renderer remains here.
      process.stderr.write('dsh-tui: the native diagnostic log could not finish closing.\n')
    })
  }
  ctx.provide('dshTui', { restoreTerminal: () => app?.restoreTerminal() })
  ctx.effect(() => () => {
    disposed = true
    // Renderer restoration is synchronous; capture stays during bounded backend/editor cleanup.
    app?.restoreTerminal()
    diagnostics?.dispose()
    return (async () => {
      try { await app?.shutdown(0) } finally { await closeOutput() }
    })()
  }, 'dsh-tui.terminal')
  const ready = ctx.appReady
  ctx.effect(() => ready.onReady(() => {
    if (disposed) return
    void (async () => {
      assertSingleSurface(ctx)
      const [{ createTerminalOutputLease }, { createNativeDiagnosticProjection }, { configDirectory }] = await Promise.all([
        import('../backend/terminal-output.ts'), import('../ui/native-diagnostics.ts'), import('../config.ts'),
      ])
      if (disposed) return
      diagnostics = createNativeDiagnosticProjection((message, level) => app?.reportNativeDiagnostic(message, level))
      const lease = await createTerminalOutputLease({
        directory: join(options.configDir ?? configDirectory(), 'logs'),
        onRecord: record => {
          if (app) diagnostics?.handle(record)
          else if (record.kind === 'warning' && earlyDiagnostics.length < 16) earlyDiagnostics.push(record)
        },
        onFatal: () => {
          // Native DSH has already decided to fail; restore before its fatal diagnostic is forwarded.
          app?.restoreTerminal()
          diagnostics?.dispose()
          output?.restore()
        },
      })
      if (disposed) { await lease.close(); return }
      output = lease
      lease.install()
      if (!options.demo) {
        const { mountNativePresets } = await import('./presets.ts')
        await mountNativePresets(ctx)
      }
      if (disposed) return
      // One module graph at a time: the native host also loads shared CJS codecs.
      const { App: TerminalApp } = await import('../app.ts')
      const backend = options.demo
        ? new (await import('../demo.ts')).DemoBackend({ cwd: resolve(options.cwd ?? process.cwd()) })
        : (await import('../backend/context.ts')).createDshBackend(ctx as unknown as DshHostContext, {
            cwd: resolve(options.cwd ?? process.cwd()),
            ...(options.resume === undefined ? {} : { resume: options.resume }),
            ...(options.provider === undefined ? {} : { provider: options.provider }),
            ...(options.model === undefined ? {} : { model: options.model }),
            warn: message => ctx.logger.warn(message),
          })
      if (disposed) { await backend.close(); return }
      const cwd = resolve(options.cwd ?? process.cwd())
      const { ProcessTerminal } = await import('#pi-tui')
      if (disposed) { await backend.close(); return }
      app = new TerminalApp({
        backend, cwd, screen: options.screen, configDir: options.configDir,
        terminal: new ProcessTerminal({ write: lease.terminalWrite }),
        demo: options.demo, initialPrompt: options.initialPrompt ?? (options.demo ? 'tools' : undefined),
        resumePicker: options.resumePicker, registerSignals: false, allowSuspend: true,
        // The native launcher owns the shutdown signals, but this process still
        // owns the visible terminal: an escaping error must restore it.
        installCrashHandlers: true,
      })
      const ownedApp = app
      for (const record of earlyDiagnostics.splice(0)) diagnostics.handle(record)
      // Start the launcher's deadline after synchronous terminal handback,
      // not after potentially stalled local persistence/diagnostic cleanup.
      void ownedApp.exitRequested.then(requestExit)
      void ownedApp.exited.then(() => closeOutput())
      await ownedApp.start()
    })().catch(async (error: unknown) => {
      app?.restoreTerminal()
      // Restore capture synchronously for the pre-screen diagnostic; neither
      // log close nor App cleanup may delay the native startup-failure request.
      const outputClosing = closeOutput()
      if (!disposed) {
        requestExit(1)
        const message = redactDiagnostic(error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, ' ')
        ctx.logger.error('dsh-tui startup failed: %s', message)
        // No renderer remains active here. Make pre-screen failures visible,
        // rather than leaving them only in DSH's bounded logger buffer.
        process.stderr.write(`dsh-tui startup failed: ${message}\n`)
        if (error instanceof Error && 'code' in error && error.code === 'ERR_INTERNAL_ASSERTION') {
          process.stderr.write(redactDiagnostic(error.stack ?? message) + '\n')
        }
      }
      await app?.shutdown(1).catch(() => {})
      await outputClosing.catch(() => {})
    })
  }), 'dsh-tui.ready')
}
