/**
 * Explicit MCP OAuth authorization owned by the management Remote: one
 * attempt per server, its phases, its bounded lifetime, the public callback
 * route the authorization server redirects the browser to, and the grant
 * operations the server's connection carries out. The protocol steps belong
 * to `mcp-client`; this module owns the browser round trip and never lets a
 * code, state, or token reach a log, a status row, or an event.
 *
 * @module
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { McpLocalError } from '@deepseek-ai/dsh-mcp-client'
import type { McpConnectionsService, McpConnectionOAuth, McpOAuthFlow, SharedConnection } from '@deepseek-ai/dsh-mcp-client'
import type { McpFleetEntry } from './index.ts'
import type { McpAuthorizationStart, McpManagementAttempt, McpOAuthAttemptPhase } from './types.ts'

/** Prefix of every callback path; one server's path appends the SHA-256 hex of its settings id. */
const CALLBACK_PATH = '/mcp/oauth/callback'

/** Bytes of one attempt's state. */
const STATE_BYTES = 32

const LOOPBACK_HOSTS = new Set(['localhost', '[::1]'])

/** Host faces the authorization owner reads and drives. */
export interface McpAuthorizationDeps {
  /** Live shared connections keyed by stable server id. */
  readonly registry: McpConnectionsService
  /** Current fleet entries, re-read on every call. */
  readonly entries: () => readonly McpFleetEntry[]
  /** Announce that an attempt moved or a grant changed. */
  readonly changed: () => void
}

/** The web listener facts and route registry the callback needs (structural: this package does not depend on the webserver package). */
interface WebListener {
  readonly protocol: string
  readonly host: string
  readonly port: number
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

/** The connection's origin trust fence (structural: this package does not depend on the connection package). */
interface OriginTrust {
  isTrustedWebOrigin(origin: string): boolean
}

/** What the callback hands the code exchange. */
interface CallbackAnswer {
  code: string
  iss: string | undefined
}

/** One attempt while it exists on its server. */
interface Attempt {
  readonly id: string
  readonly serverId: string
  readonly oauth: McpConnectionOAuth
  readonly flow: McpOAuthFlow
  readonly state: string
  readonly redirect: URL
  readonly expiresAtMs: number
  readonly controller: AbortController
  readonly callback: PromiseWithResolvers<CallbackAnswer>
  /** The connection the attempt was started against. */
  readonly connection: SharedConnection
  phase: McpOAuthAttemptPhase
  /** The state was accepted once; every later callback is answered as gone. */
  consumed: boolean
  /** The authorization server itself ended the flow, such as a denied consent. */
  denied: boolean
  /** The deadline ended the attempt. */
  timedOut: boolean
  /** Resolves with the authorization page, or rejects when discovery failed. */
  readonly started: PromiseWithResolvers<McpAuthorizationStart>
  /** Settles once the attempt is terminal and its route and flow are released. */
  readonly done: PromiseWithResolvers<void>
  deadline: NodeJS.Timeout | undefined
  /** The effect disposer that removes the callback route. */
  removeRoute: (() => unknown) | undefined
}

const CALLBACK_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const

const callbackPage = (lines: readonly [string, string]): string => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width"><title>Harniverse</title>'
  + '<style>body{font:15px/1.6 system-ui,sans-serif;max-width:32em;margin:20vh auto;padding:0 1em}</style></head><body>'
  + `<p>${lines[0]}</p><p lang="en">${lines[1]}</p></body></html>`

/** The two static bilingual pages the callback answers with; neither names a request value. */
const CALLBACK_PAGES = {
  received: callbackPage(['已收到授权。可以关闭此页，回到 Harniverse 查看连接结果。', 'Authorization received. You can close this page and check the connection in Harniverse.']),
  incomplete: callbackPage(['授权未完成。请回到 Harniverse 重试。', 'Authorization was not completed. Return to Harniverse to try again.']),
} as const

/** Whether an attempt can still complete. */
function isPendingPhase(phase: McpOAuthAttemptPhase): boolean {
  return phase === 'starting' || phase === 'waiting-browser' || phase === 'exchanging' || phase === 'committing'
}

/** Canonical authority of one Host header, or `undefined` when it is not an authority. */
function authorityOf(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).host
  } catch {
    // A Host that is not an authority belongs to no redirect URI; it is refused like a foreign one.
    return undefined
  }
}

function isLoopbackHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a received state is the attempt's state, in constant time. */
function stateMatches(received: string, expected: string): boolean {
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The state of a well-formed callback: exactly one state, exactly one of a
 * code or an error, and at most one issuer. Every other callback answers `undefined`.
 */
function stateOf(params: URLSearchParams): string | undefined {
  const states = params.getAll('state')
  const wellFormed = states.length === 1
    && params.getAll('code').length <= 1
    && params.getAll('error').length <= 1
    && params.getAll('iss').length <= 1
    && params.has('code') !== params.has('error')
    && params.get('code') !== ''
    && params.get('error') !== ''
  return wellFormed ? states[0] : undefined
}

/** The explicit authorization attempts of the MCP fleet. */
export class McpAuthorizationCoordinator {
  private readonly attempts = new Map<string, Attempt>()

  /**
   * @param ctx - Provider context; the callback route and its disposer are effects of this fiber.
   * @param deps - Registry, fleet entries, and the change announcement.
   */
  constructor(
    private readonly ctx: Context,
    private readonly deps: McpAuthorizationDeps,
  ) {}

  /**
   * The latest attempt of one server.
   * @param serverId - Stable settings identity of the server.
   * @returns A detached view of the attempt, or `undefined` before the first one.
   */
  attemptOf(serverId: string): McpManagementAttempt | undefined {
    const attempt = this.attempts.get(serverId)
    return attempt === undefined ? undefined : { id: attempt.id, phase: attempt.phase, expiresAtMs: attempt.expiresAtMs }
  }

  /**
   * Start one explicit authorization, or join the attempt already pending.
   * @param serverId - Stable settings identity of an enabled OAuth-configured server.
   * @param redirectOrigin - Origin the browser is served from; omission uses the web listener's own loopback origin.
   * @returns The attempt and the authorization page the user opens.
   * @throws when the server is unknown, has no OAuth configuration, has no live connection, the web
   *   listener is absent, the redirect origin is not a serving authority, or discovery fails.
   */
  async start(serverId: string, redirectOrigin?: string): Promise<McpAuthorizationStart> {
    const pending = this.attempts.get(serverId)
    if (pending !== undefined && isPendingPhase(pending.phase)) return pending.started.promise
    const { oauth, connection } = this.connectionOf(serverId, 'enable it before authorizing')
    const redirect = new URL(`${CALLBACK_PATH}/${createHash('sha256').update(serverId).digest('hex')}`, this.redirectOrigin(redirectOrigin))
    const attempt: Attempt = {
      id: randomUUID(),
      serverId,
      oauth,
      connection,
      flow: oauth.createFlow(),
      state: randomBytes(STATE_BYTES).toString('base64url'),
      redirect,
      expiresAtMs: Date.now() + oauth.authorizationTimeoutMs,
      controller: new AbortController(),
      callback: Promise.withResolvers(),
      phase: 'starting',
      consumed: false,
      denied: false,
      timedOut: false,
      started: Promise.withResolvers(),
      done: Promise.withResolvers(),
      deadline: undefined,
      removeRoute: undefined,
    }
    this.attempts.set(serverId, attempt)
    this.deps.changed()
    // A cancelled start rejects a promise its caller may never have awaited.
    void attempt.started.promise.catch(() => undefined)
    void this.launch(attempt)
    return attempt.started.promise
  }

  /**
   * Cancel the pending attempt of one server and wait until its route and flow are released.
   * @param serverId - Stable settings identity of the server; an unknown or settled attempt is ignored.
   */
  async cancel(serverId: string): Promise<void> {
    const attempt = this.attempts.get(serverId)
    if (attempt === undefined || !isPendingPhase(attempt.phase)) return
    this.withdraw(attempt, `MCP OAuth authorization of server "${serverId}" was cancelled`)
    await Promise.all([attempt.started.promise.catch(() => undefined), attempt.done.promise])
  }

  /**
   * Delete the stored grant of one server.
   * @param serverId - Stable settings identity of an enabled OAuth-configured server.
   * @throws when the server is unknown, has no OAuth configuration, or has no live connection.
   */
  async signOut(serverId: string): Promise<void> {
    await this.connectionOf(serverId, 'enable it first').oauth.signOut()
    this.deps.changed()
  }

  /**
   * Re-judge an attempt after its server's connection changed: a pending
   * attempt against a replaced connection is cancelled, and a settled one is forgotten.
   * @param serverId - Stable settings identity of the server whose connection changed.
   */
  retire(serverId: string): void {
    const attempt = this.attempts.get(serverId)
    if (attempt === undefined || this.deps.registry.get(serverId) === attempt.connection) return
    if (isPendingPhase(attempt.phase)) {
      void this.cancel(serverId)
      return
    }
    this.attempts.delete(serverId)
  }

  /** Withdraw every pending attempt; the fiber's own disposal releases the routes. */
  dispose(): void {
    for (const attempt of this.attempts.values()) {
      if (isPendingPhase(attempt.phase)) this.withdraw(attempt, 'MCP OAuth authorization ended because the provider was disposed')
    }
  }

  /** End an attempt's own lifetime and abort the protocol step its flow is running. */
  private withdraw(attempt: Attempt, reason: string): void {
    attempt.controller.abort(new Error(reason))
    attempt.flow.dispose()
  }

  /** Register the callback route, run discovery, and hand out the authorization page. */
  private async launch(attempt: Attempt): Promise<void> {
    try {
      const web = this.webListener()
      attempt.removeRoute = this.ctx.effect(
        () => web.register({ kind: 'exact', path: attempt.redirect.pathname, handler: this.callbackHandler(attempt) }),
        'mcp-user-config: MCP OAuth callback',
      )
      const { authorizationUrl } = await attempt.flow.begin({ redirectUri: attempt.redirect.href, state: attempt.state })
      attempt.deadline = setTimeout(() => {
        attempt.timedOut = true
        attempt.controller.abort(new McpLocalError(`MCP OAuth authorization timed out after ${String(attempt.oauth.authorizationTimeoutMs)}ms`, 'MCP_OAUTH_FAILED'))
      }, attempt.oauth.authorizationTimeoutMs)
      attempt.deadline.unref()
      this.move(attempt, 'waiting-browser')
      void this.run(attempt)
      attempt.started.resolve({ attempt: this.view(attempt), authorizationUrl })
    } catch (error) {
      const cancelled = attempt.controller.signal.aborted
      this.move(attempt, cancelled ? 'cancelled' : 'failed')
      if (!cancelled) this.logFailure(attempt, error)
      this.release(attempt)
      attempt.done.resolve()
      attempt.started.reject(error)
    }
  }

  /** Await the browser round trip, then exchange and commit the grant. */
  private async run(attempt: Attempt): Promise<void> {
    const abort = (): void => { attempt.callback.reject(attempt.controller.signal.reason) }
    attempt.controller.signal.addEventListener('abort', abort, { once: true })
    try {
      const answer = await attempt.callback.promise
      this.move(attempt, 'exchanging')
      await attempt.flow.exchange(answer)
      this.disarm(attempt)
      this.move(attempt, 'committing')
      await attempt.flow.commit()
      this.move(attempt, 'authorized')
      attempt.oauth.resume()
    } catch (error) {
      const phase = attempt.denied || (attempt.controller.signal.aborted && !attempt.timedOut) ? 'cancelled' : 'failed'
      this.move(attempt, phase)
      if (phase === 'failed') this.logFailure(attempt, error)
    } finally {
      attempt.controller.signal.removeEventListener('abort', abort)
      this.release(attempt)
      attempt.done.resolve()
    }
  }

  /** The public route the authorization server redirects the browser to. */
  private callbackHandler(attempt: Attempt): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      const reply = (status: number, page: keyof typeof CALLBACK_PAGES): void => {
        res.writeHead(status, CALLBACK_HEADERS).end(CALLBACK_PAGES[page])
      }
      const host = req.headers.host
      // The authorization server's redirect is a cross-site navigation, so the
      // route admits it by the redirect URI's own authority and by nothing else;
      // the one-time state below is what authenticates the answer.
      if (host === undefined || authorityOf(host) !== attempt.redirect.host) {
        reply(404, 'incomplete')
        return
      }
      let received: URL
      try {
        /* v8 ignore next -- node:http always sets the request target on a server request. */
        received = new URL(req.url ?? '/', attempt.redirect.origin)
      } catch {
        // An unparsable request target is answered like any other incomplete answer; the web listener never logs it.
        reply(400, 'incomplete')
        return
      }
      if (received.pathname !== attempt.redirect.pathname) {
        reply(404, 'incomplete')
        return
      }
      if (req.method !== 'GET') {
        reply(405, 'incomplete')
        return
      }
      const params = received.searchParams
      const state = stateOf(params)
      if (state === undefined || !stateMatches(state, attempt.state)) {
        reply(400, 'incomplete')
        return
      }
      if (attempt.consumed || attempt.controller.signal.aborted || attempt.phase !== 'waiting-browser') {
        reply(410, 'incomplete')
        return
      }
      attempt.consumed = true
      const code = params.get('code')
      if (code === null) {
        attempt.denied = params.get('error') === 'access_denied'
        attempt.callback.reject(new McpLocalError('MCP OAuth authorization was refused by the authorization server', 'MCP_OAUTH_FAILED'))
        reply(200, 'incomplete')
        return
      }
      attempt.callback.resolve({ code, iss: params.get('iss') ?? undefined })
      reply(200, 'received')
    }
  }

  private view(attempt: Attempt): McpManagementAttempt {
    return { id: attempt.id, phase: attempt.phase, expiresAtMs: attempt.expiresAtMs }
  }

  private move(attempt: Attempt, phase: McpOAuthAttemptPhase): void {
    attempt.phase = phase
    this.deps.changed()
  }

  private release(attempt: Attempt): void {
    this.disarm(attempt)
    attempt.removeRoute?.()
    attempt.removeRoute = undefined
    attempt.flow.dispose()
  }

  private disarm(attempt: Attempt): void {
    if (attempt.deadline === undefined) return
    clearTimeout(attempt.deadline)
    attempt.deadline = undefined
  }

  private logFailure(attempt: Attempt, error: unknown): void {
    const message = error instanceof McpLocalError ? error.message : error instanceof Error ? error.name : 'unknown failure'
    this.ctx.logger.warn(`mcp-user-config: MCP OAuth authorization failed for server "${attempt.serverId}": ${message}`)
  }

  /** The live connection and OAuth capability of an enabled OAuth-configured server, or the reason there is none. */
  private connectionOf(serverId: string, unconnected: string): { oauth: McpConnectionOAuth; connection: SharedConnection } {
    const entry = this.deps.entries().find(candidate => candidate.entry.id === serverId)
    if (entry === undefined) throw new Error(`mcp-user-config: unknown server "${serverId}"`)
    if (entry.entry.oauth === undefined) throw new Error(`mcp-user-config: server "${serverId}" has no OAuth configuration`)
    const connection = this.deps.registry.get(serverId)
    const oauth = connection?.oauth
    if (connection === undefined || oauth === undefined) throw new Error(`mcp-user-config: server "${serverId}" has no live connection; ${unconnected}`)
    return { oauth, connection }
  }

  private webListener(): WebListener {
    const web = this.ctx.get('webServer') as WebListener | undefined
    if (web === undefined) throw new Error('mcp-user-config: explicit MCP OAuth authorization requires the web listener')
    return web
  }

  /**
   * The origin the redirect URI lives on: the browser's own when it is a
   * serving authority, else the web listener's loopback form.
   */
  private redirectOrigin(redirectOrigin: string | undefined): string {
    if (redirectOrigin === undefined) {
      const web = this.webListener()
      const host = web.host === '0.0.0.0' ? '127.0.0.1' : web.host
      return `${web.protocol}//${host}:${String(web.port)}`
    }
    const refusal = `mcp-user-config: redirect origin ${JSON.stringify(redirectOrigin)} is not a serving authority of this deployment`
    let parsed: URL
    try {
      parsed = new URL(redirectOrigin)
    } catch {
      throw new Error(refusal)
    }
    const loopback = isLoopbackHost(parsed.hostname)
    if (parsed.origin !== redirectOrigin || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))) throw new Error(refusal)
    if (loopback) return redirectOrigin
    const trust = this.ctx.get('connection') as OriginTrust | undefined
    if (trust === undefined || !trust.isTrustedWebOrigin(redirectOrigin)) throw new Error(refusal)
    return redirectOrigin
  }
}
