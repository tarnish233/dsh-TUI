/**
 * Pure transcript codec backed by DSH's public helpers.
 *
 * No Agent, model, persistence or copied assembly algorithm lives here: the
 * caller supplies the public `@deepseek-ai/dsh-llm` and
 * `@deepseek-ai/dsh-session` module namespaces (production imports them, tests
 * inject fixtures). The returned `TranscriptCodec` is installed by the UI
 * before it resets a transcript, so live chunks and durable settlements share
 * one native assembly algorithm.
 *
 * @module dsh-tui/backend/native-codec
 */
import { displayContentParts } from '../attachments.ts'
import { backendError } from './errors.ts'
import type { DisplayStream, JsonRecord, SessionEvent, StreamPresentation, TranscriptCodec } from './types.ts'

interface NativeAssembler {
  push(chunk: JsonRecord): void
  blocks(): unknown
  interruptedBlocks(): unknown
}

/**
 * Rendering only: pick the already assembled native blocks the UI supports.
 * Image blocks keep DSH's canonical `{type:'image', attachment}` reference and
 * order; bytes are never inlined, copied or decoded here.
 */
function present(blocks: unknown): StreamPresentation {
  if (!Array.isArray(blocks)) throw backendError('PROTOCOL_ERROR', 'DSH assembler returned invalid content blocks')
  const text: string[] = []
  const thinking: string[] = []
  const toolNames: string[] = []
  for (const value of blocks) {
    const block = value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
    if (block === undefined) continue
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') thinking.push(block.text)
    else if (block.type === 'tool-call' && typeof block.name === 'string' && block.name.length > 0) toolNames.push(block.name)
  }
  const view: StreamPresentation = { text: text.join(''), thinking: thinking.join(''), toolNames }
  const content = displayContentParts(blocks)
  const images = content.flatMap(part => part.type === 'image' ? [part.attachment] : [])
  if (images.length === 0) return view
  // Text-only streams keep the legacy shape; an image occurrence needs its
  // position, so ordered content rides beside the reference list.
  return { ...view, images, content }
}

function exportedFunction(module: unknown, name: string): (...args: never[]) => unknown {
  const value = module !== null && typeof module === 'object'
    ? (module as Record<string, unknown>)[name]
    : undefined
  if (typeof value !== 'function') {
    throw backendError('STARTUP_FAILED', `the installed DSH helpers do not expose ${name}`)
  }
  return value as (...args: never[]) => unknown
}

/**
 * Build the production transcript codec from public DSH modules.
 *
 * @param llm - the `@deepseek-ai/dsh-llm` namespace (`BlockAssembler`,
 *   `expandAssistantStream`, `assembleAssistantStream`).
 * @param session - the `@deepseek-ai/dsh-session` namespace
 *   (`isAppendSurfaceEvent`, `isReplacementSurfaceEvent`).
 * @returns the codec the UI installs before resetting history.
 */
export function makeTranscriptCodec(llm: unknown, session: unknown): TranscriptCodec {
  const Assembler = exportedFunction(llm, 'BlockAssembler') as unknown as new () => NativeAssembler
  const expand = exportedFunction(llm, 'expandAssistantStream')
  const assemble = exportedFunction(llm, 'assembleAssistantStream') as unknown as (stream: unknown) => NativeAssembler
  const isAppend = exportedFunction(session, 'isAppendSurfaceEvent')
  const isReplacement = exportedFunction(session, 'isReplacementSurfaceEvent')

  function createStream(): DisplayStream {
    const assembler = new Assembler()
    if (typeof assembler.push !== 'function' || typeof assembler.blocks !== 'function' || typeof assembler.interruptedBlocks !== 'function') {
      throw backendError('STARTUP_FAILED', 'the installed DSH BlockAssembler has an incompatible public interface')
    }
    return {
      push: chunk => assembler.push(chunk),
      snapshot(interrupted = false) {
        if (interrupted) return present(assembler.interruptedBlocks())
        let blocks: unknown
        try {
          blocks = assembler.blocks()
        } catch {
          // A tentative stream can contain an open unknown block; the native
          // prefix accessor already knows what is safe to show in that case.
          // Durable decoding below never suppresses validation errors.
          blocks = assembler.interruptedBlocks()
        }
        return present(blocks)
      },
    }
  }

  return {
    createStream,
    assemble(stream, interrupted = false) {
      // DSH explicitly requires validation at the durable boundary. The second
      // helper assembles packed runs without re-expanding them here.
      expand(stream as never)
      const assembler = assemble(stream)
      return present(interrupted ? assembler.interruptedBlocks() : assembler.blocks())
    },
    surfaceKind(event: SessionEvent) {
      if (isAppend(event as never) === true) return 'append'
      if (isReplacement(event as never) === true) return 'replace'
      return 'none'
    },
  }
}