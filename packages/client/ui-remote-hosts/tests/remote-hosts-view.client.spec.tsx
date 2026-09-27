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
    mount({ openRemote }, [host({ state: 'connected' })])
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.openRemote })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.openRemote }))
    expect(openRemote).toHaveBeenCalledWith(hostId)
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
