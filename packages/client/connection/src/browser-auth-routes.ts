/** Browser login/status/logout routes mounted before the client plugin graph starts. */
import type { Context } from '@deepseek-ai/cordis'
import {
  authenticationChallengeId,
  authenticationEnrollmentId,
  authenticationGrantId,
  isAuthenticationCapability,
  type AuthenticationCapability,
  type AuthenticationEnrollmentDecision,
  type AuthenticationChallengeProof,
  type AuthenticationPrincipal,
} from '@deepseek-ai/dsh-authentication'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { bridge, type FetchHandler } from './http-bridge.ts'
import { describeApiTrustRequest, isTrustedApiRequest } from './api-request-trust.ts'
import { browserSessionFromCookie } from './inbound-auth.ts'

const AUTH_STATUS_PATH = '/auth/status'
const AUTH_ENROLLMENT_PATH = '/auth/enrollment'
const AUTH_CHALLENGE_PATH = '/auth/challenge'
const AUTH_EXCHANGE_PATH = '/auth/exchange'
const AUTH_TOKEN_PATH = '/auth/token'
const AUTH_MANAGE_ENROLLMENTS_PATH = '/auth/manage/enrollments'
const AUTH_MANAGE_APPROVE_PATH = '/auth/manage/enrollment/approve'
const AUTH_MANAGE_GRANTS_PATH = '/auth/manage/grants'
const AUTH_MANAGE_REVOKE_PATH = '/auth/manage/grant/revoke'
const AUTH_MANAGE_TOKEN_PATH = '/auth/manage/token'
const AUTH_LOGOUT_PATH = '/auth/logout'
const AUTH_BODY_LIMIT_BYTES = 16 * 1024

function noStoreHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers)
  result.set('cache-control', 'no-store')
  return result
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, { ...init, headers: noStoreHeaders(init?.headers) })
}

function text(value: string, status: number): Response {
  return new Response(value, { status, headers: noStoreHeaders() })
}

function browserRequestDetails(request: Request, peerAddress: string | undefined): string {
  return `${describeApiTrustRequest(request)} peer=${JSON.stringify(peerAddress ?? '-')}`
}

function principalDetails(principal: AuthenticationPrincipal): string {
  if (principal.kind === 'bypass') return 'principal=bypass'
  return `device=${JSON.stringify(principal.name ?? '-')} grant=${JSON.stringify(principal.grantId)}`
}

/** A parsed JSON body, or the response that refuses the request outright. */
type JsonBody = { kind: 'parsed'; value: unknown } | { kind: 'refused'; response: Response }

async function jsonBody(request: Request): Promise<JsonBody> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return { kind: 'refused', response: new Response('content type must be application/json', { status: 415, headers: noStoreHeaders() }) }
  }
  try {
    return { kind: 'parsed', value: await request.json() }
  } catch {
    return { kind: 'refused', response: new Response('body is not JSON', { status: 400, headers: noStoreHeaders() }) }
  }
}

function proof(value: unknown): AuthenticationChallengeProof | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const object = value as Record<string, unknown>
  if (Object.keys(object).length !== 2 || typeof object.challengeId !== 'string' || typeof object.signature !== 'string') return undefined
  return { challengeId: authenticationChallengeId(object.challengeId), signature: object.signature }
}

function exchangeStatus(reason: 'invalid-grant' | 'invalid-proof' | 'expired' | 'authentication-unavailable'): number {
  return reason === 'authentication-unavailable' ? 503 : 401
}

function enrollmentRejection(decision: Extract<AuthenticationEnrollmentDecision, { kind: 'rejected' }>): Response {
  switch (decision.reason) {
    case 'rate-limited':
      return new Response('rate limited', {
        status: 429,
        headers: noStoreHeaders({ 'retry-after': String(Math.ceil(decision.retryAfterMs / 1_000)) }),
      })
    case 'authentication-unavailable':
      return text('authentication unavailable', 503)
    case 'invalid-name':
      return text('device name must contain 1-64 letters, numbers, spaces, dots, underscores, or hyphens', 400)
    case 'invalid-public-key':
      return text('browser generated an invalid device key; use a current browser and retry', 400)
    case 'name-conflict':
      return text('device name is already registered or awaiting approval; choose another name', 409)
  }
}

async function authorizeManagement(
  ctx: Context,
  request: Request,
  peerAddress: string | undefined,
): Promise<Response | AuthenticationPrincipal> {
  const browserSession = browserSessionFromCookie(request.headers.get('cookie'))
  const decision = await ctx.authentication.authenticate({
    channel: 'http-api',
    ...(request.headers.get('authorization') !== null && { authorization: request.headers.get('authorization') as string }),
    ...(browserSession !== undefined && { browserSession }),
    ...(peerAddress !== undefined && { peerAddress }),
  })
  if (decision.kind === 'rejected') {
    return text(decision.reason === 'rate-limited' ? 'rate limited' : 'unauthorized', decision.reason === 'rate-limited' ? 429 : 401)
  }
  return decision.principal.capabilities.includes('harniverse.authorize') ? decision.principal : text('forbidden', 403)
}

function browserCookie(ctx: Context, value: string, maxAge: number): string {
  const secure = ctx.webServer.protocol === 'https:'
  const name = secure ? '__Host-dsh_auth' : 'dsh_auth'
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${String(maxAge)}`
}

function browserAuthenticationHandler(ctx: Context, peerAddress?: string): FetchHandler {
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === AUTH_STATUS_PATH && request.method === 'GET') {
        const status = await ctx.authentication.status()
        if (status.mode === 'bypass') return json({ ...status, authenticated: true })
        const browserSession = browserSessionFromCookie(request.headers.get('cookie'))
        const decision = await ctx.authentication.authenticate({
          channel: 'http-api',
          ...(browserSession !== undefined && { browserSession }),
          ...(peerAddress !== undefined && { peerAddress }),
        })
        return json({ ...status, authenticated: decision.kind === 'accepted' })
      }
      if (pathname === AUTH_ENROLLMENT_PATH && request.method === 'POST') {
        const parsed = await jsonBody(request)
        if (parsed.kind === 'refused') return parsed.response
        const body = parsed.value
        if (typeof body !== 'object' || body === null || Array.isArray(body)
          || Object.keys(body).length !== 3
          || typeof (body as { name?: unknown }).name !== 'string'
          || !['device', 'temporary'].includes(String((body as { kind?: unknown }).kind))
          || typeof (body as { publicKey?: unknown }).publicKey !== 'string') {
          return text('invalid enrollment request', 400)
        }
        const enrollment = body as { name: string; kind: 'device' | 'temporary'; publicKey: string }
        ctx.logger.info(`client-connection: enrollment requested name=${JSON.stringify(enrollment.name)} kind=${JSON.stringify(enrollment.kind)} ${browserRequestDetails(request, peerAddress)}`)
        try {
          const decision = await ctx.authentication.requestEnrollment(enrollment, peerAddress)
          if (decision.kind === 'accepted') {
            ctx.logger.info(`client-connection: enrollment pending name=${JSON.stringify(enrollment.name)} enrollment=${JSON.stringify(decision.value.id)} peer=${JSON.stringify(peerAddress ?? '-')}`)
            return json(decision.value, { status: 202 })
          }
          ctx.logger.warn(`client-connection: enrollment rejected name=${JSON.stringify(enrollment.name)} reason=${JSON.stringify(decision.reason)} peer=${JSON.stringify(peerAddress ?? '-')}`)
          return enrollmentRejection(decision)
        } catch (error) {
          ctx.logger.warn('client-connection: enrollment request failed')
          ctx.logger.warn(error)
          return text('enrollment service failed; see server log', 500)
        }
      }
      if (pathname === AUTH_ENROLLMENT_PATH && request.method === 'GET') {
        const values = new URL(request.url).searchParams.getAll('id')
        if (values.length !== 1 || values[0] === undefined || values[0].length === 0) return text('invalid enrollment id', 400)
        const status = await ctx.authentication.enrollmentStatus(authenticationEnrollmentId(values[0]))
        return status === undefined ? text('not found', 404) : json(status)
      }
      if (pathname === AUTH_CHALLENGE_PATH && request.method === 'POST') {
        const parsed = await jsonBody(request)
        if (parsed.kind === 'refused') return parsed.response
        const body = parsed.value
        if (typeof body !== 'object' || body === null || Array.isArray(body)
          || Object.keys(body).length !== 2
          || typeof (body as { grantId?: unknown }).grantId !== 'string'
          || !['access-token', 'browser-session'].includes(String((body as { purpose?: unknown }).purpose))) {
          return text('invalid challenge request', 400)
        }
        const decision = await ctx.authentication.createChallenge(
          authenticationGrantId((body as { grantId: string }).grantId),
          (body as { purpose: 'access-token' | 'browser-session' }).purpose,
        )
        if (decision.kind === 'rejected') {
          return text('unauthorized', exchangeStatus(decision.reason))
        }
        return json(decision.value)
      }
      if ((pathname === AUTH_EXCHANGE_PATH || pathname === AUTH_TOKEN_PATH) && request.method === 'POST') {
        const parsed = await jsonBody(request)
        if (parsed.kind === 'refused') return parsed.response
        const body = parsed.value
        const submitted = proof(body)
        if (submitted === undefined) return text('invalid challenge proof', 400)
        if (pathname === AUTH_TOKEN_PATH) {
          const decision = await ctx.authentication.exchangeAccessToken(submitted, peerAddress)
          return decision.kind === 'accepted'
            ? json({ accessToken: decision.value.value, expiresAt: decision.value.expiresAt })
            : text('unauthorized', exchangeStatus(decision.reason))
        }
        const decision = await ctx.authentication.createBrowserSession(submitted, peerAddress)
        if (decision.kind === 'rejected') {
          ctx.logger.warn(`client-connection: browser authentication rejected path=${JSON.stringify(pathname)} reason=${JSON.stringify(decision.reason)} ${browserRequestDetails(request, peerAddress)}`)
          return new Response(decision.reason === 'rate-limited' ? 'rate limited' : 'unauthorized', {
            status: decision.reason === 'authentication-unavailable' ? 503 : decision.reason === 'rate-limited' ? 429 : 401,
            headers: noStoreHeaders(decision.reason === 'rate-limited'
              ? { 'retry-after': String(Math.ceil(decision.retryAfterMs / 1_000)) }
              : undefined),
          })
        }
        ctx.logger.info(`client-connection: browser authentication accepted path=${JSON.stringify(pathname)} ${principalDetails(decision.session.principal)} ${browserRequestDetails(request, peerAddress)}`)
        const maxAge = Math.max(0, Math.floor((Date.parse(decision.session.expiresAt) - Date.now()) / 1000))
        return json({ authenticated: true, expiresAt: decision.session.expiresAt }, {
          headers: {
            'set-cookie': browserCookie(ctx, decision.session.value, maxAge),
          },
        })
      }
      let manager: AuthenticationPrincipal | undefined
      if (pathname.startsWith('/auth/manage/')) {
        const authorization = await authorizeManagement(ctx, request, peerAddress)
        if (authorization instanceof Response) return authorization
        manager = authorization
      }
      if (pathname === AUTH_MANAGE_ENROLLMENTS_PATH && request.method === 'GET') {
        return json(await ctx.authentication.listPendingEnrollments())
      }
      if (pathname === AUTH_MANAGE_GRANTS_PATH && request.method === 'GET') {
        return json(await ctx.authentication.listGrants())
      }
      if (pathname === AUTH_MANAGE_APPROVE_PATH && request.method === 'POST') {
        const parsed = await jsonBody(request)
        if (parsed.kind === 'refused') return parsed.response
        const body = parsed.value
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return text('invalid approval request', 400)
        const values = body as Record<string, unknown>
        if (Object.keys(values).some(key => !['id', 'capabilities', 'expiresInMs', 'idleTimeoutMs'].includes(key))
          || typeof values.id !== 'string'
          || !Array.isArray(values.capabilities)
          || values.capabilities.some(value => !isAuthenticationCapability(value))
          || (values.expiresInMs !== undefined && (!Number.isSafeInteger(values.expiresInMs) || Number(values.expiresInMs) < 1))
          || (values.idleTimeoutMs !== undefined && (!Number.isSafeInteger(values.idleTimeoutMs) || Number(values.idleTimeoutMs) < 1))) {
          return text('invalid approval request', 400)
        }
        try {
          return json(await ctx.authentication.approveEnrollment(authenticationEnrollmentId(values.id), {
            capabilities: values.capabilities as AuthenticationCapability[],
            ...(typeof values.expiresInMs === 'number' && { expiresInMs: values.expiresInMs }),
            ...(typeof values.idleTimeoutMs === 'number' && { idleTimeoutMs: values.idleTimeoutMs }),
          }))
        } catch {
          return text('approval failed', 400)
        }
      }
      if (pathname === AUTH_MANAGE_REVOKE_PATH && request.method === 'POST') {
        const parsed = await jsonBody(request)
        if (parsed.kind === 'refused') return parsed.response
        const body = parsed.value
        if (typeof body !== 'object' || body === null || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof (body as { grantId?: unknown }).grantId !== 'string') {
          return text('invalid revocation request', 400)
        }
        try {
          await ctx.authentication.revokeGrant(authenticationGrantId((body as { grantId: string }).grantId))
          return json({ revoked: true })
        } catch {
          return text('revocation failed', 404)
        }
      }
      if (pathname === AUTH_MANAGE_TOKEN_PATH && request.method === 'POST') {
        const parsed = await jsonBody(request)
        if (parsed.kind === 'refused') return parsed.response
        const body = parsed.value
        if (typeof body !== 'object' || body === null || Array.isArray(body)
          || Object.keys(body).some(key => !['capabilities', 'ttlMs'].includes(key))) return text('invalid token request', 400)
        const values = body as Record<string, unknown>
        if (!Array.isArray(values.capabilities) || values.capabilities.some(value => !isAuthenticationCapability(value))
          || !Number.isSafeInteger(values.ttlMs) || Number(values.ttlMs) < 1) return text('invalid token request', 400)
        const decision = await ctx.authentication.issueEmergencyAccessToken(
          manager as AuthenticationPrincipal,
          values.capabilities as AuthenticationCapability[],
          values.ttlMs as number,
        )
        return decision.kind === 'accepted'
          ? json({ accessToken: decision.value.value, expiresAt: decision.value.expiresAt })
          : text('token issuance rejected', exchangeStatus(decision.reason))
      }
      if (pathname === AUTH_LOGOUT_PATH && request.method === 'POST') {
        ctx.authentication.revokeBrowserSession(browserSessionFromCookie(request.headers.get('cookie')))
        return new Response(null, {
          status: 204,
          headers: noStoreHeaders({ 'set-cookie': browserCookie(ctx, '', 0) }),
        })
      }
      return text('not found', 404)
    },
  }
}

/**
 * Register browser authentication routes behind the existing request-trust fence.
 * @param ctx - Connection plugin context.
 * @param trustedHosts - deployment authorities accepted by the trust fence.
 * @param trustedOrigins - exact cross-origin HTTP(S) Origins allowed after Host trust.
 */
export function registerBrowserAuthenticationRoutes(
  ctx: Context,
  trustedHosts: readonly string[],
  trustedOrigins: readonly string[] = [],
): void {
  for (const path of [
    AUTH_STATUS_PATH,
    AUTH_ENROLLMENT_PATH,
    AUTH_CHALLENGE_PATH,
    AUTH_EXCHANGE_PATH,
    AUTH_TOKEN_PATH,
    AUTH_MANAGE_ENROLLMENTS_PATH,
    AUTH_MANAGE_APPROVE_PATH,
    AUTH_MANAGE_GRANTS_PATH,
    AUTH_MANAGE_REVOKE_PATH,
    AUTH_MANAGE_TOKEN_PATH,
    AUTH_LOGOUT_PATH,
  ]) {
    const route: WebRoute = {
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, trustedHosts, trustedOrigins)) {
          ctx.logger.warn(`client-connection: rejected untrusted browser request path=${JSON.stringify(path)} ${describeApiTrustRequest(req)} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        await bridge(req, res, browserAuthenticationHandler(ctx, req.socket.remoteAddress), AUTH_BODY_LIMIT_BYTES)
      },
    }
    ctx.effect(() => ctx.webServer.register(route), `client-connection: ${path} route`)
  }
}
