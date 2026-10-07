/** Unary, Typert, respond, and upload behavior of the chat client against a fake carrier. */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Config, HarniverseError, MAX_MUX_RENEW_AFTER_MS, type RespondResult } from '../src/index.ts'
import { internals } from '../src/internals.ts'
import type { RecordedRequest } from './fixtures/carrier.ts'
import { bootClient, REMOTE_HOST, restoreInternals } from './helpers.ts'

let booted: Context | undefined

afterEach(async () => {
  restoreInternals()
  await booted?.fiber.dispose()
  booted = undefined
})

async function boot(...args: Parameters<typeof bootClient>): Promise<Awaited<ReturnType<typeof bootClient>>> {
  const result = await bootClient(...args)
  booted = result.ctx
  return result
}

async function failure(promise: Promise<unknown>): Promise<HarniverseError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(HarniverseError)
  return error as HarniverseError
}

const HOST = { bootId: 'boot-1', version: '1.0.0', cwd: '/w' }
const CREATED = { sessionId: 'chat-1' }
const GRANT_REV2 = { kind: 'grant', grantId: 'grant-1', grantRevision: 2 }

/** The pathname of a `fetch` input. */
function pathOf(input: Parameters<typeof fetch>[0]): string {
  return new URL(input instanceof Request ? input.url : input.toString()).pathname
}

function envelope(request: RecordedRequest): Record<string, unknown> {
  return request.body as Record<string, unknown>
}

describe('authentication', () => {
  it('signs one challenge and reuses the Access Token across calls', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    await client.describeHost()
    await client.describeHost()
    expect(carrier.tokensIssued).toBe(1)
    expect(carrier.requests.map(request => request.headers.get('authorization'))).toEqual(['Bearer token-1', 'Bearer token-1'])
  })

  it('uses a Grant id from config over the credential', async () => {
    const { client, carrier } = await boot({ credentials: { DSH_CHAT_BRIDGE_SIGNING: '' }, config: { grantId: 'grant-direct' } })
    carrier.ok('POST /api/host.describe', HOST)
    // The signing credential is set below the empty placeholder: resolve the real key first.
    await client['ctx'].credentials.set('DSH_CHAT_BRIDGE_SIGNING' as never, carrier.signingKey)
    await client.describeHost()
    expect(envelope(carrier.authRequests[0]!)).toMatchObject({ grantId: 'grant-direct' })
  })

  it('reports a missing Grant id and succeeds once the credential appears', async () => {
    const { client, carrier, ctx } = await boot({ credentials: { DSH_CHAT_BRIDGE_SIGNING: 'placeholder' } })
    carrier.ok('POST /api/host.describe', HOST)
    const error = await failure(client.describeHost())
    expect(error.code).toBe('credential-missing')
    expect(error.message).toContain('dsh chat init')
    await ctx.credentials.set('DSH_CHAT_BRIDGE_GRANT_ID' as never, 'grant-1')
    await ctx.credentials.set('DSH_CHAT_BRIDGE_SIGNING' as never, carrier.signingKey)
    await expect(client.describeHost()).resolves.toMatchObject({ bootId: 'boot-1' })
  })

  it('reports a missing signing key as an authentication failure naming the credential', async () => {
    const { client, carrier } = await boot({ credentials: { DSH_CHAT_BRIDGE_GRANT_ID: 'grant-1' } })
    carrier.ok('POST /api/host.describe', HOST)
    const error = await failure(client.describeHost())
    expect(error.code).toBe('authentication-failed')
    expect(error.message).toContain('DSH_CHAT_BRIDGE_SIGNING')
    expect(carrier.requests).toHaveLength(0)
  })

  it('reports a rejected challenge with an actionable message', async () => {
    const { client, carrier } = await boot()
    carrier.challengeStatus = 404
    const error = await failure(client.describeHost())
    expect(error.code).toBe('authentication-failed')
    expect(error.message).toContain('challenge rejected (404)')
    expect(error.message).toContain('Grant is registered')
  })

  it('refuses an instance that reports no authentication', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.identityOverride = { kind: 'bypass' }
    const error = await failure(client.describeHost())
    expect(error.code).toBe('authentication-failed')
    expect(error.message).toContain('without authentication')
  })
})

describe('unary calls', () => {
  it('sends a read without expectedPrincipal or Idempotency-Key and validates the value', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/session.list', { items: [{ sessionId: 's1', updatedAt: 1, running: false }] })
    const value = await client.call('session.list', {}, { idempotencyKey: 'ignored' })
    expect(value.items[0]?.sessionId).toBe('s1')
    const request = carrier.requests[0]!
    expect(request.headers.get('idempotency-key')).toBeNull()
    expect(envelope(request)).not.toHaveProperty('expectedPrincipal')
    expect(envelope(request)).toMatchObject({ type: 'client-request', method: 'session.list', payload: {} })
  })

  it('learns the identity with a read before the first mutation and reuses it afterwards', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.ok('POST /api/session.create', CREATED)
    await client.call('session.create', { sessionId: 'chat-1' }, { idempotencyKey: 'key-1' })
    await client.call('session.create', { sessionId: 'chat-2' }, { idempotencyKey: 'key-2' })
    expect(carrier.requests.map(request => request.url.pathname)).toEqual([
      '/api/host.describe', '/api/session.create', '/api/session.create',
    ])
    const [, first, second] = carrier.requests
    expect(envelope(first!)).toMatchObject({ method: 'session.create', payload: { sessionId: 'chat-1' }, expectedPrincipal: carrier.identity })
    expect(first?.headers.get('idempotency-key')).toBe('key-1')
    expect(second?.headers.get('idempotency-key')).toBe('key-2')
  })

  it('uses a caller-supplied rpcId so the request can be correlated with its user/message event', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.ok('POST /api/session.prompt', { accepted: true, messageId: 'm1', operationId: 'op1' })
    await client.call('session.prompt', { sessionId: 's1', mode: 'queue', content: [] }, { rpcId: 'rpc-chosen' })
    expect(envelope(carrier.to('/api/session.prompt')[0]!).rpcId).toBe('rpc-chosen')
  })

  it('sets the model of one session through selectModelTarget as an idempotent mutation', async () => {
    const { client, carrier } = await boot()
    const target = { kind: 'model', selection: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
    const value = { target, selected: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
    carrier.ok('POST /api/host.describe', HOST)
    carrier.ok('POST /api/session.selectModelTarget', value)
    const result = await client.call('session.selectModelTarget', { sessionId: 's1', target }, { idempotencyKey: 'key-model' })
    expect(result.selected).toMatchObject({ provider: 'p', model: 'm' })
    expect(result.target.kind).toBe('model')
    const request = carrier.to('/api/session.selectModelTarget')[0]!
    expect(request.headers.get('idempotency-key')).toBe('key-model')
    expect(envelope(request)).toMatchObject({
      type: 'client-request', method: 'session.selectModelTarget', payload: { sessionId: 's1', target }, expectedPrincipal: carrier.identity,
    })
  })

  it('rejects a selectModelTarget value without a target kind or a selected model', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.ok('POST /api/session.selectModelTarget', { target: {}, selected: { provider: 'p', model: 'm' } })
    expect(await failure(client.call('session.selectModelTarget', { sessionId: 's1' }))).toMatchObject({ code: 'protocol-violation' })
    carrier.ok('POST /api/session.selectModelTarget', { target: { kind: 'model' }, selected: { provider: 'p' } })
    expect(await failure(client.call('session.selectModelTarget', { sessionId: 's1' }))).toMatchObject({ code: 'protocol-violation' })
  })

  it('omits Idempotency-Key when the caller supplies none', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.ok('POST /api/session.cancel', { accepted: true })
    await client.call('session.cancel', { sessionId: 's1' })
    expect(carrier.to('/api/session.cancel')[0]?.headers.get('idempotency-key')).toBeNull()
  })

  it('refreshes the identity from a principal mismatch and retries exactly once', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.script(
      'POST /api/session.create',
      request => carrier.rpcError(request, 'authentication-principal-mismatch', GRANT_REV2),
      request => carrier.rpc(request, CREATED, GRANT_REV2),
    )
    await expect(client.call('session.create', { sessionId: 'chat-1' }, { idempotencyKey: 'key-1' })).resolves.toEqual(CREATED)
    const attempts = carrier.to('/api/session.create')
    expect(attempts.map(request => (envelope(request).expectedPrincipal as { grantRevision: number }).grantRevision)).toEqual([1, 2])
    expect(attempts.map(request => request.headers.get('idempotency-key'))).toEqual(['key-1', 'key-1'])
  })

  it('surfaces a second consecutive principal mismatch', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.script('POST /api/session.create', request => carrier.rpcError(request, 'authentication-principal-mismatch', GRANT_REV2))
    const error = await failure(client.call('session.create', {}))
    expect(error).toMatchObject({ code: 'rpc-rejected', rpcCode: 'authentication-principal-mismatch' })
    expect(carrier.to('/api/session.create')).toHaveLength(2)
  })

  it('surfaces a business error with its code', async () => {
    const { client, carrier } = await boot()
    carrier.script('POST /api/session.history', request => carrier.rpcError(request, 'session-not-found'))
    const error = await failure(client.call('session.history', { sessionId: 'gone' }))
    expect(error).toMatchObject({ code: 'rpc-rejected', rpcCode: 'session-not-found' })
    expect(error.message).toContain('session-not-found happened')
  })

  it('refuses a method outside the table without touching the network', async () => {
    const { client, carrier } = await boot()
    const error = await failure(client.call('terminal.create' as never, {}))
    expect(error.code).toBe('endpoint-denied')
    expect(carrier.requests).toHaveLength(0)
    expect(carrier.authRequests).toHaveLength(0)
    expect((await failure(client.typert('terminal/create' as never, {}))).code).toBe('endpoint-denied')
    expect(carrier.requests).toHaveLength(0)
  })

  it('rejects a response that echoes another rpcId', async () => {
    const { client, carrier } = await boot()
    carrier.script('POST /api/session.list', { json: { type: 'server-response', rpcId: 'other', result: { ok: true, value: { items: [] } }, authentication: carrier.identity } })
    const error = await failure(client.call('session.list', {}))
    expect(error).toMatchObject({ code: 'protocol-violation' })
    expect(error.message).toContain('another rpcId')
  })

  it('rejects a response body that is not JSON', async () => {
    const { client, carrier } = await boot()
    carrier.script('POST /api/session.list', { status: 200, body: undefined })
    const error = await failure(client.call('session.list', {}))
    expect(error).toMatchObject({ code: 'protocol-violation' })
    expect(error.message).toContain('not JSON')
  })

  it('rejects a value with an unexpected shape', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/session.list', { items: 'nope' })
    const error = await failure(client.call('session.list', {}))
    expect(error).toMatchObject({ code: 'protocol-violation' })
    expect(error.message).toContain('unexpected shape')
  })

  it('reports an HTTP failure with its status', async () => {
    const { client, carrier } = await boot()
    carrier.script('POST /api/session.list', { status: 500 })
    expect(await failure(client.call('session.list', {}))).toMatchObject({ code: 'transport-failed', status: 500 })
  })

  it('reports a network failure', async () => {
    const { client, carrier } = await boot()
    const delegate = internals.fetch
    internals.fetch = (input, init) => pathOf(input) === '/api/session.list' ? Promise.reject(new TypeError('socket hang up')) : delegate(input, init)
    carrier.ok('POST /api/session.list', { items: [] })
    const error = await failure(client.call('session.list', {}))
    expect(error).toMatchObject({ code: 'transport-failed' })
    expect(error.message).toContain('socket hang up')
  })

  it('stringifies a non-Error network failure', async () => {
    const { client } = await boot()
    const delegate = internals.fetch
    internals.fetch = (input, init) => pathOf(input) === '/api/session.list' ? Promise.reject('plain failure') : delegate(input, init) // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
    expect((await failure(client.call('session.list', {}))).message).toContain('plain failure')
  })

  it('cancels a request through the caller signal', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/session.list', { items: [] })
    const delegate = internals.fetch
    let captured: AbortSignal | undefined
    internals.fetch = (input, init) => {
      if (pathOf(input) === '/api/session.list') captured = init?.signal ?? undefined
      return delegate(input, init)
    }
    const controller = new AbortController()
    await client.call('session.list', {}, { signal: controller.signal })
    expect(captured?.aborted).toBe(false)
    controller.abort()
    expect(captured?.aborted).toBe(true)
  })
})

describe('remote host', () => {
  it('appends dshRemoteHost, sends the local identity, and keeps the remote identity out of local state', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    const remoteIdentity = { kind: 'grant', grantId: 'remote-grant', grantRevision: 9 }
    carrier.script('POST /api/session.create', request => carrier.rpc(request, CREATED, remoteIdentity))
    await client.call('session.create', { sessionId: 'chat-1' }, { remoteHost: REMOTE_HOST })
    const remote = carrier.to('/api/session.create')[0]!
    expect(remote.url.searchParams.get('dshRemoteHost')).toBe(REMOTE_HOST)
    expect(envelope(remote).expectedPrincipal).toEqual(carrier.identity)
    await client.call('session.create', { sessionId: 'chat-2' })
    const local = carrier.to('/api/session.create')[1]!
    expect(local.url.searchParams.has('dshRemoteHost')).toBe(false)
    expect(envelope(local).expectedPrincipal).toEqual(carrier.identity)
  })

  it('rejects a malformed remote host before any network use, for every request kind', async () => {
    const { client, carrier } = await boot()
    for (const remoteHost of ['not-a-uuid', REMOTE_HOST.toUpperCase(), '3f2a8c6e-1b4d-1e7a-9c05-8d2e6f1a7b39']) {
      expect((await failure(client.call('session.list', {}, { remoteHost }))).code).toBe('remote-host-invalid')
    }
    expect((await failure(client.respond('r1', { ok: true, value: {} }, { remoteHost: 'x' }))).code).toBe('remote-host-invalid')
    expect((await failure(client.upload(new Uint8Array(1), {}, { remoteHost: 'x' }))).code).toBe('remote-host-invalid')
    expect(carrier.requests).toHaveLength(0)
  })

  it('does not retry a principal mismatch on a remote path', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.script('POST /api/session.cancel', request => carrier.rpcError(request, 'authentication-principal-mismatch', GRANT_REV2))
    const error = await failure(client.call('session.cancel', { sessionId: 's1' }, { remoteHost: REMOTE_HOST }))
    expect(error.rpcCode).toBe('authentication-principal-mismatch')
    expect(carrier.to('/api/session.cancel')).toHaveLength(1)
  })
})

describe('Typert calls', () => {
  it('posts the args object under the endpoint path and forwards the idempotency key', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/commands/execute', { commandId: 'c1', result: { kind: 'text', text: 'done' } })
    const value = await client.typert('commands/execute', { agentId: 's1', line: '/compact', images: [] }, { idempotencyKey: 'key-9' })
    expect(value).toEqual({ commandId: 'c1', result: { kind: 'text', text: 'done' } })
    const request = carrier.requests[0]!
    expect(envelope(request)).toMatchObject({ method: 'commands/execute', payload: { args: { agentId: 's1', line: '/compact', images: [] } } })
    expect(envelope(request)).not.toHaveProperty('expectedPrincipal')
    expect(request.headers.get('idempotency-key')).toBe('key-9')
  })

  it('returns undefined for an unresolved command', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/commands/execute', undefined)
    await expect(client.typert('commands/execute', { agentId: 's1', line: '/nope', images: [] })).resolves.toBeUndefined()
  })
})

describe('respond', () => {
  const allowed: RespondResult = { ok: true, value: { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' } }

  it('posts a client-response bound to the current identity', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.script('POST /api/respond', { json: { accepted: true, authentication: carrier.identity } })
    await expect(client.respond('rpc-1', allowed)).resolves.toEqual({ accepted: true })
    expect(envelope(carrier.to('/api/respond')[0]!)).toEqual({ type: 'client-response', rpcId: 'rpc-1', result: allowed, expectedPrincipal: carrier.identity })
  })

  it('reports a receipt that is no longer pending', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.script('POST /api/respond', { json: { accepted: false, reason: 'not-pending', authentication: carrier.identity } })
    await expect(client.respond('rpc-1', allowed)).resolves.toEqual({ accepted: false, reason: 'not-pending' })
  })

  it('refreshes the identity on a mismatch receipt and retries once', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.script('POST /api/respond',
      { json: { accepted: false, reason: 'authentication-principal-mismatch', authentication: GRANT_REV2 } },
      { json: { accepted: true, authentication: GRANT_REV2 } })
    await expect(client.respond('rpc-1', allowed)).resolves.toEqual({ accepted: true })
    expect(carrier.to('/api/respond').map(request => (envelope(request).expectedPrincipal as { grantRevision: number }).grantRevision)).toEqual([1, 2])
  })

  it('returns a repeated mismatch after one retry and never retries on a remote path', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.script('POST /api/respond', { json: { accepted: false, reason: 'authentication-principal-mismatch', authentication: GRANT_REV2 } })
    await expect(client.respond('rpc-1', allowed)).resolves.toEqual({ accepted: false, reason: 'authentication-principal-mismatch' })
    expect(carrier.to('/api/respond')).toHaveLength(2)
    await expect(client.respond('rpc-2', allowed, { remoteHost: REMOTE_HOST })).resolves.toEqual({ accepted: false, reason: 'authentication-principal-mismatch' })
    expect(carrier.to('/api/respond')).toHaveLength(3)
  })

  it('rejects a malformed receipt', async () => {
    const { client, carrier } = await boot()
    carrier.ok('POST /api/host.describe', HOST)
    carrier.script('POST /api/respond', { json: { accepted: 'maybe' } })
    expect((await failure(client.respond('rpc-1', allowed))).code).toBe('protocol-violation')
  })
})

describe('upload', () => {
  it('sends raw bytes with the media type and a percent-encoded name', async () => {
    const { client, carrier } = await boot()
    carrier.script('POST /api/attachment/upload', { json: { attachmentId: 'att-1', bytes: 3, name: '报告.txt', mediaType: 'text/plain' } })
    const ref = await client.upload(new Uint8Array([1, 2, 3]), { name: '报告.txt', mediaType: 'text/plain' })
    expect(ref).toMatchObject({ attachmentId: 'att-1', bytes: 3 })
    const request = carrier.requests[0]!
    expect(request.headers.get('content-type')).toBe('text/plain')
    expect(request.headers.get('x-attachment-name')).toBe(encodeURIComponent('报告.txt'))
    expect([...request.body as Uint8Array]).toEqual([1, 2, 3])
  })

  it('defaults to a binary media type and omits the name header', async () => {
    const { client, carrier } = await boot()
    carrier.script('POST /api/attachment/upload', { json: { attachmentId: 'att-2', bytes: 1 } })
    await client.upload(new Uint8Array([9]), {})
    const request = carrier.requests[0]!
    expect(request.headers.get('content-type')).toBe('application/octet-stream')
    expect(request.headers.has('x-attachment-name')).toBe(false)
  })

  it('reports an oversized upload', async () => {
    const { client, carrier } = await boot()
    carrier.script('POST /api/attachment/upload', { status: 413 })
    expect(await failure(client.upload(new Uint8Array([1]), {}))).toMatchObject({ code: 'transport-failed', status: 413 })
  })
})

describe('configuration', () => {
  it('rejects a reconnect window whose minimum exceeds its maximum', async () => {
    await expect(bootClient({ config: { reconnectMinMs: 5_000, reconnectMaxMs: 1_000 } })).rejects.toThrow('reconnectMinMs must not exceed reconnectMaxMs')
  })

  it('bounds the mux renewal interval below the Access Token lifetime', () => {
    expect(() => Config({ grantId: 'g', muxRenewAfterMs: MAX_MUX_RENEW_AFTER_MS + 1 })).toThrow()
    expect(Config({ grantId: 'g' })).toMatchObject({
      origin: 'http://127.0.0.1:3080', grantIdRef: 'DSH_CHAT_BRIDGE_GRANT_ID', signingKeyRef: 'DSH_CHAT_BRIDGE_SIGNING', muxRenewAfterMs: 540_000,
    })
  })
})
