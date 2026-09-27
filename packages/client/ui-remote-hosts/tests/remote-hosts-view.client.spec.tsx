// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteHostId, RemoteHostView } from '@deepseek-ai/dsh-remote-hosts/types'
import { createRemoteHostsViewStore } from '../src/client/stores.ts'
import { RemoteHostsView, type RemoteHostsViewProps } from '../src/client/RemoteHostsView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh)
const hostId = '11111111-1111-4111-8111-111111111111' as RemoteHostId

function host(overrides: Partial<RemoteHostView> = {}): RemoteHostView {
  return {
    id: hostId,
    name: 'Build host', host: 'build.example.test', port: 22, username: 'runner',
    fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    platform: 'linux', architecture: 'x64', authentication: { kind: 'password' }, reverseMappings: [],
    state: 'offline',
    ...overrides,
  }
}

type Face = {
  list: () => Promise<RemoteResult<RemoteHostView[]>>
  upsert: RemoteHostsViewProps['upsert']
  probe: RemoteHostsViewProps['probe']
  connect: RemoteHostsViewProps['connect']
  openRemote: RemoteHostsViewProps['openRemote']
  disconnect: RemoteHostsViewProps['disconnect']
  remove: RemoteHostsViewProps['remove']
}

function mount(overrides: Partial<Face> = {}, initialHosts: RemoteHostView[] = []) {
  const store = createRemoteHostsViewStore().create()
  const face: Face = {
    list: vi.fn(async () => ({ ok: true as const, value: initialHosts })),
    upsert: vi.fn(async () => ({ ok: true as const, value: host() })),
    probe: vi.fn(async () => ({ ok: true as const, value: { fingerprint: host().fingerprint } })),
    connect: vi.fn(async () => ({ ok: true as const, value: host({ state: 'connected' }) })),
    openRemote: vi.fn(),
    disconnect: vi.fn(async () => ({ ok: true as const, value: undefined })),
    remove: vi.fn(async () => ({ ok: true as const, value: undefined })),
    ...overrides,
  }
  const props = {
    active: true,
    useStore: ((selector: (value: ReturnType<typeof store.getSnapshot>) => unknown) => selector(store.getSnapshot())) as never,
    actions: store.actions,
    ...face,
    closeView: vi.fn(),
    t,
  } as unknown as RemoteHostsViewProps
  const view = render(<RemoteHostsView {...props} />)
  return { face, props, view }
}

describe('RemoteHostsView', () => {
  it('renders nothing while the view is inactive', () => {
    const store = createRemoteHostsViewStore().create()
    render(<RemoteHostsView {...({
      active: false,
      useStore: ((selector: (value: ReturnType<typeof store.getSnapshot>) => unknown) => selector(store.getSnapshot())) as never,
      actions: store.actions,
      list: vi.fn(async () => ({ ok: true as const, value: [] })), upsert: vi.fn(), probe: vi.fn(), connect: vi.fn(), openRemote: vi.fn(),
      disconnect: vi.fn(), remove: vi.fn(), closeView: vi.fn(), t,
    } as unknown as RemoteHostsViewProps)} />)
    expect(screen.queryByRole('heading', { name: zh.title })).toBeNull()
  })

  it('shows list failures and handles probe, key authentication, mappings, and ephemeral connect', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: [] }))
    const upsert = vi.fn(async (input: Parameters<RemoteHostsViewProps['upsert']>[0]) => ({ ok: true as const, value: host({
      name: input.name, host: input.host, username: input.username,
    }) }))
    const connect = vi.fn(async () => ({ ok: true as const, value: host({ state: 'connected' }) }))
    const probe = vi.fn(async () => ({ ok: true as const, value: { fingerprint: host().fingerprint } }))
    mount({ list, upsert, connect, probe })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.name), { target: { value: 'Key host' } })
    fireEvent.change(screen.getByLabelText(zh.host), { target: { value: 'key.example.test' } })
    fireEvent.change(screen.getByLabelText(zh.port), { target: { value: '2222' } })
    fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'runner' } })
    fireEvent.change(screen.getByLabelText(zh.auth), { target: { value: 'key' } })
    fireEvent.change(screen.getByLabelText(zh.platform), { target: { value: 'darwin' } })
    fireEvent.change(screen.getByLabelText(zh.architecture), { target: { value: 'arm64' } })
    fireEvent.change(screen.getByLabelText(zh.privateKey), { target: { value: 'PRIVATE KEY' } })
    fireEvent.change(screen.getByLabelText(zh.passphrase), { target: { value: 'phrase' } })
    fireEvent.click(screen.getByRole('button', { name: zh.addMapping }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('valid origin') })
    fireEvent.change(screen.getByLabelText(zh.localHost), { target: { value: '127.0.0.2' } })
    fireEvent.change(screen.getByLabelText(zh.remoteOrigin), { target: { value: 'http://model.example.test:9000' } })
    fireEvent.click(screen.getByRole('button', { name: zh.addMapping }))
    expect(screen.getByText(/model\.example\.test/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.removeMapping }))
    fireEvent.click(screen.getByRole('button', { name: zh.probe }))
    await waitFor(() => { expect((screen.getByLabelText(zh.fingerprint)).value).toBe(host().fingerprint) })
    fireEvent.click(screen.getByLabelText(zh.saveCredentials))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(upsert).toHaveBeenCalledTimes(1) })
    expect(upsert.mock.calls[0]?.[0].secrets).toBeUndefined()
    expect(connect).toHaveBeenCalledWith(hostId, { kind: 'key', privateKey: 'PRIVATE KEY', passphrase: 'phrase' })
  })

  it('renders refresh failures and performs disconnect/remove actions', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: [host({ state: 'connected' })] })
      .mockResolvedValue({ ok: false as const, error: { code: 'offline', message: 'list unavailable', details: {} } })
    const disconnect = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const remove = vi.fn(async () => ({ ok: true as const, value: undefined }))
    mount({ list, disconnect, remove }, [host({ state: 'connected' })])
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.disconnect })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('list unavailable') })
    fireEvent.click(screen.getByRole('button', { name: zh.disconnect }))
    await waitFor(() => { expect(disconnect).toHaveBeenCalledWith(hostId) })
    fireEvent.click(screen.getByRole('button', { name: zh.remove }))
    await waitFor(() => { expect(remove).toHaveBeenCalledWith(hostId) })
  })

  it('uses a fallback for malformed failure messages and non-Error action rejections', async () => {
    const connect = vi.fn(async () => ({ ok: false as const, error: { code: 'bad', message: 42, details: {} } } as never))
    mount({ connect }, [host()])
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.connect })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.connect }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Remote host operation failed') })
    connect.mockRejectedValueOnce('plain failure')
    fireEvent.click(screen.getByRole('button', { name: zh.connect }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('plain failure') })
  })

  it('surfaces probe and submit failures and rejects invalid mapping ports', async () => {
    const probe = vi.fn(async () => ({ ok: false as const, error: { code: 'probe', message: 'probe rejected', details: {} } }))
    const upsert = vi.fn(async () => { throw 'plain rejection' })
    mount({ probe, upsert })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.remoteOrigin), { target: { value: 'http://model.example.test' } })
    fireEvent.change(screen.getByLabelText(zh.localPort), { target: { value: '65536' } })
    fireEvent.click(screen.getByRole('button', { name: zh.addMapping }))
    expect(screen.getByRole('alert').textContent).toContain('valid origin and local port')
    fireEvent.click(screen.getByRole('button', { name: zh.probe }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('probe rejected') })
    fireEvent.change(screen.getByLabelText(zh.name), { target: { value: 'Bad host' } })
    fireEvent.change(screen.getByLabelText(zh.host), { target: { value: 'bad.example.test' } })
    fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'runner' } })
    fireEvent.change(screen.getByLabelText(zh.password), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('plain rejection') })
  })

  it('surfaces remote submit failures from both save and initial ephemeral connect', async () => {
    const upsert = vi.fn(async () => ({ ok: false as const, error: { code: 'denied', message: 'save denied', details: {} } }))
    mount({ upsert })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.name), { target: { value: 'Denied host' } })
    fireEvent.change(screen.getByLabelText(zh.host), { target: { value: 'host.example.test' } })
    fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'runner' } })
    fireEvent.change(screen.getByLabelText(zh.password), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('save denied') })
  })

  it('keeps an ephemeral host draft open when its first connection fails', async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, value: host() }))
    const connect = vi.fn(async () => ({ ok: false as const, error: { code: 'offline', message: 'connect denied', details: {} } }))
    mount({ upsert, connect })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.name), { target: { value: 'Ephemeral' } })
    fireEvent.change(screen.getByLabelText(zh.host), { target: { value: 'host.example.test' } })
    fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'runner' } })
    fireEvent.change(screen.getByLabelText(zh.password), { target: { value: 'one-time' } })
    fireEvent.click(screen.getByLabelText(zh.saveCredentials))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('connect denied') })
    expect(screen.getByLabelText(zh.name)).toBeTruthy()
  })

  it('submits a private key without a passphrase', async () => {
    const upsert = vi.fn(async (input: Parameters<RemoteHostsViewProps['upsert']>[0]) => ({ ok: true as const, value: host(input) }))
    mount({ upsert })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.name), { target: { value: 'Key host' } })
    fireEvent.change(screen.getByLabelText(zh.host), { target: { value: 'key.example.test' } })
    fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'runner' } })
    fireEvent.change(screen.getByLabelText(zh.auth), { target: { value: 'key' } })
    fireEvent.change(screen.getByLabelText(zh.privateKey), { target: { value: 'PRIVATE KEY' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(upsert).toHaveBeenCalledTimes(1) })
    expect(upsert.mock.calls[0]?.[0].secrets).toEqual({ kind: 'key', privateKey: 'PRIVATE KEY' })
  })

  it('cancels a new host draft without persisting it', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
    expect(screen.queryByLabelText(zh.name)).toBeNull()
  })

  it.each([
    ['connecting', zh.stateConnecting],
    ['deploying', zh.stateDeploying],
    ['error', zh.stateError],
  ] as const)('labels the %s lifecycle state and refreshes while it is pending', async (state, label) => {
    const callbacks: TimerHandler[] = []
    const originalInterval = globalThis.setInterval
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, timeout, ...args) => {
      if (timeout === 1_000) callbacks.push(handler)
      return originalInterval(handler, timeout, ...args)
    })
    const { face, view } = mount({}, [host({ state })])
    await waitFor(() => { expect(screen.getByText(label)).toBeTruthy() })
    if (state === 'connecting' || state === 'deploying') {
      expect(callbacks).toHaveLength(1)
      const refresh = callbacks[0]
      if (typeof refresh === 'function') (refresh as () => void)()
      await waitFor(() => { expect(face.list).toHaveBeenCalledTimes(2) })
    }
    view.unmount()
    interval.mockRestore()
  })

  it('renders failed Remote results instead of refreshing as if the action succeeded', async () => {
    const connect = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'denied', message: 'permission denied', details: {} },
    }))
    mount({ connect }, [host()])

    await waitFor(() => { expect(screen.getByRole('button', { name: zh.connect })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.connect }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('permission denied') })
  })

  it('offers the remote workspace opener only after the SSH session is connected', async () => {
    const openRemote = vi.fn()
    const { props, view } = mount({ openRemote }, [host({ state: 'connected' })])
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.openRemote })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.openRemote }))
    expect(openRemote).toHaveBeenCalledWith(hostId)
    fireEvent.click(view.container.querySelector('header button:last-child')!)
    expect(props.closeView).toHaveBeenCalled()
  })

  it('does not persist temporary login secrets and uses them for the initial connection', async () => {
    const upsert = vi.fn(async (input: Parameters<RemoteHostsViewProps['upsert']>[0]) => ({ ok: true as const, value: host({
      name: input.name, host: input.host, username: input.username,
    }) }))
    const connect = vi.fn(async () => ({ ok: true as const, value: host({ state: 'connected' }) }))
    mount({ upsert, connect })

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.name), { target: { value: 'Ephemeral host' } })
    fireEvent.change(screen.getByLabelText(zh.host), { target: { value: 'host.example.test' } })
    fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'runner' } })
    fireEvent.change(screen.getByLabelText(zh.fingerprint), { target: { value: host().fingerprint } })
    fireEvent.change(screen.getByLabelText(zh.password), { target: { value: 'one-time-password' } })
    fireEvent.click(screen.getByLabelText(zh.saveCredentials))
    fireEvent.click(screen.getByRole('button', { name: zh.save }))

    await waitFor(() => { expect(connect).toHaveBeenCalledTimes(1) })
    const savedInput = upsert.mock.calls[0]?.[0]
    expect(savedInput?.secrets).toBeUndefined()
    expect(connect).toHaveBeenCalledWith(hostId, { kind: 'password', password: 'one-time-password' })
  })
})
