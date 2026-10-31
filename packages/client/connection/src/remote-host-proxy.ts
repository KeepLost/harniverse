/** Targeted HTTP carrier for a browser page attached to an SSH-managed host. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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
/** Headers a forwarded request must not carry from the local browser hop. */
const STRIPPED_REQUEST_HEADERS = [
  'authorization', 'cookie', 'host', 'origin', 'referer', 'content-length', 'accept-encoding',
  'connection', 'transfer-encoding', 'keep-alive',
]
/** Headers a relayed response must not carry back to the local browser hop. */
const STRIPPED_RESPONSE_HEADERS = [
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'x-dsh-authentication', 'www-authenticate',
]

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
      // Typert endpoints use `namespace/method`; legacy RPC methods use `namespace.method`.
      const namespace = endpoint.split(/[./]/u)[0]
      if (target.kind === 'invalid' || (namespace !== undefined && LOCAL_NAMESPACES.has(namespace))) return undefined
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
  return targetOfUrl(new URL(request.url))
}

function targetOfUrl(url: URL): Target {
  const raw = url.searchParams.get(TARGET_PARAMETER)
  if (raw === null) return { kind: 'none' }
  return UUID.test(raw) ? { kind: 'host', id: raw } : { kind: 'invalid' }
}

/**
 * Forward one exact browser-facing route to the remote host its query
 * parameter selects. The caller authenticates the browser locally first; this
 * hop then streams the body through the SSH coordinator, strips local
 * hop-by-hop headers, and relays the remote answer. Uploads and imports must
 * land on the machine whose session will read them, not on this Host's stores.
 * @param ctx - Connection plugin context.
 * @param req - the authenticated browser request.
 * @param res - the response to answer through.
 * @returns true when the request was answered here; false when it carries no
 * remote target and the registering route's local handler must run.
 */
export async function forwardExactRoute(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  /* v8 ignore next -- `??` arm: node:http always sets url on a server request;
   * the fallback serves the client-side IncomingMessage type only. */
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const target = targetOfUrl(url)
  if (target.kind === 'none') return false
  const reply = (status: number, error: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error }))
  }
  if (target.kind === 'invalid') {
    reply(400, 'invalid dshRemoteHost parameter')
    return true
  }
  const provider = ctx.get('remoteHosts') as unknown as RemoteHostProxyProvider | undefined
  if (provider === undefined) {
    reply(503, 'remote host routing is unavailable')
    return true
  }
  url.searchParams.delete(TARGET_PARAMETER)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name)
  let response: Response
  try {
    // Both forwarding routes are POST uploads; the request body streams
    // through rather than buffering against the local byte caps. The fetch
    // spec requires duplex for streaming bodies; lib.dom's RequestInit type
    // lags the spec here, so the field rides on a widened init type.
    const init: RequestInit & { duplex: 'half' } = {
      /* v8 ignore next -- `??` arm: node:http always sets method on a server
       * request; the fallback serves the client-side IncomingMessage type only. */
      method: req.method ?? 'GET',
      headers,
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      duplex: 'half',
    }
    response = await provider.request(target.id, `${url.pathname}${url.search}`, init)
  } catch {
    reply(502, 'remote host request failed')
    return true
  }
  const responseHeaders = new Headers(response.headers)
  for (const name of STRIPPED_RESPONSE_HEADERS) responseHeaders.delete(name)
  res.writeHead(response.status, Object.fromEntries(responseHeaders))
  if (response.body === null) {
    res.end()
    return true
  }
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), res)
  } catch {
    /* v8 ignore next -- the remote body failed mid-relay after the response
     * head was already sent; only socket teardown remains. */
    res.destroy()
  }
  return true
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
