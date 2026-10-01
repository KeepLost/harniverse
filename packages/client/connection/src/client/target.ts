/** Routing for the current machine without changing the browser document. */

const TARGET_PARAMETER = 'dshRemoteHost'
const LOCAL_NAMESPACES = new Set(['remoteHosts', 'settings', 'credentials'])

/** Host management remains on the page authority even when a remote is selected.
 * @param endpoint - Typert `namespace/method` or legacy `namespace.method` name.
 * @returns whether the endpoint belongs to the page-authority namespaces.
 */
export function isHostManagement(endpoint: string): boolean {
  return LOCAL_NAMESPACES.has(endpoint.replace(/[/.].*$/u, ''))
}

/** A remote id is opaque to the client; the host proxy validates its UUID. */
export type MachineTarget = { readonly kind: 'host' } | { readonly kind: 'remote'; readonly id: string }

/** Stable observable used by the runtime and sidebar to follow machine changes. */
export interface MachineTargetSource {
  getSnapshot(): MachineTarget
  subscribe(listener: () => void): () => void
}

/** The authority captured by one operation; retirement aborts all its carriers. */
export class TargetGeneration {
  /** Aborted when this generation retires; never re-armed. */
  readonly controller = new AbortController()
  /** Path rewriting bound to this generation's target. */
  readonly resolvePath: TransportPathResolver
  private readonly retiredError = new Error('connection: machine target changed')

  constructor(readonly target: MachineTarget) {
    this.resolvePath = createTargetPathResolver(target)
  }

  /** Combine caller cancellation with this generation's retirement.
   * @param caller - optional caller cancellation combined with retirement.
   * @returns the combined signal.
   */
  signal(caller?: AbortSignal | null): AbortSignal {
    return caller == null ? this.controller.signal : AbortSignal.any([caller, this.controller.signal])
  }

  /** Abort every carrier of this generation. */
  retire(): void {
    this.controller.abort(this.retiredError)
  }

  /** Reject promptly on retirement, including carriers which ignore cancellation.
   * @param operation - the carrier operation to bound.
   * @returns the operation's result, or rejection when this generation retires first.
   */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const signal = this.controller.signal
    if (signal.aborted) return Promise.reject(this.retiredError)
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => { reject(this.retiredError) }
      signal.addEventListener('abort', abort, { once: true })
      void operation().then(
        (value) => {
          signal.removeEventListener('abort', abort)
          if (signal.aborted) abort()
          else resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }
}

/** Path rewriting hook shared by HTTP, RPC, upload, and WebSocket carriers. */
export type TransportPathResolver = (path: string) => string

/** Resolve a path for one captured machine generation.
 * @param target - the machine whose carrier parameter is applied.
 * @returns the resolver this generation's carriers rewrite paths through.
 */
export function createTargetPathResolver(target: MachineTarget): TransportPathResolver {
  if (target.kind === 'host') return path => path
  return (path) => {
    const url = new URL(path, 'http://dsh.internal')
    // Typert endpoints use `namespace/method`; legacy RPC methods use `namespace.method`.
    const namespace = url.pathname.split('/')[2]?.split('.')[0]
    if (!url.pathname.startsWith('/api/') || (namespace !== undefined && LOCAL_NAMESPACES.has(namespace))) return path
    url.searchParams.set(TARGET_PARAMETER, target.id)
    return `${url.pathname}${url.search}`
  }
}
