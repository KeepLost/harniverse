/** Cancelling a turn while its Files upload starts, through the real `fetch` and a loopback server. */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileStore } from '../src/common/file-store.ts'
import { DeepSeekUploadIndex } from '../src/common/upload-index.ts'

const IMAGE_BYTES = 2 * 1024 * 1024
const POLICY = { expiresAfterSeconds: 604_800, refreshMarginSeconds: 3_600, quotaCleanupBatch: 100 }

function image(): RequestImageAttachment {
  return {
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: IMAGE_BYTES,
      width: 1_024,
      height: 512,
    },
    data: new Uint8Array(IMAGE_BYTES).fill(7),
    mediaType: 'image/png',
    bytes: IMAGE_BYTES,
    width: 1_024,
    height: 512,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: true,
  }
}

/** Loopback Files endpoint that accepts every upload; closed, with its connections, when the test finishes. */
async function filesEndpoint(protocol: 'chat-completions' | 'messages'): Promise<string> {
  const http = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(protocol === 'messages'
        ? {
          id: 'file-api-one', type: 'file', size_bytes: IMAGE_BYTES,
          created_at: '2026-01-02T03:04:05.000Z', filename: 'image.png', mime_type: 'image/png',
        }
        : {
          id: 'file-api-one', object: 'file', bytes: IMAGE_BYTES, created_at: 1,
          filename: 'image.png', purpose: 'user_data', expires_at: 2,
        }))
    })
  })
  http.listen(0, '127.0.0.1')
  onTestFinished(async () => {
    const closed = new Promise<void>((resolve, reject) => {
      http.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    http.closeAllConnections()
    await closed
  })
  await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('missing loopback port')
  return `http://127.0.0.1:${address.port}`
}

describe('a turn cancelled while its Files upload starts', () => {
  it.each(['chat-completions', 'messages'] as const)('%s: leaves no unhandled rejection when cancelled right after the upload request was issued', async (protocol) => {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', record)
    onTestFinished(() => { process.off('unhandledRejection', record) })
    const root = await mkdtemp(join(tmpdir(), 'dsh-files-upload-cancel-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const baseURL = await filesEndpoint(protocol)

    const turn = new AbortController()
    const cancelled = new Error('turn cancelled')
    const transport = Promise.withResolvers<undefined>()
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'files-v1.json')),
      fetch: (input, init) => {
        const response = fetch(input, init)
        const settled = (): void => { transport.resolve(undefined) }
        void response.then(settled, settled)
        queueMicrotask(() => { turn.abort(cancelled) })
        return response
      },
    })
    const version = image()

    await expect(store.ensureUploaded(version, { baseURL, apiKey: 'key', protocol }, POLICY, turn.signal)).rejects.toBe(cancelled)
    await transport.promise
    // Node reports an unhandled rejection only after a later event-loop turn; with a FormData body it arrived in the
    // first turn after the transport settled. The bound only ends the wait when nothing is reported.
    for (let turns = 0; turns < 50 && unhandled.length === 0; turns += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }

    expect(unhandled).toEqual([])
  })
})
