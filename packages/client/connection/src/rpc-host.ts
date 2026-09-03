/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  RpcId,
  RequestId,
  type ClientRequest,
  type RpcError,
  type RpcErrorDetailsMap,
  type RpcId as RpcIdType,
  type ServerResponse as RpcServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { clientRequestSchema, serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { bridge, type FetchHandler } from './http-bridge.ts'
import { authenticateIncoming, rejectUnauthorized } from './inbound-auth.ts'
import { describeApiTrustRequest, isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type {
  ConnectionRpcEndpointResolver,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'
import {
  authenticationPrincipalIdentity,
  type AuthenticationCapability,
  type AuthenticationPrincipal,
  type AuthenticationPrincipalIdentity,
} from '@deepseek-ai/dsh-authentication'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly resolveEndpoint: ConnectionRpcEndpointResolver
  readonly handler: ConnectionRpcHandler
  readonly options: ConnectionRpcHandlerOptions
}

type RpcFailureReporter = (endpoint: string, error: unknown) => void

interface IdempotencyEntry {
  fingerprint: string
  expiresAt: number
  response: Promise<RpcServerResponse | undefined>
}

const IDEMPOTENCY_STORES = new WeakMap<ConnectionRpcHandler, Map<string, IdempotencyEntry>>()

function principalDetails(principal: AuthenticationPrincipal): string {
  if (principal.kind === 'bypass') return 'principal=bypass'
  return `device=${JSON.stringify(principal.name ?? '-')} grant=${JSON.stringify(principal.grantId)}`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionService
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by trusted-host channels.
   * @param trustedOrigins - exact cross-origin browser origins allowed after Host trust.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly trustedOrigins: readonly string[],
  ) {
    super(ctx, 'connection')
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler, options) => this.register(owner, channel, handler, options),
      intercept: (channel, resolveEndpoint, handler, options) =>
        this.registerInterceptor(owner, channel, resolveEndpoint, handler, options),
    }
  }

  /**
   * Apply transport trust, authentication, and one capability to an HTTP route.
   * @param req - incoming Node HTTP request.
   * @param res - response used for a stable denial.
   * @param requiredCapability - capability required before the route handler runs.
   * @returns whether the owning route may continue.
   */
  async authorizeHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requiredCapability: AuthenticationCapability,
  ): Promise<boolean> {
    if (!isTrustedApiRequest(req, this.trustedHosts, this.trustedOrigins)) {
      this.ctx.logger.warn(`client-connection: rejected untrusted RPC request path=${JSON.stringify(req.url ?? '-')} ${describeApiTrustRequest(req)} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
      res.writeHead(403)
      res.end('forbidden')
      return false
    }
    const decision = await authenticateIncoming(this.ctx, req, 'http-api')
    if (decision.kind === 'rejected') {
      this.ctx.logger.warn(`client-connection: authentication rejected channel=http-api reason=${JSON.stringify(decision.reason)} path=${JSON.stringify(req.url ?? '-')} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
      rejectUnauthorized(res, decision)
      return false
    }
    if (!decision.principal.capabilities.includes(requiredCapability)) {
      res.writeHead(403)
      res.end('forbidden')
      return false
    }
    this.ctx.logger.info(`client-connection: connection accepted channel=http-api ${principalDetails(decision.principal)} path=${JSON.stringify(req.url ?? '-')} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
    return true
  }

  /**
   * Compose one shared-channel Fetch handler from its interceptor and fallback.
   * @param channel - shared channel mounted by Connection.
   * @param fallback - handler for endpoints not claimed by the interceptor.
   * @param resolveFallback - legacy endpoint capability resolver.
   * @param principal - authenticated identity authorizing endpoint dispatch.
   * @returns Fetch handler that selects exactly one target for each request.
   */
  createSharedFetchHandler(
    channel: '/api',
    fallback: FetchHandler,
    resolveFallback: ConnectionRpcEndpointResolver,
    principal: AuthenticationPrincipal,
  ): FetchHandler {
    return {
      fetch: (request) => {
        const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
        if (endpoint === undefined) return Promise.resolve(new Response('forbidden', { status: 403 }))
        const interceptor = this.interceptors.get(channel)
        const interceptorResolution = interceptor?.resolveEndpoint(endpoint)
        if (interceptor !== undefined && interceptorResolution !== undefined) {
          if ('denied' in interceptorResolution
            || !principal.capabilities.includes(interceptorResolution.requiredCapability)) {
            return Promise.resolve(new Response('forbidden', { status: 403 }))
          }
          if (interceptor.options.authority === 'loopback' && !isTrustedApiRequest(request, [])) {
            return Promise.resolve(new Response('forbidden', { status: 403 }))
          }
          return rpcFetchHandler(channel, interceptor.handler, principal, (failedEndpoint, error) => {
            this.reportRpcFailure(failedEndpoint, error)
          }).fetch(request)
        }
        const fallbackPolicy = resolveFallback(endpoint)
        if (fallbackPolicy === undefined
          || 'denied' in fallbackPolicy
          || !principal.capabilities.includes(fallbackPolicy.requiredCapability)) {
          return Promise.resolve(new Response('forbidden', { status: 403 }))
        }
        return fallback.fetch(request)
      },
    }
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertChannel(channel)
    const trustedHosts = options.authority === 'loopback' ? [] : this.trustedHosts
    const trustedOrigins = options.authority === 'loopback' ? [] : this.trustedOrigins
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, trustedHosts, trustedOrigins)) {
          owner.logger.warn(`client-connection: rejected untrusted RPC request path=${JSON.stringify(req.url ?? '-')} ${describeApiTrustRequest(req)} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        const decision = await authenticateIncoming(owner, req, 'http-api')
        if (decision.kind === 'rejected') {
          owner.logger.warn(`client-connection: authentication rejected channel=http-api reason=${JSON.stringify(decision.reason)} path=${JSON.stringify(req.url ?? '-')} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
          rejectUnauthorized(res, decision)
          return
        }
        owner.logger.info(`client-connection: connection accepted channel=http-api ${principalDetails(decision.principal)} path=${JSON.stringify(req.url ?? '-')} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
        await bridge(req, res, capabilityFetchHandler(
          channel,
          handler,
          decision.principal,
          options.requiredCapability,
          (endpoint, error) => { this.reportRpcFailure(endpoint, error) },
        ))
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    resolveEndpoint: ConnectionRpcEndpointResolver,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      resolveEndpoint,
      handler,
      options,
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }

  private reportRpcFailure(endpoint: string, error: unknown): void {
    this.ctx.logger.warn(`client-connection: RPC handler failed for ${endpoint}`)
    this.ctx.logger.warn(error)
  }
}

function capabilityFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
  principal: AuthenticationPrincipal,
  requiredCapability: ConnectionRpcHandlerOptions['requiredCapability'],
  reportFailure: RpcFailureReporter,
): FetchHandler {
  const delegate = rpcFetchHandler(channel, handler, principal, reportFailure)
  return {
    fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (endpoint === undefined || !principal.capabilities.includes(requiredCapability)) {
        return Promise.resolve(new Response('forbidden', { status: 403 }))
      }
      return delegate.fetch(request)
    },
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
  principal: AuthenticationPrincipal,
  reportFailure: RpcFailureReporter,
): FetchHandler {
  const authentication = authenticationPrincipalIdentity(principal)
  const idempotency = IDEMPOTENCY_STORES.get(handler) ?? new Map<string, IdempotencyEntry>()
  IDEMPOTENCY_STORES.set(handler, idempotency)
  const idempotencyTtlMs = 24 * 60 * 60 * 1000
  const maxIdempotencyEntries = 1024

  function idempotencyScope(endpoint: string, key: string): string {
    return `${JSON.stringify(authentication)}\u0000${endpoint}\u0000${key}`
  }

  function purgeExpiredIdempotency(now: number): void {
    for (const [scope, entry] of idempotency) {
      if (entry.expiresAt <= now) idempotency.delete(scope)
    }
  }

  function makeRoomForIdempotency(): void {
    // Insertion order is admission order, so the first keys are the oldest.
    for (const oldest of idempotency.keys()) {
      if (idempotency.size < maxIdempotencyEntries) return
      idempotency.delete(oldest)
    }
  }

  function replayResponse(body: RpcServerResponse, message: ClientRequest): Response {
    return Response.json({
      ...body,
      rpcId: message.rpcId,
      ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
    })
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues, authentication)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        }, authentication, message.requestId)
      }

      const idempotencyKey = request.headers.get('idempotency-key')?.trim()
      const run = async (): Promise<Response> => {
        try {
          const result = await handler({ endpoint, payload: message.payload, signal: request.signal, principal })
          return fullResponse(message.rpcId, result, authentication, message.requestId)
        } catch (error) {
          reportFailure(endpoint, error)
          return new Response('internal handler failure', { status: 500 })
        }
      }
      if (idempotencyKey !== undefined && idempotencyKey !== '') {
        purgeExpiredIdempotency(Date.now())
        const scope = idempotencyScope(endpoint, idempotencyKey)
        const fingerprint = JSON.stringify(message.payload)
        const existing = idempotency.get(scope)
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            return errorResponse(message.rpcId, {
              code: 'idempotency-key-reused',
              message: 'Idempotency-Key was already used with a different payload',
              details: { key: idempotencyKey },
            }, authentication, message.requestId)
          }
          const cached = await existing.response
          return cached === undefined ? run() : replayResponse(cached, message)
        }
        const response = run()
        const cachedResponse = response.then(async (result) => {
          if (result.status !== 200) return undefined
          return serverResponseSchema.parse(await result.clone().json())
        })
        makeRoomForIdempotency()
        idempotency.set(scope, {
          fingerprint,
          expiresAt: Date.now() + idempotencyTtlMs,
          response: cachedResponse,
        })
        const body = await cachedResponse
        return body === undefined ? response : replayResponse(body, message)
      }
      try {
        const result = await handler({ endpoint, payload: message.payload, signal: request.signal, principal })
        return fullResponse(message.rpcId, result, authentication, message.requestId)
      } catch (error) {
        reportFailure(endpoint, error)
        return new Response('internal handler failure', { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(
  body: unknown,
  issues: RpcErrorDetailsMap['bad-request']['issues'],
  authentication: AuthenticationPrincipalIdentity,
): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rawRequestId = (body as { requestId?: unknown } | null)?.requestId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  const requestId = typeof rawRequestId === 'string' ? RequestId(rawRequestId) : undefined
  return errorResponse(rpcId, {
    code: 'bad-request',
    message: 'invalid client-request message',
    details: { issues },
  }, authentication, requestId)
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(
  rpcId: RpcIdType,
  error: RpcError,
  authentication: AuthenticationPrincipalIdentity,
  requestId?: RequestId,
): Response {
  return fullResponse(rpcId, { ok: false, error }, authentication, requestId)
}

/**
 * Complete one narrow result into the ServerResponse full form. The admitted
 * identity is part of that envelope: the browser validates every response
 * against it before reading the result.
 */
function fullResponse(
  rpcId: RpcIdType,
  result: RpcServerResponse['result'],
  authentication: AuthenticationPrincipalIdentity,
  requestId?: RequestId,
): Response {
  const body: RpcServerResponse = {
    type: 'server-response', rpcId, result, authentication,
    ...(requestId === undefined ? {} : { requestId }),
  }
  return Response.json(body)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}
