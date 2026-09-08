import type { BrowserAuthenticationSnapshot, ClientAuthentication } from './types.ts'

/** Bootstrap supplies the signed browser-session exchange, never its private key to Consumers. */
export type BrowserAuthenticationOptions =
  | { mode: 'bypass' }
  | { mode?: 'authenticated'; expiresAt: string; exchange: (signal: AbortSignal) => Promise<string> }

/** Stable terminal authentication failure suitable for a refresh instruction. */
export class BrowserAuthenticationRequired extends Error {
  constructor() { super('Authentication cannot be restored; refresh the page to authenticate again.') }
}

/** Waiter cancellation does not abort an exchange shared with other requests. */
async function waitFor<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return task
  signal.throwIfAborted()
  let abort!: () => void
  try {
    return await Promise.race([task, new Promise<never>((_resolve, reject) => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal owns its caller-supplied rejection reason.
      abort = () => { reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

/** One page-owned renewal chain shared by bootstrap, HTTP, and event carriers. */
export class BrowserAuthentication implements ClientAuthentication {
  private snapshot: BrowserAuthenticationSnapshot
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private operation: Promise<void> | undefined
  private abort: AbortController | undefined
  private epoch = 0
  private retry = 0
  private renewAt = Infinity
  private terminalDeadline = false

  constructor(private readonly options: BrowserAuthenticationOptions) {
    this.snapshot = { mode: options.mode === 'bypass' ? 'bypass' : 'authenticated', phase: 'ready',
      expiresAt: 'expiresAt' in options ? options.expiresAt : null, reason: null }
    window.addEventListener('focus', this.wake)
    window.addEventListener('online', this.online)
    document.addEventListener('visibilitychange', this.visible)
    this.schedule()
  }

  /** Stable snapshot until a lifecycle transition occurs. */
  getSnapshot = (): BrowserAuthenticationSnapshot => this.snapshot

  /** Register one observer without transferring lifecycle ownership. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private isStopped(): boolean { return this.snapshot.phase === 'stopped' || this.snapshot.phase === 'required' }
  private get deadline(): number { return this.snapshot.expiresAt === null ? Infinity : Date.parse(this.snapshot.expiresAt) }

  private publish(phase: BrowserAuthenticationSnapshot['phase'], reason: BrowserAuthenticationSnapshot['reason'] = null): void {
    this.snapshot = { ...this.snapshot, phase, reason }
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { console.error('[client-authentication] observer failed:', error) }
    }
  }

  private clearTimer(): void { clearTimeout(this.timer); this.timer = undefined }

  private arm(delay: number, action: () => void): void {
    this.clearTimer()
    this.timer = setTimeout(action, Math.max(1, delay))
  }

  private requireAuthentication(reason: 'rejected' | 'expired'): void {
    if (this.snapshot.phase === 'stopped') return
    this.clearTimer()
    this.publish('required', reason)
  }

  /** A repeated, classified admission refusal needs a fresh user authentication flow. */
  requireRefresh(): void { this.requireAuthentication('rejected') }

  private schedule(): void {
    if (this.isStopped() || this.snapshot.mode === 'bypass') return
    const remaining = this.deadline - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) { this.requireAuthentication('expired'); return }
    if (this.terminalDeadline) { this.arm(remaining, () => { this.requireAuthentication('expired') }); return }
    this.renewAt = Date.now() + Math.max(1, Math.floor(remaining / 2))
    this.arm(this.renewAt - Date.now(), () => { this.background() })
  }

  private readonly wake = (): void => { if (Date.now() >= this.renewAt) this.background() }
  private readonly online = (): void => { this.background() }
  private readonly visible = (): void => { if (document.visibilityState === 'visible') this.wake() }

  private background(): void { void this.renew(false).catch(() => { /* The observable state and retry timer own failure. */ }) }

  /** Wait only when the current credential cannot admit a new request. */
  async ready(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.isStopped()) throw new BrowserAuthenticationRequired()
    if (this.snapshot.phase !== 'recovering' && this.deadline > Date.now()) return
    await waitFor(this.renew(true), signal)
  }

  private renew(recovering: boolean): Promise<void> {
    if (this.isStopped()) return Promise.reject(new BrowserAuthenticationRequired())
    if (this.options.mode === 'bypass') return Promise.resolve()
    if (recovering && this.snapshot.phase !== 'recovering') this.publish('recovering')
    if (this.operation !== undefined) return this.operation
    if (this.terminalDeadline && !recovering) return Promise.resolve()
    this.clearTimer()
    const priorDeadline = this.deadline
    const controller = new AbortController()
    this.abort = controller
    const timeout = setTimeout(() => { controller.abort(new Error('Authentication exchange timed out')) }, 10_000)
    if (!recovering) this.publish(this.deadline > Date.now() ? 'renewing' : 'recovering')
    const exchange = this.options.exchange
    console.debug('[client-authentication] exchange started', recovering ? 'recovery' : 'renewal')
    const task = Promise.resolve().then(async () => {
      try {
        const expiry = await exchange(controller.signal)
        if (this.isStopped()) throw new BrowserAuthenticationRequired()
        const deadline = Date.parse(expiry)
        if (!Number.isFinite(deadline) || deadline <= Date.now()) {
          this.requireAuthentication('expired')
          throw new BrowserAuthenticationRequired()
        }
        this.epoch += 1
        this.retry = 0
        this.terminalDeadline = deadline <= priorDeadline
        this.snapshot = { ...this.snapshot, expiresAt: expiry }
        this.publish('ready')
        console.debug('[client-authentication] exchange accepted')
        this.schedule()
      } catch (error) {
        console.debug('[client-authentication] exchange failed', error instanceof BrowserAuthenticationRequired ? 'reauthentication-required' : 'unavailable')
        if (!this.isStopped()) {
          if (error instanceof BrowserAuthenticationRequired) this.requireAuthentication('rejected')
          else {
            this.publish('recovering', 'unavailable')
            this.arm(Math.min(10_000, 1_000 * 2 ** Math.min(4, this.retry++)), () => { this.background() })
          }
        }
        throw error
      } finally {
        clearTimeout(timeout)
        this.operation = undefined
        this.abort = undefined
      }
    })
    this.operation = task
    return task
  }

  /** Check the actual Cookie, rather than guessing authentication from a socket error. */
  async check(signal?: AbortSignal): Promise<void> {
    const requestSignal = signal === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    await this.ready(requestSignal)
    if (this.snapshot.mode === 'bypass') return
    const epoch = this.epoch
    const response = await globalThis.fetch('/auth/status', { credentials: 'same-origin', signal: requestSignal })
    if (!response.ok) throw new Error(`Authentication status unavailable (${response.status})`)
    const status = await response.json() as { authenticated?: boolean; sealed?: boolean }
    if (epoch !== this.epoch || this.isStopped()) return
    if (status.sealed === true) {
      this.requireAuthentication('rejected')
      throw new BrowserAuthenticationRequired()
    }
    if (status.authenticated !== true) await waitFor(this.renew(true), requestSignal)
  }

  /** Retry only explicit Host admission failures, never ambiguous transport or handler failures. */
  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const target = new URL(input, window.location.origin)
    if (target.origin !== window.location.origin) throw new TypeError('Authenticated requests must be same-origin')
    const signal = init.signal ?? AbortSignal.timeout(30_000)
    await this.ready(signal)
    const epoch = this.epoch
    const request = { ...init, credentials: 'same-origin' as const, signal }
    const response = await globalThis.fetch(input, request)
    if (this.isStopped()) throw new BrowserAuthenticationRequired()
    if (response.status !== 401 || response.headers.get('x-dsh-authentication') !== 'required') return response
    if (this.snapshot.mode === 'bypass') return response
    await response.body?.cancel()
    if (epoch === this.epoch) await waitFor(this.renew(true), signal)
    else await this.ready(signal)
    // A one-shot stream cannot be replayed without unbounded buffering.
    if (init.body instanceof ReadableStream) throw new Error('Authentication restored; retry the stream upload')
    const retryEpoch = this.epoch
    const retried = await globalThis.fetch(input, request)
    if (this.isStopped()) throw new BrowserAuthenticationRequired()
    if (retried.status === 401 && retried.headers.get('x-dsh-authentication') === 'required' && retryEpoch === this.epoch) this.requireAuthentication('rejected')
    return retried
  }

  /** Retire this owner; a late exchange cannot publish a new usable state. */
  async stop(): Promise<void> {
    this.epoch += 1
    this.clearTimer()
    this.abort?.abort()
    window.removeEventListener('focus', this.wake)
    window.removeEventListener('online', this.online)
    document.removeEventListener('visibilitychange', this.visible)
    this.publish('stopped')
    await this.operation?.catch(() => { /* The initiating caller owns the exchange error. */ })
    this.listeners.clear()
  }
}
