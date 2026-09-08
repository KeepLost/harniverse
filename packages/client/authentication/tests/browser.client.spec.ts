// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserAuthentication, BrowserAuthenticationRequired } from '../src/browser.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('browser authentication ownership', () => {
  it('recovers an admission rejection once without replaying an uncertain write', async () => {
    const exchange = vi.fn().mockResolvedValue(new Date(Date.now() + 600_000).toISOString())
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401, headers: { 'x-dsh-authentication': 'required' } }))
      .mockResolvedValueOnce(new Response('accepted'))
      .mockRejectedValueOnce(new TypeError('network failed'))
    vi.stubGlobal('fetch', fetch)
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(), exchange })
    try {
      const init = { method: 'POST', body: 'one logical message' }
      expect(await (await auth.fetch('/api/session.prompt', init)).text()).toBe('accepted')
      expect(exchange).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenNthCalledWith(1, '/api/session.prompt', expect.objectContaining({ body: init.body }))
      expect(fetch).toHaveBeenNthCalledWith(2, '/api/session.prompt', expect.objectContaining({ body: init.body }))
      await expect(auth.fetch('/api/session.prompt', init)).rejects.toThrow('network failed')
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(auth.getSnapshot().phase).toBe('ready')
    } finally { await auth.stop() }
  })

  it('shares recovery across concurrent requests and does not renew on a late old 401', async () => {
    let finish!: (expiry: string) => void
    const exchange = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401, headers: { 'x-dsh-authentication': 'required' } }))
      .mockResolvedValueOnce(new Response(null, { status: 401, headers: { 'x-dsh-authentication': 'required' } }))
      .mockImplementation(() => Promise.resolve(new Response('ok')))
    vi.stubGlobal('fetch', fetch)
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(), exchange })
    try {
      const first = auth.fetch('/api/a')
      const second = auth.fetch('/api/b')
      await vi.waitFor(() => { expect(exchange).toHaveBeenCalledOnce() })
      expect(auth.getSnapshot().phase).toBe('recovering')
      finish(new Date(Date.now() + 600_000).toISOString())
      expect(await (await first).text()).toBe('ok')
      expect(await (await second).text()).toBe('ok')
      expect(exchange).toHaveBeenCalledOnce()
    } finally { await auth.stop() }
  })

  it('does not retry permission errors or unclassified 401s', async () => {
    const exchange = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 })))
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(), exchange })
    try {
      expect((await auth.fetch('/api/a')).status).toBe(403)
      expect((await auth.fetch('/api/b')).status).toBe(401)
      expect(exchange).not.toHaveBeenCalled()
    } finally { await auth.stop() }
  })

  it('renews at half life and exposes an unextendable deadline without reloading', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const exchange = vi.fn().mockResolvedValue(new Date(8_000).toISOString())
    const auth = new BrowserAuthentication({ expiresAt: new Date(8_000).toISOString(), exchange })
    const states: string[] = []
    const unsubscribe = auth.subscribe(() => { states.push(auth.getSnapshot().phase) })
    try {
      await vi.advanceTimersByTimeAsync(3_999)
      expect(exchange).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(states).toEqual(['renewing', 'ready'])
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
      expect(exchange).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(4_000)
      expect(auth.getSnapshot()).toMatchObject({ phase: 'required', reason: 'expired' })
      await expect(auth.ready()).rejects.toBeInstanceOf(BrowserAuthenticationRequired)
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
      expect(exchange).toHaveBeenCalledOnce()
    } finally { unsubscribe(); await auth.stop() }
  })

  it('recovers on wake and retries transient failures across Cookie expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const exchange = vi.fn().mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(new Date(600_000).toISOString())
    const auth = new BrowserAuthentication({ expiresAt: new Date(8_000).toISOString(), exchange })
    try {
      window.dispatchEvent(new Event('focus'))
      expect(exchange).not.toHaveBeenCalled()
      vi.setSystemTime(10_000)
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
      expect(auth.getSnapshot()).toMatchObject({ phase: 'recovering', reason: 'unavailable' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(auth.getSnapshot().phase).toBe('ready')
      expect(exchange).toHaveBeenCalledTimes(2)
    } finally { await auth.stop() }
  })

  it('cancels one waiting request without cancelling the shared recovery', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    const exchange = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 10).toISOString(), exchange })
    vi.setSystemTime(Date.now() + 100)
    const abort = new AbortController()
    const pending = auth.ready(abort.signal)
    const result = expect(pending).rejects.toThrow('caller cancelled')
    await Promise.resolve()
    abort.abort(new Error('caller cancelled'))
    await result
    finish(new Date(Date.now() + 600_000).toISOString())
    await auth.ready()
    expect(exchange).toHaveBeenCalledOnce()
    expect(auth.getSnapshot().phase).toBe('ready')
    await expect(auth.ready(abort.signal)).rejects.toThrow('caller cancelled')
    await auth.stop()
  })

  it('drains a late exchange on stop and never publishes its credential as usable', async () => {
    let finish!: (value: string) => void
    const exchange = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(), exchange })
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    const stop = auth.stop()
    finish(new Date(Date.now() + 600_000).toISOString())
    await stop
    expect(auth.getSnapshot().phase).toBe('stopped')
    await expect(auth.ready()).rejects.toBeInstanceOf(BrowserAuthenticationRequired)
  })

  it('checks Cookie admission for status-less transports and contains observer failures', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exchange = vi.fn().mockResolvedValue(new Date(Date.now() + 600_000).toISOString())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ authenticated: false }))
      .mockResolvedValueOnce(Response.json({ authenticated: true }))
      .mockResolvedValueOnce(new Response(null, { status: 503 })))
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(), exchange })
    const stopObserving = auth.subscribe(() => { throw new Error('observer failed') })
    try {
      await auth.check(new AbortController().signal)
      await auth.check()
      expect(exchange).toHaveBeenCalledOnce()
      expect(error).toHaveBeenCalled()
      await expect(auth.check()).rejects.toThrow('Authentication status unavailable (503)')
      await expect(auth.fetch('https://another.example/api')).rejects.toThrow('same-origin')
    } finally { stopObserving(); await auth.stop(); error.mockRestore() }
  })

  it.each(['invalid', new Date(0).toISOString()])('requires authentication for invalid bootstrap expiry %s', async (expiresAt) => {
    const auth = new BrowserAuthentication({ expiresAt, exchange: vi.fn() })
    expect(auth.getSnapshot().phase).toBe('required')
    await auth.stop()
  })

  it('does not claim authentication in explicit bypass mode', async () => {
    const auth = new BrowserAuthentication({ mode: 'bypass' })
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401, headers: { 'x-dsh-authentication': 'required' } }))
    vi.stubGlobal('fetch', fetch)
    window.dispatchEvent(new Event('online'))
    await auth.check()
    expect(fetch).not.toHaveBeenCalled()
    expect((await auth.fetch('/api/a')).status).toBe(401)
    expect(auth.getSnapshot()).toMatchObject({ mode: 'bypass', phase: 'ready', expiresAt: null })
    await auth.stop()
  })

  it('stops automatic retries after the restored credential is refused again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(null,
      { status: 401, headers: { 'x-dsh-authentication': 'required' } }))))
    const exchange = vi.fn().mockResolvedValue(new Date(Date.now() + 600_000).toISOString())
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(), exchange })
    expect((await auth.fetch('/api/a')).status).toBe(401)
    expect(auth.getSnapshot()).toMatchObject({ phase: 'required', reason: 'rejected' })
    expect(exchange).toHaveBeenCalledOnce()
    await auth.stop()
  })

  it('uses visibility recovery, times out an exchange, and retries without losing the owner', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const exchange = vi.fn().mockImplementationOnce((signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('exchange aborted')) }, { once: true })
    })).mockResolvedValue(new Date(600_000).toISOString())
    const auth = new BrowserAuthentication({ expiresAt: new Date(10_000).toISOString(), exchange })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(exchange).not.toHaveBeenCalled()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.setSystemTime(6_000)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(auth.getSnapshot().phase).toBe('recovering')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(auth.getSnapshot().phase).toBe('ready')
    await auth.stop()
    vi.restoreAllMocks()
  })

  it.each(['rejected', 'invalid-expiry'])('stops automatic recovery after %s', async (outcome) => {
    const exchange = outcome === 'rejected'
      ? vi.fn().mockRejectedValue(new BrowserAuthenticationRequired())
      : vi.fn().mockResolvedValue('not-a-date')
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(), exchange })
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => { expect(auth.getSnapshot().phase).toBe('required') })
    await auth.stop()
  })

  it('does not roll back a new credential when an older admission refusal arrives late', async () => {
    let failLate!: (response: Response) => void
    const exchange = vi.fn().mockResolvedValue(new Date(Date.now() + 600_000).toISOString())
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { failLate = resolve }))
      .mockResolvedValueOnce(new Response(null, { status: 401, headers: { 'x-dsh-authentication': 'required' } }))
      .mockImplementation(() => Promise.resolve(new Response('ok')))
    vi.stubGlobal('fetch', fetch)
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(), exchange })
    const older = auth.fetch('/api/older')
    await Promise.resolve()
    await auth.fetch('/api/newer')
    failLate(new Response(null, { status: 401, headers: { 'x-dsh-authentication': 'required' } }))
    expect(await (await older).text()).toBe('ok')
    expect(exchange).toHaveBeenCalledOnce()
    await auth.stop()
  })

  it('restores authentication but never silently buffers or replays a one-shot request stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null,
      { status: 401, headers: { 'x-dsh-authentication': 'required' } })))
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(),
      exchange: async () => new Date(Date.now() + 600_000).toISOString() })
    await expect(auth.fetch('/api/upload', { method: 'POST', body: new ReadableStream() }))
      .rejects.toThrow('retry the stream upload')
    expect(auth.getSnapshot().phase).toBe('ready')
    await auth.stop()
  })

  it('reports a sealed server as requiring renewed approval', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ authenticated: false, sealed: true })))
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(), exchange: vi.fn() })
    await expect(auth.check()).rejects.toBeInstanceOf(BrowserAuthenticationRequired)
    expect(auth.getSnapshot()).toMatchObject({ phase: 'required', reason: 'rejected' })
    await auth.stop()
  })

  it.each([false, true])('does not release a response after logout (retry=%s)', async (retry) => {
    let finish!: (response: Response) => void
    const request = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve }))
    if (retry) request.mockResolvedValueOnce(new Response(null, { status: 401, headers: { 'x-dsh-authentication': 'required' } }))
    vi.stubGlobal('fetch', request)
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(),
      exchange: async () => new Date(Date.now() + 600_000).toISOString() })
    const pending = auth.fetch('/api/secret')
    const refused = expect(pending).rejects.toBeInstanceOf(BrowserAuthenticationRequired)
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(retry ? 2 : 1) })
    await auth.stop()
    finish(new Response('must not escape'))
    await refused
  })

  it.each(['renewed', 'stopped'])('ignores a stale sealed status after the runtime is %s', async (state) => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
    const auth = new BrowserAuthentication({ expiresAt: new Date(Date.now() + 600_000).toISOString(),
      exchange: async () => new Date(Date.now() + 600_000).toISOString() })
    const pending = auth.check()
    await vi.waitFor(() => { expect(finish).toBeDefined() })
    if (state === 'stopped') await auth.stop()
    else {
      window.dispatchEvent(new Event('online'))
      await vi.waitFor(() => { expect(auth.getSnapshot().phase).toBe('ready') })
    }
    finish(Response.json({ authenticated: false, sealed: true }))
    await pending
    expect(auth.getSnapshot().phase).toBe(state === 'stopped' ? 'stopped' : 'ready')
    await auth.stop()
    auth.requireRefresh()
    expect(auth.getSnapshot().phase).toBe('stopped')
  })
})
