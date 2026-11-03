/**
 * Pure display projections backed by the selected DSH installation's public
 * exports. No Agent, model client, persistence or copied assembly algorithm.
 * Loading happens before the runtime can emit ready; missing helpers fail
 * startup instead of silently substituting a display mirror.
 *
 * The same loader binds the installed launcher's *public* profile/composition
 * helpers, so profile selection, bundle resolution and user patch parsing stay
 * DSH behaviour. Nothing here re-implements YAML merging, composition order or
 * package resolution.
 */
import { pathToFileURL } from 'node:url'
import { backendError } from './errors.ts'
import { resolveDshModule } from './discover.ts'
import type { DisplayStream, JsonRecord, SessionEvent, StreamPresentation, TranscriptCodec } from './types.ts'

interface NativeAssembler {
  push(chunk: JsonRecord): void
  blocks(): unknown
  interruptedBlocks(): unknown
}

/**
 * Installed public profile helpers used for native profile selection.
 *
 * `dsh-app-boot` owns profile discovery, manifest reading/writing, bundle
 * resolution and patch parsing; this adapter only supplies the arguments and
 * keeps every write inside its own scratch directory.
 */
export interface NativeProfileApi {
  /** `DEFAULT_PROFILE_BUNDLES`: the bundle list a base-only profile is initialized with. */
  defaultBundles: readonly string[]
  /** Shipped application-surface bundles declared by `PROFILE_TEMPLATES`. */
  shippedSurfaceBundles: readonly string[]
  resolveProfileDir(name: string, home: string): string
  readManifest(dir: string): JsonRecord
  writeManifest(dir: string, manifest: JsonRecord): void
  initProfile(dir: string, bundles: readonly string[]): void
  /** Resolve one entry module name from the installation, then the profile directory. */
  resolvePackageDir(name: string, installAnchor: string, profileDir: string): string
  /** Parse one native patch list, returning `undefined` when the file is absent. */
  loadPatches(file: string): readonly JsonRecord[] | undefined
}

export interface NativeHelpers {
  transcriptCodec: TranscriptCodec
  resolveHome(configured?: string): string
  profile: NativeProfileApi
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

function exportedFunction<T>(module: JsonRecord, name: string): T {
  const value = module[name]
  if (typeof value !== 'function') throw backendError('STARTUP_FAILED', `DSH public helper is unavailable: ${name}`)
  return value as T
}

async function loadExport(anchor: string, specifier: string): Promise<JsonRecord> {
  const path = resolveDshModule(anchor, specifier)
  if (!path) throw backendError('STARTUP_FAILED', `The selected DSH installation does not provide ${specifier}`)
  try {
    const loaded: unknown = await import(pathToFileURL(path).href)
    const module = record(loaded)
    if (!module) throw new Error('module namespace unavailable')
    return module
  } catch {
    throw backendError('STARTUP_FAILED', `Could not load DSH public helpers from ${specifier}`)
  }
}

/** Rendering only: pick the already assembled native blocks our current UI supports. */
function present(blocks: unknown): StreamPresentation {
  if (!Array.isArray(blocks)) throw backendError('PROTOCOL_ERROR', 'DSH assembler returned invalid content blocks')
  const text: string[] = []
  const thinking: string[] = []
  const toolNames: string[] = []
  for (const value of blocks) {
    const block = record(value)
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') thinking.push(block.text)
    else if (block.type === 'tool-call' && typeof block.name === 'string' && block.name) toolNames.push(block.name)
  }
  return { text: text.join(''), thinking: thinking.join(''), toolNames }
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw backendError('STARTUP_FAILED', `DSH public helper is unavailable or incompatible: ${label}`)
  }
  return value as string[]
}

/** Shipped surface bundles named by `PROFILE_TEMPLATES`, excluding the shared core. */
function shippedSurfaceBundles(templates: JsonRecord, core: readonly string[]): string[] {
  const surfaces = new Set<string>()
  for (const template of Object.values(templates)) {
    const profile = record(template)
    if (!profile) continue
    for (const bundle of stringArray(profile.bundles, 'PROFILE_TEMPLATES.bundles')) {
      if (!core.includes(bundle)) surfaces.add(bundle)
    }
  }
  return [...surfaces].sort()
}

export async function loadNativeHelpers(packageJsonPath: string): Promise<NativeHelpers> {
  const [llm, surface, home, boot] = await Promise.all([
    loadExport(packageJsonPath, '@deepseek-ai/dsh-llm'),
    loadExport(packageJsonPath, '@deepseek-ai/dsh-session/surface'),
    loadExport(packageJsonPath, '@deepseek-ai/dsh-home-paths'),
    loadExport(packageJsonPath, '@deepseek-ai/dsh-app-boot'),
  ])
  const Assembler = exportedFunction<new () => NativeAssembler>(llm, 'BlockAssembler')
  const expand = exportedFunction<(stream: unknown) => unknown>(llm, 'expandAssistantStream')
  const assemble = exportedFunction<(stream: unknown) => NativeAssembler>(llm, 'assembleAssistantStream')
  const isAppend = exportedFunction<(event: SessionEvent) => boolean>(surface, 'isAppendSurfaceEvent')
  const isReplacement = exportedFunction<(event: SessionEvent) => boolean>(surface, 'isReplacementSurfaceEvent')
  const resolveHome = exportedFunction<(configured?: string) => string>(home, 'resolveDshHome')
  const defaultBundles = stringArray(boot.DEFAULT_PROFILE_BUNDLES, 'DEFAULT_PROFILE_BUNDLES')
  const templates = record(boot.PROFILE_TEMPLATES)
  if (!templates) throw backendError('STARTUP_FAILED', 'DSH public helper is unavailable or incompatible: PROFILE_TEMPLATES')
  const resolveProfileDir = exportedFunction<(name: string, home?: string) => string>(boot, 'resolveProfileDir')
  const readProfileManifest = exportedFunction<(binName: string, dir: string) => JsonRecord>(boot, 'readProfileManifest')
  const writeProfileManifest = exportedFunction<(dir: string, manifest: JsonRecord) => void>(boot, 'writeProfileManifest')
  const initProfile = exportedFunction<(dir: string, bundles: readonly string[]) => void>(boot, 'initProfile')
  const resolveBundleDir = exportedFunction<(binName: string, name: string, installAnchor: string, profileDir: string) => string>(boot, 'resolveBundleDir')
  const loadOptionalPatches = exportedFunction<(binName: string, file: string) => unknown>(boot, 'loadOptionalPatches')
  const shipped = shippedSurfaceBundles(templates, defaultBundles)

  function createStream(): DisplayStream {
    const assembler = new Assembler()
    if (typeof assembler.push !== 'function' || typeof assembler.blocks !== 'function' || typeof assembler.interruptedBlocks !== 'function') {
      throw backendError('STARTUP_FAILED', 'The selected DSH BlockAssembler has an incompatible public interface')
    }
    return {
      push: chunk => assembler.push(chunk),
      snapshot(interrupted = false) {
        if (interrupted) return present(assembler.interruptedBlocks())
        let blocks: unknown
        try {
          blocks = assembler.blocks()
        } catch {
          // A tentative stream can contain an open unknown block. The native
          // prefix accessor already knows what is safe to show in that case;
          // durable decoding below never suppresses validation/assembly errors.
          blocks = assembler.interruptedBlocks()
        }
        return present(blocks)
      },
    }
  }

  const transcriptCodec: TranscriptCodec = {
    createStream,
    assemble(stream, interrupted = false) {
      // DSH explicitly requires validation at the durable boundary. The second
      // helper then assembles packed runs without re-expanding them ourselves.
      expand(stream)
      const assembler = assemble(stream)
      return present(interrupted ? assembler.interruptedBlocks() : assembler.blocks())
    },
    surfaceKind(event) {
      if (isAppend(event)) return 'append'
      if (isReplacement(event)) return 'replace'
      return 'none'
    },
  }
  return {
    transcriptCodec,
    resolveHome(configured) {
      const value = resolveHome(configured)
      if (typeof value !== 'string' || value.length === 0) throw backendError('STARTUP_FAILED', 'DSH home-path helper returned an invalid path')
      return value
    },
    profile: {
      defaultBundles,
      shippedSurfaceBundles: shipped,
      resolveProfileDir(name, homeDir) {
        const value = resolveProfileDir(name, homeDir)
        if (typeof value !== 'string' || value.length === 0) {
          throw backendError('STARTUP_FAILED', 'DSH profile resolver returned an invalid path')
        }
        return value
      },
      readManifest(dir) {
        const manifest = record(readProfileManifest('dsh', dir))
        if (!manifest) throw backendError('STARTUP_FAILED', `DSH profile manifest is unavailable: ${dir}`)
        return manifest
      },
      writeManifest(dir, manifest) {
        writeProfileManifest(dir, manifest)
      },
      initProfile(dir, bundles) {
        initProfile(dir, bundles)
      },
      resolvePackageDir(name, installAnchor, profileDir) {
        return resolveBundleDir('dsh', name, installAnchor, profileDir)
      },
      loadPatches(file) {
        const patches: unknown = loadOptionalPatches('dsh', file)
        if (patches === undefined) return undefined
        if (!Array.isArray(patches) || patches.some(item => record(item) === undefined)) {
          throw backendError('STARTUP_FAILED', `DSH patch parser returned an invalid list: ${file}`)
        }
        return patches as JsonRecord[]
      },
    },
  }
}
