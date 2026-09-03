import { describe, expect, it } from 'vitest'
import { isMutatingRpcMethod, legacyRpcCapability } from '../src/api/rpc-map.ts'

describe('legacy RPC capability map', () => {
  it.each([
    ['session.list', 'harniverse.observe'],
    ['events.mux', 'harniverse.observe'],
    ['events.host', 'harniverse.observe'],
    ['session.export', 'harniverse.observe'],
    ['respond', 'harniverse.operate'],
  ])('resolves %s to %s', (endpoint, capability) => {
    expect(legacyRpcCapability(endpoint)).toBe(capability)
  })

  it('leaves unknown endpoints without a capability claim', () => {
    expect(legacyRpcCapability('unknown.endpoint')).toBeUndefined()
  })

  it.each([
    ['session.create', true],
    ['session.list', false],
  ] as const)('reports whether %s mutates state', (method, mutates) => {
    expect(isMutatingRpcMethod(method)).toBe(mutates)
  })
})
