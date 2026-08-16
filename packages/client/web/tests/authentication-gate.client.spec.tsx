// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AuthenticationGate } from '../src/AuthenticationGate.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('browser authentication gate', () => {
  it('exchanges a token for a cookie before releasing browser boot', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ mode: 'authenticated', sealed: false, authenticated: false }))
      .mockResolvedValueOnce(Response.json({ authenticated: true }))
    vi.stubGlobal('fetch', fetch)
    const authenticated = vi.fn()
    const view = render(<AuthenticationGate onAuthenticated={authenticated} />)
    const input = await view.findByLabelText('访问令牌')

    fireEvent.change(input, { target: { value: 'dsh1_test_secret' } })
    fireEvent.click(view.getByRole('button', { name: '进入工作台' }))
    await waitFor(() => { expect(authenticated).toHaveBeenCalledTimes(1) })
    expect(fetch).toHaveBeenNthCalledWith(2, '/auth/login', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ token: 'dsh1_test_secret' }),
    }))
    expect(localStorage).toHaveLength(0)
    expect(sessionStorage).toHaveLength(0)
  })

  it('shows sealed recovery instructions instead of a token form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      Response.json({ mode: 'authenticated', sealed: true, authenticated: false }),
    ))
    const view = render(<AuthenticationGate onAuthenticated={() => {}} />)
    expect(await view.findByText(/dsh auth token add/)).toBeTruthy()
    expect(view.queryByLabelText('访问令牌')).toBeNull()
  })
})
