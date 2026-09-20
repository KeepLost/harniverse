import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/invariant.ts'

describe('mcp-resources invariant companion', () => {
  it('registers package ownership and returns its disposer', async () => {
    const registered: string[] = []
    const ctx = new Context()
    ctx.provide('invariants')
    ctx.set('invariants', {
      register: (pkg: string) => { registered.push(pkg); return () => {} },
    } as never)
    const dispose = await apply(ctx)
    expect(registered).toEqual(['@deepseek-ai/dsh-mcp-resources'])
    expect(dispose).toBeTypeOf('function')
  })
})
