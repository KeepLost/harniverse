import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SpeechService from '@deepseek-ai/dsh-speech'
import type { SpeechPreparation, SpeechRecognizer } from '@deepseek-ai/dsh-speech'

function fakeRecognizer(id: string, overrides: Partial<SpeechRecognizer> = {}): SpeechRecognizer {
  return {
    id,
    label: id,
    location: 'host-local',
    transcribe: async input => ({ text: `${id}:${input.language ?? 'auto'}:${String(input.wav.length)}` }),
    ...overrides,
  }
}

describe('ctx.speech registry', () => {
  it('registers, lists, and disposes recognizers with their fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechService)
    const dispose = ctx.speech.registerRecognizer('a', fakeRecognizer('a'))
    ctx.speech.registerRecognizer('b', fakeRecognizer('b'))
    expect(ctx.speech.listRecognizers().map(recognizer => recognizer.id)).toEqual(['a', 'b'])
    dispose()
    expect(ctx.speech.listRecognizers().map(recognizer => recognizer.id)).toEqual(['b'])
    await ctx.fiber.dispose()
  })

  it('rejects a duplicate id and an id mismatch', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechService)
    ctx.speech.registerRecognizer('a', fakeRecognizer('a'))
    expect(() => ctx.speech.registerRecognizer('a', fakeRecognizer('a'))).toThrow('already registered')
    expect(() => ctx.speech.registerRecognizer('x', fakeRecognizer('y'))).toThrow('does not match')
    await ctx.fiber.dispose()
  })

  it('resolves preferences, explicit overrides, and refusals', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechService)
    ctx.speech.registerRecognizer('sensevoice', fakeRecognizer('sensevoice'))
    expect(ctx.speech.resolve()).toEqual({ ok: false, reason: 'disabled', recognizer: 'off' })
    ctx.speech.configure({ recognizer: 'sensevoice', language: 'zh' })
    expect(ctx.speech.resolve()).toEqual({ ok: true, recognizer: ctx.speech.recognizer('sensevoice'), language: 'zh' })
    expect(ctx.speech.resolve('openai-compatible')).toEqual({ ok: false, reason: 'unknown', recognizer: 'openai-compatible' })
    expect(ctx.speech.resolve('off')).toEqual({ ok: false, reason: 'disabled', recognizer: 'off' })
    await ctx.fiber.dispose()
  })

  it('transcribes through the resolved recognizer with language override', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechService)
    ctx.speech.registerRecognizer('sensevoice', fakeRecognizer('sensevoice'))
    ctx.speech.configure({ recognizer: 'sensevoice' })
    const wav = new Uint8Array(64)
    await expect(ctx.speech.transcribe({ wav })).resolves.toEqual({ text: 'sensevoice:auto:64' })
    await expect(ctx.speech.transcribe({ wav, language: 'en' })).resolves.toEqual({ text: 'sensevoice:en:64' })
    await ctx.fiber.dispose()
  })

  it('refuses transcription while disabled or unregistered', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechService)
    await expect(ctx.speech.transcribe({ wav: new Uint8Array(64) })).rejects.toThrow('recognizer is off')
    ctx.speech.configure({ recognizer: 'gone' })
    await expect(ctx.speech.transcribe({ wav: new Uint8Array(64) })).rejects.toThrow('"gone" is not registered')
    await ctx.fiber.dispose()
  })

  it('prepares through the resolved recognizer, defaulting to ready without a prepare step', async () => {
    const ready: SpeechPreparation = { status: 'ready' }
    const withPrepare = fakeRecognizer('local', {
      prepare: async () => ready,
      inspect: async () => ready,
    })
    const ctx = new Context()
    await ctx.plugin(SpeechService)
    ctx.speech.registerRecognizer('local', withPrepare)
    ctx.speech.registerRecognizer('cloud', fakeRecognizer('cloud', { location: 'cloud' }))
    ctx.speech.configure({ recognizer: 'cloud' })
    await expect(ctx.speech.prepare()).resolves.toEqual({ status: 'ready' })
    await expect(ctx.speech.prepare('local')).resolves.toEqual(ready)
    await expect(ctx.speech.prepare('off')).resolves.toEqual({ ok: false, reason: 'disabled', recognizer: 'off' })
    await ctx.fiber.dispose()
  })
})
