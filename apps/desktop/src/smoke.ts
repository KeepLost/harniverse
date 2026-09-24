/** Explicit clean-install qualification through the ordinary shell, Web gate, and owned Host. */
import { app, BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopShell, OwnedDesktopHost } from './main.ts'

/** Return the explicit receipt destination only when both smoke opt-ins are present. */
export function smokeReportPath(argv: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  const report = env.HARNIVERSE_DESKTOP_SMOKE_REPORT
  if (!argv.includes('--harniverse-clean-install-smoke') || !report) return
  if (!isAbsolute(report)) throw new Error('Clean-install smoke report must be absolute.')
  return report
}

/** Require a real empty PATH directory; missing PATH would enable platform defaults. */
export function assertEmptyCommandPath(path: string | undefined): void {
  if (!path || !isAbsolute(path) || path.split(delimiter).length !== 1 || readdirSync(path).length !== 0) {
    throw new Error('Clean-install smoke requires one empty command directory in PATH.')
  }
}

/** Require successful normal authentication and plugin activation plus a visible app frame. */
export function rendererReady(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return state.authenticated === true && state.criticalPluginsReady === true && state.rendered === true
}

function onlyWindow(): BrowserWindow {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length !== 1 || windows[0] === undefined) throw new Error('Smoke requires the sole ordinary desktop window.')
  return windows[0]
}

/** Test-only observer. All authentication and process lifecycle operations delegate to production owners. */
export class DesktopCleanInstallSmoke {
  port = 0
  private host: OwnedDesktopHost | undefined
  private origin = ''
  private unauthenticatedRejected = 0
  private stopped = 0
  private enrollments: { publicKey: string; grantId: string }[] = []
  private completed = new Set<string>()
  private externalRequests = new Set<string>()
  private observedSession: Electron.Session | undefined
  private inventorySha256: string

  constructor(private readonly report: string, runtimeRoot: string) {
    assertEmptyCommandPath(process.env.PATH)
    if (process.versions.electron !== '43.4.0') throw new Error('Clean-install smoke requires Electron 43.4.0.')
    this.inventorySha256 = createHash('sha256').update(readFileSync(join(runtimeRoot, 'offline-assets.json'))).digest('hex')
    const profile = mkdtempSync(join(dirname(report), 'profile-'))
    app.setPath('userData', profile)
    app.setPath('sessionData', profile)
  }

  /** Observe the real adapter's approval and acknowledged close; do not mint credentials. */
  observe(host: OwnedDesktopHost): OwnedDesktopHost {
    this.host = host
    return {
      start: async () => {
        const ready = await host.start()
        this.origin = new URL(ready.url).origin
        this.port = Number(new URL(ready.url).port)
        const response = await fetch(`${this.origin}/api/session.list`, { method: 'POST', signal: AbortSignal.timeout(5000) })
        if (response.status !== 401) throw new Error(`Unauthenticated session.list returned ${String(response.status)}.`)
        await response.body?.cancel()
        this.unauthenticatedRejected++
        this.observeRequests()
        return ready
      },
      enroll: async (publicKey) => {
        const approved = await host.enroll(publicKey)
        this.enrollments.push({ publicKey, grantId: approved.grant.id })
        return approved
      },
      activity: () => host.activity(),
      stop: async () => { await host.stop(); this.stopped++ },
      ...(host.updateTasks === undefined ? {} : { updateTasks: host.updateTasks.bind(host) }),
    }
  }

  private observeRequests(): void {
    const session = onlyWindow().webContents.session
    this.observedSession = session
    this.completed.clear()
    session.webRequest.onBeforeRequest(null)
    session.webRequest.onCompleted(null)
    session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const external = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
        && url.origin.replace(/^ws/u, 'http') !== this.origin
      if (external) this.externalRequests.add(url.origin)
      callback({ cancel: external })
    })
    session.webRequest.onCompleted((details) => {
      const url = new URL(details.url)
      if (url.origin === this.origin && details.statusCode === 200) this.completed.add(url.pathname)
    })
  }

  private async waitForRenderer(): Promise<void> {
    const deadline = Date.now() + 25_000
    let observed: unknown
    while (Date.now() < deadline) {
      const contents = onlyWindow().webContents
      if (!contents.isLoadingMainFrame() && new URL(contents.getURL()).origin === this.origin) {
        try {
          observed = await contents.executeJavaScript(`(() => {
            const frame = document.querySelector('[data-viewport]');
            const rect = frame?.getBoundingClientRect();
            return {
              authenticated: performance.getEntriesByName('dsh:auth-complete').length > 0,
              criticalPluginsReady: performance.getEntriesByName('dsh:critical-entry-end').length > 0,
              rendered: !!rect && rect.width > 0 && rect.height > 0 && frame.querySelectorAll('button').length > 0
            };
          })()`)
        } catch { /* Normal authentication reload destroys the first document's execution context. */ }
        if (rendererReady(observed) && ['/auth/challenge', '/auth/exchange', '/plugins/bootstrap.js'].every(path => this.completed.has(path))) return
      }
      await delay(50)
    }
    throw new Error(`Authenticated renderer did not become ready: ${JSON.stringify(observed)}; completed=${JSON.stringify([...this.completed])}`)
  }

  private async authenticatedApi(): Promise<void> {
    const result: unknown = await onlyWindow().webContents.executeJavaScript(`(async () => {
      const status = await fetch('/auth/status');
      const authentication = await status.json();
      const response = await fetch('/api/session.list', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', method: 'session.list', rpcId: 'desktop-smoke', payload: {} })
      });
      const body = await response.json();
      return authentication.mode === 'authenticated' && authentication.authenticated === true
        && response.status === 200 && body.rpcId === 'desktop-smoke' && body.result?.ok === true
        && Array.isArray(body.result.value?.items);
    })()`)
    if (result !== true) throw new Error('The normal authenticated HTTP session.list request failed.')
  }

  /** Exercise clean startup, persisted device reuse, close/hide, reopen, and ordinary idle Quit. */
  async run(shell: DesktopShell): Promise<void> {
    const holdQuit = (event: Electron.Event): void => { event.preventDefault() }
    try {
      await shell.connect({ kind: 'local' })
      await this.waitForRenderer()
      await this.authenticatedApi()
      await this.requireIdle()
      await shell.disconnect()
      if (this.stopped !== 1) throw new Error('Disconnect did not acknowledge owned Host close.')
      await shell.connect({ kind: 'local' })
      await this.waitForRenderer()
      await this.authenticatedApi()
      const [first, second] = this.enrollments
      if (this.enrollments.length !== 2 || first === undefined || second === undefined
        || first.publicKey !== second.publicKey || first.grantId !== second.grantId) {
        throw new Error('Owned Host restart did not reuse the persisted browser key and grant.')
      }
      const window = onlyWindow()
      window.close()
      if (window.isDestroyed() || window.isVisible()) throw new Error('Window close did not hide the retained app.')
      await this.requireIdle()
      await this.authenticatedApi()
      shell.show()
      if (!window.isVisible()) throw new Error('The retained window did not reopen.')
      await this.waitForRenderer()
      await this.requireIdle()
      if (this.externalRequests.size !== 0) throw new Error(`Smoke attempted external requests: ${[...this.externalRequests].join(', ')}`)
      app.on('will-quit', holdQuit)
      await shell.requestQuit()
      this.writeReceipt()
      app.removeListener('will-quit', holdQuit)
      app.quit()
    } catch (error) {
      console.error('Clean-install smoke failed:', error)
      try { await this.host?.stop() }
      catch (failure) { console.error('Clean-install smoke teardown failed:', failure) }
      app.removeListener('will-quit', holdQuit)
      app.exit(1)
    } finally {
      this.observedSession?.webRequest.onBeforeRequest(null)
      this.observedSession?.webRequest.onCompleted(null)
    }
  }

  private async requireIdle(): Promise<void> {
    const deadline = Date.now() + 30_000
    let activity: Awaited<ReturnType<OwnedDesktopHost['activity']>> | undefined
    while (Date.now() < deadline) {
      activity = await this.host?.activity()
      if (activity?.status === 'idle' && activity.sessions === 0 && activity.tasks === 0) return
      await delay(100)
    }
    throw new Error(`Clean-install Host did not become idle: ${JSON.stringify(activity)}`)
  }

  private writeReceipt(): void {
    if (this.stopped !== 2 || this.unauthenticatedRejected !== 2) throw new Error('Smoke lifecycle evidence is incomplete.')
    assertEmptyCommandPath(process.env.PATH)
    const receipt = {
      schemaVersion: 1, offlineAssetsLoaded: true, authenticated: true, ownedHostStopped: true,
      systemNodeUsed: false, systemPackageManagerUsed: false, networkInstallUsed: false,
      evidence: {
        electron: process.versions.electron, inventorySha256: this.inventorySha256,
        unauthenticatedStatus: 401, signedExchange: true, pluginBootstrap: true, renderedApp: true,
        sessionList: true, deviceKeyReused: true, closeHidWindow: true, hiddenHostAlive: true,
        reopened: true, acknowledgedHostCloses: this.stopped, emptyCommandPath: true,
      },
    }
    writeFileSync(this.report, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
}
