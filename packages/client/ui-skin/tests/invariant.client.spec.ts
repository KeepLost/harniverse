import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SkinInvariant from '../src/invariant.ts'

describe('ui-skin invariant companion', () => {
  it('registers the empty installer and keeps the node half inert', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SkinInvariant).await()).resolves.toBeDefined()
    expect(SkinInvariant.name).toBe('client-ui-skin-invariant')
    expect(SkinInvariant.inject).toEqual(['invariants'])
    const { apply } = await import('../src/index.ts')
    apply()
    await ctx.fiber.dispose()
  })
})
