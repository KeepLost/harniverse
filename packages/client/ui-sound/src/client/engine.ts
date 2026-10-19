/**
 * The playback engine: synthesized built-in chimes through Web Audio, local
 * audio files decoded through the same context (immune to the element
 * autoplay policy), same-source dedupe, and cross-tab arbitration. Playback
 * failures stay silent — notification sounds never surface errors.
 */

import { AudioLibrary } from './audio-library.ts'
import { CrossTabDedupe } from './cross-tab.ts'
import { BUILTIN_SOUND_KEYS, type BuiltinSoundKey } from '../sound-settings.ts'

/** Same-source dedupe window: repeated frames of one occurrence stay quiet. */
export const SOURCE_DEDUPE_MS = 400

/** Dedupe entries older than this are pruned (bounded memory). */
const PRUNE_AFTER_MS = 300_000

/** Prune cadence: every 32nd play sweeps the dedupe map. */
const PRUNE_EVERY_PLAYS = 32

/** Constructor-injectable capabilities. */
export interface SoundEngineDeps {
  /** Lazy Web Audio context source; absent support mutes everything quietly. */
  readonly audio: () => AudioContext | undefined
  /** Per-browser audio file library. */
  readonly library: AudioLibrary
  /** Cross-tab arbitration participant; undefined disables arbitration. */
  readonly dedupe: CrossTabDedupe | undefined
  /** Monotonic clock for dedupe (tests). */
  readonly now?: () => number
}

/**
 * One browser tab's playback engine.
 */
export class SoundEngine {
  private readonly lastPlayed = new Map<string, number>()
  private playCount = 0
  private readonly now: () => number

  /**
   * @param deps - context source, audio library, arbitration, clock.
   */
  constructor(private readonly deps: SoundEngineDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * Play one sound value for an event occurrence (deduped per source key) or
   * as an immediate preview (no source key).
   *
   * @param value - built-in key, `none`/`local` (silent), or `audio:<id>`.
   * @param volume - 0–1 multiplier for this event.
   * @param sourceKey - dedupe key of the occurrence; undefined previews.
   */
  play(value: string, volume: number, sourceKey?: string): void {
    if (value === '' || value === 'none' || value === 'local') return
    if (sourceKey !== undefined) {
      const now = this.now()
      const last = this.lastPlayed.get(sourceKey)
      if (last !== undefined && now - last < SOURCE_DEDUPE_MS) return
      this.lastPlayed.set(sourceKey, now)
      this.playCount += 1
      if (this.playCount % PRUNE_EVERY_PLAYS === 0) this.prune(now)
      if (this.deps.dedupe !== undefined) {
        this.deps.dedupe.declare(sourceKey, () => { this.emit(value, volume) })
        return
      }
    }
    this.emit(value, volume)
  }

  /** Resolve one value to synthesis or file playback (no dedupe). */
  private emit(value: string, volume: number): void {
    if ((BUILTIN_SOUND_KEYS as readonly string[]).includes(value)) {
      this.playBuiltin(value as BuiltinSoundKey, volume)
      return
    }
    if (value.startsWith('audio:')) {
      void this.playAudio(value.slice('audio:'.length), volume)
    }
  }

  /** Prune dedupe entries whose source can no longer ring. */
  private prune(now: number): void {
    const cutoff = now - PRUNE_AFTER_MS
    for (const [key, at] of this.lastPlayed) {
      if (at < cutoff) this.lastPlayed.delete(key)
    }
  }

  /** Lazily obtain (and unlock) the shared Web Audio context. */
  private context(): AudioContext | undefined {
    const context = this.deps.audio()
    if (context === undefined) return undefined
    if (context.state === 'suspended') void context.resume().catch(() => {})
    return context
  }

  /** Schedule one enveloped oscillator tone. */
  private tone(
    context: AudioContext, frequency: number, delay: number, duration: number,
    type: OscillatorType, gain: number, volume: number,
  ): void {
    const start = context.currentTime + delay
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, start)
    envelope.gain.setValueAtTime(0.0001, start)
    envelope.gain.exponentialRampToValueAtTime(Math.max(gain * volume, 0.0001), start + 0.02)
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    oscillator.connect(envelope)
    envelope.connect(context.destination)
    oscillator.start(start)
    oscillator.stop(start + duration + 0.05)
  }

  /** One tone plus its harmonic partials: `[ratio, lengthRatio, wave, gainRatio]`. */
  private richTone(
    context: AudioContext, frequency: number, delay: number, duration: number,
    type: OscillatorType, gain: number,
    partials: readonly (readonly [number, number, OscillatorType, number])[], volume: number,
  ): void {
    this.tone(context, frequency, delay, duration, type, gain, volume)
    for (const [ratio, lengthRatio, wave, gainRatio] of partials) {
      this.tone(context, frequency * ratio, delay, duration * lengthRatio, wave, gain * gainRatio, volume)
    }
  }

  /** Play one synthesized built-in chime. */
  private playBuiltin(key: BuiltinSoundKey, volume: number): void {
    const context = this.context()
    if (context === undefined) return
    if (key === 'ding') {
      this.richTone(context, 698.46, 0.02, 0.5, 'sine', 0.3, [[2, 0.8, 'sine', 0.35], [3.01, 0.5, 'sine', 0.12]], volume)
      this.richTone(context, 587.33, 0.28, 0.7, 'sine', 0.26, [[2, 0.8, 'sine', 0.3]], volume)
    } else if (key === 'chime') {
      this.richTone(context, 880, 0.02, 0.5, 'sine', 0.22, [[2.76, 0.6, 'sine', 0.18]], volume)
      this.richTone(context, 1318.5, 0.24, 1.1, 'sine', 0.2, [[2, 0.5, 'sine', 0.1]], volume)
    } else if (key === 'bell') {
      this.richTone(context, 493.88, 0.02, 1.6, 'sine', 0.26, [[2, 0.85, 'sine', 0.3], [2.4, 0.6, 'sine', 0.18], [3.02, 0.45, 'sine', 0.1]], volume)
    } else if (key === 'complete') {
      this.richTone(context, 523.25, 0.02, 0.28, 'triangle', 0.22, [[2, 0.7, 'sine', 0.25]], volume)
      this.richTone(context, 659.25, 0.18, 0.28, 'triangle', 0.22, [[2, 0.7, 'sine', 0.25]], volume)
      this.richTone(context, 783.99, 0.34, 0.28, 'triangle', 0.22, [[2, 0.7, 'sine', 0.25]], volume)
      this.richTone(context, 1046.5, 0.5, 0.8, 'triangle', 0.22, [[2, 0.6, 'sine', 0.25]], volume)
    } else {
      this.richTone(context, 783.99, 0.02, 0.2, 'sine', 0.2, [[2, 0.7, 'sine', 0.3]], volume)
      this.richTone(context, 1046.5, 0.16, 0.75, 'sine', 0.2, [[2, 0.6, 'sine', 0.25]], volume)
    }
  }

  /** Decode and play one library file through the shared context. */
  private async playAudio(id: string, volume: number): Promise<void> {
    const context = this.context()
    if (context === undefined) return
    const record = await this.deps.library.load(id)
    if (record === undefined) return
    try {
      const decoded = await context.decodeAudioData(await record.blob.arrayBuffer())
      const source = context.createBufferSource()
      const envelope = context.createGain()
      source.buffer = decoded
      envelope.gain.value = Math.min(Math.max(volume, 0), 1)
      source.connect(envelope)
      envelope.connect(context.destination)
      source.start()
    } catch {
      /* unsupported audio or a closed context stays silent */
    }
  }
}
