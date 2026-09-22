/**
 * A collapsing frame queue for one browser stream generation.
 *
 * The terminal's follower queue is byte-bounded and fails a slow consumer,
 * because terminal output is an ordered byte stream whose gaps cannot be
 * reconstructed. Screencast frames are the opposite: each image is a complete
 * picture of the page, and each `state` frame a complete metadata snapshot, so
 * the only correct behaviour for a slow consumer is to drop what it never saw
 * and hand it the newest value. This queue therefore holds at most one pending
 * image and one pending state frame, which makes it bounded by construction and
 * removes slow-follower failure from the contract entirely.
 */
import type { BrowserFrame } from './types.ts'

/** Latest-wins frame queue for one attachment. */
export class BrowserFollower {
  private queue: BrowserFrame[] = []
  private wake: (() => void) | undefined
  private closed = false
  private finished = false

  /**
   * Queue a frame, collapsing it onto the pending frame of the same kind.
   * @param frame - newest frame for this follower.
   */
  push(frame: BrowserFrame): void {
    if (this.closed || this.finished) return
    if (frame.type !== 'snapshot') {
      const index = this.queue.findIndex(pending => pending.type === frame.type)
      if (index >= 0) {
        this.queue[index] = frame
        this.wake?.()
        return
      }
    }
    this.queue.push(frame)
    this.wake?.()
  }

  /** Finish after delivering every queued frame, including the final state. */
  finish(): void {
    this.finished = true
    this.wake?.()
  }

  /** Stop this follower without closing its page. */
  close(): void {
    this.closed = true
    this.queue = []
    this.wake?.()
  }

  /**
   * Drain until detached.
   * @param signal - Remote generation cancellation.
   * @returns the follower's frames, newest value per kind.
   */
  async *read(signal: AbortSignal): AsyncIterable<BrowserFrame> {
    const abort = (): void => { this.close() }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      while (!this.closed) {
        const next = this.queue.shift()
        if (next !== undefined) {
          yield next
        } else {
          if (this.finished) break
          await new Promise<void>((resolve) => { this.wake = resolve })
          this.wake = undefined
        }
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.close()
    }
  }
}
