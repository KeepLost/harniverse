/**
 * Voice-input carrier paths of the host ApiProxy: `speech.transcribe`
 * enforces the canonical-base64 and WAV intake limits before the recognizer
 * seam sees audio, resolves the settings-selected recognizer per request, and
 * `speech.prepare` forwards the settled asset observation or the selection
 * refusal under its own error code.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import SpeechService from '@deepseek-ai/dsh-speech'
import type { SpeechRecognizer } from '@deepseek-ai/dsh-speech'
import type { RpcRequest, SpeechApi } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApiProxy } from '../src/api-proxy.ts'

/** Canonical 44-byte-header 16 kHz mono PCM16 WAV of `samples` frames. */
function wav(samples: number): Uint8Array {
  const dataBytes = samples * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const text = (value: string, offset: number): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  text('RIFF', 0)
  view.setUint32(4, 36 + dataBytes, true)
  text('WAVE', 8)
  text('fmt ', 12)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text('data', 36)
  view.setUint32(40, dataBytes, true)
  return bytes
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SpeechService)
  return ctx
}

/** A context with the proxy's minimum service set but no speech seam. */
async function bareHarness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/** The composed proxy's speech face. */
function speechFace(ctx: Context): SpeechApi {
  const proxy = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  if (proxy.speech === undefined) throw new Error('composed proxy did not expose the speech face')
  return proxy.speech
}

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`speech-rpc-${String(nextRpc++)}`), payload }
}

function fakeRecognizer(): SpeechRecognizer {
  return {
    id: 'sensevoice',
    label: 'test',
    location: 'host-local',
    prepare: async () => ({ status: 'ready' }),
    transcribe: async input => ({ text: `heard:${String(input.wav.length)}:${input.language ?? 'auto'}` }),
  }
}

describe('speech.transcribe', () => {
  it('returns the recognizer text for a canonical recording', async () => {
    const ctx = await harness()
    ctx.speech.registerRecognizer('sensevoice', fakeRecognizer())
    ctx.speech.configure({ recognizer: 'sensevoice', language: 'zh' })
    const speech = speechFace(ctx)
    const recording = wav(100)
    const response = await speech.transcribe(
      request({ wavBase64: Buffer.from(recording).toString('base64') }),
      new AbortController().signal,
    )
    expect(response.result).toEqual({ ok: true, value: { text: 'heard:244:zh' } })
    await ctx.fiber.dispose()
  })

  it('refuses deployment without the seam, disabled selection, and broken audio', async () => {
    const bare = await bareHarness()
    const bareFace = speechFace(bare)
    const unavailable = await bareFace.transcribe(
      request({ wavBase64: Buffer.from(wav(10)).toString('base64') }),
      new AbortController().signal,
    )
    expect(unavailable.result).toMatchObject({ ok: false, error: { code: 'speech-unavailable' } })
    await bare.fiber.dispose()

    const ctx = await harness()
    ctx.speech.registerRecognizer('sensevoice', fakeRecognizer())
    ctx.speech.configure({ recognizer: 'off' })
    const speech = speechFace(ctx)
    const disabled = await speech.transcribe(
      request({ wavBase64: Buffer.from(wav(10)).toString('base64') }),
      new AbortController().signal,
    )
    expect(disabled.result).toMatchObject({ ok: false, error: { code: 'speech-transcription-failed' } })
    const disabledMessage = disabled.result.ok ? '' : disabled.result.error.message
    expect(disabledMessage).toContain('disabled')

    const notBase64 = await speech.transcribe(request({ wavBase64: 'not base64!!' }), new AbortController().signal)
    expect(notBase64.result).toMatchObject({ ok: false, error: { code: 'speech-transcription-failed' } })

    const brokenWav = await speech.transcribe(request({ wavBase64: Buffer.from(new Uint8Array(64)).toString('base64') }), new AbortController().signal)
    const brokenMessage = brokenWav.result.ok ? '' : brokenWav.result.error.message
    expect(brokenMessage).toContain('canonical')

    const tooLong = await speech.transcribe(
      request({ wavBase64: Buffer.from(wav(16_000 * 121)).toString('base64') }),
      new AbortController().signal,
    )
    const tooLongMessage = tooLong.result.ok ? '' : tooLong.result.error.message
    expect(tooLongMessage).toContain('exceeds 120 seconds')
    await ctx.fiber.dispose()
  })

  it('maps recognizer failure onto the transcription-failed code', async () => {
    const ctx = await harness()
    ctx.speech.registerRecognizer('sensevoice', {
      id: 'sensevoice',
      label: 'test',
      location: 'host-local',
      transcribe: async () => { throw new Error('inference crashed') },
    })
    ctx.speech.configure({ recognizer: 'sensevoice' })
    const speech = speechFace(ctx)
    const response = await speech.transcribe(
      request({ wavBase64: Buffer.from(wav(10)).toString('base64') }),
      new AbortController().signal,
    )
    expect(response.result).toMatchObject({ ok: false, error: { code: 'speech-transcription-failed', message: 'inference crashed' } })
    await ctx.fiber.dispose()
  })
})

describe('speech.prepare', () => {
  it('answers the settled readiness observation', async () => {
    const ctx = await harness()
    ctx.speech.registerRecognizer('sensevoice', fakeRecognizer())
    ctx.speech.configure({ recognizer: 'sensevoice' })
    const speech = speechFace(ctx)
    await expect(speech.prepare(request({}))).resolves.toMatchObject({
      result: { ok: true, value: { status: 'ready' } },
    })
    await ctx.fiber.dispose()
  })

  it('maps the disabled selection and a missing seam to speech-unavailable', async () => {
    const bare = await bareHarness()
    const bareFace = speechFace(bare)
    await expect(bareFace.prepare(request({}))).resolves.toMatchObject({
      result: { ok: false, error: { code: 'speech-unavailable' } },
    })
    await bare.fiber.dispose()

    const ctx = await harness()
    ctx.speech.configure({ recognizer: 'off' })
    const speech = speechFace(ctx)
    const refusal = await speech.prepare(request({}))
    const refusalMessage = refusal.result.ok ? '' : refusal.result.error.message
    expect(refusalMessage).toContain('disabled')
    await ctx.fiber.dispose()
  })
})
