import { describe, expect, it } from 'vitest'
import { encodeJsonPlain, hasNonLosslessNumber, hasUnsafeIntegerToken, validateChildFrame } from '../src/protocol.ts'

describe('Python runtime protocol host boundary', () => {
  it('rebuilds valid frames and drops malformed or unknown traffic', () => {
    expect(validateChildFrame({ type: 'boot-ack', forged: true })).toEqual({ type: 'boot-ack' })
    expect(validateChildFrame({ type: 'log', text: 'hello', forged: true })).toEqual({ type: 'log', text: 'hello' })
    expect(validateChildFrame({ type: 'call', id: 1, global: 'tools', name: 'echo', args: { n: 1 }, forged: true }))
      .toEqual({ type: 'call', id: 1, global: 'tools', name: 'echo', args: { n: 1 } })
    expect(validateChildFrame({ type: 'done', value: 3, forged: true })).toEqual({ type: 'done', value: 3 })
    expect(validateChildFrame({ type: 'done', error: { kind: 'exception', message: 'failed' } }))
      .toEqual({ type: 'done', error: { kind: 'exception', message: 'failed' } })
    expect(validateChildFrame({ type: 'done', value: undefined, error: undefined })).toEqual({ type: 'done' })
    expect(validateChildFrame({ type: 'done', value: 1, error: { kind: 'output-limit', message: 'limited' } }))
      .toEqual({ type: 'done', value: 1, error: { kind: 'output-limit', message: 'limited' } })

    for (const raw of [null, 3, 'x', {}, { type: 'unknown' }, { type: 'log', text: 1 }, { type: 'call', id: -1, global: 'tools', name: 'x', args: null }, { type: 'call', id: 1, global: 'tools', name: 'x' }, { type: 'done', error: null }, { type: 'done', error: { kind: 'timeout', message: 'x' } }]) {
      expect(validateChildFrame(raw)).toBeUndefined()
    }
  })

  it('rejects lossy numbers and integer tokens before dispatch', () => {
    expect(hasNonLosslessNumber({ nested: [1, -0] })).toBe(true)
    expect(hasNonLosslessNumber({ nested: [1, 1.5] })).toBe(false)
    expect(validateChildFrame({ type: 'call', id: 1, global: 'tools', name: 'x', args: Infinity })).toBeUndefined()
    expect(hasUnsafeIntegerToken('{"n":9007199254740993}')).toBe(true)
    expect(hasUnsafeIntegerToken('{"n":999999999999999999999999999999999999}')).toBe(true)
    expect(hasUnsafeIntegerToken(`{"n":${'9'.repeat(400)}}`)).toBe(true)
    expect(hasUnsafeIntegerToken('{"n":9007199254740992,"text":"9007199254740993"}')).toBe(false)
    const inherited = Object.create({ value: -0 }) as { own?: number }
    inherited.own = 1
    expect(hasNonLosslessNumber(inherited)).toBe(false)
  })

  it('encodes deep JSON without recursion and preserves exact integral doubles', () => {
    let deep: unknown = 0
    for (let depth = 0; depth < 10_000; depth++) deep = [deep]
    expect(encodeJsonPlain(deep)).toBe(`${'['.repeat(10_000)}0${']'.repeat(10_000)}`)
    expect(encodeJsonPlain(JSON.parse('[1152921504606846976]'))).toBe('[1152921504606846976]')
  })
})
