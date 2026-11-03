/**
 * Public backend surface for the TUI.
 *
 * @module dsh-pi-tui/backend
 */
export { DshBackend } from './client.ts'
export { BackendError, asBackendError } from './errors.ts'
export type { BackendErrorCode } from './errors.ts'
export type {
  Backend,
  BackendEvent,
  DecisionOption,
  DecisionRequest,
  DshOptions,
  JsonRecord,
  Question,
  SessionEvent,
  SessionInfo,
} from './types.ts'
