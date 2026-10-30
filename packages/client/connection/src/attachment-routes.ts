/**
 * Authenticated streaming attachment-upload routes. Both sit under the `/api`
 * prefix behind the same request-trust fence and authentication as every other
 * browser-facing entry; an upload additionally requires the
 * `harniverse.operate` capability (an observer cannot inject content into a
 * session). Each body is received chunk-by-chunk against the store's byte cap
 * so an oversized upload is cut off mid-stream, never buffered past the cap.
 * @module @deepseek-ai/dsh-client-connection/attachment-routes
 */

import type { ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, type AttachmentStore, type FileAttachmentRef, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { authenticateIncoming, rejectUnauthorized } from './inbound-auth.ts'
import { describeApiTrustRequest, isTrustedApiRequest } from './api-request-trust.ts'

/** The exact upload path this module registers. */
export const UPLOAD_PATH = '/api/attachment/upload'

/** The exact image-staging upload path this module registers. */
export const UPLOAD_IMAGE_PATH = '/api/attachment/upload-image'

/** Request header carrying the percent-encoded display name. */
const NAME_HEADER = 'x-attachment-name'

/** HTTP status for one AttachmentError refusal code; unmapped codes are server failures. */
function refusalStatus(code: string, image: boolean): number {
  if (code === 'FILE_TOO_LARGE' || code === 'IMAGE_TOO_LARGE' || code === 'IMAGES_TOO_LARGE') return 413
  if (code === 'INVALID_FILE') return 400
  if (image && (code === 'UNSUPPORTED_IMAGE_TYPE' || code === 'INVALID_IMAGE' || code === 'IMAGE_TYPE_MISMATCH'
    || code === 'INVALID_IMAGE_BASE64' || code === 'IMAGE_TOO_MANY_PIXELS')) return 400
  return 500
}

/** Read the whole body chunk-by-chunk, refusing the moment the cap is crossed. */
function receiveCappedBody(req: Readable, cap: number, tooLarge: () => AttachmentError): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > cap) {
        req.destroy()
        reject(tooLarge())
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
  /* v8 ignore next -- callers pass headerValue's single-value collapse, so the
   * array arm is defensive totality over Node's raw header domain. */
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined) return undefined
  const bare = raw.split(';', 1)[0]?.trim()
  return bare === undefined || bare === '' ? undefined : bare
}

/** Refuse an untrusted, unauthenticated, or non-operating request; false means responded. */
async function refused(ctx: Context, req: Parameters<WebRoute['handler']>[0], res: ServerResponse, trustedHosts: readonly string[], trustedOrigins: readonly string[]): Promise<boolean> {
  if (!isTrustedApiRequest(req, trustedHosts, trustedOrigins)) {
    ctx.logger.warn(`client-connection: rejected untrusted upload path=${JSON.stringify(req.url ?? '-')} ${describeApiTrustRequest(req)} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
    res.writeHead(403)
    res.end('forbidden')
    return true
  }
  const decision = await authenticateIncoming(ctx, req, 'http-api')
  if (decision.kind === 'rejected') {
    ctx.logger.warn(`client-connection: upload authentication rejected reason=${JSON.stringify(decision.reason)} path=${JSON.stringify(req.url ?? '-')}`)
    rejectUnauthorized(res, decision)
    return true
  }
  if (!decision.principal.capabilities.includes('harniverse.operate')) {
    res.writeHead(403)
    res.end('forbidden')
    return true
  }
  return false
}

/** Complete one refused AttachmentError with its stable HTTP status and JSON body. */
function refuseAttachmentError(res: ServerResponse, error: AttachmentError, image: boolean): void {
  reply(res, refusalStatus(error.code, image), JSON.stringify({ code: error.code, message: error.message }))
}

/**
 * Register the authenticated streaming file- and image-upload routes.
 * @param ctx - Connection plugin context.
 * @param trustedHosts - deployment authorities accepted by the trust fence.
 * @param trustedOrigins - exact cross-origin HTTP(S) Origins allowed after Host trust.
 */
export function registerAttachmentRoutes(
  ctx: Context,
  trustedHosts: readonly string[],
  trustedOrigins: readonly string[] = [],
): void {
  const store = (): AttachmentStore | undefined => ctx.get('attachments')
  const fileRoute: WebRoute = {
    kind: 'exact',
    path: UPLOAD_PATH,
    handler: async (req, res) => {
      if (await refused(ctx, req, res, trustedHosts, trustedOrigins)) return
      const attachments = store()
      if (attachments === undefined) {
        res.writeHead(501)
        res.end('attachment storage unavailable')
        return
      }
      const cap = attachments.fileLimits?.maxFileBytes ?? Number.MAX_SAFE_INTEGER
      try {
        const length = Number(req.headers['content-length'])
        if (Number.isSafeInteger(length) && length > cap) {
          throw new AttachmentError('File exceeds the configured byte limit.', 'FILE_TOO_LARGE')
        }
        const name = decodeNameHeader(headerValue(req.headers[NAME_HEADER]))
        const mediaType = declaredMediaType(headerValue(req.headers['content-type']))
        const data = await receiveCappedBody(req, cap, () => new AttachmentError('File exceeds the configured byte limit.', 'FILE_TOO_LARGE'))
        const ref: FileAttachmentRef = await attachments.saveFile({
          data,
          ...(mediaType !== undefined ? { mediaType } : {}),
          ...(name !== undefined ? { name } : {}),
        })
        ctx.logger.info(`client-connection: upload accepted attachment=${String(ref.attachmentId)} bytes=${ref.bytes}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(ref))
      } catch (uploadError) {
        if (uploadError instanceof AttachmentError) {
          refuseAttachmentError(res, uploadError, false)
          return
        }
        ctx.logger.warn('client-connection: upload failed')
        ctx.logger.warn(uploadError)
        reply(res, 500, 'upload failed')
      }
    },
  }
  const imageRoute: WebRoute = {
    kind: 'exact',
    path: UPLOAD_IMAGE_PATH,
    handler: async (req, res) => {
      if (await refused(ctx, req, res, trustedHosts, trustedOrigins)) return
      const attachments = store()
      if (attachments === undefined) {
        res.writeHead(501)
        res.end('attachment storage unavailable')
        return
      }
      const limits = attachments.imageLimits
      // One staged image can never exceed the per-message budget either, so
      // the read stops at the smaller bound.
      const cap = Math.min(limits.maxImageBytes, limits.maxMessageImageBytes)
      try {
        const length = Number(req.headers['content-length'])
        if (Number.isSafeInteger(length) && length > cap) {
          throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
        }
        const mediaType = declaredMediaType(headerValue(req.headers['content-type']))
        if (mediaType === undefined || !(limits.mediaTypes as readonly string[]).includes(mediaType)) {
          throw new AttachmentError(
            `Image type ${mediaType ?? '(none)'} is not accepted by this deployment.`,
            'UNSUPPORTED_IMAGE_TYPE',
          )
        }
        const name = decodeNameHeader(headerValue(req.headers[NAME_HEADER]))
        const data = await receiveCappedBody(req, cap, () => new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE'))
        const input = {
          data,
          mediaType: mediaType as ImageAttachmentRef['mediaType'],
          ...(name !== undefined ? { name } : {}),
        }
        await attachments.validateImage(input)
        const ref = await attachments.saveImage(input)
        ctx.logger.info(`client-connection: image upload accepted attachment=${String(ref.attachmentId)} bytes=${ref.bytes}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(ref))
      } catch (uploadError) {
        if (uploadError instanceof AttachmentError) {
          refuseAttachmentError(res, uploadError, true)
          return
        }
        ctx.logger.warn('client-connection: image upload failed')
        ctx.logger.warn(uploadError)
        reply(res, 500, 'upload failed')
      }
    },
  }
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register(fileRoute),
      ctx.webServer.register(imageRoute),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'client-connection: attachment upload route')
}
