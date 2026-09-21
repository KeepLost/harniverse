import { describe, expect, it, vi } from 'vitest'
import type { HostDescription } from '@deepseek-ai/dsh-client-connection/client'
import { RemoteMockApiClient, RemoteMockRpcError } from '../src/index.ts'

describe('RemoteMockApiClient unary dispatch', () => {
  it('answers a programmed method through the real wire envelope', async () => {
    const mock = new RemoteMockApiClient()
    const description: HostDescription = {
      bootId: 'mock-boot' as never,
      version: '0-mock',
      cwd: '/mock',
      attachedSessions: 0,
      canOpenPath: false,
    }
    mock.on('host.describe', () => description)
    const response = await mock.host.describe({})
    if (!response.result.ok) throw new Error('expected ok')
    expect(response.result.value).toEqual(description)
    expect(mock.calls).toEqual([{ method: 'host.describe', payload: {} }])
    expect(response.authentication).toEqual({ kind: 'bypass' })
  })

  it('maps a RemoteMockRpcError onto the internal error branch', async () => {
    const mock = new RemoteMockApiClient()
    mock.on('session.list', () => {
      throw new RemoteMockRpcError('nope')
    })
    const response = await mock.sessions.list({})
    expect(response.result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'nope', details: {} },
    })
  })

  it('fails loud over HTTP 500 when no handler is programmed', async () => {
    const mock = new RemoteMockApiClient()
    await expect(mock.sessions.list({})).rejects.toThrow(/transport failure for \/api\/session\.list/)
  })

  it('rejects values that violate the method value schema', async () => {
    const mock = new RemoteMockApiClient()
    mock.on('session.list', () => ({ items: 'not-a-list' } as never))
    await expect(mock.sessions.list({})).rejects.toThrow()
  })

  it('records the resumption cursor of each opened downlink and streams frames', async () => {
    const mock = new RemoteMockApiClient()
    expect(mock.muxDownlink).toBeUndefined()
    const opened = vi.fn()
    const authenticated = vi.fn()
    const iterable = mock.events.mux({ since: { sessionA: 4 } as never }, new AbortController().signal, opened, authenticated)
    const iterator = iterable[Symbol.asyncIterator]()
    const firstNext = iterator.next()
    await vi.waitFor(() => { expect(mock.muxDownlink).toBeDefined() })
    expect(mock.downlinks).toEqual([{ stream: 'events.mux', since: { sessionA: 4 } }])
    const downstream = mock.muxDownlink
    downstream?.authenticated()
    downstream?.push({ type: 'session/subscribed', sessionId: 'sessionA' as never, lastSeq: 4 })
    const frame = await firstNext
    expect(frame.done).toBe(false)
    expect(authenticated).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledTimes(1)
    downstream?.close()
    const after = await iterator.next()
    expect(after.done).toBe(true)
  })

  it('records host downlink opens without a resumption cursor', async () => {
    const mock = new RemoteMockApiClient()
    const opened = vi.fn()
    const iterator = mock.events.host({}, new AbortController().signal, opened)[Symbol.asyncIterator]()
    const firstNext = iterator.next()
    await vi.waitFor(() => { expect(mock.hostDownlink).toBeDefined() })
    expect(mock.downlinks).toEqual([{ stream: 'events.host', since: undefined }])
    mock.hostDownlink?.push({ type: 'host/session-removed', sessionId: 'sessionA' as never })
    const frame = await firstNext
    expect(frame.done).toBe(false)
    expect((frame.value as { payload: unknown } | undefined)?.payload).toEqual({ type: 'host/session-removed', sessionId: 'sessionA' })
    mock.hostDownlink?.close()
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })

  it('forwards caller cancellation into the handler call context', async () => {
    const mock = new RemoteMockApiClient()
    const seen: (AbortSignal | undefined)[] = []
    mock.on('host.describe', (_payload, context) => {
      seen.push(context.signal)
      return { bootId: 'mock-boot' as never, version: '0', cwd: '/mock', attachedSessions: 0, canOpenPath: false }
    })
    const controller = new AbortController()
    await mock.host.describe({}, controller.signal)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(mock.calls).toHaveLength(1)
  })

  it('treats a request without an AbortSignal as uncancelled', async () => {
    class ExposedMock extends RemoteMockApiClient {
      fetchRaw = (input: URL, init?: RequestInit) => super.doFetch(input, init)
    }
    const mock = new ExposedMock()
    let captured: AbortSignal | undefined | null = 'unset' as never
    mock.on('host.describe', (_payload, context) => {
      captured = context.signal
      return { bootId: 'mock-boot' as never, version: '0', cwd: '/mock', attachedSessions: 0, canOpenPath: false }
    })
    const url = new URL('http://dsh.internal/api/host.describe')
    await mock.fetchRaw(url, { method: 'POST', body: JSON.stringify({ rpcId: 'r', requestId: 'q', payload: {} }) })
    expect(captured).toBeUndefined()
  })

  it('fails loud on a non-string request body instead of guessing an envelope', async () => {
    class ExposedMock extends RemoteMockApiClient {
      fetchRaw = (input: URL, init?: RequestInit) => super.doFetch(input, init)
    }
    const mock = new ExposedMock()
    const url = new URL('http://dsh.internal/api/host.describe')
    await expect(mock.fetchRaw(url, { method: 'POST', body: new Blob(['{}']) })).rejects.toThrow(SyntaxError)
  })

  it('settles the overridden wire identity on every response', async () => {
    const mock = new RemoteMockApiClient()
    const identity = { kind: 'grant', grantId: 'grant-1', grantRevision: 0 } as never
    mock.authenticateAs(identity)
    mock.on('host.describe', () => ({ bootId: 'mock-boot' as never, version: '0', cwd: '/mock', attachedSessions: 0, canOpenPath: false }))
    const response = await mock.host.describe({})
    expect(response.authentication).toEqual(identity)
  })

  it('propagates unexpected handler failures instead of swallowing them', async () => {
    const mock = new RemoteMockApiClient()
    mock.on('host.describe', () => {
      throw new Error('boom')
    })
    await expect(mock.host.describe({})).rejects.toThrow('boom')
  })
})

describe('createBypassClientAuthentication', () => {
  it('doubles every ClientAuthentication member without a network', async () => {
    const { createBypassClientAuthentication } = await import('../src/index.ts')
    const authentication = createBypassClientAuthentication()
    expect(authentication.getSnapshot()).toEqual({ mode: 'bypass', phase: 'ready', expiresAt: null, reason: null })
    const listener = vi.fn()
    const unsubscribe = authentication.subscribe(listener)
    unsubscribe()
    await expect(authentication.ready()).resolves.toBeUndefined()
    await expect(authentication.check()).resolves.toBeUndefined()
    authentication.requireRefresh()
    expect(authentication.getSnapshot()).toBeDefined()
    const refused = await authentication.fetch('https://example.invalid/')
    expect(refused.status).toBe(501)
    await expect(authentication.stop()).resolves.toBeUndefined()
  })
})

describe('mountRemoteConnection', () => {
  it('boots the real connection plugin over the mock carrier', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { mountRemoteConnection } = await import('../src/index.ts')
    const ctx = new Context()
    const harness = await mountRemoteConnection(ctx)
    const handle = harness.connection()
    expect(handle.api).toBe(harness.mock)
    expect(handle.isLoopback).toBe(true)
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
