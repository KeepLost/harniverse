import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'

class TestStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = Object.freeze({
    maxImageBytes: 100,
    maxImagesPerMessage: 2,
    maxMessageImageBytes: 5,
    maxImagePixels: 100,
    mediaTypes: Object.freeze(['image/png', 'image/jpeg'] as const),
  })

  validated: string[] = []
  saved: string[] = []

  validateImage(input: SaveImageAttachment): Promise<void> {
    this.validated.push(input.mediaType)
    return Promise.resolve()
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input.mediaType)
    return { attachmentId: AttachmentId(`sha256:${input.mediaType.slice('image/'.length)}`), mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 }
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.reject(new Error('not used'))
  }
}

function store(): TestStore {
  return new TestStore(new Context())
}

function image(mediaType: SaveImageAttachment['mediaType'], bytes: number): SaveImageAttachment {
  return { mediaType, data: new Uint8Array(bytes) }
}

describe('AttachmentStore default behavior', () => {
  it('validates the whole batch before saving it in order', async () => {
    const subject = store()
    const refs = await subject.saveImages([image('image/png', 2), image('image/jpeg', 3)])
    expect(subject.validated).toEqual(['image/png', 'image/jpeg'])
    expect(subject.saved).toEqual(['image/png', 'image/jpeg'])
    expect(refs).toHaveLength(2)
  })

  it('rejects batches over the image-count limit', async () => {
    await expect(store().saveImages([image('image/png', 1), image('image/png', 1), image('image/png', 1)]))
      .rejects.toMatchObject({ code: 'TOO_MANY_IMAGES' })
  })

  it('rejects batches over the aggregate byte limit', async () => {
    await expect(store().saveImages([image('image/png', 3), image('image/jpeg', 3)]))
      .rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' })
  })

  it('rejects a media type excluded by deployment policy', async () => {
    await expect(store().saveImages([image('image/webp', 1)]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE_TYPE' })
  })

  it('rejects model projection while preserving an already-aborted reason', async () => {
    const subject = store()
    const controller = new AbortController()
    controller.abort(new Error('projection stopped'))
    expect(() => subject.readImageRequest({ attachmentId: AttachmentId('sha256:png'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }, { maxPixels: 1, maxBytes: 1 }, controller.signal))
      .toThrow('projection stopped')
    await expect(subject.readImageRequest({ attachmentId: AttachmentId('sha256:png'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }, { maxPixels: 1, maxBytes: 1 }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_PROJECTION_UNSUPPORTED' })
  })
})
