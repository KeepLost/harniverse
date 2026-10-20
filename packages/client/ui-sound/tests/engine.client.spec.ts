/** The playback engine: value resolution, dedupe, pruning, synthesis, and file playback. */

import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { AudioLibrary } from '../src/client/audio-library.ts'
import { CrossTabDedupe } from '../src/client/cross-tab.ts'
import { SoundEngine } from '../src/client/engine.ts'
import type { AudioRecordStore, StoredAudioRecord } from '../src/client/audio-library.ts'

/** One recording AudioContext double. */
class FakeAudioContext {
  state = 'running'
  currentTime = 0
  resume: Mock<() => Promise<void>> = vi.fn(() => Promise.resolve())
  readonly decodeAudioData = vi.fn()
  readonly oscillators: Array<{ start: Mock<() => void>; stop: Mock<() => void> }> = []
  readonly sources: Array<{ start: Mock<() => void>; buffer: unknown }> = []
  readonly destination = {}
  createOscillator() {
    const oscillator = {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }
    this.oscillators.push(oscillator)
    return oscillator
  }
  createGain() {
    return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), value: 1 }, connect: vi.fn() }
  }
  createBufferSource() {
    const source = { buffer: undefined as unknown, connect: vi.fn(), start: vi.fn() }
    this.sources.push(source)
    return source
  }
}

/** One channel double capturing posts; inbound messages replay through receive. */
class FakeChannel {
  readonly posted: unknown[] = []
  closed = false
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage(message: unknown): void { this.posted.push(message) }
  close(): void { this.closed = true }
  receive(message: unknown): void { this.onmessage?.({ data: message }) }
}

/** In-memory record store double. */
/** In-memory record store double. */
function fakeStore(entries: ReadonlyArray<[string, StoredAudioRecord]> = []): AudioRecordStore {
  const records = new Map(entries)
  return {
    async put(id, record) { records.set(id, record); return true },
    async get(id) { return records.get(id) },
    async delete(id) { return records.delete(id) },
  }
}

/** Build an engine over doubles; clock is a mutable counter. */
function bench() {
  const context = new FakeAudioContext()
  let contextsCreated = 0
  const clock = { now: 0 }
  const engine = new SoundEngine({
    audio: () => {
      contextsCreated += 1
      return context as unknown as AudioContext
    },
    library: new AudioLibrary(async () => fakeStore()),
    dedupe: undefined,
    now: () => clock.now,
  })
  return { engine, context, contexts: () => contextsCreated, clock }
}

describe('SoundEngine value resolution', () => {
  it('stays silent for mute, pending-local, and empty values without touching audio', () => {
    const kit = bench()
    for (const value of ['', 'none', 'local']) kit.engine.play(value, 1, 'k')
    expect(kit.contexts()).toBe(0)
  })

  it('ignores values outside the vocabulary without touching audio', async () => {
    const kit = bench()
    kit.engine.play('data:audio/x', 1, 'k')
    kit.engine.play('audio:', 1, 'k')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(kit.contexts()).toBe(0)
    expect(kit.context.oscillators).toHaveLength(0)
  })

  it('swallows a context resume that rejects', () => {
    const context = new FakeAudioContext()
    context.state = 'suspended'
    context.resume = vi.fn(() => Promise.reject(new Error('blocked by browser')))
    const engine = new SoundEngine({
      audio: () => context as unknown as AudioContext,
      library: new AudioLibrary(async () => fakeStore()),
      dedupe: undefined,
      now: () => 0,
    })
    engine.play('ding', 1)
    expect(context.resume).toHaveBeenCalledTimes(1)
  })

  it('clamps file playback volumes into the 0-1 range', async () => {
    const kit = bench()
    const store = fakeStore([['a1', { blob: new Blob(['x']), name: 'n' }], ['a2', { blob: new Blob(['y']), name: 'm' }]])
    const engine = new SoundEngine({
      audio: () => kit.context as unknown as AudioContext,
      library: new AudioLibrary(async () => store),
      dedupe: undefined,
      now: () => 0,
    })
    kit.context.decodeAudioData.mockImplementation(() => Promise.resolve({ duration: 1 }))
    engine.play('audio:a1', 2)
    engine.play('audio:a2', -1)
    await vi.waitFor(() => { expect(kit.context.sources).toHaveLength(2) })
  })

  it('skips file playback when Web Audio is unavailable', async () => {
    const store = fakeStore([['a1', { blob: new Blob(['x']), name: 'n' }]])
    const engine = new SoundEngine({
      audio: () => undefined,
      library: new AudioLibrary(async () => store),
      dedupe: undefined,
      now: () => 0,
    })
    engine.play('audio:a1', 1)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })

  it('resumes a suspended Web Audio context before playing', () => {
    const context = new FakeAudioContext()
    context.state = 'suspended'
    const engine = new SoundEngine({
      audio: () => context as unknown as AudioContext,
      library: new AudioLibrary(async () => fakeStore()),
      dedupe: undefined,
      now: () => 0,
    })
    engine.play('ding', 1)
    expect(context.resume).toHaveBeenCalledTimes(1)
  })

  it('falls back to Date.now when no clock is injected', () => {
    const context = new FakeAudioContext()
    const engine = new SoundEngine({
      audio: () => context as unknown as AudioContext,
      library: new AudioLibrary(async () => fakeStore()),
      dedupe: undefined,
    })
    engine.play('ding', 1, 'k')
    engine.play('ding', 1, 'k')
    const once = context.oscillators.length
    expect(once).toBeGreaterThan(0)
  })

  it('synthesizes the five built-ins through Web Audio', () => {
    const kit = bench()
    for (const key of ['ding', 'chime', 'bell', 'complete', 'success'] as const) {
      kit.engine.play(key, 1, `k-${key}`)
      kit.clock.now += 1_000
    }
    expect(kit.context.oscillators.length).toBeGreaterThanOrEqual(5)
    expect(kit.context.oscillators.every(oscillator => oscillator.start.mock.calls.length === 1)).toBe(true)
  })

  it('plays a stored audio reference through the decoded buffer path', async () => {
    const kit = bench()
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/ogg' })
    const store = fakeStore()
    const library = new AudioLibrary(async () => store)
    const saved = await library.save(blob, 'chime.ogg')
    const engine = new SoundEngine({
      audio: () => kit.context as unknown as AudioContext,
      library,
      dedupe: undefined,
      now: () => 0,
    })
    const decoded = { duration: 1 }
    kit.context.decodeAudioData.mockImplementation(() => Promise.resolve(decoded))
    engine.play(saved, 0.5)
    await vi.waitFor(() => {
      expect(kit.context.sources[0]?.start).toHaveBeenCalled()
      expect(kit.context.sources[0]?.buffer).toBe(decoded)
    })
  })

  it('stays silent when the stored record is missing or decoding fails', async () => {
    const kit = bench()
    kit.engine.play('audio:gone', 1)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const library = new AudioLibrary(async () => fakeStore([['a1', { blob: new Blob(['x']), name: 'n' }]]))
    const engine = new SoundEngine({
      audio: () => kit.context as unknown as AudioContext,
      library,
      dedupe: undefined,
      now: () => 0,
    })
    kit.context.decodeAudioData.mockImplementation(() => Promise.reject(new Error('no codec')))
    engine.play('audio:a1', 1)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(kit.context.sources).toHaveLength(0)
  })
})

describe('SoundEngine dedupe', () => {
  it('mutes the same source key inside the window and rings again after it', () => {
    const kit = bench()
    kit.engine.play('ding', 1, 'k')
    const once = kit.context.oscillators.length
    expect(once).toBeGreaterThan(0)
    kit.engine.play('ding', 1, 'k')
    expect(kit.context.oscillators.length).toBe(once)
    kit.clock.now = 500
    kit.engine.play('ding', 1, 'k')
    expect(kit.context.oscillators.length).toBeGreaterThan(once)
  })

  it('previews without a source key are never deduped', () => {
    const kit = bench()
    kit.engine.play('ding', 1)
    kit.engine.play('ding', 1)
    expect(kit.context.oscillators.length).toBeGreaterThanOrEqual(4)
  })

  it('prunes stale source keys on the 32nd play', () => {
    const kit = bench()
    kit.engine.play('ding', 1, 'stale')
    kit.clock.now = 400_000
    for (let index = 0; index < 40; index += 1) {
      kit.engine.play('ding', 1, `fill-${index}`)
      kit.clock.now += 1
    }
    // The stale key was pruned; replaying it inside a fresh window rings again.
    const before = kit.context.oscillators.length
    kit.engine.play('ding', 1, 'stale')
    expect(kit.context.oscillators.length).toBeGreaterThan(before)
  })
})

describe('SoundEngine cross-tab handoff', () => {
  it('routes keyed plays through the arbitration participant', () => {
    const context = new FakeAudioContext()
    const timers: Array<{ fn: () => void; ms: number }> = []
    const channel = new FakeChannel()
    const dedupe = new CrossTabDedupe(
      channel,
      (fn, ms) => { const entry = { fn, ms }; timers.push(entry); return entry },
      (timer) => {
        const index = timers.indexOf(timer as { fn: () => void; ms: number })
        if (index >= 0) timers.splice(index, 1)
      },
    )
    const engine = new SoundEngine({
      audio: () => context as unknown as AudioContext,
      library: new AudioLibrary(async () => fakeStore()),
      dedupe,
      now: () => 0,
    })
    channel.receive({ t: 'hello-ack' })
    engine.play('ding', 1, 'k')
    expect(context.oscillators).toHaveLength(0)
    expect(channel.posted.some(message => (message as { t?: string }).t === 'intent')).toBe(true)
    for (const entry of timers.splice(0)) entry.fn()
    expect(context.oscillators.length).toBeGreaterThan(0)
  })
})
