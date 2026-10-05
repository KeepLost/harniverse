/** Sandboxed preload: bundled as CommonJS with Electron as its only external module. */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_IPC, type DesktopBridge, type DesktopDirectoryBridge } from './ipc.ts'
import { bootstrapOwnedBrowser } from './preload-web.ts'
import { shellCopy } from './locale.ts'

if (window === window.top) {
  if (window.location.protocol === 'file:') {
    const bridge: DesktopBridge = {
      state: () => ipcRenderer.invoke(DESKTOP_IPC.state),
      connect: profile => ipcRenderer.invoke(DESKTOP_IPC.connect, profile),
      disconnect: () => ipcRenderer.invoke(DESKTOP_IPC.disconnect),
      quit: () => ipcRenderer.invoke(DESKTOP_IPC.quit),
    }
    contextBridge.exposeInMainWorld('harniverseDesktop', bridge)
    contextBridge.exposeInMainWorld('harniverseShellCopy', shellCopy(navigator.language))
  } else if (window.location.protocol === 'https:' || window.location.protocol === 'http:') {
    const directory: DesktopDirectoryBridge = { pickDirectory: () => ipcRenderer.invoke(DESKTOP_IPC.pickDirectory) }
    contextBridge.exposeInMainWorld('harniverseDirectory', directory)
    // Names the harness-host path of a dropped or pasted file for the
    // composer's `@path` intake; only the Desktop shell resolves one.
    contextBridge.exposeInMainWorld('harniverseHostPaths', { pathFor: (file: File) => webUtils.getPathForFile(file) })
    void bootstrapOwnedBrowser().catch(() => {
      // Normal Web enrollment remains available when native bootstrap is unavailable.
      console.warn('Desktop browser bootstrap is unavailable. Use the Host authentication page.')
    })
  }
}
