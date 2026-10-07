/**
 * Minimal Telegram Bot API client over `fetch`.
 *
 * Request shaping, error metadata, and the `getUpdates` long-poll parameters
 * are ported from dsh-im (`src/channels/telegram/telegram-api.mjs`), MIT
 * License, Copyright (c) 2026 xmanrui; see THIRD_PARTY_NOTICES.md.
 * @module @deepseek-ai/dsh-chat-adapter-telegram/api
 */

/** Telegram bot token: `<numeric bot id>:<secret>`. */
export const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,}$/

/** Facts of one failed Bot API call. */
export interface TelegramApiFacts {
  /** HTTP status of the answer; absent for transport failures. */
  status?: number
  /** Bot API `error_code`. */
  providerCode?: number
  /** Platform-advised wait in seconds (`parameters.retry_after`). */
  retryAfterSeconds?: number
  /** Request was aborted by its signal. */
  aborted?: boolean
  /** Request never produced an answer (network, timeout, invalid body). */
  transport?: boolean
  cause?: unknown
}

/** A failed Bot API call, before the adapter classifies it. */
export class TelegramApiError extends Error {
  /** HTTP status of the answer, when one arrived. */
  readonly status?: number
  /** Bot API `error_code` of the answer. */
  readonly providerCode?: number
  /** Delay the platform asked for before a retry (`parameters.retry_after`). */
  readonly retryAfterSeconds?: number
  /** Whether the caller's signal aborted the request. */
  readonly aborted: boolean
  /** Whether the request never produced an answer (network, timeout, invalid body). */
  readonly transport: boolean

  constructor(message: string, facts: TelegramApiFacts = {}) {
    super(message, facts.cause === undefined ? undefined : { cause: facts.cause })
    if (facts.status !== undefined) this.status = facts.status
    if (facts.providerCode !== undefined) this.providerCode = facts.providerCode
    if (facts.retryAfterSeconds !== undefined) this.retryAfterSeconds = facts.retryAfterSeconds
    this.aborted = facts.aborted === true
    this.transport = facts.transport === true
  }
}

/** Replaceable transport, for tests and proxies. */
export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>

/** Client construction. */
export interface TelegramApiOptions {
  /** Resolves the current bot token for one request; rejects while the credential is unset. */
  token(): Promise<string>
  baseUrl: string
  fetch: FetchLike
}

/** One call's cancellation and deadline. */
export interface CallOptions {
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
}

/** Bot API client. */
export class TelegramApi {
  constructor(private readonly options: TelegramApiOptions) {}

  /**
   * Call one Bot API method with a JSON (or multipart) payload.
   * @param method - Bot API method name.
   * @param payload - JSON object, or `FormData` for uploads.
   * @param call - cancellation and deadline.
   * @returns the method's `result`.
   * @throws {TelegramApiError} on transport failure, non-OK answers, and `ok: false` bodies.
   */
  async call<T = unknown>(method: string, payload: Record<string, unknown> | FormData, call: CallOptions = {}): Promise<T> {
    const token = await this.options.token()
    const url = new URL(`${this.options.baseUrl.replace(/\/$/, '')}/bot${token}/${method}`)
    const deadline = AbortSignal.timeout(call.timeoutMs ?? 15_000)
    const signal = call.signal === undefined ? deadline : AbortSignal.any([call.signal, deadline])
    let response: Response
    try {
      response = await this.options.fetch(url, {
        method: 'POST',
        ...payload instanceof FormData ? {} : { headers: { 'content-type': 'application/json' } },
        body: payload instanceof FormData ? payload : JSON.stringify(payload),
        signal,
        redirect: 'error',
      })
    } catch (error) {
      throw new TelegramApiError(`Telegram ${method} transport failed`, {
        transport: true, aborted: call.signal?.aborted === true, cause: error,
      })
    }
    let body: { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }
    try {
      body = await response.json() as typeof body
    } catch (error) {
      throw new TelegramApiError(`Telegram ${method} returned invalid JSON`, { status: response.status, transport: true, cause: error })
    }
    if (!response.ok || body.ok !== true) {
      const retryAfter = body.parameters?.retry_after
      throw new TelegramApiError(body.description ?? `Telegram ${method} failed`, {
        status: response.status,
        ...body.error_code === undefined ? {} : { providerCode: body.error_code },
        ...typeof retryAfter === 'number' && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {},
      })
    }
    return body.result as T
  }

  /**
   * Long-poll for updates.
   * @param offset - first update id to receive (acknowledges everything before it).
   * @param timeoutSeconds - server-side long-poll wait.
   * @param signal - cancellation.
   * @returns pending updates.
   */
  getUpdates(offset: number | undefined, timeoutSeconds: number, signal: AbortSignal): Promise<unknown[]> {
    return this.call<unknown[]>('getUpdates', {
      timeout: timeoutSeconds,
      limit: 100,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      ...offset === undefined ? {} : { offset },
    }, { signal, timeoutMs: Math.max(10_000, (timeoutSeconds + 10) * 1_000) })
  }

  /**
   * Download a file by its Bot API file id.
   * @param fileId - `file_id` from an inbound message.
   * @param signal - cancellation.
   * @returns the raw response (status checked) and the size Telegram reported.
   */
  async download(fileId: string, signal: AbortSignal): Promise<{ response: Response; body: ReadableStream<Uint8Array>; size?: number }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId }, { signal })
    const path = file.file_path
    const segments = path?.split('/') ?? []
    if (path === undefined || path.startsWith('/') || path.includes('\\') || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new TelegramApiError('Telegram returned an invalid file path')
    }
    const token = await this.options.token()
    const url = new URL(`${this.options.baseUrl.replace(/\/$/, '')}/file/bot${token}/${path}`)
    let response: Response
    try {
      response = await this.options.fetch(url, { method: 'GET', signal, redirect: 'error' })
    } catch (error) {
      throw new TelegramApiError('Telegram file download failed', { transport: true, aborted: signal.aborted, cause: error })
    }
    const body = response.body
    if (!response.ok || body === null) throw new TelegramApiError('Telegram file download failed', { status: response.status })
    return { response, body, ...file.file_size === undefined ? {} : { size: file.file_size } }
  }
}
