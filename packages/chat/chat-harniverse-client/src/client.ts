/**
 * The chat bridge's only `/api` client (`ctx.harniverseClient`). It
 * authenticates with a public-key Grant through `GrantAccess`, restricts every
 * request to the closed tables in `endpoints.ts`, captures the carrier's
 * principal identity for `expectedPrincipal`, and forwards `Idempotency-Key`
 * for mutating methods. Remote isolation is one `dshRemoteHost` query
 * parameter on every request kind; the local carrier rewrites the principal.
 * @module @deepseek-ai/dsh-chat-harniverse-client/client
 */

import { createPrivateKey, randomUUID, sign } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { GrantAccess } from '@deepseek-ai/dsh-sdk-client'
import {
  CARRIER_ENDPOINTS, isTypertEndpoint, isUnaryMethod, UNARY_ENDPOINTS,
  type TypertEndpoint, type UnaryMethod, type UnaryValue,
} from './endpoints.ts'
import { describeError, HarniverseError } from './errors.ts'
import { internals } from './internals.ts'
import { HarniverseMux, type MuxHost } from './mux.ts'
import type {
  CallOptions, HarniversePrincipal, HostDescription, MuxOptions, RespondReceipt,
  RespondResult, UploadedAttachment,
} from './types.ts'
import { grantPrincipal, receiptSchema, serverResponseSchema, uploadedAttachmentSchema, type WirePrincipal } from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    harniverseClient: HarniverseClient
  }

  interface Events {
    /**
     * A request is about to leave the client. The package invariant checks that
     * `target` belongs to the closed endpoint table of its `kind`.
     * @param info - request kind and the endpoint, method, or path it addresses.
     * @mode emit
     */
    'chat-harniverse/request'(info: { kind: 'unary' | 'typert' | 'respond' | 'upload' | 'mux'; target: string }): void
  }
}

/** Lowercase RFC 4122 version-4 UUID, the only remote-host id form the carrier accepts. */
const REMOTE_HOST_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Credential reference the Grant id is stored under by default. */
export const DEFAULT_GRANT_ID_REF = 'DSH_CHAT_BRIDGE_GRANT_ID'
/** Credential reference the Grant signing key is stored under by default. */
export const DEFAULT_SIGNING_KEY_REF = 'DSH_CHAT_BRIDGE_SIGNING'

/** Client deployment configuration. */
export interface Config {
  /** Harniverse origin: loopback HTTP, or HTTPS. */
  origin: string
  /** Grant id; when omitted it is read from the credential named by `grantIdRef`. */
  grantId?: string
  /** Credential reference holding the Grant id written by `dsh chat init`. */
  grantIdRef: string
  /** Credential reference holding the PKCS#8 DER (base64url) P-256 signing key. */
  signingKeyRef: string
  /** Per-request timeout. */
  requestTimeoutMs: number
  /** Replace the mux socket this long after it opened; must stay below the Access Token lifetime cap. */
  muxRenewAfterMs: number
  /** First reconnect delay. */
  reconnectMinMs: number
  /** Reconnect delay ceiling. */
  reconnectMaxMs: number
}

/** Longest allowed mux renewal interval: the 15-minute Access Token cap minus a safety margin. */
export const MAX_MUX_RENEW_AFTER_MS = 14 * 60_000

/** What a deployment may write for the client row: every key has a schema default except an explicit `grantId`, so all are optional. */
export type ConfigInput = Partial<Config>

/** Loader validation for the client row. */
export const Config: z<ConfigInput, Config> = z.object({
  origin: z.string().default('http://127.0.0.1:3080'),
  grantId: z.string().min(1),
  grantIdRef: z.string().default(DEFAULT_GRANT_ID_REF),
  signingKeyRef: z.string().default(DEFAULT_SIGNING_KEY_REF),
  requestTimeoutMs: z.number().step(1).min(1).default(30_000),
  muxRenewAfterMs: z.number().step(1).min(1).max(MAX_MUX_RENEW_AFTER_MS).default(9 * 60_000),
  reconnectMinMs: z.number().step(1).min(1).default(1_000),
  reconnectMaxMs: z.number().step(1).min(1).default(30_000),
})

/** Options of one envelope request. */
interface EnvelopeRequest {
  path: string
  method: string
  payload: unknown
  /** Send `expectedPrincipal` (mutating unary methods). */
  expectPrincipal: boolean
  /** Send `Idempotency-Key` when the caller supplied one. */
  idempotent: boolean
}

/** The `/api` client service. */
export default class HarniverseClient extends Service implements MuxHost {
  static inject = ['credentials']
  static Config = Config

  private grantAccess: Promise<GrantAccess> | undefined
  private principal: HarniversePrincipal | undefined

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'harniverseClient')
    if (config.reconnectMinMs > config.reconnectMaxMs) {
      throw new RangeError('chat-harniverse-client: reconnectMinMs must not exceed reconnectMaxMs')
    }
    ctx.effect(() => () => {
      this.grantAccess = undefined
      this.principal = undefined
    }, 'chat-harniverse-client.state')
  }

  /**
   * Call one method of the closed unary table.
   * @param method - a key of `UNARY_ENDPOINTS`; any other method is refused locally.
   * @param payload - method payload.
   * @param options - remote host, idempotency key, cancellation.
   * @returns the schema-validated response value.
   * @throws {HarniverseError} `endpoint-denied` for a method outside the table, `rpc-rejected` for a business error.
   */
  async call<M extends UnaryMethod>(method: M, payload: unknown, options: CallOptions = {}): Promise<UnaryValue<M>> {
    if (!isUnaryMethod(method)) throw this.denied(`method ${JSON.stringify(method)}`)
    this.checkRemoteHost(options.remoteHost)
    const row = UNARY_ENDPOINTS[method]
    this.ctx.emit('chat-harniverse/request', { kind: 'unary', target: method })
    const value = await this.envelope({
      path: `/api/${method}`, method, payload, expectPrincipal: row.mutating, idempotent: row.mutating,
    }, options)
    return this.parseValue<unknown>(row.value, value, method) as UnaryValue<M>
  }

  /**
   * Call one endpoint of the closed Typert table.
   * @param endpoint - `commands/execute`; any other endpoint is refused locally.
   * @param args - the Typert `args` object.
   * @param options - remote host, idempotency key, cancellation.
   * @returns the raw response value.
   */
  async typert(endpoint: TypertEndpoint, args: Record<string, unknown>, options: CallOptions = {}): Promise<unknown> {
    if (!isTypertEndpoint(endpoint)) throw this.denied(`endpoint ${JSON.stringify(endpoint)}`)
    this.checkRemoteHost(options.remoteHost)
    this.ctx.emit('chat-harniverse/request', { kind: 'typert', target: endpoint })
    return this.envelope({
      path: `/api/${endpoint}`, method: endpoint, payload: { args }, expectPrincipal: false, idempotent: true,
    }, options)
  }

  /**
   * Describe the Host behind this client (or one remote runtime).
   * @param options - remote host and cancellation.
   * @returns the boot identity and version.
   */
  describeHost(options: CallOptions = {}): Promise<HostDescription> {
    return this.call('host.describe', {}, options) as Promise<HostDescription>
  }

  /**
   * Answer a pending approval or question frame.
   * @param rpcId - the `rpcId` of the `approval/requested` or `question/requested` server request.
   * @param result - the response result slot.
   * @param options - remote host and cancellation.
   * @returns the carrier receipt; `not-pending` means a faster responder won.
   */
  async respond(rpcId: string, result: RespondResult, options: CallOptions = {}): Promise<RespondReceipt> {
    this.checkRemoteHost(options.remoteHost)
    this.ctx.emit('chat-harniverse/request', { kind: 'respond', target: CARRIER_ENDPOINTS.respond })
    for (let attempt = 0; ; attempt += 1) {
      const body = { type: 'client-response', rpcId, result, expectedPrincipal: await this.expectedPrincipal() }
      const response = await this.post(CARRIER_ENDPOINTS.respond, JSON.stringify(body), { 'content-type': 'application/json' }, options)
      const receipt = this.parseValue(receiptSchema, await this.json(response, 'respond'), 'respond')
      this.observe(receipt.authentication, options)
      if (receipt.accepted) return { accepted: true }
      if (receipt.reason === 'authentication-principal-mismatch' && attempt === 0 && options.remoteHost === undefined) continue
      return { accepted: false, reason: receipt.reason }
    }
  }

  /**
   * Upload one file for a later `session.prompt` file part.
   * @param data - file bytes.
   * @param meta - display name and media type.
   * @param options - remote host and cancellation.
   * @returns the stored attachment handle.
   */
  async upload(
    data: Uint8Array<ArrayBuffer>,
    meta: { name?: string; mediaType?: string },
    options: CallOptions = {},
  ): Promise<UploadedAttachment> {
    this.checkRemoteHost(options.remoteHost)
    this.ctx.emit('chat-harniverse/request', { kind: 'upload', target: CARRIER_ENDPOINTS.upload })
    const headers: Record<string, string> = { 'content-type': meta.mediaType ?? 'application/octet-stream' }
    if (meta.name !== undefined) headers['x-attachment-name'] = encodeURIComponent(meta.name)
    const response = await this.post(CARRIER_ENDPOINTS.upload, data, headers, options)
    return this.parseValue(uploadedAttachmentSchema, await this.json(response, 'upload'), 'upload') as UploadedAttachment
  }

  /**
   * Open a resumable event mux whose lifetime is bound to the calling effect scope.
   * @param options - frame handler, resume cursors, and optional remote host.
   * @returns the mux, already connecting.
   */
  openMux(options: MuxOptions): HarniverseMux {
    const mux = new HarniverseMux(this, options)
    this.ctx.effect(() => () => { mux.close() }, 'chat-harniverse-client.mux')
    mux.start()
    return mux
  }

  // ---- MuxHost ----

  /**
   * Produce the `Authorization` header value for one request or socket upgrade.
   * @returns `Bearer <Access Token>`, renewed before the token expires.
   * @throws `authentication-failed` when the challenge exchange fails.
   */
  async authorization(): Promise<string> {
    const access = await this.access()
    try {
      return await access.authorization()
    } catch (error) {
      throw new HarniverseError('authentication-failed',
        `cannot obtain an Access Token (${describeError(error)}); check that the Harniverse web instance runs with authentication and the chat-bridge Grant is registered`,
        { cause: error })
    }
  }

  /**
   * Build the `events.mux` WebSocket URL that resumes the given cursors.
   * @param cursors - last applied event seq per session id; omitted when empty.
   * @param remoteHost - remote runtime to forward to, or undefined for the local Host.
   * @returns the `ws:` or `wss:` URL.
   */
  muxUrl(cursors: Readonly<Record<string, number>>, remoteHost: string | undefined): URL {
    const url = this.url(CARRIER_ENDPOINTS.mux, remoteHost)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    if (Object.keys(cursors).length > 0) url.searchParams.set('since', JSON.stringify(cursors))
    this.ctx.emit('chat-harniverse/request', { kind: 'mux', target: CARRIER_ENDPOINTS.mux })
    return url
  }

  /**
   * Record the principal a mux frame carried, so later mutating calls send a matching `expectedPrincipal`.
   * @param principal - the principal the carrier reported.
   */
  learnIdentity(principal: WirePrincipal): void {
    this.observe(principal, {})
  }

  /**
   * Log a warning through the plugin logger.
   * @param message - what happened.
   * @param error - the cause, appended to the message when present.
   */
  warn(message: string, error?: unknown): void {
    this.ctx.logger.warn(error === undefined ? message : `${message}: ${describeError(error)}`)
  }

  // ---- internals ----

  private denied(what: string): HarniverseError {
    const error = new HarniverseError('endpoint-denied', `${what} is outside the chat bridge endpoint table`)
    this.ctx.logger.warn(error.message)
    return error
  }

  private access(): Promise<GrantAccess> {
    this.grantAccess ??= this.buildAccess().catch((error: unknown) => {
      this.grantAccess = undefined
      throw error
    })
    return this.grantAccess
  }

  private async buildAccess(): Promise<GrantAccess> {
    const grantId = this.config.grantId ?? (await this.ctx.credentials.resolve(credentialRef(this.config.grantIdRef)))?.value
    if (grantId === undefined) {
      throw new HarniverseError('credential-missing', `no Grant id: set grantId or credential ${this.config.grantIdRef} (run \`dsh chat init\`)`)
    }
    return new GrantAccess({
      origin: this.config.origin,
      grantId,
      fetch: (input, init) => internals.fetch(input, init),
      signChallenge: payload => this.signChallenge(payload),
    })
  }

  private async signChallenge(payload: string): Promise<string> {
    const secret = await this.ctx.credentials.resolve(credentialRef(this.config.signingKeyRef))
    if (secret === undefined) {
      throw new HarniverseError('credential-missing', `no signing key: credential ${this.config.signingKeyRef} is unset (run \`dsh chat init\`)`)
    }
    const key = createPrivateKey({ key: Buffer.from(secret.value, 'base64url'), format: 'der', type: 'pkcs8' })
    return sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  }

  /** Refuse a malformed remote host id before any identity or network work. */
  private checkRemoteHost(remoteHost: string | undefined): void {
    if (remoteHost !== undefined && !REMOTE_HOST_PATTERN.test(remoteHost)) {
      throw new HarniverseError('remote-host-invalid', `remote host ${JSON.stringify(remoteHost)} is not a lowercase v4 UUID`)
    }
  }

  private url(path: string, remoteHost: string | undefined): URL {
    this.checkRemoteHost(remoteHost)
    const url = new URL(path, this.config.origin)
    if (remoteHost !== undefined) url.searchParams.set('dshRemoteHost', remoteHost)
    return url
  }

  private async post(
    path: string,
    body: string | Uint8Array<ArrayBuffer>,
    headers: Record<string, string>,
    options: CallOptions,
  ): Promise<Response> {
    const url = this.url(path, options.remoteHost)
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.config.requestTimeoutMs),
      ...options.signal === undefined ? [] : [options.signal],
    ])
    const authorization = await this.authorization()
    let response: Response
    try {
      response = await internals.fetch(url, { method: 'POST', headers: { ...headers, authorization }, body, signal, redirect: 'error' })
    } catch (error) {
      throw new HarniverseError('transport-failed', `${path} request failed: ${describeError(error)}`, { cause: error })
    }
    if (!response.ok) throw new HarniverseError('transport-failed', `${path} answered HTTP ${String(response.status)}`, { status: response.status })
    return response
  }

  private async json(response: Response, what: string): Promise<unknown> {
    try {
      return await response.json()
    } catch (error) {
      throw new HarniverseError('protocol-violation', `${what} response is not JSON`, { cause: error })
    }
  }

  private parseValue<T>(schema: { parse(value: unknown): T }, value: unknown, what: string): T {
    try {
      return schema.parse(value)
    } catch (error) {
      throw new HarniverseError('protocol-violation', `${what} response has an unexpected shape`, { cause: error })
    }
  }

  /** The grant identity sent as `expectedPrincipal`; the first use learns it with a read. */
  private async expectedPrincipal(): Promise<HarniversePrincipal> {
    if (this.principal === undefined) await this.describeHost()
    /* v8 ignore next 3 -- observe() throws for bypass identity and otherwise assigns, so describeHost always leaves a principal */
    if (this.principal === undefined) throw new HarniverseError('authentication-failed', 'the carrier reported no grant identity')
    return this.principal
  }

  /** Record a local-path identity; remote-path identities belong to the remote runtime and are ignored. */
  private observe(principal: WirePrincipal, options: { remoteHost?: string | undefined }): void {
    if (options.remoteHost !== undefined) return
    const grant = grantPrincipal(principal)
    if (grant === undefined) {
      throw new HarniverseError('authentication-failed', 'the Harniverse instance runs without authentication; the chat bridge requires an authenticated instance')
    }
    this.principal = grant
  }

  private async envelope(request: EnvelopeRequest, options: CallOptions): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const rpcId = options.rpcId ?? randomUUID()
      const body = {
        type: 'client-request', rpcId, method: request.method, payload: request.payload,
        ...request.expectPrincipal ? { expectedPrincipal: await this.expectedPrincipal() } : {},
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (request.idempotent && options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey
      const response = await this.post(request.path, JSON.stringify(body), headers, options)
      const parsed = this.parseValue(serverResponseSchema, await this.json(response, request.method), request.method)
      if (parsed.rpcId !== rpcId) throw new HarniverseError('protocol-violation', `${request.method} response echoed another rpcId`)
      this.observe(parsed.authentication, options)
      if (parsed.result.ok) return parsed.result.value
      const { code, message } = parsed.result.error
      if (code === 'authentication-principal-mismatch' && attempt === 0 && options.remoteHost === undefined) continue
      throw new HarniverseError('rpc-rejected', `${request.method} rejected: ${code}: ${message}`, { rpcCode: code })
    }
  }
}
