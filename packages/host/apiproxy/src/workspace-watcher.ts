/**
 * Workspace file watch feed: one subscription watches one workspace target
 * (a file or a directory's direct entries) through node:fs watchers and
 * streams coalesced invalidations. A currently missing target is legal — the
 * feed watches its nearest existing ancestor instead, so the target's
 * creation still fires. Each subscription owns exactly one live watcher and
 * closes it on unsubscribe, abort, or failure.
 */

import { watch } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import type { WorkspaceFileWatchFrame } from './api/workspace-files.ts'
import { relativePath, sameFilesystemPath, WorkspaceInspectorError } from './workspace-inspector.ts'

/** Default trailing coalescing window for one subscription's watcher bursts. */
export const DEFAULT_FILE_WATCH_DEBOUNCE_MS = 50
/** Default cap on concurrent watch subscriptions per workspace. */
export const DEFAULT_FILE_WATCH_MAX_PER_WORKSPACE = 64

/** Closeable filesystem watcher handle (the slice of FSWatcher the feed uses). */
export interface WatchHandle {
  close(): void
}

/**
 * fs.watch boundary: opens one watcher on an existing directory or file.
 * Injectable for deterministic tests, like the native opener runner seam.
 */
export type WatchOpener = (
  target: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | null) => void,
) => WatchHandle

/** Tunables of one watch subscription; unset members take the defaults. */
export interface WorkspaceWatchOptions {
  /** Trailing coalescing window in milliseconds for raw watcher bursts. */
  debounceMs?: number
  /** fs.watch boundary; defaults to node:fs watch with a non-persistent handle. */
  open?: WatchOpener
  /** Anchor-resolution lstat boundary; defaults to node:fs/promises lstat. */
  readonly lstat?: typeof lstat
  /** Anchor-resolution realpath boundary; defaults to node:fs/promises realpath. */
  readonly realpath?: typeof realpath
}

/** Watch initialization refusal mapped onto the `workspace-watch-unsupported` wire error. */
export class WorkspaceWatchError extends Error {
  /**
   * @param message - refusal text naming the refused open.
   * @param path - the workspace-relative request path the refusal answers.
   */
  constructor(message: string, readonly path: string) {
    super(message)
    this.name = 'WorkspaceWatchError'
  }
}

/** Current stat of one existing target: the wire version plus the watcher-identity pair. */
interface TargetMetadata {
  /** Opaque freshness token carried on change frames; never parsed by clients. */
  readonly version: string
  /** dev:ino pair distinguishing a replaced entry from an edited one. */
  readonly identity: string
}

/** Anchor of the moment: the watched directory and the `/`-joined path still missing below it. */
interface WatchAnchor {
  readonly dir: string
  /** Empty when the anchor is the target itself. */
  readonly suffix: string
}

/** Production fs.watch boundary; a Buffer filename is treated as unreported. */
const openNodeWatch: WatchOpener = (target, options, listener) =>
  watch(target, { persistent: false, recursive: options.recursive }, (eventType, filename) => {
    /* v8 ignore next -- Node 24 (the coverage-gate runtime) lossily decodes an
       undecodable watcher name into a replacement-character string; only older
       Node 22 inotify delivers a Buffer filename, which never executes here. */
    listener(eventType, typeof filename === 'string' ? filename : null)
  })

/**
 * Stat one target for a change frame.
 * @param target - absolute lexical target under the workspace root.
 * @param signal - subscription cancellation.
 * @returns version and identity, or undefined when no entry exists there.
 */
async function metadataOf(target: string, signal: AbortSignal): Promise<TargetMetadata | undefined> {
  signal.throwIfAborted()
  const info = await stat(target, { bigint: true }).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  })
  if (info === null) return undefined
  return {
    version: `${info.dev}:${info.ino}:${info.mtimeNs}:${info.size}`,
    identity: `${info.dev}:${info.ino}`,
  }
}

/**
 * Conservative relevance filter for events an ancestor watch reports: an
 * exact, ancestor, descendant, or trailing-segment relation to the missing
 * suffix passes, so no platform's filename vocabulary can hide a real
 * invalidation at the cost of an occasional extra frame.
 * @param filename - watcher-reported filename relative to the anchor, or null.
 * @param suffix - `/`-joined missing path below the anchor.
 * @returns whether the event can name the watched target.
 */
function relevantToSuffix(filename: string | null, suffix: string): boolean {
  if (filename === null || filename === '') return true
  const observed = filename.replace(/\\/g, '/')
  return observed === suffix
    || suffix.startsWith(`${observed}/`)
    || observed.startsWith(`${suffix}/`)
    || suffix.endsWith(`/${observed}`)
}

/**
 * Whether one refused open means this platform lacks recursive fs.watch.
 * @param error - the fs.watch open failure.
 */
function isRecursiveRefusal(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'
}

/**
 * Watch one workspace target and yield its invalidation frames.
 * @param root - registered canonical Workspace root.
 * @param path - workspace-relative target; '' or '.' address the root.
 * @param signal - subscription cancellation; abort ends the feed and closes every watcher.
 * @param options - debounce window and injectable fs.watch boundary.
 * @returns `ready` once the watcher is active, then one coalesced `change`
 *   frame per event burst carrying the target's current metadata.
 */
export async function* watchWorkspaceFiles(
  root: string,
  path: string,
  signal: AbortSignal,
  options: WorkspaceWatchOptions = {},
): AsyncGenerator<WorkspaceFileWatchFrame> {
  const feed = new TargetWatch(root, path, options)
  const onAbort = (): void => { feed.close() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await feed.start(signal)
    yield { kind: 'ready' }
    while (await feed.nextChange()) {
      signal.throwIfAborted()
      const metadata = await metadataOf(feed.target, signal)
      yield {
        kind: 'change',
        change: metadata === undefined
          ? { absolutePath: feed.target, absent: true }
          : { absolutePath: feed.target, version: metadata.version },
      }
      await feed.reanchor(metadata, signal)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    feed.close()
  }
}

/** One subscription's watcher state machine: anchor, filter, debounce, reopen. */
class TargetWatch {
  private readonly root: string
  /** The workspace-relative request path, echoed by every error row. */
  private readonly requestPath: string
  /** Absolute lexical target (validated by relativePath at construction). */
  readonly target: string
  private readonly debounceMs: number
  private readonly open: WatchOpener
  /** Anchor-resolution stat boundaries, injectable for cross-platform error-code tests. */
  private readonly lstat: typeof lstat
  private readonly realpath: typeof realpath
  private watcher: WatchHandle | undefined
  private watcherDir: string | undefined
  /** `/`-joined missing path the current watcher filters on ('' = watching the target itself). */
  private watcherSuffix = ''
  /** dev:ino the watcher was opened against, when it watches the target itself. */
  private watcherIdentity: string | undefined
  private watcherAlive = false
  private recursiveSupported = true
  private timer: NodeJS.Timeout | undefined
  private settled = false
  private wake: (() => void) | undefined
  private stopped = false

  constructor(root: string, path: string, options: WorkspaceWatchOptions) {
    this.root = root
    this.requestPath = path
    this.target = relativePath(root, path)
    this.debounceMs = options.debounceMs ?? DEFAULT_FILE_WATCH_DEBOUNCE_MS
    this.open = options.open ?? openNodeWatch
    this.lstat = options.lstat ?? lstat
    this.realpath = options.realpath ?? realpath
  }

  /**
   * Resolve the first anchor and open its watcher.
   * @param signal - subscription cancellation.
   */
  async start(signal: AbortSignal): Promise<void> {
    await this.openWatcher(signal)
  }

  /**
   * Wait for the next coalesced burst.
   * @returns true when a burst settled, false when the feed stopped.
   */
  async nextChange(): Promise<boolean> {
    if (!this.settled && !this.stopped) {
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
    if (this.stopped) return false
    this.settled = false
    return true
  }

  /**
   * Realign the watcher after a reported change: move between target and
   * ancestor as the target appears and disappears, and reopen a direct watch
   * whose inode was replaced (an editor's atomic save). Anything that changed
   * while no watcher was live is re-reported through a fresh burst.
   * @param emitted - the stat the just-yielded frame carried, undefined for absent.
   * @param signal - subscription cancellation.
   */
  async reanchor(emitted: TargetMetadata | undefined, signal: AbortSignal): Promise<void> {
    const anchor = await this.anchorFor(signal)
    const rebound = this.watcherAlive && this.watcherDir === anchor.dir
      // A replaced entry (an editor's atomic save) leaves the old watcher on
      // a stale inode: drop it so the open below re-binds to the new one.
      ? anchor.dir === this.target
        && emitted !== undefined
        && emitted.identity !== this.watcherIdentity
      : true
    if (!rebound) return
    this.closeWatcher()
    await this.openWatcher(signal)
    // Events between the emitted frame and the live watcher are invisible to
    // the new handle; a contradicting stat schedules the missed report.
    const current = await metadataOf(this.target, signal)
    const changed = current === undefined
      ? emitted !== undefined
      : emitted === undefined || current.version !== emitted.version
    if (changed) this.schedule()
  }

  /** Stop the feed: close the watcher, drop a pending burst, wake the consumer. */
  close(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.closeWatcher()
    this.wake?.()
  }

  private readonly onWatchEvent = (eventType: string, filename: string | null): void => {
    if (this.stopped) return
    if (eventType === 'error') {
      // The watcher is finished (its anchor was deleted, for example); the
      // next reanchor reopens on the nearest existing ancestor.
      this.watcherAlive = false
      this.schedule()
      return
    }
    if (this.watcherSuffix !== '' && !relevantToSuffix(filename, this.watcherSuffix)) return
    this.schedule()
  }

  /** Start the trailing debounce window; bursts inside it collapse into one wake. */
  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.settled = true
      this.wake?.()
    }, this.debounceMs)
  }

  private closeWatcher(): void {
    this.watcher?.close()
    this.watcher = undefined
    this.watcherDir = undefined
    this.watcherIdentity = undefined
    this.watcherAlive = false
  }

  /**
   * Resolve the anchor and open its watcher; an anchor that vanishes between
   * resolution and open re-resolves once before the refusal is reported.
   */
  private async openWatcher(signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const anchor = await this.anchorFor(signal)
      /* v8 ignore next -- every entry passes closeWatcher first (reanchor closes
         before reopening and a refused open never leaves watcherAlive set), so a
         live watcher on the very directory being opened is unreachable. */
      if (this.watcherAlive && this.watcherDir === anchor.dir) return
      this.closeWatcher()
      const recursive = anchor.suffix !== '' && this.recursiveSupported
      try {
        this.watcher = this.open(anchor.dir, { recursive }, this.onWatchEvent)
      } catch (error: unknown) {
        if (recursive && isRecursiveRefusal(error)) {
          this.recursiveSupported = false
          continue
        }
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' && attempt === 0) continue
        throw new WorkspaceWatchError(
          `the filesystem refused to watch "${anchor.dir}" (${code ?? 'unknown error'})`,
          this.requestPath,
        )
      }
      this.watcherDir = anchor.dir
      this.watcherSuffix = anchor.suffix
      this.watcherAlive = true
      if (anchor.dir === this.target) {
        this.watcherIdentity = (await metadataOf(this.target, signal))?.identity
      }
      return
    }
  }

  /**
   * Nearest existing ancestor of the target inside the root, refusing
   * symlinked prefixes and an anchor that resolves outside the workspace.
   * @param signal - subscription cancellation.
   */
  private async anchorFor(signal: AbortSignal): Promise<WatchAnchor> {
    let current = this.target
    while (true) {
      signal.throwIfAborted()
      const entry = await this.lstat(current).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return null
        throw new WorkspaceInspectorError(
          'workspace-entry-not-readable',
          `workspace entry ${JSON.stringify(this.requestPath)} cannot be resolved`,
          this.requestPath,
        )
      })
      if (entry !== null) {
        const canonical = await this.realpath(current).catch(() => {
          throw new WorkspaceInspectorError(
            'workspace-entry-not-readable',
            `workspace entry ${JSON.stringify(this.requestPath)} cannot be resolved`,
            this.requestPath,
          )
        })
        if (!sameFilesystemPath(canonical, current)) {
          throw new WorkspaceInspectorError(
            'workspace-path-invalid',
            `workspace path ${JSON.stringify(this.requestPath)} contains a symbolic link`,
            this.requestPath,
          )
        }
        const fromRoot = relative(this.root, canonical)
        /* v8 ignore next 7 -- containment fence over a resolver that answered
           outside the tree: the symlink check above proved the canonical form
           equals the lexical path, which relativePath already confined to the
           root, so a canonical escape cannot reach this throw. */
        if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
          throw new WorkspaceInspectorError(
            'workspace-path-invalid',
            `workspace path ${JSON.stringify(this.requestPath)} escapes the workspace`,
            this.requestPath,
          )
        }
        return {
          dir: current,
          suffix: current === this.target ? '' : relative(current, this.target).split(sep).join('/'),
        }
      }
      if (sameFilesystemPath(current, this.root)) {
        throw new WorkspaceInspectorError(
          'workspace-path-invalid',
          'the registered workspace path no longer resolves to its canonical directory',
          this.requestPath,
        )
      }
      const parent = dirname(current)
      /* v8 ignore next 7 -- lexical confinement guarantees the walk reaches the
         root check above first; only a resolver answering outside the tree
         could get here, and none does. */
      if (parent === current) {
        throw new WorkspaceInspectorError(
          'workspace-path-invalid',
          `workspace path ${JSON.stringify(this.requestPath)} escapes the workspace`,
          this.requestPath,
        )
      }
      current = parent
    }
  }
}
