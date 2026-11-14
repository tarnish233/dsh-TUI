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
import type {
  DisplayContentPart,
  DisplayStream,
  ImageAttachmentRef,
  JsonRecord,
  SessionEvent,
  StreamPresentation,
  TranscriptCodec,
} from './types.ts'

interface NativeAssembler {
  push(chunk: JsonRecord): void
  blocks(): unknown
  interruptedBlocks(): unknown
}

/**
 * One native content block reduced to the values the presentation shows.
 *
 * A fold is the *only* per-block work the codec repeats; it is derived once per
 * block and reused until that block's projection changes. Nothing is merged:
 * one fold per native block, in native order.
 */
interface FoldedBlock {
  /** Which presentation field this block feeds. */
  readonly kind: 'text' | 'reasoning' | 'tool-call' | 'other'
  /** The text (`text`/`reasoning`) or the tool name; `''` when it feeds neither. */
  readonly value: string
  /** Ordered display part this block contributes, when the renderer shows one. */
  readonly part: DisplayContentPart | undefined
}

/**
 * Incremental projection of one block sequence.
 *
 * `present()` is called for every streamed chunk, so a long reply would
 * otherwise re-scan and re-join every block per chunk (O(chunks × blocks)).
 * The memo keeps the previous blocks, their folds and the joined strings: an
 * unchanged block is recognized by identity (or, when the native assembler
 * rebuilds the array, by a shallow field compare) and is never folded again.
 *
 * The memo belongs to exactly one accessor of one assembler instance, so it can
 * never carry a projection across streams. `blocks`/`folds` are internal; the
 * exposed arrays (`toolNames`, `content`, `images`) are replaced rather than
 * mutated, so a presentation already handed to the UI never changes.
 */
interface PresentationMemo {
  /** Blocks of the previous projection, so an unchanged position is skipped. */
  blocks: readonly unknown[]
  /** One fold per block, in native order. */
  folds: FoldedBlock[]
  /** Text/reasoning values by projection order; a changed tail re-joins only these. */
  textPieces: string[]
  thinkingPieces: string[]
  toolNames: string[]
  /** Number of folds whose display part is an image; `content` exists only then. */
  imageCount: number
  text: string
  thinking: string
  content: DisplayContentPart[]
  images: ImageAttachmentRef[]
}

function emptyMemo(): PresentationMemo {
  return {
    blocks: [],
    folds: [],
    textPieces: [],
    thinkingPieces: [],
    toolNames: [],
    imageCount: 0,
    text: '',
    thinking: '',
    content: [],
    images: [],
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/**
 * Reduce one native block. Image blocks keep DSH's canonical
 * `{type:'image', attachment}` reference and order; bytes are never inlined,
 * copied or decoded here. The display part comes from the shared native
 * projection rule, never from a second copy of it.
 */
function foldBlock(block: unknown): FoldedBlock {
  const record = asRecord(block)
  const part = displayContentParts([block])[0]
  if (record !== undefined) {
    if (record.type === 'text' && typeof record.text === 'string') return { kind: 'text', value: record.text, part }
    if (record.type === 'reasoning' && typeof record.text === 'string') return { kind: 'reasoning', value: record.text, part }
    if (record.type === 'tool-call' && typeof record.name === 'string' && record.name.length > 0) {
      return { kind: 'tool-call', value: record.name, part }
    }
  }
  return { kind: 'other', value: '', part }
}

/**
 * Whether an already folded block still projects to the same fold.
 *
 * A native `BlockAssembler` materializes a fresh object for every still-open
 * block on each read and returns the stored object for a closed one, so an
 * identity match is the cheapest proof for the settled prefix; a rebuilt object
 * is re-checked on its raw fields. Image/file references are rare inside a live
 * stream and stay on the full `displayContentParts` path.
 */
function unchangedFold(fold: FoldedBlock, previousBlock: unknown, block: unknown): boolean {
  if (previousBlock === block) return true
  const record = asRecord(block)
  if (record === undefined) return fold.kind === 'other' && fold.part === undefined
  if (fold.kind === 'text') return record.type === 'text' && record.text === fold.value
  if (fold.kind === 'reasoning') return record.type === 'reasoning' && record.text === fold.value
  if (fold.kind === 'tool-call') return record.type === 'tool-call' && record.name === fold.value
  return false
}

/** Fold one block into the memo's ordered pieces. */
function absorb(memo: PresentationMemo, fold: FoldedBlock): void {
  if (fold.kind === 'text') memo.textPieces.push(fold.value)
  else if (fold.kind === 'reasoning') memo.thinkingPieces.push(fold.value)
  // Copy-on-write: a tool roster already handed to the UI must stay frozen.
  else if (fold.kind === 'tool-call') memo.toolNames = [...memo.toolNames, fold.value]
  if (fold.part?.type === 'image') memo.imageCount += 1
}

/** Rebuild the ordered `content`/`images` projection from the current folds. */
function deriveContent(memo: PresentationMemo): void {
  if (memo.imageCount === 0) {
    memo.content = []
    memo.images = []
    return
  }
  const content: DisplayContentPart[] = []
  const images: ImageAttachmentRef[] = []
  for (const fold of memo.folds) {
    if (fold.part === undefined) continue
    content.push(fold.part)
    if (fold.part.type === 'image') images.push(fold.part.attachment)
  }
  memo.content = content
  memo.images = images
}

/** The current projection; text-only streams keep the legacy shape. */
function viewOf(memo: PresentationMemo): StreamPresentation {
  const view: StreamPresentation = { text: memo.text, thinking: memo.thinking, toolNames: memo.toolNames }
  if (memo.imageCount === 0) return view
  return { ...view, images: memo.images, content: memo.content }
}

/** Project a fresh block sequence with no prior state (one durable assembly). */
function presentFresh(blocks: unknown): StreamPresentation {
  return present(blocks, emptyMemo())
}

/**
 * Project the native blocks, reusing `memo` so an unchanged block is never
 * re-folded or re-joined.
 *
 * @param blocks - the array the native assembler just returned.
 * @param memo - the memo owned by this accessor of this assembler instance.
 * @returns the presentation; the memo is updated in place for the next chunk.
 */
function present(blocks: unknown, memo: PresentationMemo): StreamPresentation {
  if (!Array.isArray(blocks)) throw backendError('PROTOCOL_ERROR', 'DSH assembler returned invalid content blocks')
  const known = memo.folds.length
  const limit = blocks.length < known ? blocks.length : known
  let reused = 0
  while (reused < limit && unchangedFold(memo.folds[reused], memo.blocks[reused], blocks[reused])) reused += 1

  // Nothing changed: the previous projection is the current one.
  if (reused === known && reused === blocks.length) return viewOf(memo)

  if (reused === known) {
    // Pure append: only the new tail is folded, and the joined strings grow.
    const textFrom = memo.textPieces.length
    const thinkingFrom = memo.thinkingPieces.length
    const imagesFrom = memo.imageCount
    for (let index = known; index < blocks.length; index += 1) {
      const fold = foldBlock(blocks[index])
      memo.folds.push(fold)
      absorb(memo, fold)
    }
    memo.blocks = blocks
    if (memo.textPieces.length !== textFrom) memo.text += memo.textPieces.slice(textFrom).join('')
    if (memo.thinkingPieces.length !== thinkingFrom) memo.thinking += memo.thinkingPieces.slice(thinkingFrom).join('')
    // An image-bearing stream carries ordered `content`, so an appended part
    // changes it even when no new image arrived.
    if (memo.imageCount !== imagesFrom || memo.imageCount > 0) deriveContent(memo)
    return viewOf(memo)
  }

  const last = known - 1
  if (reused === last && blocks.length === known) {
    // The tail block is the one DSH still assembles, so it is normally the only
    // changed position: replace its fold and re-join exactly that field.
    const fold = foldBlock(blocks[known - 1])
    const previous = memo.folds[last]
    if (fold.kind === previous.kind) {
      memo.folds[last] = fold
      memo.blocks = blocks
      const images = memo.imageCount - (previous.part?.type === 'image' ? 1 : 0) + (fold.part?.type === 'image' ? 1 : 0)
      if (fold.kind === 'text') {
        memo.textPieces[memo.textPieces.length - 1] = fold.value
        memo.text = memo.textPieces.join('')
      } else if (fold.kind === 'reasoning') {
        memo.thinkingPieces[memo.thinkingPieces.length - 1] = fold.value
        memo.thinking = memo.thinkingPieces.join('')
      } else if (fold.kind === 'tool-call') {
        memo.toolNames = [...memo.toolNames.slice(0, -1), fold.value]
      }
      if (images !== memo.imageCount || images > 0) {
        memo.imageCount = images
        deriveContent(memo)
      }
      return viewOf(memo)
    }
  }

  // A closed block changed, or the sequence shrank: keep the still-matching
  // prefix folds and rebuild the projection from them (this is not the stream
  // hot path; DSH only grows a live block list).
  memo.folds = memo.folds.slice(0, reused)
  for (let index = reused; index < blocks.length; index += 1) memo.folds.push(foldBlock(blocks[index]))
  memo.blocks = blocks
  memo.textPieces = []
  memo.thinkingPieces = []
  memo.toolNames = []
  memo.imageCount = 0
  for (const fold of memo.folds) absorb(memo, fold)
  memo.text = memo.textPieces.join('')
  memo.thinking = memo.thinkingPieces.join('')
  deriveContent(memo)
  return viewOf(memo)
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
    // One memo per accessor: the full and the interrupted projection are two
    // different orders and must not share a prefix.
    const full = emptyMemo()
    const interrupted = emptyMemo()
    return {
      push: chunk => assembler.push(chunk),
      snapshot(cut = false) {
        if (cut) return present(assembler.interruptedBlocks(), interrupted)
        let blocks: unknown
        try {
          blocks = assembler.blocks()
        } catch {
          // A tentative stream can contain an open unknown block; the native
          // prefix accessor already knows what is safe to show in that case.
          // Durable decoding below never suppresses validation errors.
          blocks = assembler.interruptedBlocks()
        }
        return present(blocks, full)
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
      return presentFresh(interrupted ? assembler.interruptedBlocks() : assembler.blocks())
    },
    surfaceKind(event: SessionEvent) {
      if (isAppend(event as never) === true) return 'append'
      if (isReplacement(event as never) === true) return 'replace'
      return 'none'
    },
  }
}