/**
 * Authorization-aware client mirror of the Host settings description. The
 * Host remains authoritative for namespace exposure, redaction, and write
 * capability; this mirror only shares the already-authorized response within
 * one authenticated connection generation.
 */

import type {
  ConnectionAuthenticationSource, IApiClient, RpcResponse, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

type SettingsFace = Pick<IApiClient, 'settings'>
type AuthenticationIdentity = ReturnType<ConnectionAuthenticationSource['getSnapshot']>

function sameIdentity(left: AuthenticationIdentity, right: AuthenticationIdentity): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind) return false
  return left.kind === 'bypass'
    || (right.kind === 'grant'
      && left.grantId === right.grantId
      && left.grantRevision === right.grantRevision)
}

/** The full successful `settings.describe` value. */
export interface SettingsDescribeView {
  /** Namespace views already filtered and redacted by the Host. */
  namespaces: readonly SettingsNamespaceView[]
  /** Whether the authenticated principal may write settings. */
  writable: boolean
  /** Whether the provider owns a native settings document. */
  hasDocument: boolean
}

/** Shared mirror state consumed by settings surfaces. */
export interface SettingsMirrorSnapshot {
  /** `ready` retains the last good view across ordinary refresh failures. */
  status: 'idle' | 'loading' | 'ready'
  /** Last authorized description, absent until the first success or after reset. */
  view: SettingsDescribeView | undefined
  /** Latest read failure, cleared by success and authentication reset. */
  error: string | null
}

/** Read and write-fold face exposed to settings consumers. */
export interface SettingsDescribeFace {
  /** @returns the current stable snapshot. */
  getSnapshot(): SettingsMirrorSnapshot
  /**
   * Observe snapshot replacement.
   * @param listener - callback invoked after replacement.
   * @returns the subscription disposer.
   */
  subscribe(listener: () => void): () => void
  /**
   * Read only when no answer or read is held.
   * @returns settlement of the current or newly started read.
   */
  ensure(): Promise<void>
  /** @returns a token binding a settings write to the current authenticated connection generation. */
  writeFence(): number
  /** @returns whether an asynchronous operation still belongs to the current principal. */
  isCurrent(fence: number): boolean
  /**
   * Accept a unary settlement only when its launch generation remains current.
   * The connection transport has already required and matched Host identity.
   * @param response - authenticated unary response retained for the shared face shape.
   * @param fence - token captured before the operation crossed the wire.
   * @returns whether the settlement may publish client state.
   */
  acceptResponse(response: Pick<RpcResponse<unknown>, 'authentication'>, fence: number): boolean
  /**
   * Fold a successful, Host-redacted write response when its launch generation is current.
   * @param view - successful settings write value.
   * @param fence - token captured before the write crossed the wire.
   * @returns whether the response belonged to the current generation.
   */
  acceptView(
    view: SettingsNamespaceView,
    fence: number,
    authentication: RpcResponse<unknown>['authentication'],
  ): boolean
}

/**
 * Owns the browser's single pending `settings.describe` read. Concurrent
 * invalidations collapse into that read and at most one rerun. Authentication
 * reset clears publication synchronously and fences all older reads and writes.
 */
export class SettingsDescribeMirror implements SettingsDescribeFace {
  private readonly store: SnapshotStore<SettingsMirrorSnapshot> = createSnapshotStore({
    status: 'idle', view: undefined, error: null,
  })
  private inFlight: Promise<void> | undefined
  private rerun = false
  private generation = 0
  private principalGeneration = 0
  private principal: AuthenticationIdentity
  private readonly stopAuthentication: () => void

  /** @param api - settings wire face whose Host enforces authorization and redaction. */
  constructor(
    private readonly api: SettingsFace,
    private readonly authentication: ConnectionAuthenticationSource,
  ) {
    this.principal = authentication.getSnapshot()
    this.stopAuthentication = authentication.subscribe(() => { this.authenticationChanged() })
  }

  /** Release the authentication subscription owned by this mirror. */
  dispose(): void {
    this.stopAuthentication()
  }

  /** @returns the current stable snapshot. */
  getSnapshot(): SettingsMirrorSnapshot {
    return this.store.getSnapshot()
  }

  /**
   * Observe snapshot replacement.
   * @param listener - callback invoked after replacement.
   * @returns the subscription disposer.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Refresh from the Host, collapsing overlap into one pending read and one rerun.
   * @returns settlement after this call's freshness request is covered.
   */
  load(): Promise<void> {
    if (this.principal === undefined) return Promise.resolve()
    if (this.inFlight !== undefined) {
      this.rerun = true
      return this.inFlight
    }
    // Claim the slot before loading publication can synchronously reenter load().
    const run = Promise.resolve().then(() => this.run())
    this.inFlight = run
    return run
  }

  /**
   * Read only when no answer or read is held.
   * @returns settlement of the current or newly started read.
   */
  ensure(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    if (this.getSnapshot().status === 'idle') return this.load()
    return Promise.resolve()
  }

  /**
   * Clear all data authorized for the previous connection generation. A read
   * already crossing the wire is fenced and rerun for the new generation.
   */
  reset(): void {
    this.principalGeneration += 1
    this.generation += 1
    if (this.inFlight !== undefined) this.rerun = true
    this.store.set({ status: 'idle', view: undefined, error: null })
  }

  /** @returns a token binding a settings write to the current authenticated connection generation. */
  writeFence(): number {
    return this.principalGeneration
  }

  /** @returns whether an asynchronous operation still belongs to the current principal. */
  isCurrent(fence: number): boolean {
    return fence === this.principalGeneration && this.principal !== undefined
  }

  /** Accept one Host-authenticated unary settlement for the current principal. */
  acceptResponse(response: Pick<RpcResponse<unknown>, 'authentication'>, fence: number): boolean {
    if (!this.isCurrent(fence)) return false
    if (!this.authentication.validate(response.authentication)) return false
    return this.isCurrent(fence)
  }

  /**
   * Fold a successful Host-redacted write after central transport identity validation.
   * @param view - successful settings write value.
   * @param fence - token captured before the write crossed the wire.
   * @returns whether the response belonged to the current principal.
   */
  acceptView(
    view: SettingsNamespaceView,
    fence: number,
    _authentication: RpcResponse<unknown>['authentication'],
  ): boolean {
    if (!this.isCurrent(fence)) return false
    const before = this.store.getSnapshot()
    this.generation += 1
    if (this.inFlight !== undefined) this.rerun = true
    if (before.view === undefined) return true
    const namespaces = before.view.namespaces.some(row => row.ns === view.ns)
      ? before.view.namespaces.map(row => row.ns === view.ns ? view : row)
      : [...before.view.namespaces, view]
    this.store.set({ ...before, view: { ...before.view, namespaces } })
    return true
  }

  /**
   * Look up one namespace in the held authorized view.
   * @param ns - settings namespace.
   * @returns its Host-redacted view, if currently exposed.
   */
  namespace(ns: string): SettingsNamespaceView | undefined {
    return this.store.getSnapshot().view?.namespaces.find(row => row.ns === ns)
  }

  private async run(): Promise<void> {
    // Slot clearing and the final rerun check share one synchronous segment so
    // an invalidation cannot land in a promise-finally gap and be lost.
    try {
      do {
        if (this.principal === undefined) break
        const before = this.store.getSnapshot()
        if (before.status === 'idle') this.store.set({ ...before, status: 'loading' })
        this.rerun = false
        const generation = ++this.generation
        const principal = this.principalGeneration
        let outcome: { view: SettingsDescribeView } | { failure: string }
        try {
          const response = await this.api.settings.describe({})
          if (!this.acceptResponse(response, principal)) continue
          outcome = response.result.ok
            ? { view: response.result.value }
            : { failure: response.result.error.message }
        } catch (error) {
          outcome = { failure: error instanceof Error ? error.message : String(error) }
        }
        if (generation !== this.generation || this.rerunRequested()) continue
        if ('view' in outcome) {
          this.store.set({ status: 'ready', view: outcome.view, error: null })
        } else {
          const held = this.store.getSnapshot()
          this.store.set({
            status: held.view === undefined ? 'idle' : 'ready',
            view: held.view,
            error: outcome.failure,
          })
        }
      } while (this.rerunRequested())
    } finally {
      this.inFlight = undefined
    }
  }

  /** Re-read invalidation state after an await, where another load may have changed it. */
  private rerunRequested(): boolean {
    return this.rerun
  }

  private authenticationChanged(): void {
    const next = this.authentication.getSnapshot()
    if (sameIdentity(this.principal, next)
      || (this.principal === undefined && next === undefined)) return
    this.principal = next
    this.reset()
    if (next !== undefined) void this.load()
  }
}
