import { describe, expect, it, vi } from 'vitest'
import { GrantAccess } from '../src/authentication.ts'

type FetchMock = typeof globalThis.fetch & ReturnType<typeof vi.fn>

function exchangeFetch(expiresAt = new Date(Date.now() + 60_000).toISOString()): FetchMock {
  return vi.fn()
    .mockResolvedValueOnce(Response.json({ id: 'challenge-id', payload: '{"nonce":"one"}', expiresAt }))
    .mockResolvedValueOnce(Response.json({ accessToken: 'short-token', expiresAt })) as FetchMock
}

describe('GrantAccess', () => {
  it('coalesces challenge exchange and reuses the short Access Token', async () => {
    const fetch = exchangeFetch()
    const signChallenge = vi.fn(() => Promise.resolve('signed-proof'))
    const access = new GrantAccess({
      origin: 'https://harness.example',
      grantId: 'client-grant',
      signChallenge,
      fetch,
    })

    await expect(Promise.all([access.authorization(), access.authorization()]))
      .resolves.toEqual(['Bearer short-token', 'Bearer short-token'])
    await expect(access.authorization()).resolves.toBe('Bearer short-token')
    expect(signChallenge).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://harness.example/auth/token', expect.objectContaining({
      body: JSON.stringify({ challengeId: 'challenge-id', signature: 'signed-proof' }),
    }))
  })

  it('refreshes near expiry and attaches the renewed credential to requests', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 'challenge-one', payload: 'one', expiresAt: new Date(Date.now() + 10_000).toISOString() }))
      .mockResolvedValueOnce(Response.json({ accessToken: 'first', expiresAt: new Date(Date.now() + 10_000).toISOString() }))
      .mockResolvedValueOnce(Response.json({ id: 'challenge-two', payload: 'two', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
      .mockResolvedValueOnce(Response.json({ accessToken: 'second', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as FetchMock
    const access = new GrantAccess({
      origin: 'http://127.0.0.1:3080',
      grantId: 'client-grant',
      renewBeforeMs: 30_000,
      signChallenge: payload => Promise.resolve(`signed-${payload}`),
      fetch,
    })

    await expect(access.authorization()).resolves.toBe('Bearer first')
    const response = await access.fetch('http://127.0.0.1:3080/api/session.list')
    expect(response.status).toBe(204)
    const lastCall = (fetch.mock.calls as unknown as [string | URL | Request, RequestInit?][]).at(-1)
    expect(lastCall?.[0]).toEqual(new URL('http://127.0.0.1:3080/api/session.list'))
    const headers = new Headers(lastCall?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer second')
  })

  it('rejects insecure remote origins and malformed exchange responses', async () => {
    expect(() => new GrantAccess({ origin: 'http://harness.example', grantId: 'grant', signChallenge: vi.fn() }))
      .toThrow(/require HTTPS/)
    const access = new GrantAccess({
      origin: 'https://harness.example',
      grantId: 'grant',
      signChallenge: vi.fn(),
      fetch: vi.fn().mockResolvedValue(Response.json({ unexpected: true })),
    })
    await expect(access.authorization()).rejects.toThrow(/invalid challenge response/)
  })

  it('never attaches a Harness credential to another origin', async () => {
    const fetch = exchangeFetch()
    const access = new GrantAccess({
      origin: 'https://harness.example',
      grantId: 'client-grant',
      signChallenge: () => Promise.resolve('signed-proof'),
      fetch,
    })

    await expect(access.fetch('https://attacker.example/collect')).rejects.toThrow(/same Harness origin/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not republish an exchange that clear invalidated', async () => {
    let resolveFirstToken!: (response: Response) => void
    const firstToken = new Promise<Response>((resolve) => { resolveFirstToken = resolve })
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 'challenge-one', payload: 'one', expiresAt }))
      .mockReturnValueOnce(firstToken)
      .mockResolvedValueOnce(Response.json({ id: 'challenge-two', payload: 'two', expiresAt }))
      .mockResolvedValueOnce(Response.json({ accessToken: 'current-token', expiresAt })) as FetchMock
    const access = new GrantAccess({
      origin: 'https://harness.example',
      grantId: 'client-grant',
      signChallenge: payload => Promise.resolve(`signed-${payload}`),
      fetch,
    })

    const stale = access.authorization()
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })
    access.clear()
    resolveFirstToken(Response.json({ accessToken: 'stale-token', expiresAt }))

    await expect(stale).resolves.toBe('Bearer stale-token')
    await expect(access.authorization()).resolves.toBe('Bearer current-token')
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('resolves relative authenticated targets against the Harness origin', async () => {
    const fetch = exchangeFetch()
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const access = new GrantAccess({
      origin: 'https://harness.example',
      grantId: 'client-grant',
      signChallenge: () => Promise.resolve('signed-proof'),
      fetch,
    })

    await expect(access.fetch('/api/session.list')).resolves.toMatchObject({ status: 204 })
    expect(fetch.mock.calls[2]?.[0]).toEqual(new URL('https://harness.example/api/session.list'))
  })

  it('preserves Request method, body, and headers while replacing Authorization', async () => {
    const fetch = exchangeFetch()
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const access = new GrantAccess({
      origin: 'https://harness.example',
      grantId: 'client-grant',
      signChallenge: () => Promise.resolve('signed-proof'),
      fetch,
    })
    const request = new Request('https://harness.example/api/session.create', {
      method: 'POST',
      headers: { authorization: 'Bearer stale', 'content-type': 'application/json', 'x-request': 'preserved' },
      body: '{"value":1}',
    })

    await expect(access.fetch(request)).resolves.toMatchObject({ status: 204 })
    const call = fetch.mock.calls[2] as unknown as [RequestInfo | URL, RequestInit?]
    const sent = new Request(call[0], call[1])
    expect(sent.method).toBe('POST')
    expect(sent.headers.get('content-type')).toBe('application/json')
    expect(sent.headers.get('x-request')).toBe('preserved')
    expect(sent.headers.get('authorization')).toBe('Bearer short-token')
    await expect(sent.text()).resolves.toBe('{"value":1}')
  })

  it('accepts a URL target and merges its headers with the refreshed credential', async () => {
    const fetch = exchangeFetch()
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const access = new GrantAccess({
      origin: 'https://harness.example',
      grantId: 'client-grant',
      signChallenge: () => Promise.resolve('signed-proof'),
      fetch,
    })

    await expect(access.fetch(new URL('https://harness.example/api/session.list'), {
      headers: { 'x-request': 'preserved' },
    })).resolves.toMatchObject({ status: 204 })
    const call = fetch.mock.calls[2] as unknown as [RequestInfo | URL, RequestInit?]
    expect(call[0]).toEqual(new URL('https://harness.example/api/session.list'))
    expect(new Headers(call[1]?.headers).get('x-request')).toBe('preserved')
  })

  it('rejects unsafe origins and invalid constructor options', () => {
    for (const value of [
      'https://user:pass@harness.example/',
      'https://harness.example/api',
      'https://harness.example/?query=1',
      'https://harness.example/#fragment',
    ]) {
      expect(() => new GrantAccess({ origin: value, grantId: 'grant', signChallenge: vi.fn() }))
        .toThrow('origin must not contain credentials, path, query, or fragment')
    }
    expect(() => new GrantAccess({ origin: 'https://harness.example', grantId: '', signChallenge: vi.fn() }))
      .toThrow('grantId must not be empty')
    for (const renewBeforeMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new GrantAccess({
        origin: 'https://harness.example', grantId: 'grant', signChallenge: vi.fn(), renewBeforeMs,
      })).toThrow('renewBeforeMs must be a non-negative integer')
    }
  })

  it('uses the global fetch fallback when no fetch implementation is supplied', async () => {
    const fetch = exchangeFetch()
    vi.stubGlobal('fetch', fetch)
    try {
      const access = new GrantAccess({
        origin: 'https://harness.example', grantId: 'grant', signChallenge: () => Promise.resolve('proof'),
      })
      await expect(access.authorization()).resolves.toBe('Bearer short-token')
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps rejected challenge and token responses to useful errors', async () => {
    const challengeRejected = new GrantAccess({
      origin: 'https://harness.example', grantId: 'grant', signChallenge: vi.fn(),
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
    })
    await expect(challengeRejected.authorization()).rejects.toThrow('challenge rejected (403)')

    const tokenRejected = new GrantAccess({
      origin: 'https://harness.example', grantId: 'grant', signChallenge: () => Promise.resolve('proof'),
      fetch: vi.fn()
        .mockResolvedValueOnce(Response.json({ id: 'challenge', payload: 'payload', expiresAt: 'later' }))
        .mockResolvedValueOnce(new Response(null, { status: 429 })),
    })
    await expect(tokenRejected.authorization()).rejects.toThrow('token exchange rejected (429)')
  })

  it('rejects malformed token responses after a valid challenge', async () => {
    for (const token of [
      null,
      [],
      { accessToken: 'token' },
      { accessToken: 'token', expiresAt: 'not-a-date' },
      { accessToken: 1, expiresAt: new Date().toISOString() },
      { accessToken: 'token', expiresAt: 5 },
    ]) {
      const access = new GrantAccess({
        origin: 'https://harness.example', grantId: 'grant', signChallenge: () => Promise.resolve('proof'),
        fetch: vi.fn()
          .mockResolvedValueOnce(Response.json({ id: 'challenge', payload: 'payload', expiresAt: 'later' }))
          .mockResolvedValueOnce(Response.json(token)),
      })
      await expect(access.authorization()).rejects.toThrow('invalid token response')
    }
  })
})
