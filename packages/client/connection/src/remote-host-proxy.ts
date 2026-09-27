/** Targeted HTTP carrier for a browser page attached to an SSH-managed host. */
import type { Context } from '@deepseek-ai/cordis'
import {
  authenticationPrincipalIdentity,
  type AuthenticationCapability,
  type AuthenticationPrincipal,
} from '@deepseek-ai/dsh-authentication'
import { legacyRpcCapability } from '@deepseek-ai/dsh-host-apiproxy/api'
import { serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { ConnectionHttpProxyResolver } from './rpc.ts'
import type { HostConnectionService } from './rpc-host.ts'

const TARGET_PARAMETER = 'dshRemoteHost'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LOCAL_NAMESPACES = new Set(['remoteHosts', 'settings', 'credentials'])

interface RemoteHostProxyProvider {
  request(id: string, path: string, init?: RequestInit): Promise<Response>
  /** Last identity observed from the remote carrier, when a mutation needs it. */
  authentication?(id: string): unknown
}

interface TypertPolicySource {
  local: { get(endpoint: string): { requiredCapability: AuthenticationCapability } | undefined }
}

type Target = { kind: 'none' } | { kind: 'invalid' } | { kind: 'host'; id: string }

/**
 * Install a raw request proxy when the optional remote-host coordinator is in
 * the composition. Local management endpoints remain owned by the local
 * Typert gateway even when a remote target query is present.
 * @param ctx - Connection plugin context.
 * @param connection - shared carrier service after local authentication.
 */
export function registerRemoteHostProxy(ctx: Context, connection: HostConnectionService): void {
  ctx.inject(['remoteHosts', 'typert'], (proxyCtx) => {
    const provider = proxyCtx.get('remoteHosts') as unknown as RemoteHostProxyProvider
    const typert = proxyCtx.get('typert') as unknown as TypertPolicySource
    const resolver: ConnectionHttpProxyResolver = (endpoint, request) => {
      const target = targetOf(request)
      if (target.kind === 'none') return undefined
      if (target.kind === 'invalid' || LOCAL_NAMESPACES.has(endpoint.split('/')[0] ?? '')) return undefined
      const requiredCapability = legacyRpcCapability(endpoint)
        ?? typert.local.get(endpoint)?.requiredCapability
      return requiredCapability === undefined ? { denied: true } : { requiredCapability }
    }
    connection.registerHttpProxy(proxyCtx, resolver, (request, principal) => forward(provider, request, principal))
  })
}

async function forward(provider: RemoteHostProxyProvider, request: Request, principal: AuthenticationPrincipal): Promise<Response> {
  const target = targetOf(request)
  if (target.kind !== 'host') return new Response('forbidden', { status: 403 })
  const url = new URL(request.url)
  url.searchParams.delete(TARGET_PARAMETER)
  const headers = new Headers(request.headers)
  for (const name of ['authorization', 'cookie', 'host', 'origin', 'referer', 'content-length', 'accept-encoding']) {
    headers.delete(name)
  }
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await rewriteExpectedPrincipal(request, provider.authentication?.(target.id))
  let response: Response
  try {
    response = await provider.request(target.id, `${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: request.signal,
    })
  } catch {
    return new Response('remote host request failed', { status: 502 })
  }
  return localizeResponse(response, principal)
}

function targetOf(request: Request): Target {
  const raw = new URL(request.url).searchParams.get(TARGET_PARAMETER)
  if (raw === null) return { kind: 'none' }
  return UUID.test(raw) ? { kind: 'host', id: raw } : { kind: 'invalid' }
}

async function rewriteExpectedPrincipal(request: Request, remoteAuthentication: unknown): Promise<ArrayBuffer | string> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json' || remoteAuthentication === undefined) return request.arrayBuffer()
  const raw = await request.text()
  try {
    const body = JSON.parse(raw) as unknown
    if (typeof body !== 'object' || body === null || !Object.hasOwn(body, 'expectedPrincipal')) return raw
    return JSON.stringify({ ...body, expectedPrincipal: remoteAuthentication })
  } catch {
    return raw
  }
}

async function localizeResponse(response: Response, principal: AuthenticationPrincipal): Promise<Response> {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.delete('x-dsh-authentication')
  headers.delete('www-authenticate')
  const contentType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  })
  const raw = await response.text()
  try {
    const parsed = serverResponseSchema.parse(JSON.parse(raw))
    return Response.json({ ...parsed, authentication: authenticationPrincipalIdentity(principal) }, {
      status: response.status, headers,
    })
  } catch {
    return new Response(raw, { status: response.status, statusText: response.statusText, headers })
  }
}
