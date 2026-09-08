/** Non-secret browser admission state; transport liveness is owned by Connection. */
export interface BrowserAuthenticationSnapshot {
  mode: 'authenticated' | 'bypass'
  phase: 'ready' | 'renewing' | 'recovering' | 'required' | 'stopped'
  expiresAt: string | null
  reason: 'rejected' | 'expired' | 'unavailable' | null
}

/** Shared authentication capability, transferred from bootstrap to its plugin owner. */
export interface ClientAuthentication {
  getSnapshot(): BrowserAuthenticationSnapshot
  subscribe(listener: () => void): () => void
  /** Wait for usable credentials without cancelling other callers' shared exchange. */
  ready(signal?: AbortSignal): Promise<void>
  /** Recheck browser Cookie admission after a carrier without HTTP status fails. */
  check(signal?: AbortSignal): Promise<void>
  /** Retire automatic recovery after a restored credential is explicitly refused again. */
  requireRefresh(): void
  /** Same-origin request with one replay only after a classified pre-dispatch refusal. */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>
  /** Stop and drain credential exchanges before the caller clears the Cookie. */
  stop(): Promise<void>
}
