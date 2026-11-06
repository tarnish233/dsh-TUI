import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactDiagnostic } from './backend/errors.ts'
import { DEFAULT_PROFILE, optionsFromFlags, tuiCommand, type TuiFlags, type TuiOptions } from './plugin/options.ts'

const ALIAS_FLAGS = new Set(['--profile', '--dsh', '--dsh-home'])

/** Strip only alias flags; DSH receives every application argument verbatim. */
export function nativeArguments(args: readonly string[], profile = DEFAULT_PROFILE): string[] {
  const inner: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--') { inner.push(...args.slice(index)); break }
    if (ALIAS_FLAGS.has(arg)) { index += 1; continue }
    if ([...ALIAS_FLAGS].some(flag => arg.startsWith(flag + '='))) continue
    inner.push(arg)
  }
  return ['--profile', profile, ...inner]
}

/** Compatibility alias only. Production startup/composition belongs to the native dsh launcher. */
export async function main(args: string[]): Promise<void> {
  if (args.some(arg => arg === '--models-file' || arg.startsWith('--models-file='))) {
    process.stderr.write('dsh-tui: --models-file was removed. Configure models and credentials through the native DSH profile; Pi models.json/auth.json are never imported.\n')
    process.exitCode = 2
    return
  }
  const command = tuiCommand(true).exitOverride()
  let options: TuiOptions | undefined
  let flags: TuiFlags = {}
  command.action((prompt: string[]) => {
    flags = command.opts<TuiFlags>()
    options = optionsFromFlags(flags, prompt, command)
  })
  try { command.parse(args, { from: 'user' }) }
  catch (error: unknown) {
    const exitCode = error !== null && typeof error === 'object' && 'exitCode' in error && typeof error.exitCode === 'number'
      ? error.exitCode : 2
    process.exitCode = exitCode
    return
  }
  if (options === undefined) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('dsh-tui requires an interactive terminal. Use --help for usage.\n')
    process.exitCode = 2
    return
  }
  if (options.demo) {
    // Fixture-only: the same terminal output boundary, without loading native DSH or a profile.
    const [{ App }, { DemoBackend }, { ProcessTerminal }, { createTerminalOutputLease }, { createNativeDiagnosticProjection }, { configDirectory }] = await Promise.all([
      import('./app.ts'), import('./demo.ts'), import('#pi-tui'), import('./backend/terminal-output.ts'),
      import('./ui/native-diagnostics.ts'), import('./config.ts'),
    ])
    const cwd = resolve(options.cwd ?? process.cwd())
    let app: InstanceType<typeof App> | undefined
    let output: Awaited<ReturnType<typeof createTerminalOutputLease>> | undefined
    const diagnostics = createNativeDiagnosticProjection((message, level) => app?.reportNativeDiagnostic(message, level))
    const closeOutput = async () => {
      diagnostics.dispose()
      output?.restore()
      await output?.close()
    }
    try {
      output = await createTerminalOutputLease({
        directory: resolve(options.configDir ?? configDirectory(), 'logs'),
        onRecord: record => diagnostics.handle(record),
        onFatal: () => { app?.restoreTerminal(); diagnostics.dispose(); output?.restore() },
      })
      output.install()
      app = new App({
        backend: new DemoBackend({ cwd }), cwd, screen: options.screen, configDir: options.configDir,
        terminal: new ProcessTerminal({ write: output.terminalWrite }),
        demo: true, initialPrompt: options.initialPrompt ?? 'tools',
      })
      await app.start()
      process.exitCode = await app.exited
      await closeOutput()
    } catch (error: unknown) {
      app?.restoreTerminal()
      await app?.shutdown(1).catch(() => {})
      await closeOutput().catch(() => {})
      const message = redactDiagnostic(error instanceof Error ? error.message : 'Offline terminal startup failed.').replace(/[\u0000-\u001f\u007f]/g, ' ')
      process.stderr.write(`dsh-tui: ${message}\n`)
      process.exitCode = 1
    }
    return
  }
  const argv = nativeArguments(args, flags.profile ?? DEFAULT_PROFILE)
  // Native composition, not a profile copy: assert activation even if both app rows were disabled.
  argv.splice(2, 0, '--patch', fileURLToPath(new URL('../assets/launcher.patch.yml', import.meta.url)))
  const executable = flags.dsh ?? 'dsh'
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (flags.dshHome !== undefined) env.DSH_HOME = resolve(flags.dshHome)
  const startup = new AbortController()
  let interruptedCode: number | undefined
  const interrupt = () => { interruptedCode = 130; startup.abort() }
  const terminate = () => { interruptedCode = 0; startup.abort() }
  // Keep handlers registered until native package cancellation and cleanup have settled.
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    if (options.cwd !== undefined) process.chdir(options.cwd)
    const { ensureNativeAttachment } = await import('./plugin/attachment.ts')
    await ensureNativeAttachment({
      executable, profile: flags.profile ?? DEFAULT_PROFILE, cwd: process.cwd(), env, signal: startup.signal,
      report: message => process.stderr.write(message + '\n'),
    })
  } catch (error: unknown) {
    if (interruptedCode !== undefined) process.exitCode = interruptedCode
    else {
      const message = redactDiagnostic(error instanceof Error ? error.message : 'Native DSH application attachment failed.').replace(/[\u0000-\u001f\u007f]/g, ' ')
      process.stderr.write(`dsh-tui: ${message}\n`)
      process.exitCode = 1
    }
    return
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
  if (interruptedCode !== undefined) { process.exitCode = interruptedCode; return }
  // POSIX replaces this alias with dsh: TUI and DSH live in one process, no IPC/supervisor.
  if (process.platform !== 'win32' && typeof process.execve === 'function') {
    const strings = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    process.execve('/usr/bin/env', ['env', executable, ...argv], strings)
    return
  }
  // Platforms without execve delegate the whole application; no TUI state remains in this shell.
  const result = spawnSync(executable, argv, { env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) {
    process.stderr.write('Could not launch native DSH. Install DSH and mount dsh-tui in the selected profile.\n')
    process.exitCode = 1
  } else process.exitCode = result.status ?? (result.signal === 'SIGINT' ? 130 : 1)
}
