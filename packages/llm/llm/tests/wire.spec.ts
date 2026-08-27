import { describe, expect, it } from 'vitest'
import { wireDiagnosticHeaders, wireJsonFingerprint, wireRequestMetadata, wireRequestParameters } from '@deepseek-ai/dsh-llm'

describe('wire metadata', () => {
  it('fingerprints UTF-8 JSON and reports its encoded byte length', () => {
    expect(wireJsonFingerprint({ text: '🙂' }).bytes).toBe(Buffer.byteLength('{"text":"🙂"}', 'utf8'))
    expect(wireJsonFingerprint({ value: 1 }).fingerprint).toBe(wireJsonFingerprint({ value: 1 }).fingerprint)
    expect(wireJsonFingerprint({ a: 1, b: 2 }).fingerprint).toBe(wireJsonFingerprint({ b: 2, a: 1 }).fingerprint)
  })

  it('keeps adapter parameters while excluding conversation and credential fields', () => {
    expect(wireRequestParameters({
      model: 'm', messages: ['history'], tools: ['tools'], system: 'instructions',
      max_tokens: 10, authorization: 'secret', metadata: { trace: 'x', api_key: 'secret' },
    })).toEqual({ model: 'm', max_tokens: 10, metadata: { trace: 'x' } })
  })

  it('keeps only bounded diagnostic response headers', () => {
    expect(wireDiagnosticHeaders({
      'X-Request-ID': 'req', 'Retry-After': '2', 'Content-Type': 'application/json',
      authorization: 'secret', 'set-cookie': 'secret', 'x-unrelated': 'drop',
    })).toEqual({ 'x-request-id': 'req', 'retry-after': '2', 'content-type': 'application/json' })
  })

  it('combines request size, fingerprint, and reconstruction parameters', () => {
    expect(wireRequestMetadata({ model: 'm', messages: [] })).toMatchObject({
      bytes: expect.any(Number),
      fingerprint: expect.any(String),
      parameters: { model: 'm' },
    })
  })
})
