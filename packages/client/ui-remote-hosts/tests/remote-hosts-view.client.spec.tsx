// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectivityResult, RemoteHostId, RemoteHostView } from '@deepseek-ai/dsh-remote-hosts/types'
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

export function evidence(overrides: Partial<ConnectivityResult> = {}): ConnectivityResult {
  return { fingerprint: host().fingerprint, platform: 'linux', architecture: 'x64', ...overrides }
}



type Face = {
  list: () => Promise<RemoteResult<RemoteHostView[]>>
  upsert: RemoteHostsViewProps['upsert']
  verify: RemoteHostsViewProps['verify']
  keyFilePicker: RemoteHostsViewProps['keyFilePicker']
  pickKeyFile: RemoteHostsViewProps['pickKeyFile']
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
    verify: vi.fn<RemoteHostsViewProps['verify']>(async () => ({ ok: true as const, value: evidence() })),
    keyFilePicker: vi.fn<RemoteHostsViewProps['keyFilePicker']>(async () => ({ ok: true as const, value: { kind: 'native' as const } })),
    pickKeyFile: vi.fn<RemoteHostsViewProps['pickKeyFile']>(async () => ({ ok: true as const, value: {} })),
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

/** Fill the target and credential fields every save path requires. */
function completeDraft(target: string): void {
  fireEvent.change(screen.getByLabelText(zh.name), { target: { value: 'New host' } })
  fireEvent.change(screen.getByLabelText(zh.host), { target: { value: target } })
  fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'runner' } })
  fireEvent.change(screen.getByLabelText(zh.password), { target: { value: 'secret' } })
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: zh.save }) as HTMLButtonElement
}

/** The file button stays disabled until the interaction probe lands; wait for the enabled native default. */
async function enabledKeyFileButton(): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const button = screen.getByRole<HTMLButtonElement>('button', { name: zh.chooseKeyFile })
    expect(button.disabled).toBe(false)
    return button
  })
}

describe('RemoteHostsView', () => {
  it('renders nothing while the view is inactive', () => {
    const store = createRemoteHostsViewStore().create()
    render(<RemoteHostsView {...({
      active: false,
      useStore: ((selector: (value: ReturnType<typeof store.getSnapshot>) => unknown) => selector(store.getSnapshot())) as never,
      actions: store.actions,
      list: vi.fn(async () => ({ ok: true as const, value: [] })), upsert: vi.fn(), verify: vi.fn(), pickKeyFile: vi.fn(),
      connect: vi.fn(), openRemote: vi.fn(),
      disconnect: vi.fn(), remove: vi.fn(), closeView: vi.fn(), t,
    } as unknown as RemoteHostsViewProps)} />)
    expect(screen.queryByRole('heading', { name: zh.title })).toBeNull()
  })

  it('requires a connectivity test before saving and records the tested evidence', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: [] }))
    const upsert = vi.fn(async (input: Parameters<RemoteHostsViewProps['upsert']>[0]) => ({ ok: true as const, value: host({
      name: input.name, host: input.host, username: input.username,
    }) }))
    const connect = vi.fn(async () => ({ ok: true as const, value: host({ state: 'connected' }) }))
    const verify = vi.fn<RemoteHostsViewProps['verify']>(async () => ({ ok: true as const,
      value: evidence({ platform: 'darwin', architecture: 'arm64' }) }))
    mount({ list, upsert, connect, verify })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('key.example.test')

    // A draft that has never been tested cannot be saved, and no field asks for a fingerprint.
    expect(saveButton().disabled).toBe(true)
    expect(document.body.textContent).not.toContain(evidence().fingerprint)

    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(verify).toHaveBeenCalledTimes(1) })
    expect(verify.mock.calls[0]?.[0]).toEqual({ host: 'key.example.test', port: 22, username: 'runner',
      secrets: { kind: 'password', password: 'secret' } })

    // Detected values prefill the target and stay editable.
    await waitFor(() => { expect(screen.getByLabelText(zh.platform)).toHaveProperty('value', 'darwin') })
    expect(screen.getByLabelText(zh.architecture)).toHaveProperty('value', 'arm64')
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })
    expect(screen.getByRole('status').textContent).toContain(evidence().fingerprint)

    fireEvent.click(screen.getByLabelText(zh.saveCredentials))
    fireEvent.click(saveButton())
    await waitFor(() => { expect(upsert).toHaveBeenCalledTimes(1) })
    const saved = upsert.mock.calls[0]?.[0]
    expect(saved?.fingerprint).toBe(evidence().fingerprint)
    expect(saved?.platform).toBe('darwin')
    expect(saved?.architecture).toBe('arm64')
    expect(saved?.secrets).toBeUndefined()
    expect(connect).toHaveBeenCalledWith(hostId, { kind: 'password', password: 'secret' })
  })

  it('invalidates a completed test whenever the tested target or credentials change', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('host.example.test')
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })

    // Each edit invalidates the evidence the save would otherwise reuse.
    for (const edit of [
      () => { fireEvent.change(screen.getByLabelText(zh.host), { target: { value: 'other.example.test' } }) },
      () => { fireEvent.change(screen.getByLabelText(zh.port), { target: { value: '2222' } }) },
      () => { fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'other' } }) },
      () => { fireEvent.change(screen.getByLabelText(zh.password), { target: { value: 'other-secret' } }) },
    ]) {
      edit()
      await waitFor(() => { expect(saveButton().disabled).toBe(true) })
      expect(screen.queryByRole('status')).toBeNull()
    }

    // Platform overrides are deployment choices, not part of what was tested.
    fireEvent.change(screen.getByLabelText(zh.platform), { target: { value: 'win32' } })
    expect(saveButton().disabled).toBe(true)
  })

  it('keeps a failed connectivity test from enabling save and reports its reason', async () => {
    const verify = vi.fn<RemoteHostsViewProps['verify']>(async () => ({ ok: false as const,
      error: { code: 'verify', message: 'verify rejected', details: {} } }))
    const upsert = vi.fn(async () => { throw 'plain rejection' })
    mount({ verify, upsert })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.remoteOrigin), { target: { value: 'http://model.example.test' } })
    fireEvent.change(screen.getByLabelText(zh.localPort), { target: { value: '65536' } })
    fireEvent.click(screen.getByRole('button', { name: zh.addMapping }))
    expect(screen.getByRole('alert').textContent).toContain('valid origin and local port')

    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('verify rejected') })
    expect(saveButton().disabled).toBe(true)

    // A successful retry clears the failure and opens the save path.
    verify.mockResolvedValueOnce({ ok: true as const, value: evidence() })
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })
  })

  it('drops a stale test when a later test fails', async () => {
    const verify = vi.fn<RemoteHostsViewProps['verify']>()
      .mockResolvedValueOnce({ ok: true as const, value: evidence() })
      .mockResolvedValueOnce({ ok: false as const, error: { code: 'verify', message: 'verify rejected', details: {} } })
    mount({ verify })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('host.example.test')
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })

    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('verify rejected') })
    expect(saveButton().disabled).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('clears a stale test when the draft is reopened', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('host.example.test')
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })

    fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    expect(saveButton().disabled).toBe(true)
  })

  it('tests a private key with its passphrase and submits it without one', async () => {
    const upsert = vi.fn(async (input: Parameters<RemoteHostsViewProps['upsert']>[0]) => ({ ok: true as const, value: host(input) }))
    const verify = vi.fn<RemoteHostsViewProps['verify']>(async () => ({ ok: true as const, value: evidence() }))
    mount({ upsert, verify })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.name), { target: { value: 'Key host' } })
    fireEvent.change(screen.getByLabelText(zh.host), { target: { value: 'key.example.test' } })
    fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'runner' } })
    fireEvent.change(screen.getByLabelText(zh.auth), { target: { value: 'key' } })
    // Pasting is opt-in: until then the textarea stays disabled and the file chooser is the enabled path.
    expect(screen.getByLabelText(zh.privateKey)).toHaveProperty('disabled', true)
    await enabledKeyFileButton()
    fireEvent.click(screen.getByLabelText(zh.manualPaste))
    expect(screen.getByLabelText(zh.privateKey)).toHaveProperty('disabled', false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.chooseKeyFile }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(zh.privateKey), { target: { value: 'PRIVATE KEY' } })
    fireEvent.change(screen.getByLabelText(zh.passphrase), { target: { value: 'phrase' } })
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(verify).toHaveBeenCalledTimes(1) })
    expect(verify.mock.calls[0]?.[0].secrets).toEqual({ kind: 'key', privateKey: 'PRIVATE KEY', passphrase: 'phrase' })

    // Dropping the passphrase invalidates the test; the retest carries no passphrase.
    fireEvent.change(screen.getByLabelText(zh.passphrase), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(verify).toHaveBeenCalledTimes(2) })
    expect(verify.mock.calls[1]?.[0].secrets).toEqual({ kind: 'key', privateKey: 'PRIVATE KEY' })

    fireEvent.click(screen.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(upsert).toHaveBeenCalledTimes(1) })
    expect(upsert.mock.calls[0]?.[0].secrets).toEqual({ kind: 'key', privateKey: 'PRIVATE KEY' })
  })

  it('records a valid reverse mapping and removes it again', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('mapping.example.test')
    fireEvent.change(screen.getByLabelText(zh.localHost), { target: { value: '127.0.0.2' } })
    fireEvent.change(screen.getByLabelText(zh.localPort), { target: { value: '7000' } })
    fireEvent.change(screen.getByLabelText(zh.remoteOrigin), { target: { value: 'http://model.example.test:9000' } })
    fireEvent.click(screen.getByRole('button', { name: zh.addMapping }))
    expect(screen.getByText(/model\.example\.test:9000/)).toBeTruthy()
    expect(screen.getByText(/127\.0\.0\.2:7000/)).toBeTruthy()
    // A successful add clears the origin field for the next mapping.
    expect(screen.getByLabelText(zh.remoteOrigin)).toHaveProperty('value', '')

    fireEvent.click(screen.getByRole('button', { name: zh.removeMapping }))
    expect(screen.queryByText(/model\.example\.test/)).toBeNull()
  })

  it('keeps an architecture override through a later connectivity test', async () => {
    const verify = vi.fn<RemoteHostsViewProps['verify']>(async () => ({ ok: true as const, value: evidence() }))
    const upsert = vi.fn(async (input: Parameters<RemoteHostsViewProps['upsert']>[0]) => ({ ok: true as const, value: host(input) }))
    mount({ verify, upsert })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('arm.example.test')
    fireEvent.change(screen.getByLabelText(zh.architecture), { target: { value: 'arm64' } })
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })
    fireEvent.click(saveButton())
    await waitFor(() => { expect(upsert).toHaveBeenCalledTimes(1) })
    // The operator's architecture choice survives the test's own detected values.
    expect(upsert.mock.calls[0]?.[0].architecture).toBe('arm64')
    expect(upsert.mock.calls[0]?.[0].platform).toBe('linux')
  })

  it('surfaces a non-Error save rejection', async () => {
    const upsert = vi.fn(async () => { throw 'plain save failure' })
    mount({ upsert })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('host.example.test')
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })
    fireEvent.click(saveButton())
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('plain save failure') })
  })

  it('submits the recorded reverse mappings with the tested host', async () => {
    const upsert = vi.fn(async (input: Parameters<RemoteHostsViewProps['upsert']>[0]) => ({ ok: true as const, value: host({
      name: input.name, host: input.host, username: input.username,
    }) }))
    mount({ upsert })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('mapping.example.test')
    fireEvent.change(screen.getByLabelText(zh.remoteOrigin), { target: { value: 'http://model.example.test:9000' } })
    fireEvent.click(screen.getByRole('button', { name: zh.addMapping }))
    fireEvent.change(screen.getByLabelText(zh.platform), { target: { value: 'win32' } })
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })
    fireEvent.click(saveButton())
    await waitFor(() => { expect(upsert).toHaveBeenCalledTimes(1) })
    // A platform override survives the test's detected-value prefill that follows it.
    expect(upsert.mock.calls[0]?.[0].reverseMappings).toEqual([
      { localHost: '127.0.0.1', localPort: 3000, remoteOriginalOrigin: 'http://model.example.test:9000' },
    ])
  })

  it('surfaces a non-Error connectivity-test rejection', async () => {
    const verify = vi.fn<RemoteHostsViewProps['verify']>(async () => { throw 'plain verify failure' })
    mount({ verify })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('host.example.test')
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('plain verify failure') })
  })

  it('ignores a submit that arrives without recorded test evidence', async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, value: host() }))
    const { view } = mount({ upsert })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('host.example.test')
    // The save control is disabled, but a form submit event can still reach the handler.
    fireEvent.submit(view.container.querySelector('form')!)
    await waitFor(() => { expect(upsert).not.toHaveBeenCalled() })
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

  it('surfaces remote submit failures from both save and initial ephemeral connect', async () => {
    const upsert = vi.fn(async () => ({ ok: false as const, error: { code: 'denied', message: 'save denied', details: {} } }))
    mount({ upsert })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('host.example.test')
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })
    fireEvent.click(saveButton())
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('save denied') })
  })

  it('keeps an ephemeral host draft open when its first connection fails', async () => {
    const upsert = vi.fn(async () => ({ ok: true as const, value: host() }))
    const connect = vi.fn(async () => ({ ok: false as const, error: { code: 'offline', message: 'connect denied', details: {} } }))
    mount({ upsert, connect })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('host.example.test')
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })
    fireEvent.click(screen.getByLabelText(zh.saveCredentials))
    fireEvent.click(saveButton())
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('connect denied') })
    expect(screen.getByLabelText(zh.name)).toBeTruthy()
  })

  it('closes the editor drawer with the Escape key', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    expect(screen.getByLabelText(zh.name)).toBeTruthy()
    // Other keys leave the drawer open; only Escape closes it.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(screen.getByLabelText(zh.name)).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByLabelText(zh.name)).toBeNull()
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


  it('loads the key material from a picked file and invalidates a completed test', async () => {
    let releasePick: (() => void) | undefined
    const pickKeyFile = vi.fn<RemoteHostsViewProps['pickKeyFile']>(async () => {
      await new Promise<void>((resolve) => { releasePick = resolve })
      return { ok: true as const, value: { path: '/home/me/.ssh/id_ed25519', content: 'PICKED KEY MATERIAL' } }
    })
    const verify = vi.fn<RemoteHostsViewProps['verify']>(async () => ({ ok: true as const, value: evidence() }))
    mount({ pickKeyFile, verify })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.host), { target: { value: 'key.example.test' } })
    fireEvent.change(screen.getByLabelText(zh.username), { target: { value: 'runner' } })
    fireEvent.change(screen.getByLabelText(zh.auth), { target: { value: 'key' } })
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })

    fireEvent.click(await enabledKeyFileButton())
    await waitFor(() => { expect(pickKeyFile).toHaveBeenCalledTimes(1) })
    // While the chooser is open every drawer action — including Escape — stays locked.
    expect(saveButton().disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByLabelText(zh.name)).toBeTruthy()
    releasePick?.()
    // The picked path labels the row and the content becomes the tested secret.
    await waitFor(() => { expect(screen.getByTitle('/home/me/.ssh/id_ed25519').textContent).toBe('/home/me/.ssh/id_ed25519') })
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(verify.mock.calls.at(-1)?.[0].secrets).toEqual({ kind: 'key', privateKey: 'PICKED KEY MATERIAL' }) })
  })

  it('leaves the draft untouched when the file chooser is dismissed', async () => {
    const pickKeyFile = vi.fn<RemoteHostsViewProps['pickKeyFile']>(async () => ({ ok: true as const, value: {} }))
    mount({ pickKeyFile })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.auth), { target: { value: 'key' } })
    fireEvent.click(await enabledKeyFileButton())
    await waitFor(() => { expect(pickKeyFile).toHaveBeenCalledTimes(1) })
    expect(screen.getByText(zh.noKeyFile)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces chooser failures without touching the draft', async () => {
    const pickKeyFile = vi.fn<RemoteHostsViewProps['pickKeyFile']>(async () => ({ ok: false as const,
      error: { code: 'picker', message: 'picker unavailable', details: {} } }))
    mount({ pickKeyFile })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.auth), { target: { value: 'key' } })
    fireEvent.click(await enabledKeyFileButton())
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('picker unavailable') })
    expect(screen.getByText(zh.noKeyFile)).toBeTruthy()

    pickKeyFile.mockRejectedValueOnce(new Error('chooser transport died'))
    fireEvent.click(await enabledKeyFileButton())
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('chooser transport died') })
    pickKeyFile.mockRejectedValueOnce('plain pick failure')
    fireEvent.click(await enabledKeyFileButton())
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('plain pick failure') })
  })

  it('reads the key through the browser when the composition serves the client interaction', async () => {
    const pickKeyFile = vi.fn()
    const keyFilePicker = vi.fn<RemoteHostsViewProps['keyFilePicker']>(async () => ({ ok: true as const, value: { kind: 'client' as const } }))
    const verify = vi.fn<RemoteHostsViewProps['verify']>(async () => ({ ok: true as const, value: evidence() }))
    const { view } = mount({ keyFilePicker, pickKeyFile, verify })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.auth), { target: { value: 'key' } })
    const button = await enabledKeyFileButton()
    expect(screen.getByText(zh.keyFileHintClient)).toBeTruthy()
    fireEvent.click(button)
    // The host chooser RPC never runs: the browser's own file input carries the pick.
    expect(pickKeyFile).not.toHaveBeenCalled()
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { files: [new File(['CLIENT KEY MATERIAL'], 'id_ed25519', { type: 'text/plain' })] } })
    await waitFor(() => { expect(screen.getByTitle('id_ed25519').textContent).toBe('id_ed25519') })
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(verify.mock.calls.at(-1)?.[0].secrets).toEqual({ kind: 'key', privateKey: 'CLIENT KEY MATERIAL' }) })
    // Re-choosing the same file name still fires: the input resets its value after every pick.
    fireEvent.click(screen.getByRole('button', { name: zh.chooseKeyFile }))
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [new File(['SECOND MATERIAL'], 'id_ed25519', { type: 'text/plain' })] } })
    await waitFor(() => { expect(screen.getByTitle('id_ed25519').textContent).toBe('id_ed25519') })
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(verify.mock.calls.at(-1)?.[0].secrets).toEqual({ kind: 'key', privateKey: 'SECOND MATERIAL' }) })
  })

  it('rejects an oversized client-side pick without touching the draft', async () => {
    const keyFilePicker = vi.fn<RemoteHostsViewProps['keyFilePicker']>(async () => ({ ok: true as const, value: { kind: 'client' as const } }))
    const { view } = mount({ keyFilePicker })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.auth), { target: { value: 'key' } })
    await enabledKeyFileButton()
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [new File(['x'.repeat(65_537)], 'huge_key', { type: 'text/plain' })] } })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.errorKeyFileTooLarge) })
    expect(screen.getByText(zh.noKeyFile)).toBeTruthy()
    expect(screen.getByLabelText(zh.privateKey)).toHaveProperty('value', '')
    // A change carrying no file is a cancel: the draft and alerts stay as they were.
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [] } })
    expect(screen.getByRole('alert').textContent).toBe(zh.errorKeyFileTooLarge)
    // A read that fails surfaces its reason without touching the draft.
    const broken = new File(['x'], 'broken', { type: 'text/plain' })
    broken.text = () => Promise.reject(new Error('read blew'))
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [broken] } })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('read blew') })
    expect(screen.getByText(zh.noKeyFile)).toBeTruthy()
    const plain = new File(['x'], 'plain', { type: 'text/plain' })
    plain.text = () => Promise.reject('plain read failure')
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [plain] } })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('plain read failure') })
  })

  it('drops interaction-probe settlements that land after the view departs', async () => {
    let releaseResolve!: (value: { ok: true; value: { kind: 'native' } }) => void
    let releaseReject!: (reason: Error) => void
    const keyFilePicker = vi.fn<RemoteHostsViewProps['keyFilePicker']>()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseResolve = resolve }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { releaseReject = reject }))
    const first = mount({ keyFilePicker })
    first.view.unmount()
    releaseResolve({ ok: true as const, value: { kind: 'native' as const } })
    await Promise.resolve()
    cleanup()
    const second = mount({ keyFilePicker })
    second.view.unmount()
    releaseReject(new Error('late probe failure'))
    await Promise.resolve()
  })

  it('falls back to the client interaction when the probe fails or reports failure', async () => {
    const pickKeyFile = vi.fn()
    const keyFilePicker = vi.fn<RemoteHostsViewProps['keyFilePicker']>()
      .mockRejectedValueOnce(new Error('probe crashed'))
      .mockResolvedValueOnce({ ok: false as const, error: { code: 'internal', message: 'probe failed', details: {} } })
    const { view } = mount({ keyFilePicker, pickKeyFile })
    for (let round = 0; round < 2; round++) {
      fireEvent.click(screen.getByRole('button', { name: zh.add }))
      fireEvent.change(screen.getByLabelText(zh.auth), { target: { value: 'key' } })
      const button = await enabledKeyFileButton()
      fireEvent.click(button)
      expect(pickKeyFile).not.toHaveBeenCalled()
      fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [new File([`MATERIAL ${round}`], 'id_rsa', { type: 'text/plain' })] } })
      await waitFor(() => { expect(screen.getByTitle('id_rsa').textContent).toBe('id_rsa') })
      fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
    }
  })

  it('maps closed KEY_* picker codes to operator copy instead of wire messages', async () => {
    const failures = [
      { code: 'KEY_PICKER_UNAVAILABLE', message: 'remote-hosts: KEY_PICKER_UNAVAILABLE' },
      { code: 'KEY_PICKER_FAILED', message: 'remote-hosts: KEY_PICKER_FAILED' },
      { code: 'KEY_FILE_TOO_LARGE', message: 'remote-hosts: KEY_FILE_TOO_LARGE' },
      { code: 'KEY_FILE_READ_FAILED', message: 'remote-hosts: KEY_FILE_READ_FAILED' },
    ] as const
    const pickKeyFile = vi.fn<RemoteHostsViewProps['pickKeyFile']>()
    for (const failure of failures) pickKeyFile.mockResolvedValueOnce({ ok: false as const, error: { ...failure, details: {} } })
    mount({ pickKeyFile })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByLabelText(zh.auth), { target: { value: 'key' } })
    for (const expected of [zh.errorKeyPickUnavailable, zh.errorKeyPickFailed, zh.errorKeyFileTooLarge, zh.errorKeyFileReadFailed]) {
      fireEvent.click(await enabledKeyFileButton())
      await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(expected) })
    }
    expect(screen.getByText(zh.noKeyFile)).toBeTruthy()
  })

  it('does not persist temporary login secrets and uses them for the initial connection', async () => {
    const upsert = vi.fn(async (input: Parameters<RemoteHostsViewProps['upsert']>[0]) => ({ ok: true as const, value: host({
      name: input.name, host: input.host, username: input.username,
    }) }))
    const connect = vi.fn(async () => ({ ok: true as const, value: host({ state: 'connected' }) }))
    mount({ upsert, connect })

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    completeDraft('host.example.test')
    fireEvent.click(screen.getByRole('button', { name: zh.test }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })
    fireEvent.click(screen.getByLabelText(zh.saveCredentials))
    fireEvent.click(saveButton())

    await waitFor(() => { expect(connect).toHaveBeenCalledTimes(1) })
    const savedInput = upsert.mock.calls[0]?.[0]
    expect(savedInput?.secrets).toBeUndefined()
    expect(connect).toHaveBeenCalledWith(hostId, { kind: 'password', password: 'secret' })
  })
})
