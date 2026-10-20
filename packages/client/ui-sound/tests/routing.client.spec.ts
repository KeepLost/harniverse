/** Playback routing: the pure settings decision for every occurrence shape. */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { resolvePlayback } from '../src/client/routing.ts'
import type { SoundEventOccurrence } from '../src/client/watcher.ts'
import { defaultSoundSettings } from '../src/sound-settings.ts'

/** One occurrence literal with defaults. */
function occurrence(overrides: Partial<SoundEventOccurrence> = {}): SoundEventOccurrence {
  return {
    kind: 'completion',
    sourceKey: 'session:s1',
    channel: 'main',
    sessionId: 's1' as SessionId,
    ...overrides,
  }
}

describe('resolvePlayback', () => {
  it('resolves the event kind to its sound, volume, and dedupe key', () => {
    const settings = defaultSoundSettings()
    expect(resolvePlayback(settings, occurrence(), undefined)).toEqual({
      sound: 'chime',
      volume: 1,
      sourceKey: 'session:s1',
    })
    expect(resolvePlayback(settings, occurrence({ kind: 'failure' }), undefined)?.sound).toBe('bell')
    expect(resolvePlayback(settings, occurrence({ kind: 'approval', sourceKey: 'pending:s1:approval' }), undefined)?.sourceKey)
      .toBe('pending:s1:approval')
  })

  it('reads the subagent channel fields for subagent occurrences', () => {
    const settings = defaultSoundSettings()
    const decision = resolvePlayback(settings, occurrence({ channel: 'subagent', kind: 'failure' }), undefined)
    expect(decision?.sound).toBe('bell')
    const completion = resolvePlayback(settings, occurrence({ channel: 'subagent', kind: 'completion' }), undefined)
    expect(completion?.sound).toBe('none')
  })

  it('stays silent while the master switch is off', () => {
    const settings = { ...defaultSoundSettings(), enabled: false }
    expect(resolvePlayback(settings, occurrence(), undefined)).toBeUndefined()
  })

  it('stays silent for ignored subagent events', () => {
    const settings = { ...defaultSoundSettings(), ignoreSubagent: true }
    expect(resolvePlayback(settings, occurrence({ channel: 'subagent' }), undefined)).toBeUndefined()
    expect(resolvePlayback(settings, occurrence({ channel: 'main' }), undefined)).toBeDefined()
  })

  it('mutes a quiet-current completion only for the open session', () => {
    const settings = { ...defaultSoundSettings(), quietCurrent: true }
    expect(resolvePlayback(settings, occurrence(), 's1' as SessionId)).toBeUndefined()
    expect(resolvePlayback(settings, occurrence(), 's2' as SessionId)).toBeDefined()
    expect(resolvePlayback(settings, occurrence({ kind: 'approval' }), 's1' as SessionId)).toBeDefined()
  })
})
