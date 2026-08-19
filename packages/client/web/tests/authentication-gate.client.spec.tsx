// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

const deviceApi = vi.hoisted(() => ({
  clear: vi.fn(),
  generate: vi.fn(),
  read: vi.fn(),
  sign: vi.fn(),
  write: vi.fn(),
}))

vi.mock('../src/browser-device.ts', () => ({
  clearBrowserDevice: deviceApi.clear,
  generateBrowserDeviceKey: deviceApi.generate,
  readBrowserDevice: deviceApi.read,
  signBrowserChallenge: deviceApi.sign,
  writeBrowserDevice: deviceApi.write,
}))

import {
  AuthenticationGate,
  logoutBrowserSession,
  maintainBrowserSession,
  stopBrowserSessionRenewal,
} from '../src/AuthenticationGate.tsx'

afterEach(async () => {
  await stopBrowserSessionRenewal()
  cleanup()
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('browser authentication gate', () => {
  it('creates and persists a personal-device enrollment before browser plugins load', async () => {
    deviceApi.read.mockResolvedValue(undefined)
    deviceApi.generate.mockResolvedValue({ privateKey: { type: 'private' }, publicKey: 'p256-spki' })
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ mode: 'authenticated', sealed: true, authenticated: false }))
      .mockResolvedValueOnce(Response.json({
        state: 'pending', id: 'request-id', approvalCode: 'a1b2c3d4', name: 'tablet', kind: 'device', expiresAt: '2099-01-01T00:00:00.000Z',
      }, { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    const view = render(<AuthenticationGate onAuthenticated={() => {}} />)
    const input = await view.findByLabelText('设备名称')

    fireEvent.change(input, { target: { value: 'tablet' } })
    fireEvent.click(view.getByRole('button', { name: '配对个人设备' }))

    expect(await view.findByText('a1b2c3d4')).toBeTruthy()
    expect(view.getByText(/dsh auth device approve request-id --profile owner/)).toBeTruthy()
    expect(deviceApi.write).toHaveBeenCalledWith(expect.objectContaining({ name: 'tablet', kind: 'device', enrollmentId: 'request-id' }))
    expect(fetch).toHaveBeenNthCalledWith(2, '/auth/enrollment', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'tablet', kind: 'device', publicKey: 'p256-spki' }),
    }))
  })

  it('shows the actionable enrollment response instead of only its status code', async () => {
    deviceApi.read.mockResolvedValue(undefined)
    deviceApi.generate.mockResolvedValue({ privateKey: { type: 'private' }, publicKey: 'p256-spki' })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ mode: 'authenticated', sealed: true, authenticated: false }))
      .mockResolvedValueOnce(new Response(
        'device name is already registered or awaiting approval; choose another name',
        { status: 409 },
      )))
    const view = render(<AuthenticationGate onAuthenticated={() => {}} />)

    fireEvent.click(await view.findByRole('button', { name: '配对个人设备' }))

    expect((await view.findByRole('alert')).textContent).toBe(
      '创建配对请求失败：设备名称已注册或正在等待批准，请换一个名称 (409)',
    )
  })

  it('uses a persisted non-exportable device key to obtain a short browser session', async () => {
    const privateKey = { type: 'private' }
    deviceApi.read.mockResolvedValue({ name: 'tablet', kind: 'device', privateKey, grantId: 'grant-id' })
    deviceApi.sign.mockResolvedValue('signed-proof')
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ mode: 'authenticated', sealed: false, authenticated: false }))
      .mockResolvedValueOnce(Response.json({ id: 'challenge-id', payload: '{"bound":true}', expiresAt: '2099-01-01T00:00:00.000Z' }))
      .mockResolvedValueOnce(Response.json({ authenticated: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }))
    vi.stubGlobal('fetch', fetch)
    const authenticated = vi.fn()
    render(<AuthenticationGate onAuthenticated={authenticated} />)

    await waitFor(() => { expect(authenticated).toHaveBeenCalledOnce() })
    expect(deviceApi.sign).toHaveBeenCalledWith(privateKey, '{"bound":true}')
    expect(fetch).toHaveBeenNthCalledWith(3, '/auth/exchange', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ challengeId: 'challenge-id', signature: 'signed-proof' }),
    }))
    expect(localStorage).toHaveLength(0)
    expect(sessionStorage).toHaveLength(0)
  })

  it('reestablishes signed renewal after reload with a valid browser session', async () => {
    const privateKey = { type: 'private' }
    deviceApi.read.mockResolvedValue({ name: 'tablet', kind: 'device', privateKey, grantId: 'grant-id' })
    deviceApi.sign.mockResolvedValue('signed-proof')
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ mode: 'authenticated', sealed: false, authenticated: true }))
      .mockResolvedValueOnce(Response.json({ id: 'challenge-id', payload: 'reload-proof', expiresAt: '2099-01-01T00:00:00.000Z' }))
      .mockResolvedValueOnce(Response.json({ authenticated: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }))
    vi.stubGlobal('fetch', fetch)
    const authenticated = vi.fn()
    render(<AuthenticationGate onAuthenticated={authenticated} />)

    await waitFor(() => { expect(authenticated).toHaveBeenCalledOnce() })
    const transferred = authenticated.mock.calls[0]?.[0] as { stop?: unknown } | undefined
    expect(typeof transferred?.stop).toBe('function')
    expect(deviceApi.sign).toHaveBeenCalledWith(privateKey, 'reload-proof')
    expect(fetch).toHaveBeenNthCalledWith(3, '/auth/exchange', expect.objectContaining({ method: 'POST' }))
  })

  it('keeps temporary-device keys in memory only', async () => {
    deviceApi.read.mockResolvedValue(undefined)
    deviceApi.generate.mockResolvedValue({ privateKey: { type: 'private' }, publicKey: 'temporary-spki' })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ mode: 'authenticated', sealed: false, authenticated: false }))
      .mockResolvedValueOnce(Response.json({
        state: 'pending', id: 'temporary-id', approvalCode: 'deadbeef', name: 'public-pc', kind: 'temporary', expiresAt: '2099-01-01T00:00:00.000Z',
      }, { status: 202 })))
    const view = render(<AuthenticationGate onAuthenticated={() => {}} />)
    fireEvent.change(await view.findByLabelText('设备名称'), { target: { value: 'public-pc' } })
    fireEvent.click(view.getByRole('button', { name: '临时使用公用设备' }))

    expect(await view.findByText('deadbeef')).toBeTruthy()
    expect(deviceApi.write).not.toHaveBeenCalled()
  })

  it('lets an owner device approve pending devices without loading browser plugins', async () => {
    window.history.replaceState({}, '', '/auth/manage')
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ mode: 'authenticated', sealed: false, authenticated: true }))
      .mockResolvedValueOnce(Response.json([{
        state: 'pending', id: 'request-id', approvalCode: 'a1b2c3d4', name: 'public-pc', kind: 'temporary', expiresAt: '2099-01-01T00:00:00.000Z',
      }]))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ id: 'grant-id' }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([]))
    vi.stubGlobal('fetch', fetch)
    const authenticated = vi.fn()
    const view = render(<AuthenticationGate onAuthenticated={authenticated} />)

    expect(await view.findByText('a1b2c3d4')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '批准' }))
    await waitFor(() => { expect(fetch).toHaveBeenCalledTimes(6) })
    expect(fetch).toHaveBeenNthCalledWith(4, '/auth/manage/enrollment/approve', expect.objectContaining({
      body: JSON.stringify({
        id: 'request-id',
        capabilities: ['harniverse.observe', 'harniverse.operate'],
        expiresInMs: 3_600_000,
        idleTimeoutMs: 900_000,
      }),
    }))
    expect(authenticated).not.toHaveBeenCalled()
  })

  it('returns an expired owner session to management after signed reauthentication', async () => {
    window.history.replaceState({}, '', '/auth/manage')
    const privateKey = { type: 'private' }
    deviceApi.read.mockResolvedValue({ name: 'owner', kind: 'device', privateKey, grantId: 'owner-grant' })
    deviceApi.sign.mockResolvedValue('owner-proof')
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ mode: 'authenticated', sealed: false, authenticated: false }))
      .mockResolvedValueOnce(Response.json({ id: 'challenge-id', payload: 'owner-challenge', expiresAt: '2099-01-01T00:00:00.000Z' }))
      .mockResolvedValueOnce(Response.json({ authenticated: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([]))
    vi.stubGlobal('fetch', fetch)
    const authenticated = vi.fn()
    const view = render(<AuthenticationGate onAuthenticated={authenticated} />)

    expect(await view.findByText('等待批准')).toBeTruthy()
    expect(authenticated).not.toHaveBeenCalled()
    expect(deviceApi.sign).toHaveBeenCalledWith(privateKey, 'owner-challenge')
  })

  it('renews the short browser session through possession before expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    deviceApi.sign.mockResolvedValue('renewal-proof')
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 'renewal-id', payload: 'renew-me', expiresAt: '2026-08-17T00:00:30.000Z' }))
      .mockResolvedValueOnce(Response.json({ authenticated: true, expiresAt: '2026-08-17T00:10:00.000Z' }))
    vi.stubGlobal('fetch', fetch)
    const recover = vi.fn()

    maintainBrowserSession({
      name: 'tablet', kind: 'device', privateKey: { type: 'private' } as CryptoKey, grantId: 'grant-id',
    }, '2026-08-17T00:00:31.000Z', recover)
    await vi.advanceTimersByTimeAsync(20_667)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(deviceApi.sign).toHaveBeenCalledWith({ type: 'private' }, 'renew-me')
    expect(recover).not.toHaveBeenCalled()
  })

  it('renews a short session proportionally without an immediate exchange loop', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    deviceApi.sign.mockResolvedValue('renewal-proof')
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 'renewal-id', payload: 'renew-me', expiresAt: '2026-08-17T00:00:08.000Z' }))
      .mockResolvedValueOnce(Response.json({ authenticated: true, expiresAt: '2026-08-17T00:00:15.000Z' }))
    vi.stubGlobal('fetch', fetch)

    maintainBrowserSession({
      name: 'tablet', kind: 'device', privateKey: { type: 'private' } as CryptoKey, grantId: 'grant-id',
    }, '2026-08-17T00:00:09.000Z')
    await vi.advanceTimersByTimeAsync(5_999)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('stops exchanging when a Grant deadline cannot extend the session', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    deviceApi.sign.mockResolvedValue('renewal-proof')
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 'renewal-id', payload: 'renew-me', expiresAt: '2026-08-17T00:00:08.000Z' }))
      .mockResolvedValueOnce(Response.json({ authenticated: true, expiresAt: '2026-08-17T00:00:09.000Z' }))
    vi.stubGlobal('fetch', fetch)
    const recover = vi.fn()

    maintainBrowserSession({
      name: 'tablet', kind: 'device', privateKey: { type: 'private' } as CryptoKey, grantId: 'grant-id',
    }, '2026-08-17T00:00:09.000Z', recover)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(recover).toHaveBeenCalledOnce()
  })

  it('drains an in-flight renewal before logout clears the resulting cookie', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    deviceApi.sign.mockResolvedValue('renewal-proof')
    let resolveExchange!: (response: Response) => void
    const exchange = new Promise<Response>((resolve) => { resolveExchange = resolve })
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 'renewal-id', payload: 'renew-me', expiresAt: '2026-08-17T00:00:30.000Z' }))
      .mockReturnValueOnce(exchange)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)

    maintainBrowserSession({
      name: 'tablet', kind: 'device', privateKey: { type: 'private' } as CryptoKey, grantId: 'grant-id',
    }, '2026-08-17T00:00:31.000Z')
    await vi.advanceTimersByTimeAsync(20_667)
    const logout = logoutBrowserSession()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)

    resolveExchange(Response.json({ authenticated: true, expiresAt: '2026-08-17T00:10:00.000Z' }))
    await logout
    expect(fetch).toHaveBeenNthCalledWith(3, '/auth/logout', { method: 'POST', credentials: 'same-origin' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
