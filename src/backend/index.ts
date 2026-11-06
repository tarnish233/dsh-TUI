/**
 * Public backend surface for the TUI.
 *
 * The TUI runs inside a DSH native application bundle. `createDshBackend`
 * adapts the host Cordis context to the neutral `Backend` contract; DSH remains
 * the owner of Agents, models, tools, permissions, commands and persistence.
 *
 * @module dsh-tui/backend
 */
export { DshContextBackend, createDshBackend } from './context.ts'
export type { DshContextBackendOptions, DshHostContext, DshNativeHelpers } from './context.ts'
export { makeTranscriptCodec } from './native-codec.ts'
export { BackendError, asBackendError } from './errors.ts'
export type { BackendErrorCode } from './errors.ts'
export type {
  Backend,
  BackendEvent,
  DecisionOption,
  DecisionOrigin,
  DecisionRequest,
  DisplayContentPart,
  ImageAttachmentRef,
  ImageAttachmentValue,
  ImageMediaType,
  JsonRecord,
  PromptContentPart,
  Question,
  SessionEvent,
  SessionInfo,
  SubagentEntry,
  SubagentMode,
  SubagentSnapshot,
  SubagentStatus,
  SubagentTiming,
} from './types.ts'