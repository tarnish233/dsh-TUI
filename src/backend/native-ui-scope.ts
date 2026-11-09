/** Narrow access seam for native UI adapters; DSH remains the domain owner. */
export interface NativeUiScope {
  readonly sessionId: string
  readonly attachmentId?: string
  /** Exact supplied native objects; absent while the root is still pending. */
  readonly session?: unknown
  readonly agent?: unknown
}

export interface NativeUiAccess {
  /** The supplied native host, used only by public native inventory helpers. */
  readonly host: unknown
  service(name: string): unknown
  current(): NativeUiScope | undefined
  /** Attachment identity, not provider/model metadata, determines ownership. */
  isCurrent(scope: NativeUiScope): boolean
  warn?(message: string): void
}
