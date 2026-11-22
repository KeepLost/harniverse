/**
 * Aggregate request-image budget enforcement on the pi-ai conversion path:
 * occurrences beyond the byte or count budget drop oldest-first and settle
 * through the request owner's hook, or local stubs without one.
 */
import { describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { toPiContext } from '../src/context.ts'

function refOf(seed: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${seed.repeat(64).slice(0, 64)}`),
    mediaType: 'image/png',
    bytes: 100,
    width: 1,
    height: 1,
  }
}

/** Store answering one deterministic 100-byte request version per attachment, counting reads. */
function store(reads: { count: number }): AttachmentStore {
  return {
    readImageRequest(value: ImageAttachmentRef): Promise<RequestImageAttachment> {
      reads.count += 1
      return Promise.resolve({
        attachment: value,
        variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
        data: Uint8Array.of(1),
        mediaType: value.mediaType,
        bytes: 100,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      })
    },
  } as unknown as AttachmentStore
}

function imageMessage(seed: string, text: string): Message {
  const content: ContentBlock[] = [
    { type: 'text', text },
    { type: 'image', attachment: refOf(seed) },
  ]
  return createUserMessage({ content, source: { kind: 'plugin', plugin: 'test' } })
}

/** Wire coordinates one settlement hook observed, or that no call happened. */
interface SettlementCapture {
  called?: boolean
  targets?: readonly { message: number; image: number }[]
}

type WireTargets = readonly { message: number; image: number }[]

type SettlementReplacement = (targets: WireTargets) => Message[]

function settlementHook(capture: SettlementCapture, replacement?: SettlementReplacement): (targets: WireTargets) => Message[] {
  return (targets) => {
    capture.called = true
    capture.targets = targets
    return replacement !== undefined ? replacement(targets) : []
  }
}

/** The inline base64 payload of the first image in one converted user message. */
function imageSeed(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null || !Array.isArray(content)) return undefined
  for (const block of content as { type: string; data?: string }[]) {
    if (block.type === 'image') return block.data
  }
  return undefined
}

describe('pi-ai aggregate request-image budget', () => {
  it('drops the oldest occurrences until the retained bytes fit', async () => {
    const reads = { count: 0 }
    const capture: SettlementCapture = {}
    const original = [imageMessage('a', 'first'), imageMessage('b', 'second'), imageMessage('c', 'third')]
    const hook = settlementHook(capture, (targets) => {
      const omitted = new Set(targets.map(target => `${target.message}:${target.image}`))
      return original.map((entry, message) => {
        let image = 0
        return {
          ...entry,
          content: entry.content.map((block) => {
            if (block.type === 'image' && omitted.has(`${message}:${image++}`)) {
              return { type: 'text', text: `[offloaded ${message}]` }
            }
            return block
          }),
        } satisfies Message
      })
    })
    const context = await toPiContext(
      { provider: 'openai', model: 'gpt-4.1', messages: original, onImagesOmitted: hook },
      store(reads),
      { maxPixels: 4, maxBytes: 1024 },
      undefined,
      { maxBytes: 150, maxCount: 10, byteQuantum: 1000, countQuantum: 5 },
    )
    expect(capture.targets).toEqual([
      { message: 0, image: 0 },
      { message: 1, image: 0 },
    ])
    expect(context.messages[0]?.content).toBe('first[offloaded 0]')
    expect(imageSeed(context.messages[1]?.content)).toBeUndefined()
    expect(imageSeed(context.messages[2]?.content)).toBe('AQ==')
  })

  it('falls back to local omission stubs without a settlement hook', async () => {
    const reads = { count: 0 }
    const oldest = refOf('a')
    const context = await toPiContext(
      { provider: 'openai', model: 'gpt-4.1', messages: [imageMessage('a', 'first'), imageMessage('c', 'third')] },
      store(reads),
      { maxPixels: 4, maxBytes: 1024 },
      undefined,
      { maxBytes: 150, maxCount: 10, byteQuantum: 1000, countQuantum: 5 },
    )
    expect(context.messages[0]?.content).toBe(`first[image omitted: ${oldest.attachmentId}]`)
    expect(imageSeed(context.messages[1]?.content)).toBe('AQ==')
  })

  it('keeps every occurrence and reads each attachment once when the budget fits', async () => {
    const reads = { count: 0 }
    const capture: SettlementCapture = { called: false }
    const context = await toPiContext(
      {
        provider: 'openai',
        model: 'gpt-4.1',
        messages: [imageMessage('a', 'first'), imageMessage('c', 'third')],
        onImagesOmitted: settlementHook(capture),
      },
      store(reads),
      { maxPixels: 4, maxBytes: 1024 },
      undefined,
      { maxBytes: 250, maxCount: 10, byteQuantum: 1000, countQuantum: 5 },
    )
    expect(capture.called).toBe(false)
    expect(imageSeed(context.messages[0]?.content)).toBe('AQ==')
    expect(imageSeed(context.messages[1]?.content)).toBe('AQ==')
    expect(reads.count).toBe(2)
  })

  it('applies the count budget through its quantum', async () => {
    const reads = { count: 0 }
    const capture: SettlementCapture = {}
    const original = [imageMessage('a', 'first'), imageMessage('b', 'second'), imageMessage('c', 'third')]
    await toPiContext(
      { provider: 'openai', model: 'gpt-4.1', messages: original, onImagesOmitted: settlementHook(capture) },
      store(reads),
      { maxPixels: 4, maxBytes: 1024 },
      undefined,
      { maxBytes: 10_000, maxCount: 2, byteQuantum: 1000, countQuantum: 1 },
    )
    expect(capture.targets).toEqual([
      { message: 0, image: 0 },
      { message: 1, image: 0 },
    ])
  })
})
