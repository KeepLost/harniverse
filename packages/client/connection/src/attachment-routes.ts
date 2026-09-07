/**
 * Authenticated streaming file-upload route. Sits under the `/api` prefix
 * behind the same request-trust fence and authentication as every other
 * browser-facing entry; an upload additionally requires the
 * `harniverse.operate` capability (an observer cannot inject content into a
 * session). The body is received chunk-by-chunk against the store's byte cap
 * so an oversized upload is cut off mid-stream, never buffered past the cap.
 * @module @deepseek-ai/dsh-client-connection/attachment-routes
 */

import type { ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { authenticateIncoming, rejectUnauthorized } from './inbound-auth.ts'
import { describeApiTrustRequest, isTrustedApiRequest } from './api-request-trust.ts'

/** The exact upload path this module registers. */
export const UPLOAD_PATH = '/api/attachment/upload'

/** Request header carrying the percent-encoded display name. */
const NAME_HEADER = 'x-attachment-name'

/** Read the whole body chunk-by-chunk, refusing the moment the cap is crossed. */
function receiveCappedBody(req: Readable, cap: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > cap) {
        req.destroy()
        reject(new AttachmentError('File exceeds the configured byte limit.', 'FILE_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(new Uint8Array(Buffer.concat(chunks))) })
    req.on('error', (error: Error) => { reject(error) })
  })
}

/** Percent-decode the display-name header; any malformed value refuses the request. */
function decodeNameHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    throw new AttachmentError('The attachment name header is not percent-encoded.', 'INVALID_FILE')
  }
}

/** Complete one plain-text JSON-adjacent response. */
function reply(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

/** Collapse a possibly-repeated header to its first value. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Strip content-type parameters to the bare declared media type. */
function declaredMediaType(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined) return undefined
  const bare = raw.split(';', 1)[0]?.trim()
  return bare === undefined || bare === '' ? undefined : bare
}

/**
 * Register the authenticated streaming file-upload route.
 * @param ctx - Connection plugin context.
 * @param trustedHosts - deployment authorities accepted by the trust fence.
 * @param trustedOrigins - exact cross-origin HTTP(S) Origins allowed after Host trust.
 */
export function registerAttachmentRoutes(
  ctx: Context,
  trustedHosts: readonly string[],
  trustedOrigins: readonly string[] = [],
): void {
  const route: WebRoute = {
    kind: 'exact',
    path: UPLOAD_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts, trustedOrigins)) {
        ctx.logger.warn(`client-connection: rejected untrusted upload path=${JSON.stringify(req.url ?? '-')} ${describeApiTrustRequest(req)} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const decision = await authenticateIncoming(ctx, req, 'http-api')
      if (decision.kind === 'rejected') {
        ctx.logger.warn(`client-connection: upload authentication rejected reason=${JSON.stringify(decision.reason)} path=${JSON.stringify(req.url ?? '-')}`)
        rejectUnauthorized(res, decision)
        return
      }
      if (!decision.principal.capabilities.includes('harniverse.operate')) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const store = ctx.get('attachments')
      if (store === undefined) {
        res.writeHead(501)
        res.end('attachment storage unavailable')
        return
      }
      const cap = store.fileLimits?.maxFileBytes ?? Number.MAX_SAFE_INTEGER
      try {
        const length = Number(req.headers['content-length'])
        if (Number.isSafeInteger(length) && length > cap) {
          throw new AttachmentError('File exceeds the configured byte limit.', 'FILE_TOO_LARGE')
        }
        const name = decodeNameHeader(headerValue(req.headers[NAME_HEADER]))
        const mediaType = declaredMediaType(headerValue(req.headers['content-type']))
        const data = await receiveCappedBody(req, cap)
        const ref: FileAttachmentRef = await store.saveFile({
          data,
          ...(mediaType !== undefined ? { mediaType } : {}),
          ...(name !== undefined ? { name } : {}),
        })
        ctx.logger.info(`client-connection: upload accepted attachment=${String(ref.attachmentId)} bytes=${ref.bytes}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(ref))
      } catch (uploadError) {
        if (uploadError instanceof AttachmentError) {
          const status = uploadError.code === 'FILE_TOO_LARGE' ? 413 : uploadError.code === 'INVALID_FILE' ? 400 : 500
          reply(res, status, JSON.stringify({ code: uploadError.code, message: uploadError.message }))
          return
        }
        ctx.logger.warn('client-connection: upload failed')
        ctx.logger.warn(uploadError)
        reply(res, 500, 'upload failed')
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: attachment upload route')
}
