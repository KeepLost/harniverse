/**
 * Browser upload transport for the Host file-attachment route
 * (`POST /api/attachment/upload`; raw bytes body, receipt JSON response).
 *
 * XHR rather than fetch: upload progress needs `xhr.upload.onprogress`
 * (fetch request-body streaming is not universally available), and abort is
 * bridged from the caller's AbortSignal onto `xhr.abort()`.
 */

import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** One upload's raw inputs (a browser File satisfies every field structurally). */
export interface FileUploadRequest {
  /** File bytes, sent verbatim as the request body. */
  readonly data: Blob | ArrayBuffer | Uint8Array
  /** Declared MIME type; the Host strips parameters and echoes it in the receipt. */
  readonly mediaType?: string
  /** File name; URI-encoded onto the `x-attachment-name` header. */
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

/** Structural receipt shape the route returns on 200. */
interface ReceiptShape {
  attachmentId?: unknown
  bytes?: unknown
  name?: unknown
  mediaType?: unknown
}

/**
 * Create the browser (XHR) upload transport.
 * @param resolveBase - origin resolver (shared with the RPC carrier).
 * @returns transport posting raw bytes to the Host attachment route.
 */
export function createWebFileUploadTransport(resolveBase: () => string): FileUploadTransport {
  return (request, hooks) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', new URL('/api/attachment/upload', resolveBase()).toString())
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
          reject(httpError(xhr.status, xhr.responseText))
          return
        }
        const parsed = parseReceipt(xhr.responseText)
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

/** Validate and narrow the 200 body into a FileAttachmentRef. */
function parseReceipt(body: string): FileAttachmentRef | undefined {
  let parsed: ReceiptShape
  try {
    parsed = JSON.parse(body) as ReceiptShape
  } catch {
    return undefined
  }
  const id = parsed.attachmentId
  if (typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(id)) return undefined
  if (typeof parsed.bytes !== 'number') return undefined
  return {
    attachmentId: id as FileAttachmentRef['attachmentId'],
    bytes: parsed.bytes,
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    ...(typeof parsed.mediaType === 'string' ? { mediaType: parsed.mediaType } : {}),
  }
}
