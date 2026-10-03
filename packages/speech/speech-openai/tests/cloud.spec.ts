import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SpeechService from '@deepseek-ai/dsh-speech'
import * as speechOpenai from '../src/index.ts'
import type { FetchLike } from '../src/types.ts'

const CONFIG = speechOpenai.Config({
  endpoints: ['https://official.example/v1', 'https://gateway-a.example/v1', 'https://gateway-b.example/v1'],
})

const WAV = new Uint8Array(64)

describe('transcribeThroughChain', () => {
  it('falls through a transport failure and a retriable status to the next endpoint', async () => {
    const calls: string[] = []
    const fetchImpl: FetchLike = async (url: string) => {
      calls.push(url)
      if (url.startsWith('https://official.example')) throw new TypeError('connection reset')
      if (url.includes('gateway-a.example')) return new Response('busy', { status: 503 })
      return new Response(JSON.stringify({ text: '  hello cloud  ' }), { status: 200 })
    }
    const recognizer = speechOpenai.createOpenAiRecognizer(CONFIG, () => ({ apiKey: 'sk-test' }), fetchImpl)
    await expect(recognizer.transcribe({ wav: WAV })).resolves.toEqual({ text: 'hello cloud' })
    expect(calls).toEqual([
      'https://official.example/v1/audio/transcriptions',
      'https://gateway-a.example/v1/audio/transcriptions',
      'https://gateway-b.example/v1/audio/transcriptions',
    ])
  })

  it('fails immediately with the definitive answer when an endpoint rejects the request', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    const recognizer = speechOpenai.createOpenAiRecognizer(CONFIG, () => ({ apiKey: 'sk-bad' }), fetchImpl)
    await expect(recognizer.transcribe({ wav: WAV })).rejects.toThrow('HTTP 401')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('reports the exhausted chain when every endpoint is unavailable', async () => {
    const fetchImpl: FetchLike = async () => new Response('busy', { status: 500 })
    const recognizer = speechOpenai.createOpenAiRecognizer(CONFIG, () => ({ apiKey: 'sk-test' }), fetchImpl)
    await expect(recognizer.transcribe({ wav: WAV })).rejects.toThrow('endpoint https://gateway-b.example/v1 unavailable')
  })

  it('refuses to send without an API key and honors request language over the preference', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response(JSON.stringify({ text: 'ok' })))
    const keyless = speechOpenai.createOpenAiRecognizer(CONFIG, () => ({}), fetchImpl)
    await expect(keyless.transcribe({ wav: WAV })).rejects.toThrow('no API key')
    expect(fetchImpl).not.toHaveBeenCalled()

    const recognizer = speechOpenai.createOpenAiRecognizer(CONFIG, () => ({ apiKey: 'sk-test', language: 'zh' }), fetchImpl)
    await expect(recognizer.transcribe({ wav: WAV })).resolves.toEqual({ text: 'ok' })
    const body = vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body as FormData
    expect(body.get('model')).toBe('whisper-1')
    expect(body.get('language')).toBe('zh')
    await expect(recognizer.transcribe({ wav: WAV, language: 'en' })).resolves.toEqual({ text: 'ok' })
    const override = vi.mocked(fetchImpl).mock.calls[1]?.[1]?.body as FormData
    expect(override.get('language')).toBe('en')
  })

  it('answers readiness from the key state', async () => {
    const recognizer = speechOpenai.createOpenAiRecognizer(CONFIG, () => ({ apiKey: 'sk-test' }))
    await expect(recognizer.inspect?.()).resolves.toEqual({ status: 'ready' })
    const keyless = speechOpenai.createOpenAiRecognizer(CONFIG, () => ({}))
    await expect(keyless.inspect?.()).resolves.toEqual({ status: 'unprepared' })
  })

  it('fails the chain when an endpoint hangs past its deadline', async () => {
    const shortDeadline = speechOpenai.Config({ endpoints: ['https://official.example/v1'], timeoutMs: 50 })
    const fetchImpl: FetchLike = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        // oxlint-disable-next-line prefer-promise-reject-errors -- the abort reason is the case under test
        reject(init.signal?.reason ?? new Error('aborted'))
      })
    }))
    const recognizer = speechOpenai.createOpenAiRecognizer(shortDeadline, () => ({ apiKey: 'sk-test' }), fetchImpl)
    await expect(recognizer.transcribe({ wav: WAV }, new AbortController().signal)).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rethrows immediately when the caller signal is already aborted', async () => {
    const fetchImpl: FetchLike = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        // oxlint-disable-next-line prefer-promise-reject-errors -- the abort reason is the case under test
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      signal?.addEventListener('abort', () => {
        // oxlint-disable-next-line prefer-promise-reject-errors -- the abort reason is the case under test
        reject(signal.reason ?? new Error('aborted'))
      })
    }))
    const recognizer = speechOpenai.createOpenAiRecognizer(CONFIG, () => ({ apiKey: 'sk-test' }), fetchImpl)
    const controller = new AbortController()
    controller.abort()
    await expect(recognizer.transcribe({ wav: WAV }, controller.signal)).rejects.toThrow()
  })

  it('answers empty text when the payload carries a non-string text field', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response(JSON.stringify({ text: 42 })))
    const recognizer = speechOpenai.createOpenAiRecognizer(CONFIG, () => ({ apiKey: 'sk-test' }), fetchImpl)
    await expect(recognizer.transcribe({ wav: WAV })).resolves.toEqual({ text: '' })
  })
})

describe('speech-openai plugin', () => {
  it('registers and releases the cloud recognizer, reading live preferences', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechService)
    const fiber = ctx.plugin(speechOpenai, speechOpenai.Config({}))
    await fiber
    expect(ctx.speech.recognizer('openai-compatible')?.location).toBe('cloud')
    ctx.speech.configure({ recognizer: 'openai-compatible', apiKey: 'sk-live' })
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ text: 'live' }))
    const cloud = speechOpenai.createOpenAiRecognizer(speechOpenai.Config({}), () => ctx.speech.currentPreferences(), fetchImpl)
    await expect(cloud.transcribe({ wav: WAV })).resolves.toEqual({ text: 'live' })
    await fiber.dispose()
    expect(ctx.speech.recognizer('openai-compatible')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('the registered recognizer consults live preferences before sending', async () => {
    const ctx = new Context()
    await ctx.plugin(SpeechService)
    const fiber = ctx.plugin(speechOpenai, speechOpenai.Config({}))
    await fiber
    // No API key configured: the registered recognizer reads the live
    // preferences and refuses before any endpoint is contacted.
    ctx.speech.configure({ recognizer: 'openai-compatible' })
    await expect(ctx.speech.transcribe({ wav: WAV })).rejects.toThrow('no API key')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
