/** Authentication adapter from Node HTTP requests to the provider-neutral seam. */
import type { Context } from '@deepseek-ai/cordis'
import type { AuthenticationChannel, AuthenticationDecision } from '@deepseek-ai/dsh-authentication'
import type { IncomingMessage, ServerResponse } from 'node:http'

const COOKIE_NAME = 'dsh_auth'
const SECURE_COOKIE_NAME = '__Host-dsh_auth'

/**
 * Select one valid browser-session value from a raw transport Cookie header.
 * @param cookie - raw Cookie header, when present.
 * @returns the preferred secure or legacy session value.
 */
export function browserSessionFromCookie(cookie: string | null | undefined): string | undefined {
  if (cookie === undefined || cookie === null) return undefined
  const parts = cookie.split(';').map(part => part.trim())
  const secure = parts.filter(part => part.startsWith(`${SECURE_COOKIE_NAME}=`)).map(part => part.slice(SECURE_COOKIE_NAME.length + 1))
  const legacy = parts.filter(part => part.startsWith(`${COOKIE_NAME}=`)).map(part => part.slice(COOKIE_NAME.length + 1))
  const values = secure.length > 0 ? secure : legacy
  const value = values[0]
  return values.length === 1 && value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
}

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
  const browserSession = browserSessionFromCookie(
    typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
  )
  return ctx.authentication.authenticate({
    channel,
    ...(typeof req.headers.authorization === 'string' && { authorization: req.headers.authorization }),
    ...(browserSession !== undefined && { browserSession }),
    ...(req.socket.remoteAddress !== undefined && { peerAddress: req.socket.remoteAddress }),
  })
}

/**
 * Send the stable HTTP authentication rejection without exposing provider details.
 * @param res - Node HTTP response owned by the route.
 * @param decision - provider rejection, including an optional retry interval.
 */
export function rejectUnauthorized(
  res: ServerResponse,
  decision: Extract<AuthenticationDecision, { kind: 'rejected' }>,
): void {
  if (decision.reason === 'rate-limited') {
    res.writeHead(429, { 'retry-after': String(Math.ceil(decision.retryAfterMs / 1_000)) })
    res.end('rate limited')
    return
  }
  res.writeHead(401, { 'www-authenticate': 'Bearer realm="dsh"' })
  res.end('unauthorized')
}
