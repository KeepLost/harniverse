/**
 * Node HTTP to provider-neutral authentication adapter: which transport
 * carriers become an admission attempt, and which absent header simply stays
 * absent rather than becoming an empty claim.
 */

import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type {
  AuthenticationAttempt,
  AuthenticationDecision,
  InboundAuthentication,
} from '@deepseek-ai/dsh-authentication'
import { authenticateIncoming, browserSessionFromCookie } from '../src/inbound-auth.ts'

const SESSION = 'S'.repeat(43)

/** A context whose authentication provider records every attempt it receives. */
function harness(): { ctx: Context; attempts: AuthenticationAttempt[] } {
  const attempts: AuthenticationAttempt[] = []
  const ctx = new Context()
  ctx.provide('authentication', {
    authenticate: vi.fn((attempt: AuthenticationAttempt): Promise<AuthenticationDecision> => {
      attempts.push(attempt)
      return Promise.resolve({ kind: 'rejected', reason: 'invalid-credential' })
    }),
  } as unknown as InboundAuthentication)
  return { ctx, attempts }
}

function request(options: {
  headers?: Record<string, unknown>
  peerAddress?: string | undefined
} = {}): IncomingMessage {
  const value = Readable.from([]) as unknown as IncomingMessage
  Object.assign(value, {
    url: '/api/session.list',
    method: 'GET',
    headers: { host: '127.0.0.1:3080', ...options.headers },
    socket: options.peerAddress === undefined ? {} : { remoteAddress: options.peerAddress },
  })
  return value
}

describe('browserSessionFromCookie', () => {
  it('prefers the secure cookie name over the legacy one', () => {
    const legacy = 'L'.repeat(43)
    expect(browserSessionFromCookie(`dsh_auth=${legacy}; __Host-dsh_auth=${SESSION}`)).toBe(SESSION)
  })

  it('accepts a single legacy cookie', () => {
    expect(browserSessionFromCookie(`dsh_auth=${SESSION}`)).toBe(SESSION)
  })

  it.each([
    ['no cookie header', undefined],
    ['a null cookie header', null],
    ['an unrelated cookie', 'other=value'],
    ['duplicate secure values', `__Host-dsh_auth=${SESSION}; __Host-dsh_auth=${'L'.repeat(43)}`],
    ['duplicate legacy values', `dsh_auth=${SESSION}; dsh_auth=${'L'.repeat(43)}`],
    ['a short value', 'dsh_auth=too-short'],
    ['a value with disallowed characters', `dsh_auth=${'!'.repeat(43)}`],
    ['an empty value', 'dsh_auth='],
  ])('selects nothing from %s', (_label, cookie) => {
    expect(browserSessionFromCookie(cookie)).toBeUndefined()
  })
})

describe('authenticateIncoming', () => {
  it('carries every present transport carrier into one attempt', async () => {
    const { ctx, attempts } = harness()
    await authenticateIncoming(ctx, request({
      headers: { authorization: 'Bearer token-value', cookie: `__Host-dsh_auth=${SESSION}` },
      peerAddress: '10.1.2.3',
    }), 'http-api')

    expect(attempts).toEqual([{
      channel: 'http-api',
      authorization: 'Bearer token-value',
      browserSession: SESSION,
      peerAddress: '10.1.2.3',
    }])
  })

  it('omits an absent authorization header rather than claiming an empty one', async () => {
    const { ctx, attempts } = harness()
    await authenticateIncoming(ctx, request({ peerAddress: '10.1.2.3' }), 'websocket-mux')

    expect(attempts[0]).toEqual({ channel: 'websocket-mux', peerAddress: '10.1.2.3' })
    expect(attempts[0]).not.toHaveProperty('authorization')
    expect(attempts[0]).not.toHaveProperty('browserSession')
  })

  it('omits a non-string authorization header', async () => {
    const { ctx, attempts } = harness()
    // Node exposes a repeated header as an array; that is not a credential.
    await authenticateIncoming(ctx, request({
      headers: { authorization: ['Bearer a', 'Bearer b'] },
      peerAddress: '10.1.2.3',
    }), 'http-api')

    expect(attempts[0]).not.toHaveProperty('authorization')
  })

  it('omits a non-string cookie header', async () => {
    const { ctx, attempts } = harness()
    await authenticateIncoming(ctx, request({
      headers: { cookie: [`dsh_auth=${SESSION}`] },
      peerAddress: '10.1.2.3',
    }), 'http-api')

    expect(attempts[0]).not.toHaveProperty('browserSession')
  })

  it('omits a cookie that carries no valid session value', async () => {
    const { ctx, attempts } = harness()
    await authenticateIncoming(ctx, request({
      headers: { cookie: 'other=value' },
      peerAddress: '10.1.2.3',
    }), 'http-api')

    expect(attempts[0]).not.toHaveProperty('browserSession')
  })

  it('omits an unavailable peer address', async () => {
    const { ctx, attempts } = harness()
    await authenticateIncoming(ctx, request({ headers: { authorization: 'Bearer t' } }), 'websocket-host')

    expect(attempts[0]).toEqual({ channel: 'websocket-host', authorization: 'Bearer t' })
    expect(attempts[0]).not.toHaveProperty('peerAddress')
  })

  it('returns the provider decision unchanged', async () => {
    const ctx = new Context()
    const decision: AuthenticationDecision = {
      kind: 'rejected',
      reason: 'rate-limited',
      retryAfterMs: 2_000,
    }
    ctx.provide('authentication', {
      authenticate: () => Promise.resolve(decision),
    } as unknown as InboundAuthentication)

    await expect(authenticateIncoming(ctx, request(), 'http-api')).resolves.toBe(decision)
  })
})
