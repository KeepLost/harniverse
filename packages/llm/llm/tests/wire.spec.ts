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
      bytes: expect.any(Number) as number,
      fingerprint: expect.any(String) as string,
      parameters: { model: 'm' },
    })
  })

  it('fingerprints an unserializable payload as the null document', () => {
    const nothing = wireJsonFingerprint(undefined)
    expect(nothing.bytes).toBe(4)
    expect(nothing.fingerprint).toBe(wireJsonFingerprint(null).fingerprint)
  })

  it('fingerprints an array holding an unserializable member as the null document', () => {
    expect(wireJsonFingerprint([undefined]).fingerprint).toBe(wireJsonFingerprint(null).fingerprint)
  })

  it('keeps array parameters element-wise while redacting credentials inside them', () => {
    expect(wireRequestParameters({ stop: ['\n', '###'], routes: [{ region: 'eu', api_key: 'secret' }] }))
      .toEqual({ stop: ['\n', '###'], routes: [{ region: 'eu' }] })
  })

  it('drops unserializable members of a nested parameter object', () => {
    expect(wireRequestParameters({ metadata: { trace: 'x', absent: undefined } }))
      .toEqual({ metadata: { trace: 'x' } })
  })

  it('reports no parameters for a payload that is not a parameter object', () => {
    for (const value of [null, undefined, 'text', 7, ['a'], true]) {
      expect(wireRequestParameters(value)).toBeUndefined()
    }
  })

  it('reports no parameters when a payload carries conversation context alone', () => {
    expect(wireRequestParameters({ messages: ['history'], system: 'instructions' })).toBeUndefined()
    expect(wireRequestMetadata({ messages: ['history'] })).not.toHaveProperty('parameters')
  })

  it('reports no diagnostic headers when none apply', () => {
    expect(wireDiagnosticHeaders({})).toBeUndefined()
    expect(wireDiagnosticHeaders({ authorization: 'secret', 'x-unrelated': 'drop' })).toBeUndefined()
  })
})
