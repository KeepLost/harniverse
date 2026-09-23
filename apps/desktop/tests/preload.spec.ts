import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  ipcRenderer: { invoke: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
}))
const device = vi.hoisted(() => ({
  generateDesktopDeviceKey: vi.fn(), readDesktopBrowserDevice: vi.fn(), writeDesktopBrowserDevice: vi.fn(),
}))
vi.mock('electron', () => electron)
vi.mock('../src/desktop-browser-device.ts', () => device)
import { bootstrapOwnedBrowser } from '../src/preload-web.ts'
import { DESKTOP_IPC, type DesktopBridge, type DesktopDirectoryBridge } from '../src/ipc.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); vi.resetModules() })

function browser(protocol = 'http:') {
  const page = { location: { protocol, reload: vi.fn() }, top: undefined as unknown }
  page.top = page
  vi.stubGlobal('window', page)
  return page
}

describe('desktop browser bootstrap', () => {
  it('passes only the public key across IPC and persists the browser key for normal Web authentication', async () => {
    browser()
    const key = { type: 'private', extractable: false }
    device.generateDesktopDeviceKey.mockResolvedValue({ publicKey: 'public-key', privateKey: key })
    electron.ipcRenderer.invoke.mockResolvedValueOnce({ kind: 'enroll' }).mockResolvedValueOnce({ kind: 'approved', name: 'Desktop', grantId: 'grant-1' })
    await bootstrapOwnedBrowser()
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      [DESKTOP_IPC.authWeb, { kind: 'inspect' }],
      [DESKTOP_IPC.authWeb, { kind: 'enroll', publicKey: 'public-key' }],
      [DESKTOP_IPC.authWeb, { kind: 'complete' }],
    ])
    expect(device.writeDesktopBrowserDevice).toHaveBeenCalledWith({ kind: 'device', name: 'Desktop', privateKey: key, publicKey: 'public-key', grantId: 'grant-1' })
    expect(device.writeDesktopBrowserDevice.mock.invocationCallOrder[0])
      .toBeLessThan(electron.ipcRenderer.invoke.mock.invocationCallOrder[2])
  })

  it('leaves normal enrollment untouched for an existing Host or an already enrolled local connection', async () => {
    const page = browser('https:')
    electron.ipcRenderer.invoke.mockResolvedValue({ kind: 'ordinary' })
    await bootstrapOwnedBrowser()
    expect(device.generateDesktopDeviceKey).not.toHaveBeenCalled()
    expect(device.writeDesktopBrowserDevice).not.toHaveBeenCalled()
    expect(page.location.reload).not.toHaveBeenCalled()
  })

  it('does not persist an unapproved grant or retry enrollment after a rejection', async () => {
    const page = browser()
    device.generateDesktopDeviceKey.mockResolvedValue({ publicKey: 'public-key', privateKey: {} })
    electron.ipcRenderer.invoke.mockResolvedValueOnce({ kind: 'enroll' }).mockRejectedValueOnce(new Error('revoked'))
    await expect(bootstrapOwnedBrowser()).rejects.toThrow('revoked')
    expect(device.writeDesktopBrowserDevice).not.toHaveBeenCalled()
    expect(page.location.reload).not.toHaveBeenCalled()
  })

  it('reuses the approved non-exportable key on the next owned Host boot', async () => {
    browser()
    const stored = { kind: 'device', name: 'Desktop', privateKey: { extractable: false }, publicKey: 'original-key', grantId: 'grant-1' }
    device.readDesktopBrowserDevice.mockResolvedValue(stored)
    device.generateDesktopDeviceKey.mockResolvedValue({ publicKey: 'rotated-key', privateKey: { extractable: false } })
    electron.ipcRenderer.invoke.mockResolvedValueOnce({ kind: 'enroll' })
      .mockResolvedValueOnce({ kind: 'approved', name: 'Desktop', grantId: 'grant-1' })
    await bootstrapOwnedBrowser()
    expect(device.generateDesktopDeviceKey).not.toHaveBeenCalled()
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      [DESKTOP_IPC.authWeb, { kind: 'inspect' }],
      [DESKTOP_IPC.authWeb, { kind: 'enroll', publicKey: 'original-key' }],
      [DESKTOP_IPC.authWeb, { kind: 'complete' }],
    ])
    expect(device.writeDesktopBrowserDevice).toHaveBeenCalledWith(stored)
  })

  it('never rotates an existing key when its grant is rejected', async () => {
    browser()
    device.readDesktopBrowserDevice.mockResolvedValue({ publicKey: 'revoked-key', privateKey: { extractable: false }, grantId: 'revoked' })
    device.generateDesktopDeviceKey.mockResolvedValue({ publicKey: 'rotated-key', privateKey: { extractable: false } })
    electron.ipcRenderer.invoke.mockResolvedValueOnce({ kind: 'enroll' }).mockRejectedValueOnce(new Error('revoked'))
    await expect(bootstrapOwnedBrowser()).rejects.toThrow('revoked')
    expect(device.generateDesktopDeviceKey).not.toHaveBeenCalled()
    expect(device.writeDesktopBrowserDevice).not.toHaveBeenCalled()
    expect(electron.ipcRenderer.invoke.mock.calls).toHaveLength(2)
  })

  it('leaves a Web-enrolled record without a desktop public key to normal Web authentication', async () => {
    browser()
    device.readDesktopBrowserDevice.mockResolvedValue({ privateKey: { extractable: false }, grantId: 'web-grant' })
    device.generateDesktopDeviceKey.mockResolvedValue({ publicKey: 'rotated-key', privateKey: { extractable: false } })
    electron.ipcRenderer.invoke.mockResolvedValueOnce({ kind: 'enroll' }).mockResolvedValueOnce({ kind: 'approved', name: 'Desktop', grantId: 'new-grant' })
    await bootstrapOwnedBrowser()
    expect(device.generateDesktopDeviceKey).not.toHaveBeenCalled()
    expect(device.writeDesktopBrowserDevice).not.toHaveBeenCalled()
    expect(electron.ipcRenderer.invoke.mock.calls).toHaveLength(1)
  })
})

describe('desktop context bridge', () => {
  it('exposes fixed shell operations without forwarding arbitrary IPC or native objects', async () => {
    browser('file:')
    await import('../src/preload.ts')
    const [name, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, DesktopBridge]
    expect(name).toBe('harniverseDesktop')
    expect(Object.keys(bridge)).toEqual(['state', 'connect', 'disconnect', 'quit'])
    await bridge.connect({ kind: 'local' })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.connect, { kind: 'local' })
    expect(bridge).not.toHaveProperty('invoke')
    expect(bridge).not.toHaveProperty('send')
  })

  it('exposes only directory selection to the shared app and no bridge to child frames', async () => {
    const page = browser()
    electron.ipcRenderer.invoke.mockResolvedValue({ kind: 'ordinary' })
    await import('../src/preload.ts')
    const [name, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, DesktopDirectoryBridge]
    expect(name).toBe('harniverseDirectory')
    expect(Object.keys(bridge)).toEqual(['pickDirectory'])
    await bridge.pickDirectory()
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.pickDirectory)
    vi.resetModules()
    electron.contextBridge.exposeInMainWorld.mockClear()
    page.top = {}
    await import('../src/preload.ts')
    expect(electron.contextBridge.exposeInMainWorld).not.toHaveBeenCalled()
  })
})
