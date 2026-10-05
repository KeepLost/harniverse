/**
 * Client-side change feed for Workspace file watching: one watch
 * subscription per expanded tree directory, frames folded into debounced
 * relist requests.
 *
 * The feed consumes the runtime workspaces service's `watchFiles`
 * subscription contract (first a `ready` frame, then `change` frames naming
 * the changed absolute path) and owns its lifecycle per directory: a change
 * burst under one directory collapses into one relist request, a lost stream
 * reopens with the connection loop's jittered capped-exponential backoff, and
 * repeated consecutive failures drop the whole Workspace to manual-refresh
 * mode (every watch of that Workspace is torn down and `onMode` reports the
 * transition once). Typed watch refusals (`watch-unsupported`,
 * `not-found`, `outside-workspace`) end only their own directory's watch
 * without retry: the capability is absent or the target is gone, and neither
 * changes by reopening.
 */
import type { WorkspaceId } from '@deepseek-ai/dsh-client-connection/client'
import type { WorkspaceFileWatch, WorkspaceFileWatchFailureCode } from '../contract/workspaces.ts'

export type {
  WorkspaceFileWatch, WorkspaceFileWatchChange, WorkspaceFileWatchFailureCode, WorkspaceFileWatchFrame,
} from '../contract/workspaces.ts'

/**
 * A watch failure the service surface distinguishes by code.
 *
 * The runtime service throws these from the subscription open or its
 * iteration; the feed also accepts any error whose `code` is one of the
 * typed codes.
 */
export class WorkspaceFileWatchError extends Error {
  /**
   * @param code - the typed failure code.
   * @param message - diagnostic text; defaults to a code-derived line.
   */
  constructor(
    readonly code: WorkspaceFileWatchFailureCode,
    message: string = `workspace file watch failed: ${code}`,
  ) {
    super(message)
    this.name = 'WorkspaceFileWatchError'
  }
}

/** Whether a Workspace's directories refresh from watch frames or only manually. */
export type ChangeFeedMode = 'auto' | 'manual'

/** Dependencies and tunables of one {@link ChangeFeed}. */
export interface ChangeFeedOptions {
  /** Opens one directory watch subscription (the service's `watchFiles`). */
  readonly watch: WorkspaceFileWatch
  /**
   * One collapsed relist request for a directory whose watch delivered a
   * change burst.
   * @param workspaceId - Workspace owning the directory.
   * @param path - store-keyed directory path; `''` is the Workspace root.
   */
  readonly onInvalidate: (workspaceId: WorkspaceId, path: string) => void
  /**
   * A Workspace dropped to manual refresh after repeated stream failures;
   * fires once per transition (there is no path back inside one feed).
   * @param workspaceId - the Workspace that dropped.
   * @param mode - always `'manual'`.
   */
  readonly onMode?: (workspaceId: WorkspaceId, mode: ChangeFeedMode) => void
  /** Trailing coalesce window for one directory's change burst, in ms. */
  readonly coalesceMs?: number
  /** Backoff base for the first reconnect, in ms. */
  readonly backoffBaseMs?: number
  /** Backoff growth factor per consecutive stream failure. */
  readonly backoffFactor?: number
  /** Backoff ceiling, in ms. */
  readonly backoffMaxMs?: number
  /** Consecutive stream failures of one directory before the Workspace drops to manual. */
  readonly manualAfterFailures?: number
  /** Jitter source for backoff delays; defaults to `Math.random`. */
  readonly random?: () => number
}

/** One watched directory's subscription state. */
interface DirectoryWatch {
  /** Aborting tears the open subscription down; cleared retries stop with it. */
  readonly controller: AbortController
  /** Trailing relist timer of a change burst. */
  relistTimer: ReturnType<typeof setTimeout> | undefined
  /** Reconnect timer after a stream failure. */
  retryTimer: ReturnType<typeof setTimeout> | undefined
  /** Consecutive stream failures without an intervening `ready` frame. */
  failures: number
  /** Set when this watch has ended; late callbacks and retries no-op. */
  ended: boolean
}

/** Watch key of one Workspace and directory path. */
function watchKey(workspaceId: WorkspaceId, path: string): string {
  return JSON.stringify([workspaceId as string, path])
}

/**
 * Read a typed failure code off any error shape.
 * @param error - the thrown stream failure.
 * @returns the typed code, or undefined for an unclassified (transport) failure.
 */
function failureCodeOf(error: unknown): WorkspaceFileWatchFailureCode | undefined {
  if (error instanceof WorkspaceFileWatchError) return error.code
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error
    if (code === 'watch-unsupported' || code === 'not-found' || code === 'outside-workspace') {
      return code
    }
  }
  return undefined
}

/**
 * Owns one watch subscription per expanded tree directory.
 *
 * Call `sync` (or `watchDir`/`unwatchDir`) as directories expand and
 * collapse; `dispose` when the owning surface goes away. Every subscription
 * runs on its own `AbortSignal`, so disposal is immediate and provable.
 */
export class ChangeFeed {
  private readonly watch: WorkspaceFileWatch
  private readonly onInvalidate: ChangeFeedOptions['onInvalidate']
  private readonly onMode: ChangeFeedOptions['onMode']
  private readonly coalesceMs: number
  private readonly backoffBaseMs: number
  private readonly backoffFactor: number
  private readonly backoffMaxMs: number
  private readonly manualAfterFailures: number
  private readonly random: () => number
  /** Live and backing-off watches, by watch key. */
  private readonly watches = new Map<string, { workspaceId: WorkspaceId; path: string; state: DirectoryWatch }>()
  /** Mode per Workspace; absent means still `'auto'`. */
  private readonly modes = new Map<WorkspaceId, ChangeFeedMode>()

  /**
   * @param options - subscription factory, callbacks, and tunables.
   */
  constructor(options: ChangeFeedOptions) {
    this.watch = options.watch
    this.onInvalidate = options.onInvalidate
    this.onMode = options.onMode
    this.coalesceMs = options.coalesceMs ?? 300
    this.backoffBaseMs = options.backoffBaseMs ?? 500
    this.backoffFactor = options.backoffFactor ?? 2
    this.backoffMaxMs = options.backoffMaxMs ?? 10_000
    this.manualAfterFailures = options.manualAfterFailures ?? 5
    this.random = options.random ?? Math.random
  }

  /**
   * Start (or keep) the watch of one directory. A no-op for a directory
   * already watched and for a Workspace in manual mode.
   * @param workspaceId - Workspace owning the directory.
   * @param path - store-keyed directory path; `''` is the Workspace root.
   */
  watchDir(workspaceId: WorkspaceId, path: string): void {
    if (this.modes.get(workspaceId) === 'manual') return
    const key = watchKey(workspaceId, path)
    if (this.watches.has(key)) return
    const state: DirectoryWatch = {
      controller: new AbortController(), relistTimer: undefined, retryTimer: undefined, failures: 0, ended: false,
    }
    this.watches.set(key, { workspaceId, path, state })
    void this.iterate(workspaceId, path, state)
  }

  /**
   * Stop the watch of one directory; aborting its signal tears the
   * subscription down. A no-op for an unknown directory.
   * @param workspaceId - Workspace owning the directory.
   * @param path - store-keyed directory path; `''` is the Workspace root.
   */
  unwatchDir(workspaceId: WorkspaceId, path: string): void {
    this.stopWatch(watchKey(workspaceId, path))
  }

  /**
   * Reconcile one Workspace's watches to exactly these directories: new
   * entries start, missing entries stop.
   * @param workspaceId - Workspace owning the directories.
   * @param paths - store-keyed directory paths to watch (`''` is the root).
   */
  sync(workspaceId: WorkspaceId, paths: readonly string[]): void {
    const wanted = new Set(paths.map(path => watchKey(workspaceId, path)))
    for (const [key, entry] of [...this.watches]) {
      if (entry.workspaceId === workspaceId && !wanted.has(key)) this.stopWatch(key)
    }
    for (const path of paths) this.watchDir(workspaceId, path)
  }

  /**
   * The refresh mode of one Workspace.
   * @param workspaceId - Workspace to read.
   * @returns `'manual'` after the drop transition, otherwise `'auto'`.
   */
  modeOf(workspaceId: WorkspaceId): ChangeFeedMode {
    return this.modes.get(workspaceId) ?? 'auto'
  }

  /**
   * Tear every subscription and pending relist down: each open signal
   * aborts, so the service's iteration ends immediately.
   */
  dispose(): void {
    for (const key of [...this.watches.keys()]) this.stopWatch(key)
    this.modes.clear()
  }

  /** Run one subscription generation to its end, classifying the outcome. */
  private async iterate(workspaceId: WorkspaceId, path: string, state: DirectoryWatch): Promise<void> {
    try {
      const frames = this.watch(workspaceId, path === '' ? undefined : path, state.controller.signal)
      for await (const frame of frames) {
        if (state.ended || state.controller.signal.aborted) return
        switch (frame.kind) {
          case 'ready':
            // No relist on acknowledgement; a delivering generation resets
            // the reconnect account (official accept() semantics).
            state.failures = 0
            break
          case 'change':
            this.scheduleRelist(workspaceId, path, state)
            break
          default:
            assertNever(frame)
        }
      }
      if (state.ended || state.controller.signal.aborted) return
      // A clean end means the Host closed the subscription: reopen it on the
      // failure path (the official supervised stream treats normal end as an
      // error to force a reopen).
      this.onStreamFailure(workspaceId, path, state, undefined)
    } catch (error) {
      if (state.ended || state.controller.signal.aborted) return
      this.onStreamFailure(workspaceId, path, state, error)
    }
  }

  /** Schedule the trailing relist of one directory, collapsing the burst. */
  private scheduleRelist(workspaceId: WorkspaceId, path: string, state: DirectoryWatch): void {
    if (state.relistTimer !== undefined) return
    state.relistTimer = setTimeout(() => {
      state.relistTimer = undefined
      if (state.ended) return
      this.onInvalidate(workspaceId, path)
    }, this.coalesceMs)
  }

  /** Classify one stream failure: typed refusal, reconnect, or manual drop. */
  private onStreamFailure(
    workspaceId: WorkspaceId,
    path: string,
    state: DirectoryWatch,
    error: unknown,
  ): void {
    const code = failureCodeOf(error)
    if (code !== undefined) {
      // The capability is absent or the target is gone; reopening changes
      // nothing, so this directory's watch ends quietly.
      this.stopWatch(watchKey(workspaceId, path))
      return
    }
    state.failures += 1
    if (state.failures >= this.manualAfterFailures) {
      this.dropToManual(workspaceId)
      return
    }
    const attempt = state.failures
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      if (!state.ended && !state.controller.signal.aborted) void this.iterate(workspaceId, path, state)
    }, this.backoffDelay(attempt))
  }

  /** The connection loop's backoff: capped exponential cap, jittered across its upper half. */
  private backoffDelay(attempt: number): number {
    const cap = Math.min(this.backoffMaxMs, this.backoffBaseMs * this.backoffFactor ** Math.max(0, attempt - 1))
    return cap / 2 + this.random() * (cap / 2)
  }

  /** End one watch: cancel its timers, abort its signal, forget it. */
  private stopWatch(key: string): void {
    const entry = this.watches.get(key)
    if (entry === undefined) return
    this.watches.delete(key)
    entry.state.ended = true
    if (entry.state.relistTimer !== undefined) clearTimeout(entry.state.relistTimer)
    if (entry.state.retryTimer !== undefined) clearTimeout(entry.state.retryTimer)
    entry.state.controller.abort()
  }

  /** Tear down a Workspace's watches and report the one-way manual transition. */
  private dropToManual(workspaceId: WorkspaceId): void {
    if (this.modes.get(workspaceId) === 'manual') return
    this.modes.set(workspaceId, 'manual')
    for (const [key, entry] of [...this.watches]) {
      if (entry.workspaceId === workspaceId) this.stopWatch(key)
    }
    this.onMode?.(workspaceId, 'manual')
  }
}

/** Closed frame union guard. */
function assertNever(frame: never): never {
  throw new Error(`Unexpected workspace file watch frame: ${JSON.stringify(frame)}`)
}
