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

export interface ImageDetailsDialogOptions {
  readonly image: ImageViewItem
  readonly keymap: CcKeymap
  readonly readImage: ReadImageAttachment
  readonly maxHeight?: number
  readonly onClose: () => void
  readonly onInterrupt?: () => void
  readonly onRenderRequest?: () => void
  readonly getImageNavigation?: () => { readonly index: number; readonly total: number }
  readonly onPreviousImage?: () => void
  readonly onNextImage?: () => void
}
