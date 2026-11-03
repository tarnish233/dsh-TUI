/**
 * Type declarations for the runtime bridge's pure, testable exports.
 * The plugin itself is plain JS mounted by Cordis; only these helpers are
 * imported from TypeScript.
 */

export declare const name: string
export declare const inject: string[]

/** Control-plane wire version carried by the hello frame. */
export declare const PROTOCOL_VERSION: 2

export declare function apply(ctx: unknown): void

export type ApprovalOutcomeValue = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface AskQuestionShape {
  id: string
  question: string
  multiSelect?: boolean
  options?: Array<{ label: string; description?: string }>
}

export interface NormalizedAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

export declare function normalizeApprovalOutcome(value: unknown): ApprovalOutcomeValue
export declare function normalizeAskAnswer(questions: readonly AskQuestionShape[], value: unknown): NormalizedAnswer

/** One durable session event as the bridge reads it from native `session/event` or sessionQuery. */
export interface NativeSessionEventShape {
  type: string
  seq: number
  time?: number
  data?: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: unknown
}

/** Pure native tool-card views: `{call?, result?}` (wrapped, never flattened by the bridge). */
export interface ToolPresentationWire {
  call?: Record<string, unknown>
  result?: Record<string, unknown>
}

/** Minimal native tool-definition surface used for presentation only. */
export interface ToolDefinitionShape {
  presentCall?(args: unknown): unknown
  presentResult?(
    args: unknown,
    result: { content: unknown[]; isError: boolean; meta?: unknown },
  ): unknown
}

/** Minimal tool registry surface: `tools.get(name, agent)`. */
export interface ToolRegistryShape {
  get(name: string, scope?: object): ToolDefinitionShape | undefined
}

/**
 * Ephemeral projection over the mounted native tool registry. It caches call
 * metadata so a `tool/result` card can carry its pending call view; it never
 * re-runs a tool, reads a file, or mutates durable content.
 */
export declare class ToolPresentation {
  constructor(tools: ToolRegistryShape | undefined, agent: object | undefined)
  reset(): void
  of(event: NativeSessionEventShape): ToolPresentationWire | undefined
}