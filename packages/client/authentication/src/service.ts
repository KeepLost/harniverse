import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClientAuthentication } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { clientAuthentication: BrowserAuthenticationService }
}

/** Cordis Service Definition and browser Provider over the adopted bootstrap runtime. */
export class BrowserAuthenticationService extends Service implements ClientAuthentication {
  /** @param ctx - owning plugin context. @param runtime - the already authenticated bootstrap instance. */
  constructor(ctx: Context, private readonly runtime: ClientAuthentication) {
    super(ctx, 'clientAuthentication')
    ctx.effect(() => () => this.stop(), 'client-authentication: bootstrap ownership')
  }
  /** Return the adopted runtime's stable, non-secret snapshot. */
  getSnapshot(): ReturnType<ClientAuthentication['getSnapshot']> { return this.runtime.getSnapshot() }
  /** Subscribe to authentication transitions; the returned disposer removes only this observer. */
  subscribe(listener: () => void): () => void { return this.runtime.subscribe(listener) }
  /** Await usable credentials; caller cancellation does not cancel other waiters. */
  ready(signal?: AbortSignal): Promise<void> { return this.runtime.ready(signal) }
  /** Reconcile Cookie admission after a status-less carrier fails. */
  check(signal?: AbortSignal): Promise<void> { return this.runtime.check(signal) }
  /** Perform a same-origin request with bounded, classified admission recovery. */
  fetch(input: string | URL, init?: RequestInit): Promise<Response> { return this.runtime.fetch(input, init) }
  /** Retire automatic recovery after a repeated admission refusal. */
  requireRefresh(): void { this.runtime.requireRefresh() }
  /** Stop and drain the adopted runtime before clearing any credential. */
  stop(): Promise<void> { return this.runtime.stop() }
}
