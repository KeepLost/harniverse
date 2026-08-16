/** Authentication adapter from Node HTTP requests to the provider-neutral seam. */
import type { Context } from '@deepseek-ai/cordis'
import type { AuthenticationChannel, AuthenticationDecision } from '@deepseek-ai/dsh-authentication'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Authenticate one HTTP or upgrade request after transport trust checks pass.
 * @param ctx - Connection plugin context carrying authentication.
 * @param req - Node HTTP request.
 * @param channel - carrier requesting admission.
 * @returns the provider's admission decision.
 */
export function authenticateIncoming(
  ctx: Context,
  req: IncomingMessage,
  channel: AuthenticationChannel,
): Promise<AuthenticationDecision> {
  return ctx.authentication.authenticate({
    channel,
    ...(typeof req.headers.authorization === 'string' && { authorization: req.headers.authorization }),
    ...(typeof req.headers.cookie === 'string' && { cookie: req.headers.cookie }),
    ...(req.socket.remoteAddress !== undefined && { peerAddress: req.socket.remoteAddress }),
  })
}

/**
 * Send the stable HTTP authentication rejection without exposing provider details.
 * @param res - Node HTTP response owned by the route.
 */
export function rejectUnauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'www-authenticate': 'Bearer realm="dsh"' })
  res.end('unauthorized')
}
