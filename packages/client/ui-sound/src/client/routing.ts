/**
 * Playback routing: the pure decision from the current settings, one
 * detected occurrence, and the open session to the sound value, volume,
 * and dedupe key the engine plays (or no play at all).
 */

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SoundChannel, SoundEventKind, SoundSettings } from '../sound-settings.ts'
import { soundFieldFor, volumeFieldFor } from '../sound-settings.ts'
import type { SoundEventOccurrence } from './watcher.ts'

/** One resolved playback instruction. */
export interface PlaybackDecision {
  /** Sound value the engine plays. */
  readonly sound: string
  /** Event volume (0–1). */
  readonly volume: number
  /** Dedupe key of the occurrence. */
  readonly sourceKey: string
}

/**
 * Decide whether one occurrence rings under the current settings.
 *
 * @param settings - the complete current sound section.
 * @param event - one detected occurrence.
 * @param currentSession - the session the reader has open, for quiet-current.
 * @returns the playback instruction, or undefined when nothing rings.
 */
export function resolvePlayback(
  settings: SoundSettings,
  event: SoundEventOccurrence,
  currentSession: SessionId | undefined,
): PlaybackDecision | undefined {
  if (!settings.enabled) return undefined
  if (event.channel === 'subagent' && settings.ignoreSubagent) return undefined
  if (event.kind === 'completion' && settings.quietCurrent && currentSession === event.sessionId) return undefined
  return {
    sound: Reflect.get(settings, soundFieldFor(event.kind, event.channel)) as string,
    volume: Reflect.get(settings, volumeFieldFor(event.kind, event.channel)) as number,
    sourceKey: event.sourceKey,
  }
}

/** Re-export the occurrence type so routing consumers need one import. */
export type { SoundEventOccurrence, SoundChannel, SoundEventKind }
