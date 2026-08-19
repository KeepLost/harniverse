/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type { AuthenticationPrincipal } from '@deepseek-ai/dsh-authentication'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { legacyRpcCapability } from '@deepseek-ai/dsh-host-apiproxy/api'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES, type FetchHandler } from './http-bridge.ts'
import { authenticateIncoming, rejectUnauthorized } from './inbound-auth.ts'
import { assertTrustedAuthority, assertTrustedOrigin, describeApiTrustRequest, isTrustedApiRequest } from './api-request-trust.ts'
import { registerBrowserAuthenticationRoutes } from './browser-auth-routes.ts'
import { HostConnectionService } from './rpc-host.ts'
import { rejectUnauthorizedWebSocket, rejectWebSocketUpgrade, WebSocketDownlinks } from './websocket-downlink.ts'

export type {
  ConnectionRpcAuthority,
  ConnectionRpcEndpointPolicy,
  ConnectionRpcEndpointResolver,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  ConnectionRpcInvocation,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

function principalDetails(principal: AuthenticationPrincipal): string {
  if (principal.kind === 'bypass') return 'principal=bypass'
  return `device=${JSON.stringify(principal.name ?? '-')} grant=${JSON.stringify(principal.grantId)}`
}

function requestDetails(request: Pick<IncomingMessage, 'method' | 'url' | 'headers' | 'socket'>): string {
  return `method=${JSON.stringify(request.method ?? '-')} path=${JSON.stringify(request.url ?? '-')} ${describeApiTrustRequest(request)} peer=${JSON.stringify(request.socket.remoteAddress ?? '-')}`
}

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection; API Proxy is an optional `/api` fallback. */
export const inject = ['webServer', 'authentication']

/** Plugin config: the deployment's serving authorities and browser origins. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by (the dsh CLI derives the machine's LAN IP literals itself). An entry
   * that is not a bare, canonical authority fails the plugin load.
   */
  trustedHosts?: string[]
  /** Exact cross-origin HTTP(S) browser origins explicitly allowed after Host trust. */
  trustedOrigins?: string[]
  /** Maximum buffered JSON body for every `/api` request. */
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  trustedOrigins: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Mounts the API gateway under the browser transport prefix. Every request on
 * the prefix passes the browser-trust fence first (DNS-rebinding and
 * cross-site defense — [api-request-trust](./api-request-trust.ts));
 * privileged methods additionally pass it with an empty trust list, which
 * pins them to loopback.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const trustedOrigins = config?.trustedOrigins ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  for (const entry of trustedOrigins) assertTrustedOrigin(entry)
  if (ctx.get('apiProxy') !== undefined) assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  if (ctx.authentication.mode === 'bypass' && ctx.webServer.host !== '127.0.0.1') {
    throw new Error('client-connection: authentication bypass is restricted to a loopback listener')
  }
  const connection = new HostConnectionService(ctx, trustedHosts, trustedOrigins)
  const fallbackFetchHandler = (principal: AuthenticationPrincipal): FetchHandler => ({
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
        return new Response('upgrade required', {
          status: 426,
          headers: { connection: 'Upgrade', upgrade: 'websocket' },
        })
      }
      const apiProxy = ctx.get('apiProxy')
      if (apiProxy === undefined) return new Response('not found', { status: 404 })
      return toFetchHandler(apiProxy, principal, (operation, error) => {
        ctx.logger.warn(`client-connection: ApiProxy handler failed for ${operation}`)
        ctx.logger.warn(error)
      }).fetch(request)
    },
  })
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts, trustedOrigins)) {
        ctx.logger.warn(`client-connection: rejected untrusted /api request path=${JSON.stringify(req.url ?? '-')} ${describeApiTrustRequest(req)} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const decision = await authenticateIncoming(ctx, req, 'http-api')
      if (decision.kind === 'rejected') {
        ctx.logger.warn(`client-connection: authentication rejected channel=http-api reason=${JSON.stringify(decision.reason)} ${requestDetails(req)}`)
        rejectUnauthorized(res, decision)
        return
      }
      ctx.logger.info(`client-connection: connection accepted channel=http-api ${principalDetails(decision.principal)} ${requestDetails(req)}`)
      await bridge(
        req,
        res,
        connection.createSharedFetchHandler(
          API_PATH,
          fallbackFetchHandler(decision.principal),
          (endpoint) => {
            const requiredCapability = legacyRpcCapability(endpoint)
            return requiredCapability === undefined ? undefined : { requiredCapability }
          },
          decision.principal,
        ),
        maxRequestBodyBytes,
      )
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  registerBrowserAuthenticationRoutes(ctx, trustedHosts, trustedOrigins)
  ctx.inject(['apiProxy'], (apiCtx) => {
    assertImageBodyCapacity(apiCtx, maxRequestBodyBytes)
    const downlinks = new WebSocketDownlinks(apiCtx.apiProxy, (error) => {
      apiCtx.logger.warn('client-connection: WebSocket event stream failed')
      apiCtx.logger.warn(error)
    })
    const registerDownlink = (path: string): void => {
      apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
        path,
        handler: async (req, socket, head) => {
          if (!isTrustedApiRequest(req, trustedHosts, trustedOrigins)) {
            apiCtx.logger.warn(`client-connection: rejected untrusted WebSocket request path=${JSON.stringify(path)} ${describeApiTrustRequest(req)} peer=${JSON.stringify(req.socket.remoteAddress ?? '-')}`)
            rejectWebSocketUpgrade(socket)
            return
          }
          const channel = path === MUX_EVENTS_PATH ? 'websocket-mux' : 'websocket-host'
          const decision = await authenticateIncoming(apiCtx, req, channel)
          if (decision.kind === 'rejected') {
            apiCtx.logger.warn(`client-connection: authentication rejected channel=${JSON.stringify(channel)} reason=${JSON.stringify(decision.reason)} ${requestDetails(req)}`)
            rejectUnauthorizedWebSocket(socket, decision)
            return
          }
          apiCtx.logger.info(`client-connection: connection accepted channel=${JSON.stringify(channel)} ${principalDetails(decision.principal)} ${requestDetails(req)}`)
          if (!decision.principal.capabilities.includes('harniverse.observe')) {
            rejectWebSocketUpgrade(socket)
            return
          }
          if (path === MUX_EVENTS_PATH) downlinks.handleMux(req, socket, head, decision)
          else downlinks.handleHost(req, socket, head, decision)
        },
      }), `client-connection: ${path} WebSocket`)
    }
    apiCtx.effect(() => () => downlinks.close(), 'client-connection: WebSocket downlinks')
    apiCtx.on('authentication/revoked', ({ grants }) => { downlinks.revoke(grants) })
    apiCtx.on('authentication/unavailable', () => { downlinks.authenticationUnavailable() })
    apiCtx.on('authentication/available', () => { downlinks.authenticationRecovered() })
    registerDownlink(MUX_EVENTS_PATH)
    registerDownlink(HOST_EVENTS_PATH)
  })
}
