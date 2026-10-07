/**
 * Feishu/Lark Open API client over `fetch`: tenant token caching with one
 * refresh retry, message send/update/delete, file upload, and resource
 * download.
 * @module @deepseek-ai/dsh-chat-adapter-feishu/api
 */

import type { FetchLike } from './runtime.ts'

/** Feishu `app_id` shape. */
export const APP_ID_PATTERN = /^cli_[0-9a-zA-Z]{8,32}$/

/** Codes that mean the tenant token must be replaced. */
const TOKEN_CODES = new Set([99991661, 99991663, 99991668])
/** Codes that mean the app credentials themselves are wrong. */
const CREDENTIAL_CODES = new Set([10003, 10012, 10014])

/** Facts of one failed Open API call. */
export interface FeishuApiFacts {
  status?: number
  code?: number
  retryAfterSeconds?: number
  transport?: boolean
  cause?: unknown
}

/** A failed Open API call, before the adapter classifies it. */
export class FeishuApiError extends Error {
  /** HTTP status of the answer, when one arrived. */
  readonly status?: number
  /** Feishu business `code` of the answer. */
  readonly code?: number
  /** Delay the platform asked for before a retry. */
  readonly retryAfterSeconds?: number
  /** Whether the request never produced an answer (network, timeout, invalid body). */
  readonly transport: boolean

  constructor(message: string, facts: FeishuApiFacts = {}) {
    super(message, facts.cause === undefined ? undefined : { cause: facts.cause })
    if (facts.status !== undefined) this.status = facts.status
    if (facts.code !== undefined) this.code = facts.code
    if (facts.retryAfterSeconds !== undefined) this.retryAfterSeconds = facts.retryAfterSeconds
    this.transport = facts.transport === true
  }

  /** Whether the failure means the credentials are rejected. */
  get credentialRejected(): boolean {
    return this.code !== undefined && (TOKEN_CODES.has(this.code) || CREDENTIAL_CODES.has(this.code))
  }
}

/** Client construction. */
export interface FeishuApiOptions {
  appId: string
  secret(): Promise<string>
  domain: string
  fetch: FetchLike
}

/** One request. */
export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query?: Record<string, string>
  json?: unknown
  form?: FormData
  signal?: AbortSignal | undefined
  timeoutMs?: number
}

/** Open API client for one app. */
export class FeishuApi {
  private token: { value: string; expiresAt: number } | undefined

  constructor(private readonly options: FeishuApiOptions) {}

  private async tenantToken(signal?: AbortSignal): Promise<string> {
    if (this.token !== undefined && this.token.expiresAt - 60_000 > Date.now()) return this.token.value
    const body = await this.send({
      method: 'POST', path: '/open-apis/auth/v3/tenant_access_token/internal',
      json: { app_id: this.options.appId, app_secret: await this.options.secret() }, signal,
    }, false)
    const parsed = body as { tenant_access_token?: string; expire?: number }
    if (parsed.tenant_access_token === undefined) throw new FeishuApiError('token endpoint returned no token')
    this.token = { value: parsed.tenant_access_token, expiresAt: Date.now() + (parsed.expire ?? 7_200) * 1_000 }
    return this.token.value
  }

  private async send(spec: RequestSpec, authenticated: boolean, raw = false): Promise<unknown> {
    const url = new URL(spec.path, this.options.domain)
    for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value)
    const headers: Record<string, string> = {}
    if (authenticated) headers.authorization = `Bearer ${await this.tenantToken(spec.signal)}`
    if (spec.json !== undefined) headers['content-type'] = 'application/json'
    const deadline = AbortSignal.timeout(spec.timeoutMs ?? 15_000)
    let response: Response
    try {
      response = await this.options.fetch(url, {
        method: spec.method, headers,
        ...spec.json === undefined ? {} : { body: JSON.stringify(spec.json) },
        ...spec.form === undefined ? {} : { body: spec.form },
        signal: spec.signal === undefined ? deadline : AbortSignal.any([spec.signal, deadline]),
        redirect: 'error',
      })
    } catch (error) {
      throw new FeishuApiError(`Feishu ${spec.method} ${spec.path} transport failed`, { transport: true, cause: error })
    }
    if (raw && response.ok) return response
    const retryAfter = Number(response.headers.get('x-ogw-ratelimit-reset'))
    let body: { code?: number; msg?: string; data?: unknown }
    try {
      body = await response.json() as typeof body
    } catch (error) {
      throw new FeishuApiError(`Feishu ${spec.path} returned an unreadable answer`, { status: response.status, transport: true, cause: error })
    }
    if (!response.ok || (body.code ?? 0) !== 0) {
      throw new FeishuApiError(body.msg ?? `Feishu ${spec.path} failed`, {
        status: response.status,
        ...body.code === undefined ? {} : { code: body.code },
        ...Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {},
      })
    }
    return body
  }

  private async authenticated(spec: RequestSpec): Promise<{ data?: unknown }> {
    try {
      return await this.send(spec, true) as { data?: unknown }
    } catch (error) {
      if (!(error instanceof FeishuApiError) || error.code === undefined || !TOKEN_CODES.has(error.code)) throw error
      this.token = undefined
      return await this.send(spec, true) as { data?: unknown }
    }
  }

  /**
   * Call an authenticated endpoint, replacing a rejected tenant token once.
   * @param spec - the request.
   * @returns the response `data` object (empty when the answer carries none).
   * @throws {FeishuApiError} on transport failure or a non-zero code.
   */
  async call<T = Record<string, unknown>>(spec: RequestSpec): Promise<T> {
    return ((await this.authenticated(spec)).data ?? {}) as T
  }

  /**
   * Like {@link FeishuApi.call}, for the few endpoints that answer outside `data`.
   * @param spec - the request.
   * @returns the whole response body.
   */
  async callBody<T>(spec: RequestSpec): Promise<T> {
    return await this.authenticated(spec) as T
  }

  /**
   * Download a message resource.
   * @param messageId - message the resource belongs to.
   * @param key - `image_key` or `file_key`.
   * @param type - `image` or `file`.
   * @param signal - cancellation.
   * @returns the raw successful response.
   */
  async download(messageId: string, key: string, type: 'image' | 'file', signal: AbortSignal): Promise<Response> {
    const spec: RequestSpec = { method: 'GET', path: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}`, query: { type }, signal, timeoutMs: 60_000 }
    try {
      return await this.send(spec, true, true) as Response
    } catch (error) {
      if (!(error instanceof FeishuApiError) || error.code === undefined || !TOKEN_CODES.has(error.code)) throw error
      this.token = undefined
      return await this.send(spec, true, true) as Response
    }
  }
}
