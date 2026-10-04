import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import {
  ChangeFeed, WorkspaceFileWatchError,
  type ChangeFeedMode, type WorkspaceFileWatch, type WorkspaceFileWatchFrame,
} from '../src/client/workspaces/change-feed.ts'

const wid = (id: string): WorkspaceId => id as WorkspaceId

/** One programmable watch generation: the test pushes frames, ends, or fails it. */
class FakeChannel {
  /** Increments when the consumer stops iterating (teardown proof). */
  iterationsEnded = 0
  private readonly queue: WorkspaceFileWatchFrame[] = []
  private failure: unknown
  private done = false
  private wake: (() => void) | undefined

  /**
   * @param signal - the subscription lifetime; abort wakes and ends the stream.
   */
  constructor(signal: AbortSignal) {
    signal.addEventListener('abort', () => {
      this.done = true
      this.wake?.()
    }, { once: true })
  }

  /** Deliver one frame to the consumer. */
  emit(frame: WorkspaceFileWatchFrame): void {
    this.queue.push(frame)
    this.wake?.()
  }

  /** Fail the stream with `error` (transport-loss material). */
  fail(error: unknown): void {
    this.failure = error
    this.done = true
    this.wake?.()
  }

  /** End the stream cleanly (Host-closed material). */
  end(): void {
    this.done = true
    this.wake?.()
  }

  /** The generation's frame stream. */
  async *frames(): AsyncGenerator<WorkspaceFileWatchFrame> {
    try {
      while (true) {
        const next = this.queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (this.done) {
          if (this.failure !== undefined) throw this.failure
          return
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      this.iterationsEnded++
    }
  }
}

/** Records every watch open and hands back a scriptable channel per call. */
class FakeWatch {
  readonly calls: { workspaceId: string; path: string | undefined; signal: AbortSignal }[] = []
  readonly channels: FakeChannel[] = []
  /** When set, opening a watch throws it instead of returning a channel. */
  refuseWith: unknown
  /** When set, every opened channel fails with it on its first pull. */
  autoFail: unknown

  /** The watch subscription factory the feed consumes. */
  readonly watch: WorkspaceFileWatch = (workspaceId, path, signal) => {
    this.calls.push({ workspaceId, path, signal })
    if (this.refuseWith !== undefined) throw this.refuseWith
    const channel = new FakeChannel(signal)
    if (this.autoFail !== undefined) channel.fail(this.autoFail)
    this.channels.push(channel)
    return channel.frames()
  }
}

const invalidations: string[] = []

interface FeedTunables {
  coalesceMs?: number
  backoffBaseMs?: number
  backoffFactor?: number
  manualAfterFailures?: number
  onMode?: (workspaceId: WorkspaceId, mode: ChangeFeedMode) => void
}

/** Build a feed over `fake` with fast coalescing and jitter pinned to 0.5. */
function makeFeed(fake: FakeWatch, over: FeedTunables = {}): ChangeFeed {
  return new ChangeFeed({
    watch: fake.watch,
    onInvalidate: (workspaceId, path) => { invalidations.push(`${workspaceId}:${path}`) },
    coalesceMs: over.coalesceMs ?? 100,
    backoffBaseMs: over.backoffBaseMs ?? 500,
    backoffFactor: over.backoffFactor ?? 2,
    manualAfterFailures: over.manualAfterFailures ?? 3,
    random: () => 0.5,
    ...(over.onMode === undefined ? {} : { onMode: over.onMode }),
  })
}

/** Drain pending microtasks (async-generator chains take several ticks). */
async function flush(): Promise<void> {
  for (let round = 0; round < 12; round++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  invalidations.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ChangeFeed', () => {
  it('does nothing on ready and collapses a change burst into one relist', async () => {
    const fake = new FakeWatch()
    const feed = makeFeed(fake)
    feed.watchDir(wid('w'), '')
    await flush()
    expect(fake.calls).toEqual([{ workspaceId: 'w', path: undefined, signal: fake.calls[0]?.signal }])
    expect(fake.calls[0]?.signal).toBeInstanceOf(AbortSignal)

    fake.channels[0]?.emit({ kind: 'ready' })
    await flush()
    expect(invalidations).toEqual([])

    fake.channels[0]?.emit({ kind: 'change', change: { absolutePath: '/w/a.ts', version: '1' } })
    fake.channels[0]?.emit({ kind: 'change', change: { absolutePath: '/w/b.ts', version: '2' } })
    fake.channels[0]?.emit({ kind: 'change', change: { absolutePath: '/w/c.ts', absent: true } })
    await vi.advanceTimersByTimeAsync(50)
    expect(invalidations).toEqual([])
    await vi.advanceTimersByTimeAsync(60)
    expect(invalidations).toEqual(['w:'])
    feed.dispose()
  })

  it('relists each watched directory independently and maps the root key to undefined', async () => {
    const fake = new FakeWatch()
    const feed = makeFeed(fake)
    feed.sync(wid('w'), ['', 'src'])
    await flush()
    expect(fake.calls.map(call => call.path)).toEqual([undefined, 'src'])
    fake.channels[1]?.emit({ kind: 'change', change: { absolutePath: '/w/src/x.ts', version: '1' } })
    await vi.advanceTimersByTimeAsync(120)
    expect(invalidations).toEqual(['w:src'])
    feed.dispose()
  })

  it('sync stops exactly the directories that collapsed', async () => {
    const fake = new FakeWatch()
    const feed = makeFeed(fake)
    feed.sync(wid('w'), ['', 'src', 'docs'])
    await flush()
    feed.sync(wid('w'), ['', 'docs'])
    await flush()
    expect(fake.calls[1]?.signal.aborted).toBe(true)
    expect(fake.channels[1]?.iterationsEnded).toBe(1)
    expect(fake.calls[0]?.signal.aborted).toBe(false)
    expect(fake.calls[2]?.signal.aborted).toBe(false)
    feed.dispose()
  })

  it('aborting the disposal signal tears every subscription down', async () => {
    const fake = new FakeWatch()
    const feed = makeFeed(fake)
    feed.watchDir(wid('w'), '')
    feed.watchDir(wid('w'), 'src')
    feed.watchDir(wid('other'), '')
    await flush()
    feed.dispose()
    await flush()
    expect(fake.calls.map(call => call.signal.aborted)).toEqual([true, true, true])
    expect(fake.channels.map(channel => channel.iterationsEnded)).toEqual([1, 1, 1])
    expect(feed.modeOf(wid('w'))).toBe('auto')
  })

  it('reconnects a failed stream with exponential backoff and resets the account on ready', async () => {
    const fake = new FakeWatch()
    const feed = makeFeed(fake)
    feed.watchDir(wid('w'), 'src')
    await flush()

    fake.channels[0]?.fail(new Error('transport down'))
    await flush()
    expect(fake.calls).toHaveLength(1)
    // Jitter 0.5 → delay 0.75 × cap: first retry after 375ms.
    await vi.advanceTimersByTimeAsync(374)
    expect(fake.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(fake.calls).toHaveLength(2)

    fake.channels[1]?.fail(new Error('transport down again'))
    await flush()
    await vi.advanceTimersByTimeAsync(749)
    expect(fake.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2)
    expect(fake.calls).toHaveLength(3)

    // A delivering generation resets the account: the next backoff is the base again.
    fake.channels[2]?.emit({ kind: 'ready' })
    fake.channels[2]?.emit({ kind: 'change', change: { absolutePath: '/w/src/x.ts', version: '9' } })
    await vi.advanceTimersByTimeAsync(120)
    expect(invalidations).toEqual(['w:src'])
    fake.channels[2]?.fail(new Error('transport down'))
    await flush()
    await vi.advanceTimersByTimeAsync(374)
    expect(fake.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(2)
    expect(fake.calls).toHaveLength(4)
    expect(feed.modeOf(wid('w'))).toBe('auto')
    feed.dispose()
  })

  it('caps the backoff delay at the configured ceiling', async () => {
    const fake = new FakeWatch()
    const feed = makeFeed(fake, { backoffBaseMs: 500, backoffFactor: 4, manualAfterFailures: 6 })
    feed.watchDir(wid('w'), 'src')
    await flush()
    // Failure delays with jitter 0.5: 375, 1500, 6000, then 7500 (10s cap, not 32s).
    for (const delay of [375, 1500, 6000]) {
      fake.channels.at(-1)?.fail(new Error('down'))
      await flush()
      await vi.advanceTimersByTimeAsync(delay)
      await flush()
    }
    expect(fake.calls).toHaveLength(4)
    fake.channels.at(-1)?.fail(new Error('down'))
    await flush()
    await vi.advanceTimersByTimeAsync(7499)
    expect(fake.calls).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(2)
    expect(fake.calls).toHaveLength(5)
    expect(feed.modeOf(wid('w'))).toBe('auto')
    feed.dispose()
  })

  it('treats a clean stream end as a failure that reopens the subscription', async () => {
    const fake = new FakeWatch()
    const feed = makeFeed(fake)
    feed.watchDir(wid('w'), 'src')
    await flush()
    fake.channels[0]?.emit({ kind: 'ready' })
    fake.channels[0]?.end()
    await flush()
    await vi.advanceTimersByTimeAsync(600)
    expect(fake.calls).toHaveLength(2)
    expect(feed.modeOf(wid('w'))).toBe('auto')
    feed.dispose()
  })

  it('drops the workspace to manual refresh after consecutive failures and stops every watch', async () => {
    const fake = new FakeWatch()
    const onMode = vi.fn()
    const feed = makeFeed(fake, { manualAfterFailures: 3, onMode })
    feed.sync(wid('w'), ['', 'src'])
    await flush()
    fake.autoFail = new Error('down')
    fake.channels[0]?.fail(new Error('down'))
    fake.channels[1]?.fail(new Error('down'))
    await flush()
    // Failure rounds open one generation per directory until the third
    // consecutive failure of the first directory to get there trips the
    // workspace-wide drop, which also cancels the sibling's pending retry.
    await vi.advanceTimersByTimeAsync(375)
    await flush()
    expect(fake.calls).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(750)
    await flush()
    expect(fake.calls).toHaveLength(5)
    expect(onMode).toHaveBeenCalledExactlyOnceWith(wid('w'), 'manual')
    expect(feed.modeOf(wid('w'))).toBe('manual')
    expect(fake.calls.every(call => call.signal.aborted)).toBe(true)
    const callsAtDrop = fake.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.calls).toHaveLength(callsAtDrop)
    feed.dispose()
  })

  it('ignores new watches for a workspace in manual mode', async () => {
    const fake = new FakeWatch()
    const feed = makeFeed(fake, { manualAfterFailures: 1 })
    feed.watchDir(wid('w'), 'src')
    await flush()
    fake.channels[0]?.fail(new Error('down'))
    await flush()
    expect(feed.modeOf(wid('w'))).toBe('manual')
    feed.watchDir(wid('w'), 'docs')
    feed.sync(wid('w'), ['', 'docs'])
    await flush()
    expect(fake.calls).toHaveLength(1)
    // Another workspace still watches.
    feed.watchDir(wid('other'), '')
    await flush()
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]?.workspaceId).toBe('other')
    feed.dispose()
  })

  it('ends a typed watch refusal quietly without retry or manual mode', async () => {
    const fake = new FakeWatch()
    const onMode = vi.fn()
    const feed = makeFeed(fake, { onMode })
    fake.refuseWith = new WorkspaceFileWatchError('watch-unsupported')
    feed.watchDir(wid('w'), '')
    await flush()
    expect(feed.modeOf(wid('w'))).toBe('auto')
    expect(onMode).not.toHaveBeenCalled()
    // The refusal is terminal: nothing reopens over time.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.calls).toHaveLength(1)
    feed.dispose()
  })

  it('ends only the refused directory on not-found and outside-workspace', async () => {
    const fake = new FakeWatch()
    const feed = makeFeed(fake)
    feed.watchDir(wid('w'), '')
    await flush()
    // A fresh watch of a typed-refused target ends itself and leaves the
    // Workspace's other watches untouched.
    fake.refuseWith = Object.assign(new Error('nope'), { code: 'not-found' as const })
    feed.watchDir(wid('w'), 'gone')
    await flush()
    fake.refuseWith = Object.assign(new Error('outside'), { code: 'outside-workspace' as const })
    feed.watchDir(wid('w'), 'beyond')
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.calls.map(call => call.path)).toEqual([undefined, 'gone', 'beyond'])
    expect(feed.modeOf(wid('w'))).toBe('auto')
    expect(fake.calls[0]?.signal.aborted).toBe(false)
    expect(fake.calls[1]?.signal.aborted).toBe(true)
    expect(fake.calls[2]?.signal.aborted).toBe(true)
    feed.dispose()
  })
})
