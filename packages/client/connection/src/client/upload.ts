/**
 * Browser upload transport for the Host attachment routes
 * (`POST /api/attachment/upload` files, `POST /api/attachment/upload-image`
 * staged images; raw bytes body, receipt JSON response).
 *
 * XHR rather than fetch: upload progress needs `xhr.upload.onprogress`
 * (fetch request-body streaming is not universally available), and abort is
 * bridged from the caller's AbortSignal onto `xhr.abort()`.
 */

import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ClientAuthentication } from '@deepseek-ai/dsh-client-authentication'
import type { TransportPathResolver } from './target.ts'

/** One upload's raw inputs (a browser File satisfies every field structurally). */
export interface FileUploadRequest {
  /** File bytes, sent verbatim as the request body. */
  readonly data: Blob | ArrayBuffer | Uint8Array
  /** Declared MIME type; the Host strips parameters and echoes it in the receipt. */
  readonly mediaType?: string
  /** File name; URI-encoded onto the `x-attachment-name` header. */
  readonly name?: string
}

/** One image-staging upload's inputs; the declared media type drives Host admission. */
export interface ImageUploadRequest {
  /** Image bytes, sent verbatim as the request body. */
  readonly data: Blob | ArrayBuffer | Uint8Array
  /** Declared image MIME type the Host validates against the decoded bytes. */
  readonly mediaType: string
  /** Image name; URI-encoded onto the `x-attachment-name` header. */
  readonly name?: string
}

/** Upload progress report (bytes transferred of the total body). */
export interface FileUploadProgress {
  readonly loaded: number
  readonly total: number
}

/** Route-shaped failure: HTTP status plus the JSON error body's code when one was parsed. */
export class FileUploadError extends Error {
  /** HTTP status of the failed response. */
  readonly status: number
  /** Error code from the route's `{code, message}` JSON body, when parseable. */
  readonly code: string | undefined

  /** @param status - HTTP status. @param code - wire error code, when parsed. @param message - user-facing message. */
  constructor(status: number, code: string | undefined, message: string) {
    super(message)
    this.name = 'FileUploadError'
    this.status = status
    this.code = code
  }
}

/** Caller hooks around one upload. */
export interface FileUploadHooks {
  /** Upload progress (throttled by the engine, not by this layer). */
  onProgress?: (progress: FileUploadProgress) => void
  /** Cancellation; aborts the in-flight XHR and rejects the upload. */
  signal?: AbortSignal
}

/** Upload transport face: real (XHR) or fixture (in-memory). */
export type FileUploadTransport = (
  request: FileUploadRequest,
  hooks?: FileUploadHooks,
) => Promise<FileAttachmentRef>

/** Image-staging transport face: real (XHR) or fixture (in-memory). */
export type ImageUploadTransport = (
  request: ImageUploadRequest,
  hooks?: FileUploadHooks,
) => Promise<ImageAttachmentRef>

/** Structural receipt shape the routes return on 200. */
interface ReceiptShape {
  attachmentId?: unknown
  bytes?: unknown
  name?: unknown
  mediaType?: unknown
  width?: unknown
  height?: unknown
}

function receiptId(parsed: ReceiptShape): string | undefined {
  const id = parsed.attachmentId
  return typeof id === 'string' && /^sha256:[0-9a-f]{64}$/u.test(id) ? id : undefined
}

/** Validate and narrow the 200 body into a FileAttachmentRef. */
function parseReceipt(body: string): FileAttachmentRef | undefined {
  let parsed: ReceiptShape
  try {
    parsed = JSON.parse(body) as ReceiptShape
  } catch {
    return undefined
  }
  const id = receiptId(parsed)
  if (id === undefined || typeof parsed.bytes !== 'number') return undefined
  return {
    attachmentId: id as FileAttachmentRef['attachmentId'],
    bytes: parsed.bytes,
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    ...(typeof parsed.mediaType === 'string' ? { mediaType: parsed.mediaType } : {}),
  }
}

/** Validate and narrow the 200 body into an ImageAttachmentRef. */
function parseImageReceipt(body: string): ImageAttachmentRef | undefined {
  let parsed: ReceiptShape
  try {
    parsed = JSON.parse(body) as ReceiptShape
  } catch {
    return undefined
  }
  const id = receiptId(parsed)
  if (id === undefined || typeof parsed.bytes !== 'number') return undefined
  if (typeof parsed.mediaType !== 'string' || parsed.mediaType === '') return undefined
  if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return undefined
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: parsed.mediaType as ImageAttachmentRef['mediaType'],
    bytes: parsed.bytes,
    width: parsed.width,
    height: parsed.height,
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
  }
}

/** Bare XHR carrier over one route; `parse` validates the 200 receipt. */
function createXhrUpload<Ref>(
  resolveBase: () => string,
  resolvePath: TransportPathResolver,
  path: string,
  parse: (body: string) => Ref | undefined,
): (request: FileUploadRequest, hooks?: FileUploadHooks) => Promise<Ref> {
  return (request, hooks) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', new URL(resolvePath(path), resolveBase()).toString())
    if (request.mediaType !== undefined) xhr.setRequestHeader('content-type', request.mediaType)
    if (request.name !== undefined) xhr.setRequestHeader('x-attachment-name', encodeURIComponent(request.name))
    xhr.responseType = 'text'
    const signal = hooks?.signal
    const onAbort = (): void => { xhr.abort() }
    const settle = (finish: () => void): void => {
      signal?.removeEventListener('abort', onAbort)
      xhr.upload.onprogress = null
      finish()
    }
    xhr.upload.onprogress = (event) => {
      hooks?.onProgress?.({ loaded: event.loaded, total: event.total })
    }
    xhr.onload = () => {
      settle(() => {
        if (xhr.status < 200 || xhr.status >= 300) {
          if (xhr.status === 401 && xhr.getResponseHeader('x-dsh-authentication') === 'required') {
            reject(new FileUploadError(401, 'authentication-required', 'connection.upload: authentication required'))
            return
          }
          reject(httpError(xhr.status, xhr.responseText))
          return
        }
        const parsed = parse(xhr.responseText)
        if (parsed === undefined) {
          reject(new FileUploadError(xhr.status, undefined, 'connection.upload: malformed receipt'))
          return
        }
        resolve(parsed)
      })
    }
    xhr.onerror = () => {
      settle(() => {
        reject(new FileUploadError(0, undefined, 'connection.upload: network failure'))
      })
    }
    xhr.onabort = () => {
      settle(() => {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('connection.upload: aborted'))
      })
    }
    signal?.addEventListener('abort', onAbort)
    if (signal?.aborted) {
      settle(() => { reject(new Error('connection.upload: aborted')) })
      return
    }
    // XHR body typing wants ArrayBuffer-backed views; a Uint8Array over a
    // shared buffer (never the browser path) is copied into its own slice.
    const body: Document | XMLHttpRequestBodyInit = request.data instanceof Blob
      || request.data instanceof ArrayBuffer
      ? request.data
      : request.data.slice().buffer
    xhr.send(body)
  })
}

/** Wrap one upload with the shared admission check and single replay. */
function withAuthentication<Req extends FileUploadRequest, Ref>(
  upload: (request: Req, hooks?: FileUploadHooks) => Promise<Ref>,
  authentication: Pick<ClientAuthentication, 'ready' | 'check' | 'requireRefresh'>,
): (request: Req, hooks?: FileUploadHooks) => Promise<Ref> {
  return async (request, hooks) => {
    await authentication.ready(hooks?.signal)
    hooks?.signal?.throwIfAborted()
    try { return await upload(request, hooks) }
    catch (error) {
      if (!(error instanceof FileUploadError) || error.code !== 'authentication-required') throw error
      await authentication.check(hooks?.signal)
      await authentication.ready(hooks?.signal)
      hooks?.signal?.throwIfAborted()
      try { return await upload(request, hooks) }
      catch (retryError) {
        if (retryError instanceof FileUploadError && retryError.code === 'authentication-required') authentication.requireRefresh()
        throw retryError
      }
    }
  }
}

/**
 * Create the browser (XHR) file upload transport.
 * @param resolveBase - origin resolver (shared with the RPC carrier).
 * @param authentication - shared admission and recovery capability, retaining the XHR progress carrier.
 * @param resolvePath - maps the upload route to the selected transport target.
 * @returns transport posting raw bytes to the Host file-attachment route.
 */
export function createWebFileUploadTransport(
  resolveBase: () => string,
  authentication?: Pick<ClientAuthentication, 'ready' | 'check' | 'requireRefresh'>,
  resolvePath: TransportPathResolver = path => path,
): FileUploadTransport {
  const upload = createXhrUpload(resolveBase, resolvePath, '/api/attachment/upload', parseReceipt)
  return authentication === undefined ? upload : withAuthentication(upload, authentication)
}

/**
 * Create the browser (XHR) image-staging transport.
 * @param resolveBase - origin resolver (shared with the RPC carrier).
 * @param authentication - shared admission and recovery capability, retaining the XHR progress carrier.
 * @param resolvePath - maps the upload route to the selected transport target.
 * @returns transport posting raw bytes to the Host image-staging route.
 */
export function createWebImageUploadTransport(
  resolveBase: () => string,
  authentication?: Pick<ClientAuthentication, 'ready' | 'check' | 'requireRefresh'>,
  resolvePath: TransportPathResolver = path => path,
): ImageUploadTransport {
  const upload = createXhrUpload(resolveBase, resolvePath, '/api/attachment/upload-image', parseImageReceipt)
  return authentication === undefined ? upload : withAuthentication(upload, authentication)
}

/** Parse a route error body (`{code, message}` JSON) or fall back to a status line. */
function httpError(status: number, body: string): FileUploadError {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown }
    if (typeof parsed.code === 'string' && typeof parsed.message === 'string') {
      return new FileUploadError(status, parsed.code, parsed.message)
    }
  } catch {
    // Non-JSON bodies (the trust fence's plain-text rejections) use the fallback line.
  }
  return new FileUploadError(status, undefined, `connection.upload: HTTP ${status}`)
}
