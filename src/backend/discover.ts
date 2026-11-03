/**
 * Locate and validate the installed DeepSeek Harness package.
 *
 * Only the published package root, its own manifest and Node's package
 * resolver are used: the launcher comes from `package.json`'s `bin` field and
 * the public helper packages the bridge imports are resolved with
 * `createRequire(<dsh package.json>).resolve(...)`. No `lib/` layout is
 * assumed and nothing is installed or modified here.
 *
 * @module dsh-pi-tui/backend/discover
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { backendError } from './errors.ts'

export interface DshInstall {
  /** Absolute package directory of `@deepseek-ai/dsh`. */
  dir: string
  /** Absolute path of the launcher declared by the manifest's `bin` field. */
  binPath: string
  /** Version read from the installed manifest. */
  version: string
  /** Absolute path of the installed manifest. */
  packageJsonPath: string
  /** File URL of `@deepseek-ai/dsh-agent`'s public entry, when the install ships it. */
  agentModuleUrl?: string
}

const PACKAGE_NAME = '@deepseek-ai/dsh'
/** The concrete installed release this backend is written and tested against. */
const TESTED_VERSION = '0.2.1-rc.5'
/** Bounded list of global install roots searched after definitive discovery. */
const GLOBAL_INSTALL_ROOTS = [
  '/opt/homebrew/lib/node_modules',
  '/usr/local/lib/node_modules',
]
/** Environment escape hatch used by tests that install a stub runtime. */
const DSH_PATH_ENV = 'DSH_PI_TUI_DSH_PATH'
/** Explicit escape hatch for a version line newer than the tested one. */
const UNSUPPORTED_ENV = 'DSH_PI_TUI_ALLOW_UNSUPPORTED'

interface DshManifest {
  name?: string
  version?: string
  bin?: unknown
}

function readManifest(dir: string): DshManifest | undefined {
  const path = join(dir, 'package.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DshManifest
  } catch {
    return undefined
  }
}

function normalizeDir(candidate: string): string | undefined {
  try {
    let real = realpathSync(candidate)
    // Explicit --dsh may name the executable, not just the package directory.
    for (let level = 0; level < 8; level++) {
      if (readManifest(real)?.name === PACKAGE_NAME) return real
      const parent = dirname(real)
      if (parent === real) break
      real = parent
    }
    return undefined
  } catch {
    return undefined
  }
}

function fromWhich(): string | undefined {
  try {
    const found = execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (found.length === 0) return undefined
    // The launcher on PATH resolves into the package; walk up to its manifest
    // instead of assuming a global `lib/node_modules` layout.
    return normalizeDir(found)
  } catch {
    return undefined
  }
}

function fromNpmRoot(): string | undefined {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (root.length === 0) return undefined
    return normalizeDir(join(root, PACKAGE_NAME))
  } catch {
    return undefined
  }
}

export function candidateDshDirs(explicit?: string): string[] {
  // An explicit location is authoritative: silently falling back to another
  // install would hide a misconfigured path.
  if (explicit !== undefined && explicit.trim().length > 0) return [resolve(explicit.trim())]
  const fromEnv = process.env[DSH_PATH_ENV]
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return [resolve(fromEnv.trim())]
  const candidates: string[] = []
  const which = fromWhich()
  if (which !== undefined) candidates.push(which)
  for (const root of GLOBAL_INSTALL_ROOTS) candidates.push(join(root, PACKAGE_NAME))
  try {
    candidates.push(join(homedir(), '.npm-global', 'lib', 'node_modules', PACKAGE_NAME))
  } catch {
    /* homedir unavailable */
  }
  const npmRoot = fromNpmRoot()
  if (npmRoot !== undefined) candidates.push(npmRoot)
  return candidates
}

/** Reject an installation this backend was not written against. */
export function assertSupportedVersion(dir: string, version: string): void {
  const allow = process.env[UNSUPPORTED_ENV] === '1'
  if (version === TESTED_VERSION || allow) return
  throw backendError(
    'DSH_VERSION_UNSUPPORTED',
    `unsupported @deepseek-ai/dsh version ${version} at ${dir}: this backend targets the tested release ` +
      `${TESTED_VERSION} (set ${UNSUPPORTED_ENV}=1 to try anyway)`,
  )
}

/** The launcher this package declares, or `undefined` when it declares none. */
function launchRelativePath(manifest: DshManifest): string | undefined {
  const bin = manifest.bin
  if (typeof bin === 'string' && bin.trim().length > 0) return bin.trim()
  if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) return undefined
  const entries = bin as Record<string, unknown>
  const preferred = entries.dsh
  if (typeof preferred === 'string' && preferred.trim().length > 0) return preferred.trim()
  const declared = Object.values(entries).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return declared.length === 1 ? declared[0]!.trim() : undefined
}

/**
 * Resolve one public package export of this installation with Node's own
 * resolver, seeded at the installed manifest.
 * @returns the absolute module path, or `undefined` when the install does not ship it.
 */
export function resolveDshModule(packageJsonPath: string, specifier: string): string | undefined {
  try {
    return createRequire(packageJsonPath).resolve(specifier)
  } catch {
    return undefined
  }
}

function agentModuleUrl(packageJsonPath: string): string | undefined {
  const entry = resolveDshModule(packageJsonPath, '@deepseek-ai/dsh-agent')
  return entry === undefined ? undefined : pathToFileURL(entry).href
}

/**
 * Resolve the installed DSH package, verifying its identity, launcher and
 * supported version line.
 */
export function resolveDshInstall(explicit?: string): DshInstall {
  const tried: string[] = []
  for (const candidate of candidateDshDirs(explicit)) {
    tried.push(candidate)
    const dir = normalizeDir(candidate)
    if (dir === undefined) continue
    const manifest = readManifest(dir)
    if (manifest === undefined) continue
    const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
    assertSupportedVersion(dir, version)
    const relative = launchRelativePath(manifest)
    if (relative === undefined) {
      throw backendError('DSH_NOT_FOUND', `dsh installation at ${dir} declares no launcher in package.json "bin"`)
    }
    const binPath = resolve(dir, relative)
    if (!existsSync(binPath)) {
      throw backendError('DSH_NOT_FOUND', `dsh installation at ${dir} declares a missing launcher at ${binPath}`)
    }
    const packageJsonPath = join(dir, 'package.json')
    const agent = agentModuleUrl(packageJsonPath)
    return {
      dir,
      binPath,
      version,
      packageJsonPath,
      ...(agent === undefined ? {} : { agentModuleUrl: agent }),
    }
  }
  throw backendError(
    'DSH_NOT_FOUND',
    `could not find an installed ${PACKAGE_NAME} package (looked in ${tried.length} locations); ` +
      'pass DshOptions.dshPath or set DSH_PI_TUI_DSH_PATH',
  )
}