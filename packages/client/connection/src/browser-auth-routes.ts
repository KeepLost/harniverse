/** Browser login/status/logout routes mounted before the client plugin graph starts. */
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { bridge, type FetchHandler } from './http-bridge.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'

const AUTH_STATUS_PATH = '/auth/status'
const AUTH_LOGIN_PATH = '/auth/login'
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
        const cookie = request.headers.get('cookie')
        const decision = await ctx.authentication.authenticate({
          channel: 'http-api',
          ...(cookie !== null && { cookie }),
          ...(peerAddress !== undefined && { peerAddress }),
        })
        return json({ ...status, authenticated: decision.kind === 'accepted' })
      }
      if (pathname === AUTH_LOGIN_PATH && request.method === 'POST') {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return text('content type must be application/json', 415)
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return text('body is not JSON', 400)
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof (body as { token?: unknown }).token !== 'string') {
          return text('invalid login request', 400)
        }
        const decision = await ctx.authentication.createBrowserSession((body as { token: string }).token, peerAddress)
        if (decision.kind === 'rejected') {
          return new Response('unauthorized', {
            status: decision.reason === 'authentication-unavailable'
              ? 503
              : decision.reason === 'rate-limited' ? 429 : 401,
            headers: noStoreHeaders(decision.reason === 'rate-limited'
              ? { 'retry-after': String(Math.ceil(decision.retryAfterMs / 1_000)) }
              : undefined),
          })
        }
        const maxAge = Math.max(0, Math.floor((Date.parse(decision.session.expiresAt) - Date.now()) / 1000))
        return json({ authenticated: true }, {
          headers: {
            'set-cookie': browserCookie(ctx, decision.session.value, maxAge),
          },
        })
      }
      if (pathname === AUTH_LOGOUT_PATH && request.method === 'POST') {
        ctx.authentication.revokeBrowserSession(request.headers.get('cookie') ?? undefined)
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
 */
export function registerBrowserAuthenticationRoutes(ctx: Context, trustedHosts: readonly string[]): void {
  for (const path of [AUTH_STATUS_PATH, AUTH_LOGIN_PATH, AUTH_LOGOUT_PATH]) {
    const route: WebRoute = {
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, trustedHosts)) {
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
