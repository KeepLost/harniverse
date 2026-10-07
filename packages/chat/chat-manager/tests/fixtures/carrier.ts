/**
 * A minimal `/api` carrier for the Loader composition suite. The challenge and
 * token routes delegate to the REAL authentication provider, so the Grant the
 * manager provisioned is verified by real P-256 proof of possession; the
 * business endpoints are scripted stand-ins that record what the real
 * bridge's real HTTP client sent. The `events.mux` upgrade is not served, so
 * the client keeps retrying it in the background.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { authenticationChallengeId, authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** One recorded business call. */
export interface CarrierCall {
  method: string
  payload: Record<string, unknown>
}

/** What the carrier recorded. */
export const carrierCalls: CarrierCall[] = []

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

/** The scripted values of the business endpoints the first owner prompt reaches. */
function value(method: string, payload: Record<string, unknown>): unknown {
  switch (method) {
    case 'host.describe': return { bootId: 'boot-1', version: 'test' }
    case 'session.create': return { sessionId: payload.sessionId }
    case 'session.selectModelTarget': return { target: { kind: 'model' }, selected: { provider: 'p', model: 'm' } }
    case 'session.prompt': return { accepted: true, messageId: 'message-1', operationId: 'operation-1' }
    default: throw new Error(`the test carrier does not serve ${method}`)
  }
}

/** The function plugin mounting the carrier on the real web server. */
export const carrier = {
  name: 'test-carrier',
  inject: ['webServer', 'authentication'],
  apply(ctx: Context): void {
    const route = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void => {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))
    }
    route('/auth/challenge', async (req, res) => {
      const body = await readJson(req) as { grantId: string; purpose: 'access-token' }
      const decision = await ctx.authentication.createChallenge(authenticationGrantId(body.grantId), body.purpose)
      if (decision.kind === 'rejected') {
        send(res, 401)
        return
      }
      send(res, 200, decision.value)
    })
    route('/auth/token', async (req, res) => {
      const body = await readJson(req) as { challengeId: string; signature: string }
      const decision = await ctx.authentication.exchangeAccessToken({
        challengeId: authenticationChallengeId(body.challengeId), signature: body.signature,
      })
      if (decision.kind !== 'accepted') {
        send(res, 401)
        return
      }
      send(res, 200, { accessToken: decision.value.value, expiresAt: decision.value.expiresAt })
    })
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api',
      async handler(req, res) {
        const decision = await ctx.authentication.authenticate({
          channel: 'http-api',
          ...req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization },
        })
        if (decision.kind !== 'accepted' || decision.principal.kind !== 'grant') {
          send(res, 401)
          return
        }
        const method = (req.url ?? '').slice('/api/'.length)
        const request = await readJson(req) as { rpcId: string; payload?: Record<string, unknown> }
        const payload = request.payload ?? {}
        carrierCalls.push({ method, payload })
        send(res, 200, {
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: true, value: value(method, payload) },
          authentication: { kind: 'grant', grantId: decision.principal.grantId, grantRevision: decision.principal.grantRevision },
        })
      },
    }))
  },
}
