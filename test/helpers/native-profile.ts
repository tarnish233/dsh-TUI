import { createRequire } from 'node:module'
import { mkdtemp, mkdir, symlink, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const PROJECT = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)

export interface NativeProfileFixture {
  readonly directory: string
  readonly home: string
  readonly cwd: string
  readonly profileDir: string
  readonly bin: string
  readonly env: NodeJS.ProcessEnv
  args(inner?: readonly string[]): string[]
  cleanup(): Promise<void>
}

/** Public installed manifest only. Never inspect an existing user profile or credentials. */
export async function nativeDshManifest(): Promise<string> {
  try { return require.resolve('@deepseek-ai/dsh/package.json') }
  catch {
    const candidates = ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules']
    for (const base of candidates) {
      const path = join(base, '@deepseek-ai/dsh/package.json')
      try { await readFile(path, 'utf8'); return path } catch { /* next installation */ }
    }
  }
  throw new Error('Native DSH acceptance requires the verified @deepseek-ai/dsh installation')
}

/** Real native profile composition in a temporary home; no copied profile engine or inherited auth. */
export async function nativeProfileFixture(patch = '[]\n'): Promise<NativeProfileFixture> {
  const manifestPath = await nativeDshManifest()
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || !('bin' in manifest) || manifest.bin === null || typeof manifest.bin !== 'object' || !('dsh' in manifest.bin) || typeof manifest.bin.dsh !== 'string') {
    throw new Error('Native DSH manifest exposes no dsh launcher')
  }
  const bin = resolve(dirname(manifestPath), manifest.bin.dsh)
  const nativeRequire = createRequire(manifestPath)
  const boot = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-app-boot')).href) as {
    initProfile(dir: string, bundles: readonly string[]): void
    readProfileManifest(bin: string, dir: string): Record<string, unknown>
    writeProfileManifest(dir: string, manifest: Record<string, unknown>): void
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-plugin-'))
  const home = join(directory, 'home')
  const cwd = join(directory, 'workspace')
  const profileDir = join(home, 'profiles/dsh-tui')
  try {
    await mkdir(cwd, { recursive: true })
    boot.initProfile(profileDir, ['@deepseek-ai/dsh-base', 'dsh-tui'])
    const profile = boot.readProfileManifest('dsh-test', profileDir)
    boot.writeProfileManifest(profileDir, { ...profile, dependencies: { 'dsh-tui': `link:${PROJECT}` } })
    await mkdir(join(profileDir, 'node_modules'), { recursive: true })
    await symlink(PROJECT, join(profileDir, 'node_modules/dsh-tui'), 'dir')
    await writeFile(join(profileDir, 'cordis.patch.yml'), patch)
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: 'en_US.UTF-8', HOME: home, DSH_HOME: home,
      TERM: 'xterm-256color', TERM_PROGRAM: 'rex', CI: '1',
      DSH_TELEMETRY_DISABLED: '1',
    }
    return {
      directory, home, cwd, profileDir, bin, env,
      args: (inner = []) => [bin, '--profile', 'dsh-tui', ...inner],
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
