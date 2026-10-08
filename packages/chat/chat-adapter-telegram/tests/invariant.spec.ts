/** The companion registers under the package name. */

import { describe, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as TelegramInvariant from '../src/invariant.ts'

describe('invariant companion', () => {
  it('registers under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(TelegramInvariant)
    await ctx.fiber.dispose()
  })
})
