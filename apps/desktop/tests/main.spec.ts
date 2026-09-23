import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  class Events {
    listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    on(name: string, callback: (...args: unknown[]) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback])
      return this
    }
    emit(name: string, ...args: unknown[]) { for (const callback of this.listeners.get(name) ?? []) callback(...args) }
  }
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const windows: Window[] = []
  const trays: Tray[] = []
  class Contents extends Events {
    mainFrame = { url: '', origin: '' }
    setWindowOpenHandler = vi.fn()
    session = {
      setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
      on: vi.fn(), fetch: vi.fn(),
    }
  }
  class Window extends Events {
    webContents = new Contents()
    visible = false
    minimized = false
    destroyed = false
    loadFailure: Error | undefined
    loaded: string[] = []
    constructor(readonly options: Record<string, unknown>) { super(); windows.push(this) }
    async loadURL(url: string) {
      if (this.loadFailure !== undefined) { const error = this.loadFailure; this.loadFailure = undefined; throw error }
      this.loaded.push(url)
      this.webContents.mainFrame = { url, origin: new URL(url).origin }
    }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.visible = false }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false }
    show() { this.visible = true }
    hide() { this.visible = false }
    focus = vi.fn()
  }
  class Tray extends Events {
    destroyed = false
    menu: unknown
    constructor() { super(); trays.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
    setToolTip = vi.fn()
    setContextMenu(menu: unknown) {
      if (this.destroyed) throw new Error('Object has been destroyed')
      this.menu = menu
    }
  }
  const app = Object.assign(new Events(), {
    quit: vi.fn(), whenReady: vi.fn(async () => {}), requestSingleInstanceLock: vi.fn(() => true),
    setName: vi.fn(), setAppUserModelId: vi.fn(), getPath: vi.fn(() => '/data/harniverse'), getVersion: vi.fn(() => '1.0.0'), isPackaged: false,
  })
  return {
    app, windows, trays, handlers, BrowserWindow: Window, Tray,
    ipcMain: { handle: vi.fn((name: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(name, handler) }) },
    Menu: { buildFromTemplate: vi.fn((template: unknown) => template), setApplicationMenu: vi.fn() },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })), showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/local/work'] })), showErrorBox: vi.fn() },
    nativeImage: { createFromBitmap: vi.fn(() => ({ isEmpty: () => false, setTemplateImage: vi.fn() })) },
    shell: { openPath: vi.fn(async () => '') },
  }
})
vi.mock('electron', () => electron)

import { DesktopShell, launchDesktopShell, type OwnedDesktopHost, type OwnedHostCallbacks } from '../src/main.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'
import type { UpdateConnection } from '../src/update.ts'

const rendererURL = pathToFileURL('/app/renderer/index.html').href

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let settle: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, resolve: (value) => { settle?.(value) } }
}

beforeEach(() => {
  vi.clearAllMocks()
  electron.windows.length = 0
  electron.trays.length = 0
  electron.handlers.clear()
  electron.app.listeners.clear()
  electron.dialog.showMessageBox.mockResolvedValue({ response: 0 })
  electron.app.requestSingleInstanceLock.mockReturnValue(true)
})

async function fixture(updates?: ConstructorParameters<typeof DesktopShell>[0]['updates']) {
  let callbacks: OwnedHostCallbacks | undefined
  const host = {
    start: vi.fn(async () => ({ url: 'http://127.0.0.1:9090/' })),
    stop: vi.fn(async () => {}),
    hasClosed: vi.fn(() => false),
    activity: vi.fn<OwnedDesktopHost['activity']>(async () => ({ status: 'idle', sessions: 0, tasks: 0 })),
    enroll: vi.fn(async () => ({ grant: { id: 'grant-1', name: 'Desktop' } })),
    updateTasks: vi.fn<NonNullable<OwnedDesktopHost['updateTasks']>>(async () => ({ status: 'idle', sessions: 0, tasks: 0 })),
  }
  const factory = vi.fn((value: OwnedHostCallbacks) => { callbacks = value; return host })
  const shell = new DesktopShell({ createOwnedHost: factory, rendererPath: '/app/renderer/index.html', preloadPath: '/app/lib/preload.cjs', updates })
  await shell.start()
  const window = electron.windows[0]
  window.webContents.session.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string) as { rpcId: string }
    const selected = await callbacks!.pickDirectory()
    return Response.json({ rpcId: request.rpcId, result: { ok: true, value: { path: selected.kind === 'selected' ? selected.path : null } } })
  })
  const invoke = async (channel: string, ...args: unknown[]) => {
    const owner = electron.windows.at(-1)!
    return electron.handlers.get(channel)!({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame }, ...args)
  }
  return { shell, host, factory, window, invoke, fail: () => { callbacks!.onFailure(new Error('secret Host stderr')) } }
}

describe('desktop window and connection lifecycle', () => {
  it('identifies the product and exits before creating a window when another instance owns the lock', async () => {
    electron.app.requestSingleInstanceLock.mockReturnValue(false)
    const factory = vi.fn()
    expect(await launchDesktopShell({ createOwnedHost: factory, rendererPath: '/app/renderer/index.html', preloadPath: '/app/lib/preload.cjs' })).toBeUndefined()
    expect(electron.windows).toHaveLength(0)
    expect(electron.app.quit).toHaveBeenCalledOnce()
    expect(electron.app.setName).toHaveBeenCalledWith('dsh-harniverse')
    expect(electron.app.setAppUserModelId).toHaveBeenCalledWith('com.keeplost.harniverse')
  })

  it('loads the shell with sandbox and context isolation and keeps a visible tray', async () => {
    const { window } = await fixture()
    expect(window.options.webPreferences).toMatchObject({
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false,
    })
    expect(window.loaded).toEqual([rendererURL])
    expect(window.visible).toBe(true)
    expect(electron.trays).toHaveLength(1)
    expect(window.options.title).toBe('Harniverse')
    expect(window.options.icon).toBeDefined()
    expect(electron.trays[0].setToolTip).toHaveBeenCalledWith('Harniverse')
    expect(electron.trays[0].menu).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Quit Harniverse' })]))
  })

  it('hides on close and reveals the same window on a second launch without stopping work', async () => {
    const { shell, host, window } = await fixture()
    await shell.connect({ kind: 'local' })
    const event = { preventDefault: vi.fn() }
    window.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.visible).toBe(false)
    expect(host.stop).not.toHaveBeenCalled()
    electron.app.emit('second-instance')
    expect(window.visible).toBe(true)
    expect(electron.windows).toHaveLength(1)
  })

  it('loads the shared Host URL and requires disconnect before changing connections', async () => {
    const { shell, host, factory, window } = await fixture()
    await shell.connect({ kind: 'local' })
    expect(window.loaded.at(-1)).toBe('http://127.0.0.1:9090/')
    await expect(shell.connect({ kind: 'existingHost', url: 'https://remote.test' })).rejects.toThrow('Disconnect')
    expect(factory).toHaveBeenCalledOnce()
    await shell.disconnect()
    expect(host.stop).toHaveBeenCalledOnce()
    await shell.connect({ kind: 'existingHost', url: 'https://remote.test' })
    expect(electron.windows.at(-1)!.loaded.at(-1)).toBe('https://remote.test/')
  })

  it('denies external navigation, child windows and permissions', async () => {
    const { shell } = await fixture()
    await shell.connect({ kind: 'existingHost', url: 'https://remote.test' })
    const window = electron.windows.at(-1)!
    const denied = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', denied, 'file:///etc/passwd')
    window.webContents.emit('will-redirect', denied, 'https://other.test')
    expect(denied.preventDefault).toHaveBeenCalledTimes(2)
    window.webContents.emit('will-navigate', denied, 'https://remote.test/auth/manage')
    expect(denied.preventDefault).toHaveBeenCalledTimes(2)
    const popup = window.webContents.setWindowOpenHandler.mock.calls[0][0] as () => unknown
    expect(popup()).toEqual({ action: 'deny' })
    const permission = window.webContents.session.setPermissionCheckHandler.mock.calls[0][0] as () => boolean
    expect(permission()).toBe(false)
  })
})

describe('desktop quit and failures', () => {
  it('keeps active local work running when the quit warning is cancelled', async () => {
    const { shell, host, window } = await fixture()
    await shell.connect({ kind: 'local' })
    host.activity.mockResolvedValue({ status: 'active', sessions: 1, tasks: 2 })
    await shell.requestQuit()
    expect(electron.dialog.showMessageBox.mock.calls[0][0]).toMatchObject({
      defaultId: 0, cancelId: 0, detail: expect.stringContaining('interrupt') as unknown,
    })
    expect(host.stop).not.toHaveBeenCalled()
    expect(electron.app.quit).not.toHaveBeenCalled()
    expect(window.visible).toBe(true)
  })

  it('awaits actual owned Host exit before quitting and coalesces concurrent quit requests', async () => {
    const { shell, host } = await fixture()
    await shell.connect({ kind: 'local' })
    let settle!: () => void
    host.stop.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    const quit = shell.requestQuit()
    expect(shell.requestQuit()).toBe(quit)
    await vi.waitFor(() => { expect(host.stop).toHaveBeenCalledOnce() })
    expect(electron.app.quit).not.toHaveBeenCalled()
    settle()
    await quit
    expect(electron.app.quit).toHaveBeenCalledOnce()
    expect(electron.trays[0].destroyed).toBe(true)
  })

  it('warns on unknown activity and leaves an external loopback Host running', async () => {
    const { shell, host, factory } = await fixture()
    await shell.connect({ kind: 'existingHost', url: 'http://localhost:8010' })
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    await shell.requestQuit()
    expect(electron.dialog.showMessageBox.mock.calls[0][0]).toMatchObject({ detail: expect.stringContaining('continues running') as unknown })
    expect(factory).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    expect(electron.app.quit).toHaveBeenCalledOnce()
  })

  it('does not quit or detach ownership after teardown rejects', async () => {
    const { shell, host, window } = await fixture()
    await shell.connect({ kind: 'local' })
    host.stop.mockRejectedValue(new Error('child remains alive'))
    await shell.requestQuit()
    expect(electron.app.quit).not.toHaveBeenCalled()
    expect(electron.trays[0].destroyed).toBe(false)
    expect(window.visible).toBe(true)
    await expect(shell.connect({ kind: 'local' })).rejects.toThrow('Disconnect')
  })

  it('retains a failed startup child until its teardown settles', async () => {
    const { shell, host, window, invoke } = await fixture()
    host.start.mockRejectedValue(new Error('secret boot diagnostic'))
    await expect(shell.connect({ kind: 'local' })).rejects.toThrow('connection failed')
    expect(window.loaded.at(-1)).toBe(rendererURL)
    expect(await invoke(DESKTOP_IPC.state)).toMatchObject({ phase: 'failed', ownership: 'owned' })
    expect(JSON.stringify(await invoke(DESKTOP_IPC.state))).not.toContain('secret')
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    await shell.disconnect()
    expect(host.stop).toHaveBeenCalledOnce()
    expect(await invoke(DESKTOP_IPC.state)).toEqual({ phase: 'disconnected', activity: { status: 'unknown' } })
  })

  it('allows an explicit Quit after an unclean Host exit is confirmed', async () => {
    const { shell, host } = await fixture()
    await shell.connect({ kind: 'local' })
    host.stop.mockRejectedValue(new Error('Host exited without acknowledgement'))
    host.hasClosed.mockReturnValue(true)
    await shell.requestQuit()
    expect(electron.app.quit).toHaveBeenCalledOnce()
    expect(electron.trays[0].destroyed).toBe(true)
  })

  it('allows reconnect after disconnect confirms a failed Host has exited', async () => {
    const { shell, host } = await fixture()
    await shell.connect({ kind: 'local' })
    host.stop.mockRejectedValue(new Error('Host exited without acknowledgement'))
    host.hasClosed.mockReturnValue(true)
    await shell.disconnect()
    await shell.connect({ kind: 'existingHost', url: 'https://remote.test' })
    expect(electron.windows.at(-1)!.loaded.at(-1)).toBe('https://remote.test/')
  })

  it('refuses update installation when an exited Host did not stop cleanly', async () => {
    const updates = { recover: vi.fn(async () => {}), install: vi.fn(async (connection: UpdateConnection) => {
      await connection.host!.stop()
      await connection.finish()
    }) }
    const { shell, host } = await fixture(updates)
    await shell.connect({ kind: 'local' })
    host.stop.mockRejectedValue(new Error('Host exited without acknowledgement'))
    host.hasClosed.mockReturnValue(true)
    await expect(shell.installUpdate()).rejects.toThrow('did not finish stopping')
    expect(electron.app.quit).not.toHaveBeenCalled()
  })

  it('recovers renderer crashes without stopping the Host and redacts Host failures', async () => {
    const { shell, host, window, invoke, fail } = await fixture()
    await shell.connect({ kind: 'local' })
    window.webContents.emit('render-process-gone')
    await vi.waitFor(() => { expect(window.loaded.at(-1)).toBe(rendererURL) })
    expect(await invoke(DESKTOP_IPC.state)).toMatchObject({ phase: 'failed', message: expect.stringContaining('window stopped') as unknown })
    expect(host.stop).not.toHaveBeenCalled()
    fail()
    await vi.waitFor(async () => {
      expect(await invoke(DESKTOP_IPC.state)).toMatchObject({ phase: 'failed', message: expect.stringContaining('Host stopped') as unknown })
    })
    expect(JSON.stringify(await invoke(DESKTOP_IPC.state))).not.toContain('secret')
  })
})

describe('desktop authenticated native operations', () => {
  it('waits for initial document loading before completing browser bootstrap navigation', async () => {
    const { shell, window, invoke } = await fixture()
    const loaded = deferred<undefined>()
    const load = window.loadURL.bind(window)
    const loading = vi.spyOn(window, 'loadURL').mockImplementationOnce(async (url) => { await load(url); await loaded.promise })
    const connected = shell.connect({ kind: 'local' })
    await vi.waitFor(() => { expect(window.loaded.at(-1)).toBe('http://127.0.0.1:9090/') })
    await invoke(DESKTOP_IPC.authWeb, { kind: 'enroll', publicKey: 'public-key' })
    const completed = invoke(DESKTOP_IPC.authWeb, { kind: 'complete' })
    expect(loading).toHaveBeenCalledOnce()
    loaded.resolve(undefined)
    await connected
    await completed
    expect(loading).toHaveBeenCalledTimes(2)
    expect(window.loaded.at(-1)).toBe('http://127.0.0.1:9090/')
    await expect(invoke(DESKTOP_IPC.authWeb, { kind: 'complete' })).rejects.toThrow('unavailable')
  })

  it('enrolls only one browser key through the local Host and exposes only the approved receipt', async () => {
    const { shell, host, invoke } = await fixture()
    await shell.connect({ kind: 'local' })
    expect(await invoke(DESKTOP_IPC.authWeb, { kind: 'inspect' })).toEqual({ kind: 'enroll' })
    expect(await invoke(DESKTOP_IPC.authWeb, { kind: 'enroll', publicKey: 'public-key' })).toEqual({ kind: 'approved', grantId: 'grant-1', name: 'Desktop' })
    expect(await invoke(DESKTOP_IPC.authWeb, { kind: 'inspect' })).toEqual({ kind: 'ordinary' })
    await expect(invoke(DESKTOP_IPC.authWeb, { kind: 'enroll', publicKey: 'replacement' })).rejects.toThrow('unavailable')
    expect(host.enroll).toHaveBeenCalledOnce()
    await expect(invoke(DESKTOP_IPC.connect, { kind: 'local' })).rejects.toThrow('unavailable')
  })

  it('requires exact top-frame identity even at the active Host origin', async () => {
    const { shell, host, window } = await fixture()
    await shell.connect({ kind: 'local' })
    const foreign = { mainFrame: window.webContents.mainFrame }
    const handler = electron.handlers.get(DESKTOP_IPC.authWeb)!
    expect(() => handler({ sender: foreign, senderFrame: foreign.mainFrame }, { kind: 'inspect' })).toThrow('owned')
    expect(() => handler({ sender: window.webContents, senderFrame: { ...foreign.mainFrame } }, { kind: 'inspect' })).toThrow('owned')
    expect(host.enroll).not.toHaveBeenCalled()
  })

  it('routes local directory selection through the owned Host without accepting a renderer path', async () => {
    const { shell, invoke, window } = await fixture()
    await shell.connect({ kind: 'local' })
    expect(await invoke(DESKTOP_IPC.pickDirectory)).toEqual({ kind: 'selected', path: '/local/work' })
    expect(electron.dialog.showOpenDialog.mock.calls[0][0]).toBe(window)
    expect(window.webContents.session.fetch.mock.calls[0][0]).toBe('http://127.0.0.1:9090/api/host.pickDirectory')
    expect(window.webContents.session.fetch.mock.calls[0][1]).toMatchObject({ credentials: 'include', redirect: 'error', headers: { origin: 'http://127.0.0.1:9090' } })
    await expect(invoke(DESKTOP_IPC.pickDirectory, '/remote/path')).rejects.toThrow('does not accept a path')
  })

  it('requires the Host to authorize the browser session before opening a local picker', async () => {
    const { shell, invoke, window } = await fixture()
    await shell.connect({ kind: 'local' })
    window.webContents.session.fetch.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    await expect(invoke(DESKTOP_IPC.pickDirectory)).rejects.toThrow('authorize')
    expect(electron.dialog.showOpenDialog).not.toHaveBeenCalled()
    window.webContents.session.fetch.mockResolvedValueOnce(Response.json({ rpcId: 'other', result: { ok: true, value: { path: '/unrelated' } } }))
    await expect(invoke(DESKTOP_IPC.pickDirectory)).rejects.toThrow('could not select')
  })

  it('keeps existingHost enrollment and filesystem operations on that Host even through loopback', async () => {
    const { shell, invoke, host } = await fixture()
    await shell.connect({ kind: 'existingHost', url: 'http://localhost:8010' })
    expect(await invoke(DESKTOP_IPC.authWeb, { kind: 'inspect' })).toEqual({ kind: 'ordinary' })
    await expect(invoke(DESKTOP_IPC.pickDirectory)).rejects.toThrow('connected Host directory picker')
    expect(electron.dialog.showOpenDialog).not.toHaveBeenCalled()
    expect(host.enroll).not.toHaveBeenCalled()
  })

  it('discards a local selection when its connection changes before the dialog settles', async () => {
    const { shell, invoke } = await fixture()
    await shell.connect({ kind: 'local' })
    const selected = deferred<{ canceled: boolean; filePaths: string[] }>()
    electron.dialog.showOpenDialog.mockReturnValueOnce(selected.promise)
    const picking = invoke(DESKTOP_IPC.pickDirectory)
    await shell.disconnect()
    await shell.connect({ kind: 'existingHost', url: 'https://remote.test' })
    selected.resolve({ canceled: false, filePaths: ['/local/private'] })
    expect(await picking).toEqual({ kind: 'cancelled' })
  })
})

describe('native updates and connection credential isolation', () => {
  it('runs startup recovery and exposes Install update in the retained tray menu', async () => {
    const updates = { recover: vi.fn(async () => {}), install: vi.fn(async () => {}) }
    await fixture(updates)
    expect(updates.recover).toHaveBeenCalledOnce()
    const menu = electron.trays[0].menu as { label?: string; enabled?: boolean; click?(): void }[]
    const install = menu.find(item => item.label === 'Install update…')!
    expect(install.enabled).toBe(true)
    install.click!()
    await vi.waitFor(() => { expect(updates.install).toHaveBeenCalledOnce() })
    expect(electron.handlers.has('harniverse:desktop:update')).toBe(false)
  })

  it('disables updates when startup recovery cannot safely restore the previous executable', async () => {
    const updates = { recover: vi.fn(async () => { throw new Error('unverified previous image') }), install: vi.fn(async () => {}) }
    const { shell } = await fixture(updates)
    await expect(shell.installUpdate()).rejects.toThrow('unavailable')
    expect(electron.trays[0].menu).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Install update…', enabled: false })]))
    expect(updates.install).not.toHaveBeenCalled()
  })

  it('wires owned admission and actual exit before native update completion quits', async () => {
    const updates = {
      recover: vi.fn(async () => {}),
      install: vi.fn(async (connection: UpdateConnection) => {
        await connection.host!.updateTasks('lock')
        await connection.host!.stop()
        await connection.detach()
        await connection.finish()
      }),
    }
    const { shell, host } = await fixture(updates)
    await shell.connect({ kind: 'local' })
    const exited = deferred<undefined>()
    host.stop.mockImplementationOnce(async () => { await exited.promise })
    const update = shell.installUpdate()
    await vi.waitFor(() => { expect(host.stop).toHaveBeenCalledOnce() })
    expect(electron.app.quit).not.toHaveBeenCalled()
    exited.resolve(undefined)
    await update
    expect(host.updateTasks).toHaveBeenCalledWith('lock')
    expect(electron.app.quit).toHaveBeenCalledOnce()
    expect(electron.trays[0].destroyed).toBe(true)
  })

  it('restores only the stopped owned connection after update failure', async () => {
    const updates = {
      recover: vi.fn(async () => {}),
      install: vi.fn(async (connection: UpdateConnection) => {
        await connection.host!.stop()
        await connection.detach()
        await connection.restore()
        throw new Error('installer failed')
      }),
    }
    const { shell, host, factory, window } = await fixture(updates)
    await shell.connect({ kind: 'local' })
    await expect(shell.installUpdate()).rejects.toThrow('installer failed')
    expect(factory).toHaveBeenCalledTimes(2)
    expect(host.stop).toHaveBeenCalledOnce()
    expect(window.loaded.at(-1)).toBe('http://127.0.0.1:9090/')
    expect(electron.app.quit).not.toHaveBeenCalled()
  })

  it('supplies no Host control during updates of an existing loopback connection', async () => {
    const updates = {
      recover: vi.fn(async () => {}),
      install: vi.fn(async (connection: UpdateConnection) => {
        expect(connection.host).toBeUndefined()
        await connection.detach()
        await connection.finish()
      }),
    }
    const { shell, host, factory } = await fixture(updates)
    await shell.connect({ kind: 'existingHost', url: 'http://127.0.0.1:9090' })
    await shell.installUpdate()
    expect(host.stop).not.toHaveBeenCalled()
    expect(host.updateTasks).not.toHaveBeenCalled()
    expect(factory).not.toHaveBeenCalled()
  })

  it('isolates owned browser credentials from external Hosts even at the same origin', async () => {
    const { shell, window } = await fixture()
    await shell.connect({ kind: 'local' })
    const ownedPartition = (window.options.webPreferences as { partition: string }).partition
    await shell.disconnect()
    await shell.connect({ kind: 'existingHost', url: 'http://127.0.0.1:9090' })
    const external = electron.windows.at(-1)!
    const externalPartition = (external.options.webPreferences as { partition: string }).partition
    expect(externalPartition).not.toBe(ownedPartition)
    expect(window.destroyed).toBe(true)
    expect(electron.windows.filter(item => !item.destroyed)).toHaveLength(1)
    expect(() => electron.handlers.get(DESKTOP_IPC.authWeb)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, { kind: 'inspect' })).toThrow('owned')
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    await shell.disconnect()
    await shell.connect({ kind: 'existingHost', url: 'https://other.test' })
    expect((electron.windows.at(-1)!.options.webPreferences as { partition: string }).partition).not.toBe(externalPartition)
    expect(electron.windows.filter(item => !item.destroyed)).toHaveLength(1)
  })
})
