import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentLimits, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { contentHasImage, resolveImageAttachmentAccess } from '../src/content.ts'
import type { ContentBlock } from '../src/types.ts'

class PathlessStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = Object.freeze({
    maxImageBytes: 10, maxImagesPerMessage: 1, maxMessageImageBytes: 10, maxImagePixels: 10,
    mediaTypes: Object.freeze(['image/png'] as const),
  })

  validateImage(): Promise<void> { return Promise.resolve() }
  async saveImage(): Promise<ImageAttachmentRef> { throw new Error('not used') }
  async readImage(): Promise<StoredImageAttachment> { throw new Error('not used') }
}

class HostPathStore extends PathlessStore {
  override imageHostPath(): string { return '/host/stored.png' }
}

const ref: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:content'), mediaType: 'image/png', bytes: 4, width: 1, height: 1,
}

describe('resolveImageAttachmentAccess', () => {
  it('stays undefined until a host-file-backed store and mapping both resolve', () => {
    expect(resolveImageAttachmentAccess(new PathlessStore(new Context()), () => '/mapped', ref)).toBeUndefined()
    expect(resolveImageAttachmentAccess(new HostPathStore(new Context()), () => undefined, ref)).toBeUndefined()
    expect(resolveImageAttachmentAccess(new HostPathStore(new Context()), host => `/mapped${host}`, ref))
      .toEqual({ readonlyPath: '/mapped/host/stored.png' })
  })
})

describe('contentHasImage', () => {
  it('walks nested tool-result content for image blocks', () => {
    const nested: ContentBlock[] = [
      { type: 'tool-result', toolCallId: CallId('call'), isError: false, content: [{ type: 'text', text: 'label' }] },
    ]
    const withImage: ContentBlock[] = [
      { type: 'tool-result', toolCallId: CallId('call'), isError: false, content: [
        { type: 'image', attachment: ref },
      ] },
    ]
    expect(contentHasImage([{ type: 'text', text: 'plain' }])).toBe(false)
    expect(contentHasImage(nested)).toBe(false)
    expect(contentHasImage(withImage)).toBe(true)
  })
})
