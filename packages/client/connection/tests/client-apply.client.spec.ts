/**
 * Connection plugin browser-half apply: ctx.connection handle mounting, mode
 * selection off the page URL, and the single-consumer stream-loop ownership.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import { apply, type ConnectionHandle, type ConnectionCarrierOverride } from '../src/client/index.ts'
import type { RpcMessage } from '../src/client/api.ts'
import { RpcId } from '../src/client/api.ts'
import { FixtureApiClient } from '../src/client/fixture.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'
import { createWebConnectionRpc } from '../src/client/rpc.ts'
import type { ClientAuthentication, BrowserAuthenticationSnapshot } from '@deepseek-ai/dsh-client-authentication'

type Win = { location?: { hostname: string; search: string; origin?: string } }
type WebSocketGlobal = { WebSocket?: typeof WebSocket }

const originalWebSocket = globalThis.WebSocket
const sockets: FakeWebSocket[] = []
const contexts: Context[] = []

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = FakeWebSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return
      this.readyState = FakeWebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  delete (globalThis as Win).location
  sockets.length = 0
  if (originalWebSocket === undefined) delete (globalThis as WebSocketGlobal).WebSocket
  else globalThis.WebSocket = originalWebSocket
})

function authenticationDouble(): ClientAuthentication {
  return {
    getSnapshot: () => ({ mode: 'bypass', phase: 'ready', expiresAt: null, reason: null }),
    subscribe: () => () => {}, ready: async () => {}, check: async () => {}, stop: async () => {}, requireRefresh: () => {},
    fetch: (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init),
  }
}

async function mount(authentication = authenticationDouble(), carrier?: ConnectionCarrierOverride): Promise<ConnectionHandle> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('clientAuthentication', authentication)
  if (carrier !== undefined) ctx.provide('connectionCarrier', carrier)
  await ctx.plugin({ apply, inject: [] })
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

describe('connection client apply', () => {
  it('routes local settings through page authority and retracts a mismatched local reply', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'http://localhost:3080' }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected JSON body')
      const { rpcId, method } = JSON.parse(init.body) as { rpcId: string; method: string }
      const identity = method === 'settings.describe'
        ? { kind: 'grant', grantId: 'foreign', grantRevision: 1 } : { kind: 'bypass' }
      return Promise.resolve(Response.json({ type: 'server-response', rpcId, authentication: identity,
        result: method === 'host.describe'
          ? { ok: true, value: { bootId: 'boot', version: '0', cwd: '/', attachedSessions: 0, canOpenPath: false } }
          : { ok: false, error: { code: 'internal', message: 'offline', details: {} } } }))
    })
    const handle = await mount()
    const loop = handle.start({})
    try {
      await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
      for (const socket of sockets) socket.receive(JSON.stringify({ type: 'server-request', rpcId: 'identity',
        method: 'connection.authenticated', payload: { kind: 'bypass' } }))
      await vi.waitFor(() => { expect(handle.authentication.getSnapshot()).toEqual({ kind: 'bypass' }) })
      await handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
      const local = handle.api.settings.describe({ namespace: 'test' })
      await expect(local).rejects.toThrow('authentication identity mismatch')
      expect(handle.authentication.getSnapshot()).toBeUndefined()
      const request = fetch.mock.calls.at(-1)?.[0]
      expect(new URL(request instanceof Request ? request.url : request!).search).toBe('')
    } finally { loop.stop(); fetch.mockRestore() }
  })

  it('routes responses to the selected target and handles uploads with optional hooks', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    await handle.upload({ data: new Uint8Array([1]) })
    await handle.upload({ data: new Uint8Array([2]) }, {})
    await handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    expect(handle.target.getSnapshot().kind).toBe('remote')
  })

  it('contains a target observer exception and notifies the remaining observers', async () => {
    const handle = await mount()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    handle.target.subscribe(() => { throw new Error('observer failed') })
    handle.target.subscribe(() => { seen.push(handle.target.getSnapshot().kind) })
    try {
      await handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
      expect(seen).toEqual(['remote'])
      expect(errors).toHaveBeenCalledWith('[client-connection] target observer failed:', expect.any(Error))
    } finally { errors.mockRestore() }
  })

  it('routes a raw upload to the selected remote with no optional hooks', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    class UploadXhr {
      static latest: UploadXhr | undefined
      constructor() { UploadXhr.latest = this }
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
      onload: (() => void) | null = null
      onabort: (() => void) | null = null
      onerror: (() => void) | null = null
      responseType = ''
      status = 200
      responseText = JSON.stringify({ attachmentId: `sha256:${'a'.repeat(64)}`, bytes: 1 })
      readonly open = vi.fn()
      setRequestHeader(): void {}
      send(): void { this.onload?.() }
      abort(): void { this.onabort?.() }
    }
    vi.stubGlobal('XMLHttpRequest', UploadXhr)
    try {
      const handle = await mount()
      await handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
      await expect(handle.upload({ data: new Uint8Array([1]) })).resolves.toMatchObject({ bytes: 1 })
      expect(UploadXhr.latest?.open).toHaveBeenCalledWith('POST',
        'http://dsh.internal/api/attachment/upload?dshRemoteHost=11111111-1111-4111-8111-111111111111')
    } finally { vi.unstubAllGlobals() }
  })

  it('delivers matched-generation mux and host frames after authentication', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'http://localhost:3080' }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected JSON body')
      const { rpcId } = JSON.parse(init.body) as { rpcId: string }
      return Promise.resolve(Response.json({ type: 'server-response', rpcId, authentication: { kind: 'bypass' },
        result: { ok: true, value: { bootId: 'boot', version: '0', cwd: '/', attachedSessions: 0, canOpenPath: false } } }))
    })
    const handle = await mount()
    const received: string[] = []
    const loop = handle.start({
      onMuxEnvelope: (envelope) => { received.push(envelope.payload.type) },
      onHostEnvelope: (envelope) => { received.push(envelope.payload.type) },
    })
    try {
      await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
      for (const socket of sockets) socket.receive(JSON.stringify({ type: 'server-request', rpcId: 'identity',
        method: 'connection.authenticated', payload: { kind: 'bypass' } }))
      await vi.waitFor(() => { expect(handle.health.getSnapshot()).toBe('bypass') })
      sockets[0]!.receive(JSON.stringify({ type: 'server-request', rpcId: 'mux', method: 'session/subscribed',
        payload: { type: 'session/subscribed', sessionId: 'same', lastSeq: 1 } }))
      sockets[1]!.receive(JSON.stringify({ type: 'server-request', rpcId: 'host', method: 'host/session-removed',
        payload: { type: 'host/session-removed', sessionId: 'same' } }))
      await vi.waitFor(() => { expect(received).toEqual(['session/subscribed', 'host/session-removed']) })
    } finally { loop.stop(); fetch.mockRestore() }
  })

  it('does not announce a machine retargeted by a health observer mid-handshake', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const connected = vi.fn()
    const teardown = Promise.withResolvers<undefined>()
    let switched: Promise<void> | undefined
    let once = false
    handle.health.subscribe(() => {
      if (once || handle.health.getSnapshot() !== 'bypass') return
      once = true
      switched = handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    })
    const loop = handle.start({ onConnected: connected, onTargetChange: () => teardown.promise })
    await vi.waitFor(() => { expect(once).toBe(true) })
    expect(connected).not.toHaveBeenCalled()
    teardown.resolve(undefined)
    await switched
    loop.stop()
  })

  it('does not announce a remote retargeted by its page-identity observer', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    await handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    const connected = vi.fn()
    const teardown = Promise.withResolvers<undefined>()
    let switched: Promise<void> | undefined
    let once = false
    handle.authentication.subscribe(() => {
      if (once || handle.authentication.getSnapshot() === undefined) return
      once = true
      switched = handle.switchTarget({ kind: 'host' })
    })
    const loop = handle.start({ onConnected: connected, onTargetChange: () => teardown.promise })
    await vi.waitFor(() => { expect(once).toBe(true) })
    expect(connected).not.toHaveBeenCalled()
    teardown.resolve(undefined)
    await switched
    expect(handle.target.getSnapshot()).toEqual({ kind: 'host' })
    loop.stop()
  })

  it('shares the pending transition with a same-target request from a target observer', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const teardown = Promise.withResolvers<undefined>()
    const loop = handle.start({ onTargetChange: () => teardown.promise })
    let observed: Promise<void> | undefined
    handle.target.subscribe(() => { observed = handle.switchTarget(handle.target.getSnapshot()) })
    const switched = handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    expect(observed).toBe(switched)
    teardown.resolve(undefined)
    await switched
    loop.stop()
  })

  it('publishes the transition before invoking consumer teardown', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const teardown = Promise.withResolvers<undefined>()
    let observed: Promise<void> | undefined
    const loop = handle.start({ onTargetChange: () => {
      observed = handle.switchTarget(handle.target.getSnapshot())
      return teardown.promise
    } })
    const switched = handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    expect(observed).toBe(switched)
    teardown.resolve(undefined)
    await switched
    loop.stop()
  })

  it('keeps the oldest cleanup barrier when an intervening switch fails', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const teardown = Promise.withResolvers<undefined>()
    let resets = 0
    const loop = handle.start({ onTargetChange: () => {
      resets++
      if (resets === 1) return teardown.promise
      if (resets === 2) return Promise.reject(new Error('middle cleanup failed'))
    } })
    const first = handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    const second = handle.switchTarget({ kind: 'remote', id: '22222222-2222-4222-8222-222222222222' })
      .catch((error: unknown) => error)
    let settled = false
    const last = handle.switchTarget({ kind: 'host' }).then(() => { settled = true })
    for (let turn = 0; turn < 12; turn++) await Promise.resolve()
    expect(settled).toBe(false)
    teardown.resolve(undefined)
    await Promise.all([first, last])
    expect(await second).toMatchObject({ message: 'middle cleanup failed' })
    expect(settled).toBe(true)
    loop.stop()
  })

  it('does not start the latest target until every retired consumer teardown finishes', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const first = Promise.withResolvers<undefined>()
    let resets = 0
    const loop = handle.start({ onTargetChange: () => ++resets === 1 ? first.promise : undefined })
    const toFirst = handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    let settled = false
    const toSecond = handle.switchTarget({ kind: 'remote', id: '22222222-2222-4222-8222-222222222222' })
      .then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    first.resolve(undefined)
    await Promise.all([toFirst, toSecond])
    expect(settled).toBe(true)
    loop.stop()
  })

  it.each(['rejects', 'throws', 'non-error'] as const)('can return to the host after a prior consumer teardown %s', async (failure) => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    let resets = 0
    const loop = handle.start({ onTargetChange: () => {
      if (++resets === 1) {
        const reason: unknown = failure === 'non-error' ? 'cleanup failed' : new Error('cleanup failed')
        if (failure !== 'rejects') throw reason
        return Promise.reject(new Error('cleanup failed'))
      }
    } })
    await expect(handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' }))
      .rejects.toThrow('cleanup failed')
    await handle.switchTarget({ kind: 'host' })
    expect(handle.target.getSnapshot()).toEqual({ kind: 'host' })
    expect(resets).toBe(2)
    loop.stop()
  })

  it('cannot revive a disposed connection through a retained switch or start callback', async () => {
    const handle = await mount()
    await contexts.at(-1)!.fiber.dispose()
    expect(() => handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' }))
      .toThrow('disposed')
    expect(() => handle.start({})).toThrow('disposed')
    await expect(handle.captureApi().host.describe({})).rejects.toThrow('machine target changed')
  })

  it('awaits target teardown, skips superseded streams, and returns from an unavailable remote', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'http://localhost:3080' }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const first = Promise.withResolvers<undefined>()
    const second = Promise.withResolvers<undefined>()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON string request body')
      const { rpcId } = JSON.parse(init.body) as { rpcId: string }
      return Promise.resolve(Response.json({ type: 'server-response', rpcId, authentication: { kind: 'bypass' },
        result: { ok: true, value: { bootId: 'boot', version: '0', cwd: '/', attachedSessions: 0, canOpenPath: false } } }))
    })
    const handle = await mount()
    let resets = 0
    const loop = handle.start({ onTargetChange: () => ++resets === 1 ? first.promise : resets === 2 ? second.promise : undefined })
    try {
      await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
      const toFirst = handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
      const toSecond = handle.switchTarget({ kind: 'remote', id: '22222222-2222-4222-8222-222222222222' })
      first.resolve(undefined)
      await toFirst
      expect(sockets).toHaveLength(2)
      expect(sockets.every(socket => socket.readyState === FakeWebSocket.CLOSED)).toBe(true)
      second.resolve(undefined)
      await toSecond
      expect(sockets.slice(2).map(socket => new URL(socket.url).searchParams.get('dshRemoteHost'))).toEqual([
        '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222',
      ])
      await handle.switchTarget({ kind: 'host' })
      expect(handle.target.getSnapshot()).toEqual({ kind: 'host' })
      expect(sockets.slice(-2).every(socket => new URL(socket.url).search === '')).toBe(true)
    } finally { loop.stop(); fetch.mockRestore() }
  })

  it('revokes retained API calls and ignores unary bodies delivered after a switch', async () => {
    const handle = await mount()
    const previous = handle.captureApi()
    const body = Promise.withResolvers<unknown>()
    const reading = Promise.withResolvers<undefined>()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const response = Response.json({})
      response.json = () => { reading.resolve(undefined); return body.promise }
      return response
    })
    try {
      const pending = previous.host.describe({}).catch((error: unknown) => error)
      await reading.promise
      await handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
      expect(await pending).toBeInstanceOf(Error)
      const calls = fetch.mock.calls.length
      await expect(previous.host.describe({})).rejects.toThrow('machine target changed')
      expect(fetch.mock.calls).toHaveLength(calls)
      body.resolve({})
      await body.promise
      expect(handle.target.getSnapshot()).toMatchObject({ kind: 'remote' })
      await handle.switchTarget({ kind: 'host' })
    } finally { fetch.mockRestore() }
  })

  it('aborts uploads and suppresses late receipts and progress after changing machines', async () => {
    const receipt = Promise.withResolvers<import('@deepseek-ai/dsh-attachment').FileAttachmentRef>()
    let hooks: import('../src/client/upload.ts').FileUploadHooks | undefined
    const handle = await mount(authenticationDouble(), {
      api: new FixtureApiClient(), upload: (_request, next) => { hooks = next; return receipt.promise },
    })
    const progress: number[] = []
    const pending = handle.upload({ data: new Uint8Array([1]) }, { onProgress: value => progress.push(value.loaded) })
      .catch((error: unknown) => error)
    hooks?.onProgress?.({ loaded: 1, total: 2 })
    await handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    expect(hooks?.signal?.aborted).toBe(true)
    hooks?.onProgress?.({ loaded: 2, total: 2 })
    receipt.resolve({ attachmentId: `sha256:${'a'.repeat(64)}` as never, bytes: 2 })
    expect(await pending).toBeInstanceOf(Error)
    expect(progress).toEqual([1])
  })

  it('preserves page-authority authentication while the selected remote is unavailable', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const ready = Promise.withResolvers<undefined>()
    const loop = handle.start({ onConnected: () => { ready.resolve(undefined) } })
    await ready.promise
    const identity = handle.authentication.getSnapshot()
    await handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    expect(handle.authentication.getSnapshot()).toBe(identity)
    expect(handle.authentication.validate(identity)).toBe(true)
    await handle.switchTarget({ kind: 'host' })
    loop.stop()
  })

  it('switches machines in the document and treats the same target as a no-op', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    expect(handle.target.getSnapshot()).toEqual({ kind: 'host' })
    expect(() => handle.switchTarget({ kind: 'remote', id: '../invalid' })).toThrow('invalid remote host id')
    expect(handle.target.getSnapshot()).toEqual({ kind: 'host' })
    const changes: unknown[] = []
    const unsubscribe = handle.target.subscribe(() => { changes.push(handle.target.getSnapshot()) })
    const remote = { kind: 'remote' as const, id: '11111111-1111-4111-8111-111111111111' }
    await handle.switchTarget(remote)
    const snapshot = handle.target.getSnapshot()
    await handle.switchTarget({ ...remote })
    expect(handle.target.getSnapshot()).toBe(snapshot)
    expect(changes).toEqual([remote])
    expect((globalThis as Win).location?.search).toBe('')
    await handle.switchTarget({ kind: 'host' })
    expect(changes).toEqual([remote, { kind: 'host' }])
    unsubscribe()
  })

  it('cancels pending target RPCs across rapid switches and leaves local management usable', async () => {
    const handle = await mount()
    const pending = Promise.withResolvers<Response>()
    const requests: Array<{ url: URL; signal: AbortSignal | null | undefined; rpcId: string }> = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON string request body')
      const { rpcId } = JSON.parse(init.body) as { rpcId: string }
      requests.push({ url, signal: init?.signal, rpcId })
      if (url.pathname === '/api/goals/read') return pending.promise
      return Promise.resolve(Response.json({ type: 'server-response', rpcId, result: { ok: true, value: 'local' }, authentication: { kind: 'bypass' } }))
    })
    try {
      const old = handle.rpc.call('/api', 'goals/read', {}).catch((error: unknown) => error)
      await handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
      await handle.switchTarget({ kind: 'remote', id: '22222222-2222-4222-8222-222222222222' })
      expect(requests[0]?.signal?.aborted).toBe(true)
      pending.resolve(Response.json({ type: 'server-response', rpcId: requests[0]!.rpcId, result: { ok: true, value: 'stale' }, authentication: { kind: 'bypass' } }))
      expect(await old).toBeInstanceOf(Error)
      await expect(handle.rpc.call('/api', 'remoteHosts/list', {})).resolves.toMatchObject({ ok: true, value: 'local' })
      expect(requests.at(-1)?.url.search).toBe('')
      await handle.switchTarget({ kind: 'host' })
      expect(handle.target.getSnapshot()).toEqual({ kind: 'host' })
    } finally { fetch.mockRestore() }
  })

  it('projects authentication and transport health without exposing recovery actions to observers', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    let snapshot: BrowserAuthenticationSnapshot = { mode: 'authenticated', phase: 'ready', expiresAt: null, reason: null }
    let notify!: () => void
    const handle = await mount({ ...authenticationDouble(), getSnapshot: () => snapshot,
      subscribe: (listener) => { notify = listener; return () => {} } })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const observed: string[] = []
    const unsubscribe = handle.health.subscribe(() => { observed.push(handle.health.getSnapshot()) })
    const stopThrowing = handle.health.subscribe(() => { throw new Error('observer failed') })
    expect(handle.health.getSnapshot()).toBe('connecting')
    const loop = handle.start({})
    await vi.waitFor(() => { expect(handle.health.getSnapshot()).toBe('connected') })
    for (const phase of ['renewing', 'recovering', 'required', 'stopped'] as const) {
      snapshot = { ...snapshot, phase }
      notify()
      expect(handle.health.getSnapshot()).toBe(phase === 'stopped' ? 'required' : phase)
    }
    expect(handle.authentication.getSnapshot()).toBeUndefined()
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    expect(observed).toContain('recovering')
    expect(errors).toHaveBeenCalled()
    unsubscribe(); stopThrowing(); loop.stop(); errors.mockRestore()
  })

  it('keeps standalone carriers usable with an explicitly supplied transport', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    try {
      await expect(new WebApiClient().host.describe({})).rejects.toThrow('HTTP 503')
      await expect(createWebConnectionRpc().call('/api', 'test', {})).rejects.toThrow('HTTP 503')
    } finally { vi.unstubAllGlobals() }
  })

  it.each([false, true])('checks admission when a downlink closes (authentication=%s)', async (authenticated) => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const check = vi.fn().mockResolvedValue(undefined)
    const auth = authenticated ? { ...authenticationDouble(), check } : undefined
    const api = new WebApiClient(undefined, undefined, undefined, auth)
    const iterator = api.events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
    const reading = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.close()
    expect((await reading).done).toBe(true)
    expect(check).toHaveBeenCalledTimes(authenticated ? 1 : 0)
  })

  it('mounts ctx.connection with the real client when no ?fixture switch is present', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('selects the fixture client under ?fixture (and with no location at all stays real)', async () => {
    ;(globalThis as Win).location = { hostname: '127.0.0.1', search: '?fixture' }
    expect((await mount()).api).toBeInstanceOf(FixtureApiClient)
    delete (globalThis as Win).location
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('reports non-loopback page authority through the connection handle', async () => {
    ;(globalThis as Win).location = { hostname: '192.0.2.20', search: '' }
    expect((await mount()).isLoopback).toBe(false)
  })

  it('start() hands out one loop, rejects a second consumer, and stop() aborts the streams', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const descriptions: Array<boolean | undefined> = []
    const stopThrowing = handle.hostDescription.subscribe(() => { throw new Error('subscriber bug') })
    const stopDescription = handle.hostDescription.subscribe(() => {
      descriptions.push(handle.hostDescription.getSnapshot()?.canOpenPath)
    })
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    expect(handle.health.getSnapshot()).toBe('connecting')
    // config omitted: the `config ?? {}` default arm is part of the surface.
    let connected = 0
    const loop = handle.start({ onConnected: () => { connected++ } })
    expect(() => handle.start({})).toThrow(/already owned by another consumer/)
    await vi.waitFor(() => {
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    })
    loop.stop() // teardown must not throw; the fixture streams abort quietly
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    expect(descriptions).toEqual([true, undefined])
    expect(connected).toBe(1)
    expect(errorSpy).toHaveBeenCalledTimes(2)
    stopThrowing()
    stopDescription()
    errorSpy.mockRestore()
  })

  it('does not announce a generation synchronously stopped by a description subscriber', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const owner: { loop?: ReturnType<ConnectionHandle['start']> } = {}
    let sawDescription = false
    const stopDescription = handle.hostDescription.subscribe(() => {
      if (handle.hostDescription.getSnapshot() === undefined) return
      sawDescription = true
      owner.loop?.stop()
    })
    const connected = vi.fn()
    const loop = handle.start({ onConnected: connected })
    owner.loop = loop
    try {
      await vi.waitFor(() => { expect(sawDescription).toBe(true) })
      expect(handle.hostDescription.getSnapshot()).toBeUndefined()
      expect(connected).not.toHaveBeenCalled()
    } finally {
      stopDescription()
      loop.stop()
    }
  })

  it('retracts the host description while reconnecting and republishes the next generation', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const descriptions: Array<boolean | undefined> = []
    const reconnectSnapshots: Array<boolean | undefined> = []
    const stopDescription = handle.hostDescription.subscribe(() => {
      descriptions.push(handle.hostDescription.getSnapshot()?.canOpenPath)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({
      onStateChange: (state) => {
        if (state === 'reconnecting') {
          reconnectSnapshots.push(handle.hostDescription.getSnapshot()?.canOpenPath)
        }
      },
    }, { backoffBaseMs: 10, backoffFactor: 1, backoffMaxMs: 10, streamOpenTimeoutMs: 500 })
    try {
      await vi.waitFor(() => {
        expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
      })
      expect(handle.health.getSnapshot()).toBe('bypass')
      const timing = (globalThis as Record<string, unknown>).__fxTiming as
        | { breakStreams(): void }
        | undefined
      if (timing === undefined) throw new Error('fixture timing hooks missing')
      timing.breakStreams()

      await vi.waitFor(() => { expect(reconnectSnapshots).toEqual([undefined]) })
      await vi.waitFor(() => { expect(descriptions).toEqual([true, undefined, true]) })
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    } finally {
      stopDescription()
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('WebApiClient keeps reads on fetch and refuses a response before authentication readiness', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (input: URL | RequestInfo) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    try {
      // Schema rejection is fine — the transport hop is the assertion.
      await (handle.api as WebApiClient).host.describe({}).catch(() => undefined)
      await handle.api.respond({
        type: 'client-response',
        rpcId: RpcId('response-over-http'),
        result: { ok: true, value: {} },
      }).catch(() => undefined)
    } finally {
      globalThis.fetch = original
    }
    expect(seen.some(u => u.includes('/api/host.describe'))).toBe(true)
    expect(seen.some(u => u.includes('/api/respond'))).toBe(false)
  })

  it('opens one WebSocket per downlink, parses frames, and aborts both without using fetch', async () => {
    ;(globalThis as Win).location = {
      hostname: 'localhost', search: '', origin: 'http://localhost:3080',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const fetch = vi.spyOn(globalThis, 'fetch')
    const client = (await mount()).api as WebApiClient
    const envelopes: RpcMessage[][] = []
    client.subscribeEnvelopes((batch) => { envelopes.push([...batch]) })
    const opened: string[] = []
    const muxAbort = new AbortController()
    const hostAbort = new AbortController()
    const mux = client.events.mux({}, muxAbort.signal, () => { opened.push('mux') })[Symbol.asyncIterator]()
    const host = client.events.host({}, hostAbort.signal, () => { opened.push('host') })[Symbol.asyncIterator]()
    const muxFrame = mux.next()
    const hostFrame = host.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    expect(sockets.map(socket => socket.url)).toEqual([
      'ws://localhost:3080/api/events.mux',
      'ws://localhost:3080/api/events.host',
    ])
    await vi.waitFor(() => { expect(opened).toEqual(['mux', 'host']) })

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    sockets[0]!.receive(new Uint8Array([1, 2, 3]))
    sockets[1]!.receive(JSON.stringify({ type: 'server-request', rpcId: 'bad', method: 'host/session-status', payload: {} }))
    sockets[0]!.receive(JSON.stringify({
      type: 'server-request',
      rpcId: 'mux-browser',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-browser', lastSeq: 8 },
    }))
    sockets[1]!.receive(JSON.stringify({
      type: 'server-request',
      rpcId: 'host-browser',
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    }))
    expect(await muxFrame).toMatchObject({
      value: { rpcId: 'mux-browser', payload: { type: 'session/subscribed', lastSeq: 8 } },
    })
    expect(await hostFrame).toMatchObject({
      value: { rpcId: 'host-browser', payload: { type: 'host/remote-event', event: 'commands/change' } },
    })
    expect(errors).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => { expect(envelopes.flat()).toHaveLength(2) })
    expect(fetch).not.toHaveBeenCalled()

    const muxEnd = mux.next()
    const hostEnd = host.next()
    muxAbort.abort()
    hostAbort.abort()
    await expect(muxEnd).resolves.toMatchObject({ done: true })
    await expect(hostEnd).resolves.toMatchObject({ done: true })
    expect(sockets.every(socket => socket.readyState === FakeWebSocket.CLOSED)).toBe(true)
    errors.mockRestore()
    fetch.mockRestore()
  })

  it('maps an HTTPS page origin to a secure WebSocket URL', async () => {
    ;(globalThis as Win).location = {
      hostname: 'harness.example', search: '', origin: 'https://harness.example',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = (await mount()).api
    const abort = new AbortController()
    const iterator = client.events.mux({ since: { ['session-secure' as never]: 7 } }, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => {
      const url = new URL(sockets[0]?.url ?? 'ws://invalid')
      expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('wss://harness.example/api/events.mux')
      expect(JSON.parse(url.searchParams.get('since') ?? '')).toEqual({ 'session-secure': 7 })
    })
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
  })

  it('does not open a WebSocket when its signal was already aborted', async () => {
    ;(globalThis as Win).location = {
      hostname: 'localhost', search: '', origin: 'http://localhost:3080',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = (await mount()).api
    const abort = new AbortController()
    abort.abort()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    expect(sockets).toHaveLength(0)
  })

  it('carries RPC calls without requiring secure-context randomUUID', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        return bytes.fill(0)
      },
    })
    const handle = await mount()
    const original = globalThis.fetch
    const seen: { url: string; body: unknown }[] = []
    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON string request body')
      const body = JSON.parse(init.body) as { rpcId: string }
      seen.push({ url, body })
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { ref: 'goal-1' } },
        authentication: { kind: 'bypass' },
      })
    }
    try {
      await expect(handle.rpc.call('/api', 'goals/create', { args: { agentId: 'agent-1' } }))
        .resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    } finally {
      globalThis.fetch = original
      vi.unstubAllGlobals()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://dsh.internal/api/goals/create')
    expect(seen[0]?.body).toMatchObject({
      type: 'client-request',
      rpcId: '00000000-0000-4000-8000-000000000000',
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    })
  })

  it('validates generic RPC transport failures, correlation, and targets', async () => {
    ;(globalThis as Win).location = {
      hostname: 'harness.example', search: '', origin: 'https://harness.example',
    }
    const handle = await mount()
    const original = globalThis.fetch
    const abort = new AbortController()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))
    try {
      await expect(handle.rpc.call('/api', 'goals/create', {}, abort.signal))
        .rejects.toThrow('HTTP 503')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        new URL('https://harness.example/api/goals/create'),
        expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
      )

      ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'null' }
      globalThis.fetch = vi.fn().mockResolvedValue(Response.json({
        type: 'server-response',
        rpcId: 'different-rpc',
        result: { ok: true, value: null },
        authentication: { kind: 'bypass' },
      }))
      await expect(handle.rpc.call('/api', 'goals/create', {})).rejects.toThrow('rpcId mismatch')
      const fetch = vi.mocked(globalThis.fetch)
      expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('http://dsh.internal/api/goals/create'))
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    } finally {
      globalThis.fetch = original
    }

    for (const [channel, endpoint] of [
      ['api2', 'goals/create'],
      ['/api/path', 'goals/create'],
      ['/api', ''],
      ['/api', '.'],
      ['/api', '..'],
      ['/api', 'goals//create'],
      ['/api', 'goals/create?unsafe'],
    ] as const) {
      await expect(handle.rpc.call(channel, endpoint, {})).rejects.toThrow('invalid RPC target')
    }
  })

  it('carries Goal Remotes over the same state as the client-only fixture API', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const created = await handle.rpc.call('/api', 'goals/create', {
      args: { agentId: 'fx-alpha', request: { objective: 'fixture remote' } },
    })
    expect(created).toMatchObject({ ok: true, value: { ref: { revision: 1 } } })
    if (!created.ok) throw new Error('fixture Goal create failed')
    const ref = (created.value as { ref: { id: string; revision: number } }).ref
    const edited = await handle.rpc.call('/api', 'goals/edit', {
      args: { agentId: 'fx-alpha', ref, request: { objective: 'edited fixture remote' } },
    })
    expect(edited).toMatchObject({ ok: true, value: { objective: 'edited fixture remote', revision: 2 } })
    const editedRef = { id: ref.id, revision: 2 }
    const paused = await handle.rpc.call('/api', 'goals/pause', {
      args: { agentId: 'fx-alpha', ref: editedRef },
    })
    expect(paused).toMatchObject({ ok: true, value: { phase: 'paused', activation: 'disarmed', revision: 3 } })
    const resumed = await handle.rpc.call('/api', 'goals/resume', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 3 } },
    })
    expect(resumed).toMatchObject({ ok: true, value: { phase: 'active', activation: 'armed', revision: 4 } })
    const completed = await handle.rpc.call('/api', 'goals/complete', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 4 } },
    })
    expect(completed).toMatchObject({ ok: true, value: { phase: 'complete', activation: 'disarmed', revision: 5 } })
    await expect(handle.rpc.call('/api', 'goals/clear', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 5 } },
    })).resolves.toEqual({ ok: true, value: { id: ref.id, revision: 6 } })
    await expect(handle.rpc.call('/other', 'goals/create', {})).rejects.toThrow(/channel.*unavailable/)
    await expect(handle.rpc.call('/api', 'unknown/read', { args: { agentId: 'fx-alpha' } }))
      .rejects.toThrow(/endpoint.*unavailable/)
  })
})

describe('connection handle authentication source', () => {
  it('publishes the matched identity on connect and retracts it on stop', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const seen: Array<string | undefined> = []
    const stop = handle.authentication.subscribe(() => { seen.push(handle.authentication.getSnapshot()?.kind) })
    expect(handle.authentication.getSnapshot()).toBeUndefined()

    const loop = handle.start({})
    await vi.waitFor(() => { expect(handle.authentication.getSnapshot()?.kind).toBe('bypass') })
    loop.stop()
    expect(handle.authentication.getSnapshot()).toBeUndefined()
    expect(seen).toEqual(['bypass', undefined])
    stop()
  })

  it('does not republish an unchanged identity', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    let notifications = 0
    const stop = handle.authentication.subscribe(() => { notifications += 1 })

    const loop = handle.start({})
    await vi.waitFor(() => { expect(notifications).toBe(1) })
    // validate() against the identity already held is a pure read: the
    // generation stays and no listener runs again.
    expect(handle.authentication.validate({ kind: 'bypass' })).toBe(true)
    expect(notifications).toBe(1)
    expect(handle.authentication.getSnapshot()?.kind).toBe('bypass')
    loop.stop()
    stop()
  })

  it('retracts the identity and description when validate() sees a foreign identity', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const loop = handle.start({})
    await vi.waitFor(() => { expect(handle.authentication.getSnapshot()?.kind).toBe('bypass') })

    // A Host-verified identity the page did not expect invalidates the
    // generation, so the reconnect loop re-authenticates every carrier.
    expect(handle.authentication.validate({
      kind: 'grant',
      grantId: authenticationGrantId('someone-else'),
      grantRevision: 1,
    })).toBe(false)
    expect(handle.authentication.getSnapshot()).toBeUndefined()
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    // The loop is still running, so it re-establishes the same fixture identity.
    await vi.waitFor(() => { expect(handle.authentication.getSnapshot()?.kind).toBe('bypass') })
    loop.stop()
  })

  it('isolates a throwing authentication subscriber', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stopThrowing = handle.authentication.subscribe(() => { throw new Error('auth subscriber bug') })
    const kinds: Array<string | undefined> = []
    const stopReading = handle.authentication.subscribe(() => { kinds.push(handle.authentication.getSnapshot()?.kind) })

    const loop = handle.start({})
    await vi.waitFor(() => { expect(kinds).toEqual(['bypass']) })
    expect(errorSpy.mock.calls.map(call => String(call[0])))
      .toContain('[web-runtime] authentication listener threw:')
    loop.stop()
    stopThrowing()
    stopReading()
    errorSpy.mockRestore()
  })

  it('unsubscribes an authentication listener', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    let notifications = 0
    handle.authentication.subscribe(() => { notifications += 1 })()

    const loop = handle.start({})
    await vi.waitFor(() => { expect(handle.authentication.getSnapshot()?.kind).toBe('bypass') })
    expect(notifications).toBe(0)
    loop.stop()
  })

  it('retracts the identity while reconnecting', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const states: string[] = []
    const loop = handle.start({ onStateChange: state => states.push(state) }, {
      backoffBaseMs: 5, backoffFactor: 1, backoffMaxMs: 5,
    })
    await vi.waitFor(() => { expect(handle.authentication.getSnapshot()?.kind).toBe('bypass') })

    handle.authentication.validate({ kind: 'grant', grantId: authenticationGrantId('other'), grantRevision: 9 })
    await vi.waitFor(() => { expect(states).toContain('reconnecting') })
    await vi.waitFor(() => { expect(handle.authentication.getSnapshot()?.kind).toBe('bypass') })
    loop.stop()
  })
})

describe('WebApiClient stream authentication frames', () => {
  it('keeps envelope subscribers on the selected machine and isolates a throwing observer', async () => {
    const handle = await mount()
    if (!(handle.api instanceof WebApiClient)) throw new Error('expected a WebApiClient')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const received: RpcMessage[][] = []
    const throwing = handle.api.subscribeEnvelopes(() => { throw new Error('observer failed') })
    const stop = handle.api.subscribeEnvelopes((batch) => { received.push([...batch]) })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('expected JSON body')
      const { rpcId } = JSON.parse(init.body) as { rpcId: string }
      return Promise.resolve(Response.json({ type: 'server-response', rpcId,
        authentication: { kind: 'bypass' }, result: { ok: false, error: { code: 'internal', message: 'offline', details: {} } } }))
    })
    try {
      await expect(handle.api.host.describe({})).resolves.toMatchObject({ result: { ok: false } })
      await vi.waitFor(() => { expect(received.flat()).toHaveLength(2) })
      expect(errors).toHaveBeenCalledWith('[client-connection] envelope observer failed:', expect.any(Error))
      await handle.switchTarget({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
      await expect(handle.api.host.describe({})).resolves.toMatchObject({ result: { ok: false } })
      await vi.waitFor(() => { expect(received.flat()).toHaveLength(4) })
      stop(); throwing()
      await handle.api.host.describe({})
      expect(received.flat()).toHaveLength(4)
    } finally { fetch.mockRestore(); errors.mockRestore() }
  })

  it('drops messages delivered to a WebSocket after abort and closes during listener installation', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const caller = new AbortController()
    const api = new WebApiClient()
    const iterator = api.events.mux({}, caller.signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    caller.abort()
    sockets[0]!.receive(JSON.stringify({ type: 'server-request', rpcId: 'late', method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'same', lastSeq: 1 } }))
    expect(await first).toMatchObject({ done: true })
    expect(sockets[0]!.readyState).toBe(FakeWebSocket.CLOSED)

    const duringConstruction = new AbortController()
    class AbortingSocket extends FakeWebSocket {
      constructor(url: string | URL) { super(url); duringConstruction.abort() }
    }
    globalThis.WebSocket = AbortingSocket as unknown as typeof WebSocket
    const next = api.events.host({}, duringConstruction.signal)[Symbol.asyncIterator]()
    expect(await next.next()).toMatchObject({ done: true })
    expect(sockets.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('discards a queued WebSocket frame when the caller cancels before delivery', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const caller = new AbortController()
    const iterator = new WebApiClient().events.mux({}, caller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.receive(JSON.stringify({ type: 'server-request', rpcId: 'queued', method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'same', lastSeq: 1 } }))
    caller.abort()
    expect(await pending).toMatchObject({ done: true })
  })

  it('opens an unbound host downlink without a machine generation', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const caller = new AbortController()
    const iterator = new WebApiClient().events.host({}, caller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    expect(sockets[0]!.url).toBe('ws://dsh.internal/api/events.host')
    caller.abort()
    expect(await pending).toMatchObject({ done: true })
  })

  it('reports the Host-verified identity out of band and keeps it out of the frame stream', async () => {
    ;(globalThis as Win).location = {
      hostname: 'localhost', search: '', origin: 'http://localhost:3080',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = (await mount()).api as WebApiClient
    const identities: unknown[] = []
    const abort = new AbortController()
    const stream = client.events.mux({}, abort.signal, undefined, identity => identities.push(identity))
    const iterator = stream[Symbol.asyncIterator]()
    const firstFrame = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })

    sockets[0]!.receive(JSON.stringify({
      type: 'server-request',
      rpcId: 'auth-frame',
      method: 'connection.authenticated',
      payload: { kind: 'grant', grantId: 'browser-grant', grantRevision: 3 },
    }))
    await vi.waitFor(() => {
      expect(identities).toEqual([{ kind: 'grant', grantId: 'browser-grant', grantRevision: 3 }])
    })

    // The identity is transport metadata, so it never becomes a business frame.
    sockets[0]!.receive(JSON.stringify({
      type: 'server-request',
      rpcId: 'mux-after-auth',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-after-auth', lastSeq: 1 },
    }))
    expect(await firstFrame).toMatchObject({
      value: { rpcId: 'mux-after-auth', payload: { type: 'session/subscribed', lastSeq: 1 } },
    })

    const end = iterator.next()
    abort.abort()
    await expect(end).resolves.toMatchObject({ done: true })
  })

  it('drops an authentication frame carrying an unusable identity', async () => {
    ;(globalThis as Win).location = {
      hostname: 'localhost', search: '', origin: 'http://localhost:3080',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = (await mount()).api as WebApiClient
    const identities: unknown[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal, undefined, identity => identities.push(identity))[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })

    sockets[0]!.receive(JSON.stringify({
      type: 'server-request',
      rpcId: 'auth-bad',
      method: 'connection.authenticated',
      payload: { kind: 'grant' },
    }))
    await vi.waitFor(() => { expect(errors).toHaveBeenCalledTimes(1) })
    expect(identities).toEqual([])

    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    errors.mockRestore()
  })
})
