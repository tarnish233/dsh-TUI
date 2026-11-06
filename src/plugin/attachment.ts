import { constants, existsSync } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APPLICATION = 'dsh-tui'
const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url))
const OTHER_FRONTENDS = new Set([
  '@deepseek-harness-tui/dsh-tui', '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-headless-app',
  '@deepseek-ai/dsh-acp-app', '@deepseek-ai/dsh-sdk-app',
])

export interface AttachmentRunResult {
  exitCode: number
  logPath?: string
  timedOut?: boolean
}

/** Only DSH-owned package metadata and package operations; never user patch contents. */
export interface NativeAttachmentApi {
  profileDirectory(profile: string, home?: string): string
  manifest(directory: string): unknown
  bundleDirectory(name: string, directory: string): string
  run(profile: string, directory: string, args: readonly string[], options: AttachmentOptions): Promise<AttachmentRunResult>
}

export interface AttachmentOptions {
  executable: string
  profile: string
  cwd: string
  env: NodeJS.ProcessEnv
  packageDirectory?: string
  signal?: AbortSignal
  report?(message: string): void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function call(module: unknown, name: string, args: readonly unknown[]): unknown {
  const target = record(module)
  const fn = target?.[name]
  if (typeof fn !== 'function') throw new Error('The selected DSH installation lacks its public plugin-management API.')
  return Reflect.apply(fn, target, args)
}

function textResult(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('DSH returned invalid package metadata.')
  return value
}

/** Resolve the selected OS command, not a second DSH runtime or a profile mirror. */
async function launcherPath(executable: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const candidates = isAbsolute(executable) || executable.includes('/') || executable.includes('\\')
    ? [resolve(cwd, executable)]
    : (env.PATH ?? '').split(delimiter).map(directory => resolve(directory || cwd, executable))
  if (process.platform === 'win32') {
    const extensions = (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    candidates.push(...candidates.flatMap(path => extensions.map(extension => path + extension.toLowerCase())))
  }
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate) }
    catch { /* next PATH entry */ }
  }
  throw new Error('Could not find native DSH. Install DSH and make its launcher available on PATH.')
}

/** Load public APIs from the same installation that the alias will execute. */
export async function nativeAttachmentApi(options: AttachmentOptions): Promise<NativeAttachmentApi> {
  const executable = await launcherPath(options.executable, options.env, options.cwd)
  let installAnchor: string
  let boot: unknown
  let operations: unknown
  let homes: unknown
  try {
    const commandRequire = createRequire(executable)
    installAnchor = commandRequire.resolve('@deepseek-ai/dsh/package.json')
    const nativeRequire = createRequire(installAnchor)
    ;[boot, operations, homes] = await Promise.all([
      import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-app-boot')).href),
      import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href),
      import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-home-paths')).href),
    ])
  } catch {
    throw new Error('Could not load the public plugin-management APIs from the selected DSH launcher. Use the native DSH executable, not a shell wrapper.')
  }
  return {
    profileDirectory: (profile, home) => textResult(call(boot, 'resolveProfileDir', [profile, textResult(call(homes, 'resolveDshHome', [home, options.env]))])),
    manifest: directory => call(boot, 'readProfileManifest', [APPLICATION, directory]),
    bundleDirectory: (name, directory) => textResult(call(boot, 'resolveBundleDir', [APPLICATION, name, installAnchor, directory])),
    async run(profile, directory, args, runOptions) {
      const result: unknown = await call(operations, 'runPluginCommand', [
        { profile, dir: directory, installAnchor, cwd: runOptions.cwd }, args,
        {
          execution: 'service',
          env: Object.fromEntries(Object.entries(runOptions.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          outputBytes: 16_384, lockWaitMs: 30_000, idleTimeoutMs: 30_000, lookupTimeoutMs: 20_000,
          ...(runOptions.signal === undefined ? {} : { signal: runOptions.signal }),
        },
      ])
      const value = record(result)
      if (typeof value?.exitCode !== 'number' || !Number.isInteger(value.exitCode)) throw new Error('DSH returned an invalid plugin-management result.')
      return {
        exitCode: value.exitCode,
        ...(typeof value.logPath === 'string' ? { logPath: value.logPath } : {}),
        ...(typeof value.timedOut === 'boolean' ? { timedOut: value.timedOut } : {}),
      }
    },
  }
}

function metadata(value: unknown): { dependencies: Record<string, unknown>; bundles: string[] } {
  const manifest = record(value)
  const dsh = record(manifest?.dsh)
  const profile = record(dsh?.profile)
  const dependencies = record(manifest?.dependencies)
  const bundles = profile?.bundles ?? []
  if (!manifest || (manifest.dsh !== undefined && !dsh) || (dsh?.profile !== undefined && !profile)
    || (manifest.dependencies !== undefined && !dependencies)
    || (dependencies && Object.values(dependencies).some(value => typeof value !== 'string'))
    || !Array.isArray(bundles) || bundles.some(value => typeof value !== 'string')) {
    throw new Error('The DSH profile has invalid package metadata; repair it with native DSH management.')
  }
  return { dependencies: dependencies ?? {}, bundles: bundles as string[] }
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  try { return await realpath(left) === await realpath(right) } catch { return false }
}

async function sourceIsThisPackage(spec: unknown, profileDirectory: string, packageDirectory: string): Promise<boolean> {
  if (typeof spec !== 'string') return false
  const path = /^(?:file|link):(.+)$/.exec(spec)?.[1]
  return path !== undefined && await sameDirectory(resolve(profileDirectory, path), packageDirectory)
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('DSH application attachment was cancelled.')
}

/** Explicit alias invocation authorizes attaching this application, never replacing another frontend. */
export async function ensureNativeAttachment(options: AttachmentOptions, suppliedApi?: NativeAttachmentApi): Promise<void> {
  checkSignal(options.signal)
  const api = suppliedApi ?? await nativeAttachmentApi(options)
  const packageDirectory = resolve(options.packageDirectory ?? PACKAGE_DIR)
  const home = options.env.DSH_HOME?.trim() || undefined
  const directory = api.profileDirectory(options.profile, home)
  let state = { dependencies: {} as Record<string, unknown>, bundles: [] as string[] }
  if (existsSync(join(directory, 'package.json'))) {
    try { state = metadata(api.manifest(directory)) }
    catch { throw new Error('Could not read DSH profile package metadata. No configuration was rewritten; repair it with native DSH management.') }
  }
  const otherFrontend = state.bundles.find(name => OTHER_FRONTENDS.has(name))
  if (otherFrontend) throw new Error(`The selected DSH profile already selects another frontend (${otherFrontend}). Select a separate profile or disable that frontend explicitly; it was not replaced.`)
  if (APPLICATION in state.dependencies && !state.bundles.includes(APPLICATION)) {
    throw new Error('This DSH profile has dsh-tui installed but its bundle is disabled. Enable it explicitly with native DSH plugin management; the saved choice was not overridden.')
  }
  let currentDirectory: string | undefined
  try { currentDirectory = api.bundleDirectory(APPLICATION, directory) } catch { /* first attachment */ }
  const mounted = state.bundles.includes(APPLICATION) && currentDirectory !== undefined
    && await sameDirectory(currentDirectory, packageDirectory)
  const ownedAliases: string[] = []
  for (const [name, spec] of Object.entries(state.dependencies)) {
    if (name !== APPLICATION && await sourceIsThisPackage(spec, directory, packageDirectory)) ownedAliases.push(name)
  }
  if (mounted && ownedAliases.length === 0) return
  if (!mounted && APPLICATION in state.dependencies && !await sourceIsThisPackage(state.dependencies[APPLICATION], directory, packageDirectory)) {
    throw new Error('This profile already installs dsh-tui from another source. It was not replaced; use a separate profile or update it explicitly with native DSH management.')
  }
  const run = async (args: readonly string[]) => {
    checkSignal(options.signal)
    const deadline = AbortSignal.timeout(90_000)
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
    let result: AttachmentRunResult
    try { result = await api.run(options.profile, directory, args, { ...options, signal }) }
    catch {
      checkSignal(options.signal)
      throw new Error(deadline.aborted ? 'Native DSH plugin management exceeded its startup deadline.' : 'Native DSH plugin management failed. Retry with native DSH plugin management; configuration details were not echoed.')
    }
    checkSignal(options.signal)
    if (deadline.aborted || result.exitCode !== 0) {
      const reason = deadline.aborted || result.timedOut ? 'timed out' : `exited ${result.exitCode}`
      // Native DSH owns raw package diagnostics. Never echo arbitrary package output/configuration here.
      throw new Error(`Native DSH plugin management ${reason}. Attachment did not complete; retry with dsh plugin --profile <name> add <local-application-path>.`)
    }
  }
  options.report?.('dsh-tui: attaching the local application through native DSH plugin management…')
  // Install first: an unsuccessful add must not delete the previous local application.
  if (!mounted) await run(['add', '--ignore-scripts', `link:${packageDirectory}`])
  if (ownedAliases.length > 0) await run(['remove', '--ignore-scripts', '--', ...ownedAliases])
  let attached = false
  try {
    const final = metadata(api.manifest(directory))
    attached = final.bundles.includes(APPLICATION)
      && ownedAliases.every(name => !(name in final.dependencies) && !final.bundles.includes(name))
      && await sameDirectory(api.bundleDirectory(APPLICATION, directory), packageDirectory)
  } catch { /* a completed package run is not evidence of an activated bundle */ }
  if (!attached) throw new Error('Native DSH package management finished, but the dsh-tui bundle is not available. Startup stopped instead of launching without a terminal frontend.')
}
