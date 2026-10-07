/** In-process fake of the Harniverse `/api` carrier: Grant token exchange plus scripted RPC answers. */

import { createPublicKey, generateKeyPairSync, randomUUID, verify, type KeyObject } from 'node:crypto'
import { CredentialProvider, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'

/** One request the carrier observed. */
export interface RecordedRequest {
  method: string
  url: URL
  headers: Headers
  /** Parsed JSON body, or the raw bytes for an upload. */
  body: unknown
}

/** Scripted answer: a status, a JSON body, or a function deriving either from the request. */
export type Answer = { status: number; body?: unknown } | { json: unknown } | ((request: RecordedRequest) => Answer)

/** Identity as the carrier reports it. */
export interface Identity {
  kind: 'grant'
  grantId: string
  grantRevision: number
}

/** Scripted fake carrier plus the credentials that authenticate against it. */
export class FakeCarrier {
  readonly requests: RecordedRequest[] = []
  /** Challenge and token exchanges, kept apart from API traffic. */
  readonly authRequests: RecordedRequest[] = []
  readonly signingKey: string
  identity: Identity = { kind: 'grant', grantId: 'grant-1', grantRevision: 1 }
  /** Answers queued per `METHOD path`; the last one repeats. */
  private readonly scripts = new Map<string, Answer[]>()
  private readonly challenges = new Map<string, string>()
  private readonly publicKey: KeyObject
  /** When set, every RPC answer reports this authentication instead of {@link FakeCarrier.identity}. */
  identityOverride: unknown
  tokensIssued = 0
  challengeStatus = 200

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    this.publicKey = createPublicKey(pair.privateKey)
    this.signingKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  }

  /**
   * Script the answers for one endpoint.
   * @param key - `POST /api/session.create` style key.
   * @param answers - answers served in order; the last repeats.
   */
  script(key: string, ...answers: Answer[]): void {
    this.scripts.set(key, answers)
  }

  /**
   * Script successful RPC answers for one endpoint: each answer echoes the request's own `rpcId`.
   * @param key - `POST /api/session.create` style key.
   * @param values - response values served in order; the last repeats.
   */
  ok(key: string, ...values: unknown[]): void {
    this.script(key, ...values.map(value => (request: RecordedRequest): Answer => this.rpc(request, value)))
  }

  /** @returns requests whose path equals `path`. */
  to(path: string): RecordedRequest[] {
    return this.requests.filter(request => request.url.pathname === path)
  }

  /** An RPC answer for the request envelope that `request` carries. */
  rpc(request: RecordedRequest, value: unknown, authentication: unknown = this.identityOverride ?? this.identity): { json: unknown } {
    const rpcId = (request.body as { rpcId: string }).rpcId
    return { json: { type: 'server-response', rpcId, result: { ok: true, value }, authentication } }
  }

  /** An RPC business-error answer. */
  rpcError(request: RecordedRequest, code: string, authentication: unknown = this.identityOverride ?? this.identity): { json: unknown } {
    const rpcId = (request.body as { rpcId: string }).rpcId
    return { json: { type: 'server-response', rpcId, result: { ok: false, error: { code, message: `${code} happened`, details: {} } }, authentication } }
  }

  /** The replacement for `internals.fetch`. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    const headers = new Headers(init?.headers)
    const method = init?.method ?? 'GET'
    const raw = init?.body
    let body: unknown = raw
    if (typeof raw === 'string') body = JSON.parse(raw) as unknown
    const request: RecordedRequest = { method, url, headers, body }
    if (url.pathname.startsWith('/auth/')) this.authRequests.push(request)
    if (url.pathname === '/auth/challenge') {
      if (this.challengeStatus !== 200) return new Response('nope', { status: this.challengeStatus })
      const id = randomUUID()
      const payload = `challenge-${id}`
      this.challenges.set(id, payload)
      return Response.json({ id, payload, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    }
    if (url.pathname === '/auth/token') {
      const { challengeId, signature } = body as { challengeId: string; signature: string }
      const payload = this.challenges.get(challengeId)
      const valid = payload !== undefined && verify('sha256', Buffer.from(payload), { key: this.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
      if (!valid) return new Response('bad signature', { status: 401 })
      this.tokensIssued += 1
      return Response.json({ accessToken: `token-${String(this.tokensIssued)}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() })
    }
    this.requests.push(request)
    const queue = this.scripts.get(`${method} ${url.pathname}`)
    let answer: Answer = queue === undefined ? { status: 404 } : queue.length > 1 ? queue.shift()! : queue[0]!
    while (typeof answer === 'function') answer = answer(request)
    if ('json' in answer) return Response.json(answer.json)
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status })
  }
}

/** In-memory credential provider holding the test secrets. */
export class MemoryCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly values: Map<string, string>) {
    super(ctx)
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<{ configured: boolean; writable: boolean }> {
    return Promise.resolve({ configured: this.values.has(ref), writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    return Promise.resolve()
  }
}
