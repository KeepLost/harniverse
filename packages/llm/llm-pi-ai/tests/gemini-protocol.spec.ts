/** A hand-declared route can speak the Gemini API protocol. */

import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as PiAi from '../src/index.ts'
import { assemble } from './assemble.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

async function gateway(baseURL: string): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: { 'gemini-gateway': {
    api: 'google-generative-ai',
    baseURL,
    models: [{ id: 'gemini-test' }],
  } } })
  return ctx
}

it('serves a hand-declared Gemini route through pi-ai\'s Google adapter', async () => {
  // The wire protocol itself is pi-ai's and stays covered there; this pins
  // the harniverse wiring — the protocol table dispatch reaches the real
  // google-generative-ai lazy module, and its key requirement surfaces as a
  // structured provider failure rather than an unknown protocol.
  const ctx = await gateway('https://gateway.example/v1beta')

  const failure = await assemble(ctx, {
    provider: 'gemini-gateway',
    model: 'gemini-test',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  })

  expect(failure.finish).toMatchObject({ kind: 'error' })
  if (failure.finish.kind !== 'error') throw new Error('expected an error finish')
  expect(failure.finish.failure.message).toMatch(/No API key for provider/i)
})

it('names the Gemini protocol in supportedProtocols, so settings schemas offer it', () => {
  expect(PiAi.supportedProtocols()).toContain('google-generative-ai')
})
