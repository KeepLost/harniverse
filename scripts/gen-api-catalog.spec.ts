import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RPC_METHOD_CAPABILITIES, RPC_METHOD_METADATA } from '../packages/host/apiproxy/src/api/rpc-map.ts'
import { RPC_ERROR_CODES } from '../packages/host/apiproxy/src/api/rpc.ts'
import { rpcErrorSchema } from '../packages/host/apiproxy/src/api/rpc.schema.ts'
import { buildApiCatalog } from './gen-api-catalog.ts'

const CAPABILITIES = ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'] as const

describe('api catalog', () => {
  it('locks the committed artifact to the runtime registries', () => {
    const committed = readFileSync(resolve(import.meta.dirname, '../docs/api-catalog.json'), 'utf8')
    expect(committed).toBe(`${JSON.stringify(buildApiCatalog(), null, 2)}\n`)
  })

  it('describes every unary method exactly once with a valid capability and effect', () => {
    const methods = RPC_METHOD_METADATA.map(entry => entry.method)
    expect(new Set(methods).size).toBe(methods.length)
    expect(methods.sort()).toEqual([...Object.keys(RPC_METHOD_CAPABILITIES)].sort())
    for (const entry of RPC_METHOD_METADATA) {
      expect(CAPABILITIES).toContain(entry.requiredCapability)
      expect(['read', 'mutate']).toContain(entry.effect)
      expect(['stable', 'deprecated']).toContain(entry.stability)
      if (entry.stability === 'deprecated') expect(entry.replacement).toBeTypeOf('string')
      else expect(entry.replacement).toBeUndefined()
    }
  })

  it('keeps the error-code registry duplicate-free and aligned with the wire schema branches', () => {
    expect(new Set(RPC_ERROR_CODES).size).toBe(RPC_ERROR_CODES.length)
    const branches = rpcErrorSchema as unknown as { options: Array<{ shape: { code: { value: string } } }> }
    const branchCodes = branches.options.map(option => option.shape.code.value)
    expect(new Set(branchCodes)).toEqual(new Set(RPC_ERROR_CODES))
  })
})
