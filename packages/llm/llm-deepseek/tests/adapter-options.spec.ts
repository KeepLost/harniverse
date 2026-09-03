/**
 * Deployment-config validation for the DeepSeek route: every bound is refused
 * at the earliest resolvable point rather than reaching a provider request.
 */

import { describe, expect, it } from 'vitest'
import { resolveAdapterOptions } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** The largest delay a Node timer can hold, shared with the module bound. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

describe('resolveAdapterOptions', () => {
  it('resolves every documented default', () => {
    const options = resolveAdapterOptions({})
    expect(options).toMatchObject({
      streamIdleTimeoutMs: expect.any(Number),
      maxRequestFilesBytes: expect.any(Number),
      maxInlineRequestImageBytes: expect.any(Number),
      maxImagesPerRequest: expect.any(Number),
      filesApiTimeoutMs: expect.any(Number),
      fileExpiresAfterSeconds: expect.any(Number),
      fileRefreshMarginSeconds: expect.any(Number),
      fileQuotaCleanupBatch: expect.any(Number),
    })
    expect(options.models.length).toBeGreaterThan(0)
  })

  describe('reasoning', () => {
    it.each(['high', 'max'] as const)('refuses reasoningEffort %s against disabled thinking', (reasoningEffort) => {
      expect(() => resolveAdapterOptions({ thinking: 'disabled', reasoningEffort }))
        .toThrow(/only reasoningEffort "off" can be configured when thinking is disabled/)
    })

    it('accepts an explicitly off effort against disabled thinking', () => {
      expect(resolveAdapterOptions({ thinking: 'disabled', reasoningEffort: 'off' }).defaults)
        .toMatchObject({ thinking: 'disabled', reasoningEffort: 'off' })
    })
  })

  describe('numeric bounds', () => {
    it.each([
      ['defaultContextWindow', 0, /defaultContextWindow must be a positive integer/],
      ['defaultContextWindow', -1, /defaultContextWindow must be a positive integer/],
      ['defaultContextWindow', 1.5, /defaultContextWindow must be a positive integer/],
      ['maxTokens', 0, /maxTokens must be a positive safe integer/],
      ['maxTokens', -1, /maxTokens must be a positive safe integer/],
      ['maxTokens', 1.5, /maxTokens must be a positive safe integer/],
      ['streamIdleTimeoutMs', 0, /streamIdleTimeoutMs must be a positive finite number/],
      ['streamIdleTimeoutMs', -1, /streamIdleTimeoutMs must be a positive finite number/],
      ['streamIdleTimeoutMs', Number.POSITIVE_INFINITY, /streamIdleTimeoutMs must be a positive finite number/],
      ['streamIdleTimeoutMs', MAX_TIMER_DELAY_MS + 1, /streamIdleTimeoutMs must be a positive finite number/],
      ['filesApiTimeoutMs', 0, /filesApiTimeoutMs must be a positive finite number/],
      ['filesApiTimeoutMs', -1, /filesApiTimeoutMs must be a positive finite number/],
      ['filesApiTimeoutMs', Number.POSITIVE_INFINITY, /filesApiTimeoutMs must be a positive finite number/],
      ['filesApiTimeoutMs', MAX_TIMER_DELAY_MS + 1, /filesApiTimeoutMs must be a positive finite number/],
      ['fileRefreshMarginSeconds', -1, /fileRefreshMarginSeconds must be a non-negative safe integer/],
      ['fileRefreshMarginSeconds', 1.5, /fileRefreshMarginSeconds must be a non-negative safe integer/],
      ['fileQuotaCleanupBatch', 0, /fileQuotaCleanupBatch must be between 1 and 1000/],
      ['fileQuotaCleanupBatch', 1_001, /fileQuotaCleanupBatch must be between 1 and 1000/],
      ['fileQuotaCleanupBatch', 1.5, /fileQuotaCleanupBatch must be between 1 and 1000/],
      ['fileExpiresAfterSeconds', 3_599, /fileExpiresAfterSeconds must be between 3600 and 2592000/],
      ['fileExpiresAfterSeconds', 2_592_001, /fileExpiresAfterSeconds must be between 3600 and 2592000/],
      ['fileExpiresAfterSeconds', 3_600.5, /fileExpiresAfterSeconds must be between 3600 and 2592000/],
    ] as const)('refuses %s of %s', (key, value, message) => {
      expect(() => resolveAdapterOptions({ [key]: value } as Config)).toThrow(message)
    })

    it.each([
      'maxRequestFilesBytes',
      'maxInlineRequestImageBytes',
      'maxImagesPerRequest',
      'imageOffloadByteQuantum',
      'inlineImageOffloadByteQuantum',
      'imageOffloadCountQuantum',
    ] as const)('refuses a non-positive %s', (key) => {
      for (const value of [0, -1, 1.5]) {
        expect(() => resolveAdapterOptions({ [key]: value } as Config))
          .toThrow(new RegExp(`${key} must be a positive safe integer`, 'u'))
      }
    })

    it('accepts the exact edges of every bounded range', () => {
      expect(resolveAdapterOptions({
        streamIdleTimeoutMs: MAX_TIMER_DELAY_MS,
        filesApiTimeoutMs: MAX_TIMER_DELAY_MS,
        fileExpiresAfterSeconds: 3_600,
        fileRefreshMarginSeconds: 0,
        fileQuotaCleanupBatch: 1,
      })).toMatchObject({
        streamIdleTimeoutMs: MAX_TIMER_DELAY_MS,
        filesApiTimeoutMs: MAX_TIMER_DELAY_MS,
        fileExpiresAfterSeconds: 3_600,
        fileRefreshMarginSeconds: 0,
        fileQuotaCleanupBatch: 1,
      })
      expect(resolveAdapterOptions({ fileExpiresAfterSeconds: 2_592_000, fileQuotaCleanupBatch: 1_000 }))
        .toMatchObject({ fileExpiresAfterSeconds: 2_592_000, fileQuotaCleanupBatch: 1_000 })
    })
  })

  describe('advisory model catalog', () => {
    /** A catalog entry carrying only what the validator requires. */
    const model = (overrides: Record<string, unknown> = {}) => ({ id: 'deepseek-test', ...overrides })

    it('detaches the resolved catalog from the configured array', () => {
      const models = [model()]
      const resolved = resolveAdapterOptions({ models } as Config)
      expect(resolved.models).not.toBe(models)
      expect(resolved.models[0]).toMatchObject({ id: 'deepseek-test', inputModalities: ['text'] })
    })

    it.each([
      ['an empty id', model({ id: '' }), /catalog model ids must be non-empty/],
      ['an empty name', model({ name: '' }), /has an empty name/],
      ['a zero context window', model({ contextWindow: 0 }), /contextWindow must be a positive integer/],
      ['a fractional context window', model({ contextWindow: 1.5 }), /contextWindow must be a positive integer/],
      ['zero max tokens', model({ maxTokens: 0 }), /maxTokens must be a positive integer/],
      ['fractional max tokens', model({ maxTokens: 1.5 }), /maxTokens must be a positive integer/],
      ['no modalities', model({ inputModalities: [] }), /has invalid input modalities/],
      ['a foreign modality', model({ inputModalities: ['audio'] }), /has invalid input modalities/],
      ['a zero pixel budget', model({ imagePixelBudget: 0 }), /imagePixelBudget must be a positive safe integer/],
      ['a fractional pixel budget', model({ imagePixelBudget: 1.5 }), /imagePixelBudget must be a positive safe integer/],
    ] as const)('refuses a catalog model with %s', (_label, entry, message) => {
      expect(() => resolveAdapterOptions({ models: [entry] } as Config)).toThrow(message)
    })

    it('accepts an image-capable model with a pixel budget', () => {
      expect(resolveAdapterOptions({
        models: [model({ inputModalities: ['text', 'image'], imagePixelBudget: 1_000, contextWindow: 100, maxTokens: 50, name: 'Test' })],
      } as Config).models[0]).toMatchObject({
        inputModalities: ['text', 'image'],
        imagePixelBudget: 1_000,
        name: 'Test',
      })
    })
  })
})
