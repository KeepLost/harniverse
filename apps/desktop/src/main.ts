/** Electron owns presentation and one local child; all business UI and capabilities belong to the Host. */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { desktopIconBitmap } from './branding.ts'
import { createDesktopUpdates } from './update-native.ts'
import type { DesktopUpdates } from './update.ts'
import {
  assertShellSender, DESKTOP_IPC, parseConnectionProfile, quitWarning, validateHostUrl,
  type AuthWebReply, type ConnectionProfile, type DirectorySelection, type RendererAuthority, type ShellActivity, type ShellState,
} from './ipc.ts'

/** Ready data stays in the main process; the URL may contain a short-lived browser bootstrap. */
export interface DesktopHostReady { url: string; authWeb?: string }

/** The process adapter owns actual-exit settlement and the authenticated Host control channel. */
export interface OwnedDesktopHost {
  start(): Promise<DesktopHostReady>
  stop(): Promise<void>
  /** Whether the owned process has actually closed, including unclean exits. */
  hasClosed?(): boolean
  activity(): Promise<ShellActivity>
  enroll(publicKey: string): Promise<{ grant: { id: string; name: string } }>
  updateTasks?(action: 'inspect' | 'lock' | 'unlock'): Promise<ShellActivity>
}

/** Native dialogs are callbacks on the owned child, never arbitrary renderer commands. */
export interface OwnedHostCallbacks {
  onFailure(error: Error): void
  pickDirectory(): Promise<DirectorySelection>
}

/** Distribution paths and the owned-process factory are main-process configuration. */
export interface DesktopShellOptions {
  createOwnedHost(callbacks: OwnedHostCallbacks): OwnedDesktopHost
  rendererPath: string
  preloadPath: string
  updates?: Pick<DesktopUpdates, 'install' | 'recover'>
}

interface Connection {
  profile: ConnectionProfile
  host?: OwnedDesktopHost
  origin?: string
  webUrl?: string
  failed: boolean
  bootstrap: 'available' | 'enrolling' | 'approved' | 'complete'
  stopping?: boolean
}

/**
 * Start the sole application instance after Electron is ready.
 * @param options - trusted distribution paths and owned Host adapter.
 * @returns the active shell, or undefined when another process owns the instance lock.
 */
export async function launchDesktopShell(options: DesktopShellOptions): Promise<DesktopShell | undefined> {
  app.setName('dsh-harniverse')
  app.setAppUserModelId('com.keeplost.harniverse')
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return undefined
  }
  await app.whenReady()
  const shell = new DesktopShell(options)
  await shell.start()
  return shell
}

/** One window, one active Host, and serialized process ownership transitions. */
export class DesktopShell {
  private window: BrowserWindow | undefined
  private tray: Tray | undefined
  private connection: Connection | undefined
  private authority: RendererAuthority | undefined
  private state: ShellState = { phase: 'disconnected', activity: { status: 'unknown' } }
  private operation: Promise<void> = Promise.resolve()
  private quitPending: Promise<void> | undefined
  private quitting = false
  private picking = false
  private updating = false
  private updates: Pick<DesktopUpdates, 'install' | 'recover'> | undefined
  private partition = 'persist:harniverse-owned'
  private readonly securedSessions = new WeakSet<Electron.Session>()

  constructor(private readonly options: DesktopShellOptions) {}

  /** Create the shell window and retained tray after Electron readiness. */
  async start(): Promise<void> {
    this.registerIpc()
    this.createTray()
    await this.showLauncher()
    const updates = this.options.updates ?? createDesktopUpdates()
    try { await updates.recover(); this.updates = updates }
    catch { dialog.showErrorBox('Harniverse update recovery', 'An interrupted update could not be recovered. Updates are disabled for this launch. Keep the update journal and retained executable for recovery.') }
    this.refreshMenu()
    app.on('activate', () => { this.show() })
    app.on('second-instance', () => { this.show() })
    app.on('window-all-closed', () => { /* The retained tray owns the application's background lifetime. */ })
    app.on('before-quit', (event) => {
      if (this.quitting) return
      event.preventDefault()
      void this.requestQuit()
    })
  }

  /** Reveal the sole window from the tray or another launch. */
  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /**
   * Connect only after any existing owned child has completed teardown.
   * @param input - connection profile from the shell page.
   * @returns completion of loading the shared authenticated Web app.
   */
  connect(input: unknown): Promise<void> {
    const profile = parseConnectionProfile(input)
    return this.serialize(async () => { await this.connectNow(profile) })
  }

  /** Return to the connection page after an activity-aware disconnect. */
  disconnect(): Promise<void> {
    return this.serialize(async () => {
      if (!await this.confirmStop('Disconnect')) return
      await this.stopOwned(true)
      this.connection = undefined
      this.state = { phase: 'disconnected', activity: { status: 'unknown' } }
      await this.showLauncher()
    })
  }

  /** Confirm possible work interruption, settle only the owned child, then quit. */
  requestQuit(): Promise<void> {
    if (this.quitPending !== undefined) return this.quitPending
    this.quitPending = this.serialize(async () => {
      if (!await this.confirmStop('Quit')) return
      await this.stopOwned(true)
      this.quitting = true
      this.tray?.destroy()
      app.quit()
    }).catch(async () => {
      await dialog.showMessageBox({ type: 'error', title: 'Harniverse', message: 'The local Host could not be stopped.', detail: 'The shell stays open so you can retry. Active work may still be running.', buttons: ['OK'] })
    }).finally(() => { this.quitPending = undefined })
    return this.quitPending
  }

  /** Native-menu update selection never accepts a renderer path or executable command. */
  installUpdate(): Promise<void> {
    return this.serialize(async () => {
      const updates = this.updates
      if (updates === undefined || this.quitting) throw new Error('Updates are unavailable in this launch.')
      const connection = this.connection
      const host = connection?.host
      const updateTasks = host?.updateTasks?.bind(host)
      if (host !== undefined && updateTasks === undefined) throw new Error('The local Host does not support safe update admission control.')
      this.updating = true
      this.refreshMenu()
      try {
        await updates.install({
          host: updateTasks === undefined ? undefined : {
            updateTasks,
            stop: () => this.stopOwned(),
          },
          detach: async () => {
            this.connection = undefined
            this.state = { phase: 'disconnected', activity: { status: 'unknown' } }
            await this.showLauncher()
          },
          restore: async () => {
            // This callback is admitted only after the old owned child's stop promise fulfills.
            if (host === undefined) return
            this.connection = undefined
            this.updating = false
            await this.connectNow({ kind: 'local' })
          },
          finish: () => {
            this.quitting = true
            this.tray?.destroy()
            app.quit()
            return Promise.resolve()
          },
        })
      } finally { this.updating = false; this.refreshMenu() }
    })
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.operation.then(action)
    this.operation = next.catch(() => { /* A rejected transition must not block a later explicit retry. */ })
    return next
  }

  private connectionUsable(connection: Connection): boolean {
    return connection === this.connection && !connection.failed && !connection.stopping && !this.quitting && !this.updating
  }

  private connectionFailed(connection: Connection): boolean {
    return connection.failed
  }

  private async connectNow(profile: ConnectionProfile): Promise<void> {
    if (this.quitting) throw new Error('The shell is quitting.')
    if (this.connection !== undefined) throw new Error('Disconnect the current Host before connecting another.')
    const connection: Connection = { profile, failed: false, bootstrap: 'available' }
    this.connection = connection
    this.state = { phase: 'connecting', profile, ownership: profile.kind === 'local' ? 'owned' : 'external', activity: { status: 'unknown' } }
    try {
      let webUrl: string
      if (profile.kind === 'local') {
        connection.host = this.options.createOwnedHost({
          onFailure: () => { this.hostFailed(connection) },
          pickDirectory: () => this.showDirectoryPicker(connection),
        })
        const ready = await connection.host.start()
        const origin = new URL(validateHostUrl(ready.url)).origin
        if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Owned Host must bind loopback.')
        webUrl = ready.authWeb ?? ready.url
        const authenticated = new URL(webUrl)
        if (authenticated.origin !== origin || authenticated.username !== '' || authenticated.password !== '') throw new Error('Invalid browser bootstrap origin.')
        connection.origin = origin
      } else {
        webUrl = profile.url
        connection.origin = new URL(webUrl).origin
      }
      if (this.connectionFailed(connection)) throw new Error('The Host stopped during startup.')
      connection.webUrl = `${connection.origin}/`
      const partition = profile.kind === 'local' ? 'persist:harniverse-owned'
        : `persist:harniverse-external-${createHash('sha256').update(connection.origin).digest('hex')}`
      this.ensureWindow(partition)
      this.authority = { kind: 'web', origin: connection.origin }
      await this.window?.loadURL(webUrl)
      if (this.connectionFailed(connection)) throw new Error('The Host stopped during startup.')
      this.state = { ...this.state, phase: 'ready' }
      this.refreshMenu()
      this.show()
    } catch {
      connection.failed = true
      this.state = { ...this.state, phase: 'failed', message: 'The Host connection failed. Check the Host and retry.', activity: { status: 'unknown' } }
      await this.showLauncher()
      // Ownership remains attached until stop settles, including failed startup.
      throw new Error('The Host connection failed. Disconnect before retrying.')
    }
  }

  private hostFailed(connection: Connection): void {
    if (connection !== this.connection || connection.stopping || this.quitting) return
    connection.failed = true
    this.state = { ...this.state, phase: 'failed', activity: { status: 'unknown' }, message: 'The local Host stopped unexpectedly. Disconnect and reconnect to start it again.' }
    void this.serialize(async () => { if (connection === this.connection) await this.showLauncher() }).catch(() => {
      dialog.showErrorBox('Harniverse', 'The Host stopped and the recovery page could not load. Use the tray menu to quit.')
    })
  }

  private async stopOwned(allowUncleanExit = false): Promise<void> {
    const connection = this.connection
    if (connection?.host === undefined) return
    connection.stopping = true
    try { await connection.host.stop() }
    catch {
      // Explicit quit/disconnect can release a dead child; updates require acknowledged clean exit.
      if (!allowUncleanExit || connection.host.hasClosed?.() !== true) {
        throw new Error('The local Host did not finish stopping. It remains attached for retry.')
      }
    }
    finally { connection.stopping = false }
  }

  private async confirmStop(action: 'Quit' | 'Disconnect'): Promise<boolean> {
    const connection = this.connection
    if (connection === undefined) return true
    let activity: ShellActivity = { status: 'unknown' }
    if (connection.host !== undefined && !connection.failed) {
      try { activity = await connection.host.activity() } catch { /* Unavailable observation requires a conservative warning. */ }
    }
    this.state = { ...this.state, activity }
    const warning = quitWarning(connection.profile.kind === 'local' ? 'owned' : 'external', activity)
    if (warning === undefined) return true
    this.show()
    const result = await dialog.showMessageBox({
      type: 'warning', title: 'Harniverse', message: `${action} Harniverse?`, detail: warning,
      buttons: ['Keep running', action], defaultId: 0, cancelId: 0, noLink: true,
    })
    return result.response === 1
  }

  private async showDirectoryPicker(connection: Connection): Promise<DirectorySelection> {
    if (connection !== this.connection || connection.profile.kind !== 'local' || connection.host === undefined
      || connection.failed || connection.stopping || this.quitting || this.updating || this.picking || this.state.phase !== 'ready') {
      throw new Error('Native directory selection requires the active local Host.')
    }
    const window = this.window
    if (window === undefined || window.isDestroyed()) throw new Error('The desktop window is unavailable.')
    this.picking = true
    try {
      const selection = await dialog.showOpenDialog(window, { title: 'Choose a local workspace', properties: ['openDirectory', 'createDirectory'] })
      if (!this.connectionUsable(connection) || selection.canceled || selection.filePaths[0] === undefined) return { kind: 'cancelled' }
      return { kind: 'selected', path: selection.filePaths[0] }
    } finally { this.picking = false }
  }

  private registerIpc(): void {
    const handle = (channel: string, audience: 'shell' | 'web', action: (...args: unknown[]) => unknown) => {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        const owner = this.window?.webContents
        const authority = this.authority
        if (owner === undefined || authority === undefined || authority.kind !== audience) throw new Error('Desktop operation is unavailable in this page.')
        assertShellSender(event, owner, authority)
        return action(...args)
      })
    }
    handle(DESKTOP_IPC.state, 'shell', () => this.state)
    handle(DESKTOP_IPC.connect, 'shell', (...args) => {
      if (args.length !== 1) throw new Error('Expected one connection profile.')
      return this.connect(args[0])
    })
    handle(DESKTOP_IPC.disconnect, 'shell', () => this.disconnect())
    handle(DESKTOP_IPC.quit, 'shell', () => this.requestQuit())
    handle(DESKTOP_IPC.authWeb, 'web', async (...args): Promise<AuthWebReply> => {
      const input = args[0]
      if (args.length !== 1 || typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Invalid browser bootstrap request.')
      const request = input as Record<string, unknown>
      const connection = this.connection
      if (connection?.profile.kind !== 'local' || connection.host === undefined || connection.failed || connection.stopping || this.quitting || this.updating) return { kind: 'ordinary' }
      if (request.kind === 'inspect' && Object.keys(request).length === 1) return { kind: connection.bootstrap === 'available' ? 'enroll' : 'ordinary' }
      if (request.kind === 'complete' && Object.keys(request).length === 1 && connection.bootstrap === 'approved') {
        connection.bootstrap = 'complete'
        await this.serialize(async () => {
          const origin = connection.origin
          const window = this.window
          if (!this.connectionUsable(connection) || connection.webUrl === undefined || origin === undefined || window === undefined) return
          this.authority = { kind: 'web', origin }
          await window.loadURL(connection.webUrl)
        })
        return { kind: 'ordinary' }
      }
      if (request.kind !== 'enroll' || Object.keys(request).length !== 2 || typeof request.publicKey !== 'string'
        || request.publicKey.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(request.publicKey) || connection.bootstrap !== 'available') throw new Error('Browser bootstrap is unavailable.')
      connection.bootstrap = 'enrolling'
      let result: { grant: { id: string; name: string } }
      try { result = await connection.host.enroll(request.publicKey) }
      catch { throw new Error('Desktop browser enrollment failed. Use the Host authentication page or reconnect.') }
      if (!this.connectionUsable(connection)) throw new Error('The Host connection changed during enrollment.')
      connection.bootstrap = 'approved'
      return { kind: 'approved', grantId: result.grant.id, name: result.grant.name }
    })
    handle(DESKTOP_IPC.pickDirectory, 'web', async (...args): Promise<DirectorySelection> => {
      if (args.length !== 0) throw new Error('Directory selection does not accept a path.')
      const connection = this.connection
      if (connection?.profile.kind !== 'local' || connection.host === undefined || connection.failed || connection.stopping || this.updating || this.state.phase !== 'ready') {
        throw new Error('Use the connected Host directory picker for this connection.')
      }
      const rpcId = randomUUID()
      const origin = connection.origin
      const window = this.window
      if (origin === undefined || window === undefined || window.isDestroyed()) throw new Error('The desktop window is unavailable.')
      const response = await window.webContents.session.fetch(`${origin}/api/host.pickDirectory`, {
        method: 'POST', credentials: 'include', redirect: 'error',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'host.pickDirectory', payload: {} }),
      })
      if (!response.ok) throw new Error('The Host did not authorize directory selection. Refresh authentication and retry.')
      const result: unknown = await response.json()
      if (typeof result !== 'object' || result === null || !('rpcId' in result) || result.rpcId !== rpcId
        || !('result' in result) || typeof result.result !== 'object' || result.result === null
        || !('ok' in result.result) || result.result.ok !== true || !('value' in result.result)
        || typeof result.result.value !== 'object' || result.result.value === null || !('path' in result.result.value)) {
        throw new Error('The Host could not select a directory.')
      }
      const path = result.result.value.path
      if (path !== null && typeof path !== 'string') throw new Error('Invalid Host directory selection.')
      if (!this.connectionUsable(connection)) return { kind: 'cancelled' }
      return path === null ? { kind: 'cancelled' } : { kind: 'selected', path }
    })
  }

  private async showLauncher(): Promise<void> {
    const window = this.ensureWindow()
    const url = pathToFileURL(this.options.rendererPath).href
    this.authority = { kind: 'shell', url }
    await window.loadURL(url)
    this.refreshMenu()
    this.show()
  }

  private ensureWindow(partition = this.partition): BrowserWindow {
    if (partition !== this.partition) {
      this.authority = undefined
      this.window?.destroy()
      this.window = undefined
      this.partition = partition
    }
    if (this.window === undefined || this.window.isDestroyed()) {
      const window = new BrowserWindow({
        width: 1200, height: 840, minWidth: 720, minHeight: 540, show: false, title: 'Harniverse',
        icon: nativeImage.createFromBitmap(desktopIconBitmap(256, 'bgra'), { width: 256, height: 256 }),
        webPreferences: {
          preload: this.options.preloadPath, contextIsolation: true, sandbox: true,
          nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false,
          webviewTag: false, partition,
        },
      })
      this.window = window
      this.secureWindow(window)
    }
    return this.window
  }

  private secureWindow(window: BrowserWindow): void {
    const contents = window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const permitNavigation = (event: { preventDefault(): void }, target: string) => {
      const authority = this.authority
      let allowed = false
      if (authority?.kind === 'shell') allowed = target === authority.url
      if (authority?.kind === 'web') {
        try {
          const url = new URL(target)
          allowed = ['https:', 'http:'].includes(url.protocol) && url.origin === authority.origin && url.username === '' && url.password === ''
        } catch { /* Invalid navigation targets are denied. */ }
      }
      if (!allowed) event.preventDefault()
    }
    contents.on('will-navigate', permitNavigation)
    contents.on('will-redirect', permitNavigation)
    contents.on('will-attach-webview', (event) => { event.preventDefault() })
    if (!this.securedSessions.has(contents.session)) {
      this.securedSessions.add(contents.session)
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
      contents.session.setPermissionCheckHandler(() => false)
      contents.session.on('will-download', (event) => { event.preventDefault() })
    }
    window.on('close', (event) => {
      if (this.quitting || this.tray === undefined || this.tray.isDestroyed()) return
      event.preventDefault()
      window.hide()
    })
    contents.on('render-process-gone', () => {
      if (this.quitting || window !== this.window) return
      this.state = { ...this.state, phase: 'failed', message: 'The window stopped unexpectedly. The Host may still be running. Reopen the app or disconnect safely.' }
      void this.serialize(async () => { await this.showLauncher() }).catch(() => {
        dialog.showErrorBox('Harniverse', 'The window could not recover. Use the tray menu to quit.')
      })
    })
    contents.on('unresponsive', () => { this.tray?.setToolTip('Harniverse — window is not responding') })
    contents.on('responsive', () => { this.tray?.setToolTip('Harniverse') })
  }

  private createTray(): void {
    const image = nativeImage.createFromBitmap(desktopIconBitmap(18, 'bgra'), { width: 18, height: 18 })
    if (image.isEmpty()) throw new Error('The desktop tray icon could not be created.')
    image.setTemplateImage(process.platform === 'darwin')
    this.tray = new Tray(image)
    this.tray.setToolTip('Harniverse')
    this.tray.on('click', () => { this.show() })
    this.refreshMenu()
  }

  private refreshMenu(): void {
    if (this.quitting) return
    const safe = (action: () => Promise<void>) => () => {
      void action().catch(() => { dialog.showErrorBox('Harniverse', 'The requested operation failed. The Host remains attached; retry from the connection page.') })
    }
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: 'Show Harniverse', click: () => { this.show() } },
      { label: 'Open connected app', enabled: this.connection?.webUrl !== undefined && !this.connection.failed, click: safe(() => this.serialize(async () => {
        const connection = this.connection
        if (connection?.webUrl === undefined || connection.origin === undefined || connection.failed) return
        this.authority = { kind: 'web', origin: connection.origin }
        await this.window?.loadURL(connection.webUrl)
        this.state = { ...this.state, phase: 'ready' }
        this.show()
      })) },
      { label: 'Connection settings', click: safe(() => this.serialize(() => this.showLauncher())) },
      { label: 'Disconnect Host', enabled: this.connection !== undefined, click: safe(() => this.disconnect()) },
      { label: 'Install update…', enabled: this.updates !== undefined && !this.updating, click: () => {
        void this.installUpdate().catch((error: unknown) => {
          dialog.showErrorBox('Harniverse update', error instanceof Error ? error.message : 'The update did not finish.')
        })
      } },
      { type: 'separator' },
      { label: 'Quit Harniverse', click: () => { void this.requestQuit() } },
    ]
    this.tray?.setContextMenu(Menu.buildFromTemplate(items))
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Harniverse', submenu: items }, { role: 'editMenu' }]))
  }
}
