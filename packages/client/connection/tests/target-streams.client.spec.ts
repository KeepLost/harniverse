import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebApiClient } from '../src/client/web-api-client.ts'
import { TargetGeneration } from '../src/client/target.ts'
import { RpcId } from '../src/client/api.ts'

const payload = { sessionId: 'same' as never, id: 'view' as never, attachmentId: 'attachment' as never }
const frame = { type: 'stream/error', error: { code: 'internal', message: 'closed', details: {} } }
const envelope = (method: string, data: unknown) => `data: ${JSON.stringify({
  type: 'server-request', rpcId: method, method, payload: data,
})}\n\n`
const response = () => new Response(
  envelope('connection.authenticated', { kind: 'bypass' }) + envelope('stream/error', frame),
)

afterEach(() => { vi.restoreAllMocks() })

describe.each(['terminal', 'hold', 'browser'] as const)('%s target stream', (kind) => {
  it.each(['standalone', 'captured', 'delegate'] as const)('delivers framed data through the %s API', async (mode) => {
    const generation = new TargetGeneration({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    const captured = new WebApiClient(undefined, undefined, undefined, undefined,
      generation.resolvePath, () => generation)
    const api = mode === 'standalone' ? new WebApiClient() : mode === 'captured' ? captured
      : new WebApiClient(undefined, undefined, undefined, undefined, undefined, undefined, () => captured)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    const opened = vi.fn()
    const identities: unknown[] = []
    const iterator = api.events[kind](payload, new AbortController().signal, opened,
      identity => identities.push(identity))[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ done: false, value: { payload: frame } })
    expect(await iterator.next()).toMatchObject({ done: true })
    expect(opened).toHaveBeenCalledOnce()
    expect(identities).toEqual([{ kind: 'bypass' }])
    const input = fetch.mock.calls[0]![0]
    const url = new URL(input instanceof Request ? input.url : input)
    expect(url.pathname).toBe(`/api/events.${kind}`)
    expect(url.searchParams.get('dshRemoteHost')).toBe(mode === 'standalone' ? null : generation.target.kind === 'remote' ? generation.target.id : null)
  })

  it('can deliver without readiness callbacks', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    const iterator = new WebApiClient().events[kind](payload, new AbortController().signal)[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: { payload: frame } })
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  it('suppresses open, identity and buffered frames after cancellation', async () => {
    const caller = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      caller.abort()
      return response()
    })
    const opened = vi.fn()
    const identities: unknown[] = []
    const iterator = new WebApiClient().events[kind](payload, caller.signal, opened,
      identity => identities.push(identity))[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ done: true })
    expect(opened).not.toHaveBeenCalled()
    expect(identities).toEqual([])
  })
})

describe('standalone HTTP cancellation', () => {
  it.each([new Error('cancelled'), 'cancelled'])('refuses an aborted carrier before fetch (%s)', async (reason) => {
    const caller = new AbortController()
    caller.abort(reason)
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(new WebApiClient().host.describe({}, caller.signal)).rejects.toThrow(/cancelled|aborted/u)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends a standalone response with matched authentication', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      accepted: false, reason: 'not-pending', authentication: { kind: 'bypass' },
    }))
    await expect(new WebApiClient().respond({
      type: 'client-response', rpcId: RpcId('reply'), result: { ok: true, value: {} },
    })).resolves.toMatchObject({ accepted: false, reason: 'not-pending' })
  })
})
