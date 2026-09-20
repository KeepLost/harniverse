/**
 * remote-mock invariant companion registration.
 */
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as RemoteMockInvariant from '../src/invariant.ts'

describe('remote-mock invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(RemoteMockInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-remote-mock', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
