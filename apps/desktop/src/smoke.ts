/** Explicit clean-install qualification through the ordinary shell, Web gate, and owned Host. */
import { app, BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopShell, OwnedDesktopHost } from './main.ts'

/** One smoke lifecycle step's total budget; the outer driver kill stays the last resort. */
const STEP_BUDGET_MS = 100_000

/**
 * Settle one named lifecycle step within its budget. An unattended clean
 * install must never park forever on a modal dialog or a frozen await: the
 * Windows CI captures showed a fully-booted, then silent application until
 * the outer 300-second kill, with every deadline-bounded helper ruled out —
 * the step budget names the parked call and fails the qualification loudly.
 * @param step - human-readable step name for the failure message.
 * @param budgetMs - settle budget for the whole step.
 * @param action - the step's promise.
 * @returns the step's value once it settles in time.
 */
export async function boundedSmokeStep<T>(step: string, budgetMs: number, action: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Clean-install smoke step '${step}' did not settle within ${String(budgetMs)}ms; the shell is parked on it.`))
        }, budgetMs)
      }),
    ])
  }
  finally { clearTimeout(timer) }
}

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
  /** Current lifecycle step, named by the heartbeat while the run is parked. */
  private step = 'boot'
  private heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(private readonly report: string, runtimeRoot: string) {
    assertEmptyCommandPath(process.env.PATH)
    // The pinned runtime the packaging checks provisioned, handed in by the smoke driver; the
    // adjacent manifest read covers source-checkout runs where no driver supplied it.
    const expectedElectron = process.env.HARNIVERSE_DESKTOP_SMOKE_ELECTRON
      ?? (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        devDependencies?: { electron?: string }
      }).devDependencies?.electron
    if (expectedElectron !== undefined && process.versions.electron !== expectedElectron) {
      throw new Error(`Clean-install smoke requires Electron ${expectedElectron}.`)
    }
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

  /**
   * Race one renderer probe against a short bound: an executeJavaScript
   * issued into a frame that is navigating or being destroyed can hang
   * forever, and a single hung await would freeze a polling loop past its
   * own deadline (observed as the clean-install smoke's outer kill).
   * @param script - JavaScript to evaluate in the sole window's main frame.
   * @param boundMs - probe budget; resolution to `undefined` means "not
   *   answerable right now", never a failed qualification on its own.
   * @returns the script's value, or `undefined` when the bound expired.
   */
  private async probeRenderer<T>(script: string, boundMs: number): Promise<T | undefined> {
    return await Promise.race([
      onlyWindow().webContents.executeJavaScript(script) as Promise<T>,
      delay(boundMs).then(() => undefined),
    ])
  }

  private async waitForRenderer(): Promise<void> {
    const deadline = Date.now() + 25_000
    let observed: unknown
    while (Date.now() < deadline) {
      const contents = onlyWindow().webContents
      if (!contents.isLoadingMainFrame() && new URL(contents.getURL()).origin === this.origin) {
        try {
          observed = await this.probeRenderer(`(() => {
            const frame = document.querySelector('[data-viewport]');
            const rect = frame?.getBoundingClientRect();
            return {
              authenticated: performance.getEntriesByName('dsh:auth-complete').length > 0,
              criticalPluginsReady: performance.getEntriesByName('dsh:critical-entry-end').length > 0,
              rendered: !!rect && rect.width > 0 && rect.height > 0 && frame.querySelectorAll('button').length > 0
            };
          })()`, 2000)
        } catch { /* Normal authentication reload destroys the first document's execution context. */ }
        if (rendererReady(observed) && ['/auth/challenge', '/auth/exchange', '/plugins/bootstrap.js'].every(path => this.completed.has(path))) return
      }
      await delay(50)
    }
    throw new Error(`Authenticated renderer did not become ready: ${JSON.stringify(observed)}; completed=${JSON.stringify([...this.completed])}`)
  }

  private async authenticatedApi(): Promise<void> {
    const result = await this.probeRenderer(`(async () => {
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
    })()`, 10_000)
    if (result === undefined) throw new Error('The authenticated renderer probe did not answer within its budget.')
    if (result !== true) throw new Error('The normal authenticated HTTP session.list request failed.')
  }

  /** Exercise clean startup, persisted device reuse, close/hide, reopen, and ordinary idle Quit. */
  async run(shell: DesktopShell): Promise<void> {
    const holdQuit = (event: Electron.Event): void => { event.preventDefault() }
    this.startHeartbeat()
    try {
      await this.within('connect (first start)', () => shell.connect({ kind: 'local' }))
      await this.waitForRenderer()
      await this.authenticatedApi()
      await this.requireIdle()
      await this.within('disconnect', () => shell.disconnect())
      if (this.stopped !== 1) throw new Error('Disconnect did not acknowledge owned Host close.')
      await this.within('connect (restart)', () => shell.connect({ kind: 'local' }))
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
      await this.within('quit', () => shell.requestQuit())
      this.writeReceipt()
      app.removeListener('will-quit', holdQuit)
      this.stopHeartbeat()
      app.quit()
    } catch (error) {
      console.error('Clean-install smoke failed:', error)
      this.stopHeartbeat()
      try { await this.host?.stop() }
      catch (failure) { console.error('Clean-install smoke teardown failed:', failure) }
      app.removeListener('will-quit', holdQuit)
      app.exit(1)
    } finally {
      this.observedSession?.webRequest.onBeforeRequest(null)
      this.observedSession?.webRequest.onCompleted(null)
    }
  }

  /** Mark and bound one lifecycle step: the heartbeat names it while parked. */
  private async within<T>(step: string, action: () => Promise<T>): Promise<T> {
    this.step = step
    return await boundedSmokeStep(step, STEP_BUDGET_MS, action)
  }

  /**
   * Log liveness every 10 seconds while the qualification runs. Continuing
   * heartbeats beside a stuck step prove the main loop is alive and parked on
   * an await; stopped heartbeats prove the loop itself is frozen — the two
   * failure classes the Windows captures could not be told apart by.
   */
  private startHeartbeat(): void {
    const started = Date.now()
    const timer = setInterval(() => {
      console.log(`clean-install smoke heartbeat: T+${String(Math.round((Date.now() - started) / 1000))}s step=${this.step}`)
    }, 10_000)
    // The heartbeat must never hold the event loop; Electron main timers unref.
    timer.unref()
    this.heartbeat = timer
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === undefined) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private async requireIdle(): Promise<void> {
    const deadline = Date.now() + 30_000
    let activity: Awaited<ReturnType<OwnedDesktopHost['activity']>> | undefined
    while (Date.now() < deadline) {
      // Bounded like the renderer probes: one hung activity RPC must not
      // freeze this loop past its deadline.
      activity = await Promise.race([this.host?.activity(), delay(2000).then(() => undefined)])
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
