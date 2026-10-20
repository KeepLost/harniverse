/** Cross-tab arbitration: hello handshake, intent deferral with nonce tie-break, malformed inbound, disposal. */

import { describe, expect, it, vi } from 'vitest'
import { CrossTabDedupe } from '../src/client/cross-tab.ts'

/** One channel double capturing posts; inbound messages replay through receive. */
class FakeChannel {
  readonly posted: unknown[] = []
  closed = false
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage(message: unknown): void { this.posted.push(message) }
  close(): void { this.closed = true }
  receive(message: unknown): void { this.onmessage?.({ data: message }) }
}

/** Manual timer bank. */
/** Manual timer bank face. */
interface Bank {
  timers: Array<{ fn: () => void }>
  schedule: (fn: () => void, ms: number) => unknown
  cancel: (timer: unknown) => void
  flush: () => void
}

function bank(): Bank {
  const timers: Array<{ fn: () => void }> = []
  return {
    timers,
    schedule: (fn) => { const entry = { fn }; timers.push(entry); return entry },
    cancel: (timer) => {
      const index = timers.indexOf(timer as { fn: () => void })
      if (index >= 0) timers.splice(index, 1)
    },
    flush: () => { for (const entry of timers.splice(0)) entry.fn() },
  }
}

/** Build one participant over a fresh channel and timer bank. */
function bench(withChannel = true) {
  const channel: FakeChannel | undefined = withChannel ? new FakeChannel() : undefined
  const timers = bank()
  const dedupe = new CrossTabDedupe(channel ?? undefined, timers.schedule, timers.cancel)
  return { dedupe, channel: channel as FakeChannel, timers }
}

describe('CrossTabDedupe', () => {
  it('plays immediately without a channel', () => {
    const play = vi.fn()
    const { dedupe } = bench(false)
    dedupe.declare('k', play)
    expect(play).toHaveBeenCalledTimes(1)
    dedupe.dispose()
  })

  it('plays immediately while no peer answered the hello', () => {
    const play = vi.fn()
    const { dedupe, channel, timers } = bench()
    dedupe.declare('k', play)
    expect(play).toHaveBeenCalledTimes(1)
    expect(timers.timers).toHaveLength(0)
    expect(channel.posted).toEqual([{ t: 'hello' }, { t: 'intent', key: 'k', nonce: 0 }])
    dedupe.dispose()
  })

  it('answers a peer hello and defers intents once a peer is seen', () => {
    const play = vi.fn()
    const { dedupe, channel, timers } = bench()
    channel.receive({ t: 'hello' })
    expect(channel.posted).toContainEqual({ t: 'hello-ack' })
    dedupe.declare('k', play)
    expect(play).not.toHaveBeenCalled()
    timers.flush()
    expect(play).toHaveBeenCalledTimes(1)
    dedupe.dispose()
  })

  it('keeps playing when the peer nonce is larger than its own', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const play = vi.fn()
      const { dedupe, channel, timers } = bench()
      channel.receive({ t: 'hello-ack' })
      dedupe.declare('k', play)
      channel.receive({ t: 'intent', key: 'k', nonce: 0.9 })
      timers.flush()
      expect(play).toHaveBeenCalledTimes(1)
      dedupe.dispose()
    } finally {
      random.mockRestore()
    }
  })

  it('defers to the peer when its own nonce is the larger one', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const play = vi.fn()
      const { dedupe, channel, timers } = bench()
      channel.receive({ t: 'hello-ack' })
      dedupe.declare('k', play)
      channel.receive({ t: 'intent', key: 'k', nonce: 0.1 })
      expect(timers.timers).toHaveLength(0)
      timers.flush()
      expect(play).not.toHaveBeenCalled()
      dedupe.dispose()
    } finally {
      random.mockRestore()
    }
  })

  it('ignores malformed inbound messages', () => {
    const play = vi.fn()
    const { dedupe, channel, timers } = bench()
    channel.receive(null)
    channel.receive(42)
    channel.receive({ t: 'intent' })
    dedupe.declare('k', play)
    expect(play).toHaveBeenCalledTimes(1)
    timers.flush()
    dedupe.dispose()
  })

  it('cancels deferred intents and closes the channel on dispose', () => {
    const play = vi.fn()
    const { dedupe, channel, timers } = bench()
    channel.receive({ t: 'hello-ack' })
    dedupe.declare('k', play)
    dedupe.dispose()
    timers.flush()
    expect(play).not.toHaveBeenCalled()
    expect(channel.closed).toBe(true)
  })

  it('uses the real timers when none are injected', () => {
    vi.useFakeTimers()
    try {
      const channel = new FakeChannel()
      const dedupe = new CrossTabDedupe(channel)
      channel.receive({ t: 'hello-ack' })
      const play = vi.fn()
      dedupe.declare('k', play)
      expect(play).not.toHaveBeenCalled()
      vi.advanceTimersByTime(40)
      expect(play).toHaveBeenCalledTimes(1)
      dedupe.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a deferred intent through the default timer cancel on dispose', () => {
    vi.useFakeTimers()
    try {
      const channel = new FakeChannel()
      const dedupe = new CrossTabDedupe(channel)
      channel.receive({ t: 'hello-ack' })
      const play = vi.fn()
      dedupe.declare('k', play)
      dedupe.dispose()
      vi.advanceTimersByTime(40)
      expect(play).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows posts to a channel that already closed', () => {
    const breaking = new FakeChannel()
    breaking.postMessage = (): void => { throw new Error('closed') }
    const timers = bank()
    const dedupe = new CrossTabDedupe(breaking, timers.schedule, timers.cancel)
    expect(() => { dedupe.declare('k', () => {}) }).not.toThrow()
    dedupe.dispose()
  })
})
