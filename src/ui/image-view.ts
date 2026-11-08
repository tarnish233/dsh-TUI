/** Shared image inspection contract. Viewing is independent from model vision/admission. */
import type { ImageAttachmentRef, ImageAttachmentValue, PromptContentPart } from '../backend/types.ts'
import type { CcKeymap } from '../input/index.ts'

export type ImageUploadPart = Extract<PromptContentPart, { readonly type: 'image' }>

export type ImageViewItem =
  | { readonly key: string; readonly label: string; readonly attachment: ImageAttachmentRef; readonly upload?: never }
  | { readonly key: string; readonly label: string; readonly upload: ImageUploadPart; readonly attachment?: never }

export interface ImageDetailsRequest {
  /** Stable occurrence identity, not just attachmentId (the same image can appear twice). */
  readonly key: string
}

export interface ImageViewOptions {
  readonly onImageDetails?: (request: ImageDetailsRequest) => void
  readonly imageDetailsHint?: string
}

export type ReadImageAttachment = (attachment: ImageAttachmentRef, signal?: AbortSignal) => Promise<ImageAttachmentValue>

/**
 * Viewer display preference (renderer-only).
 *
 * - `auto` lazily reads/decodes the occurrence and paints the native graphics
 *   when the terminal supports it.
 * - `text` never starts a read/decode and shows the metadata/ref identity only;
 *   switching to it aborts and tombstones any pending read.
 */
export type ImagePreviewMode = 'auto' | 'text'

export interface ImageDetailsDialogOptions {
  readonly image: ImageViewItem
  readonly keymap: CcKeymap
  readonly readImage: ReadImageAttachment
  readonly maxHeight?: number
  /**
   * Display preference supplied by the parent (a live getter is supported).
   * Viewing never changes model vision/admission and never submits an image.
   */
  readonly preview?: ImagePreviewMode
  /**
   * The viewer asks the parent to persist a new display preference. The parent
   * owns the settings write; the viewer applies the mode to its own surface
   * immediately and never waits for the round-trip to paint text-only.
   */
  readonly setPreview?: (value: ImagePreviewMode) => void
  readonly onClose: () => void
  readonly onInterrupt?: () => void
  readonly onRenderRequest?: () => void
  readonly getImageNavigation?: () => { readonly index: number; readonly total: number }
  readonly onPreviousImage?: () => void
  readonly onNextImage?: () => void
}
