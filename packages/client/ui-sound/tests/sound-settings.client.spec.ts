/** The package's node half: the durable schema, its decoder, and the namespace registration. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as NodeHalf from '@deepseek-ai/dsh-client-ui-sound/src/index.ts'
import {
  BUILTIN_SOUND_KEYS, DEFAULT_SOUND_FOR, SOUND_CHANNELS, SOUND_EVENT_KINDS, SOUND_SETTINGS_NAMESPACE,
  SOUND_VALUE_PATTERN, SoundSettingsSchema, decodeSoundSettings, defaultSoundSettings, resolveSoundSettings,
  soundFieldFor, volumeFieldFor,
} from '@deepseek-ai/dsh-client-ui-sound/src/sound-settings.ts'

describe('sound settings schema', () => {
  it('resolves an empty document to the complete defaults', () => {
    const section = resolveSoundSettings({})
    expect(section).toEqual(defaultSoundSettings())
  })

  it('keeps the per-channel defaults the section documents', () => {
    const section = resolveSoundSettings({}) as unknown as Record<string, unknown>
    for (const channel of SOUND_CHANNELS) {
      for (const kind of SOUND_EVENT_KINDS) {
        expect(Reflect.get(section, soundFieldFor(kind, channel))).toBe(DEFAULT_SOUND_FOR[channel][kind])
        expect(Reflect.get(section, volumeFieldFor(kind, channel))).toBe(1)
      }
    }
  })

  it('accepts every built-in key, none, local, and audio references', () => {
    for (const value of [...BUILTIN_SOUND_KEYS, 'none', 'local', 'audio:a1b2c3']) {
      expect(SOUND_VALUE_PATTERN.test(value)).toBe(true)
    }
  })

  it('rejects sound values outside the accepted vocabulary', () => {
    for (const value of ['', 'data:text/html,x', 'audio:', 'audio:A1', 'ding ', 'exec']) {
      expect(SOUND_VALUE_PATTERN.test(value)).toBe(false)
    }
    expect(() => resolveSoundSettings({ completionSound: 'data:audio/x' })).toThrow()
  })

  it('clamps volumes outside the range', () => {
    expect(() => resolveSoundSettings({ completionVolume: 1.5 })).toThrow()
    expect(() => resolveSoundSettings({ completionVolume: -0.1 })).toThrow()
  })
})

describe('decodeSoundSettings', () => {
  it('yields undefined for non-object sections', () => {
    for (const section of [undefined, null, 42, 'x', []]) {
      expect(decodeSoundSettings(section)).toBeUndefined()
    }
  })

  it('fills defaults for an empty object', () => {
    expect(decodeSoundSettings({})).toEqual(defaultSoundSettings())
  })

  it('drops non-boolean switches and non-finite volumes', () => {
    const section = decodeSoundSettings({
      enabled: 'on',
      quietCurrent: 1,
      ignoreSubagent: null,
      completionVolume: Number.POSITIVE_INFINITY,
    })
    expect(section?.enabled).toBe(true)
    expect(section?.quietCurrent).toBe(false)
    expect(section?.ignoreSubagent).toBe(false)
    expect(section?.completionVolume).toBe(1)
  })

  it('keeps valid fields and drops malformed ones', () => {
    const section = decodeSoundSettings({
      enabled: false,
      quietCurrent: true,
      ignoreSubagent: true,
      completionSound: 'bell',
      completionVolume: 0.25,
      failureSound: 'rm -rf',
      subagentGoalBlockedSound: 'audio:zz9',
      subagentGoalBlockedVolume: Number.NaN,
    })
    expect(section?.enabled).toBe(false)
    expect(section?.quietCurrent).toBe(true)
    expect(section?.ignoreSubagent).toBe(true)
    expect(section?.completionSound).toBe('bell')
    expect(section?.completionVolume).toBe(0.25)
    expect(section?.failureSound).toBe('bell')
    expect(section?.subagentGoalBlockedSound).toBe('audio:zz9')
    expect(section?.subagentGoalBlockedVolume).toBe(1)
  })

  it('clamps finite volumes into the range', () => {
    expect(decodeSoundSettings({ completionVolume: 7 })?.completionVolume).toBe(1)
    expect(decodeSoundSettings({ completionVolume: -7 })?.completionVolume).toBe(0)
  })
})

describe('node half', () => {
  it('registers the ui-sound namespace when a settings provider exists', async () => {
    const ctx = new Context()
    const register = vi.fn()
    ctx.provide('settings', { register })
    NodeHalf.apply(ctx)
    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith(SOUND_SETTINGS_NAMESPACE, SoundSettingsSchema)
    })
  })

  it('stays quiet when no settings service exists', async () => {
    const ctx = new Context()
    expect(() => { NodeHalf.apply(ctx) }).not.toThrow()
  })
})
