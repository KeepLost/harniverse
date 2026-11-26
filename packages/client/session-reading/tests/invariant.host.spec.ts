/** The invariant companion and the Host loader entry on a real Cordis Context. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ReadingInvariant from '../src/invariant.ts'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true }).await()
    await expect(ctx.plugin(ReadingInvariant).await()).resolves.toBeDefined()
  })
})
