import { describe, expect, it } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { piStreamOptions } from '../src/request-options.ts'

/** A minimal reasoning-capable budget model speaking one translated protocol. */
function model(overrides: Partial<Model<Api>> & { api: 'anthropic-messages' | 'openai-responses' }): Model<Api> {
  return {
    id: 'm',
    name: 'M',
    provider: 'p',
    baseUrl: 'https://p.test',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65536,
    maxTokens: 8192,
    ...overrides,
  }
}

const none = { reasoning: undefined, thinkingBudgets: undefined, maxTokens: undefined, temperature: undefined }

describe('anthropic-messages option translation', () => {
  it('keeps the provider default when no level is selected', () => {
    const options = piStreamOptions(model({ api: 'anthropic-messages' }), none)
    // No thinking field at all: adaptive models think by their own default,
    // and `max_tokens` uses the capability because the wire requires one.
    expect(options).toEqual({ maxTokens: 8192 })
  })

  it('disables thinking explicitly for off', () => {
    const options = piStreamOptions(model({ api: 'anthropic-messages' }), { ...none, reasoning: 'off' })
    expect(options).toEqual({ maxTokens: 8192, thinkingEnabled: false })
  })

  it('sends an effort for an adaptive-thinking model', () => {
    const adaptive = model({ api: 'anthropic-messages', compat: { forceAdaptiveThinking: true } })
    expect(piStreamOptions(adaptive, { ...none, reasoning: 'high' }))
      .toEqual({ maxTokens: 8192, thinkingEnabled: true, effort: 'high' })
    // A model spelling the level in its own map wins over the default mapping.
    const spelled = model({
      api: 'anthropic-messages',
      compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    })
    expect(piStreamOptions(spelled, { ...none, reasoning: 'xhigh' })).toMatchObject({ effort: 'xhigh' })
    expect(piStreamOptions(spelled, { ...none, reasoning: 'minimal' })).toMatchObject({ effort: 'low' })
    expect(piStreamOptions(spelled, { ...none, reasoning: 'medium' })).toMatchObject({ effort: 'medium' })
  })

  it('sends a budget fitted inside the caller cap for a budget-thinking model', () => {
    const budgeted = model({ api: 'anthropic-messages' })
    // The default high budget (16,384) shrinks to leave the reply its room.
    expect(piStreamOptions(budgeted, { ...none, reasoning: 'high' }))
      .toEqual({ maxTokens: 8192, thinkingEnabled: true, thinkingBudgetTokens: 7168 })
    // A profile budget wins while it fits, and the caller cap stays the cap.
    expect(piStreamOptions(budgeted, {
      ...none, reasoning: 'low', thinkingBudgets: { low: 2048 }, maxTokens: 4096,
    })).toEqual({ maxTokens: 4096, thinkingEnabled: true, thinkingBudgetTokens: 2048 })
    // Escalated levels ride the default table even beside profile budgets.
    expect(piStreamOptions(budgeted, {
      ...none, reasoning: 'max', thinkingBudgets: { high: 2048 },
    })).toMatchObject({ thinkingBudgetTokens: 7168 })
  })

  it('refuses a cap that cannot host the smallest legal budget', () => {
    const budgeted = model({ api: 'anthropic-messages' })
    expect(() => piStreamOptions(budgeted, { ...none, reasoning: 'low', maxTokens: 2047 }))
      .toThrow(/budget of at least 1024 tokens/)
    expect(() => piStreamOptions(model({ api: 'anthropic-messages', maxTokens: 1000 }), {
      ...none, reasoning: 'high',
    })).toThrow(/raise maxTokens above 1000/)
    // The exact floor fits: 2048 leaves 1024 for thinking and 1024 for reply.
    expect(piStreamOptions(budgeted, { ...none, reasoning: 'minimal', maxTokens: 2048 }))
      .toMatchObject({ thinkingEnabled: true, thinkingBudgetTokens: 1024 })
  })

  it('carries the temperature only where thinking cannot run', () => {
    const adaptive = model({ api: 'anthropic-messages', compat: { forceAdaptiveThinking: true } })
    // Unselected: the provider default may think, so the temperature waits.
    expect(piStreamOptions(adaptive, { ...none, temperature: 0.3 })).not.toHaveProperty('temperature')
    expect(piStreamOptions(adaptive, { ...none, reasoning: 'off', temperature: 0.3 }))
      .toMatchObject({ temperature: 0.3 })
    const plain = model({ api: 'anthropic-messages' })
    expect(piStreamOptions(plain, { ...none, reasoning: 'low', temperature: 0.3 }))
      .not.toHaveProperty('temperature')
    expect(piStreamOptions(model({ api: 'anthropic-messages', reasoning: false }), { ...none, temperature: 0.3 }))
      .toMatchObject({ temperature: 0.3 })
  })
})

describe('openai-responses option translation', () => {
  it('omits the output cap and effort nobody selected', () => {
    expect(piStreamOptions(model({ api: 'openai-responses' }), none)).toEqual({})
  })

  it('carries a selected level and cap', () => {
    expect(piStreamOptions(model({ api: 'openai-responses' }), {
      ...none, reasoning: 'high', maxTokens: 512,
    })).toEqual({ reasoningEffort: 'high', maxTokens: 512 })
    expect(piStreamOptions(model({ api: 'openai-responses' }), { ...none, reasoning: 'off' }))
      .toEqual({})
  })

  it('refuses a sub-floor output cap instead of silently raising it', () => {
    expect(() => piStreamOptions(model({ api: 'openai-responses' }), { ...none, maxTokens: 8 }))
      .toThrow(/output caps must be at least 16 tokens/)
  })

  it('carries the temperature wherever thinking is off on the wire', () => {
    const reasoning = model({ api: 'openai-responses' })
    // Unselected dispatches as `effort: none`, so the temperature is safe.
    expect(piStreamOptions(reasoning, { ...none, temperature: 0.4 })).toMatchObject({ temperature: 0.4 })
    expect(piStreamOptions(reasoning, { ...none, reasoning: 'off', temperature: 0.4 }))
      .toMatchObject({ temperature: 0.4 })
    expect(piStreamOptions(reasoning, { ...none, reasoning: 'high', temperature: 0.4 }))
      .not.toHaveProperty('temperature')
    expect(piStreamOptions(model({ api: 'openai-responses', reasoning: false }), {
      ...none, reasoning: 'high', temperature: 0.4,
    })).toMatchObject({ temperature: 0.4 })
  })
})
