/** The package's invariant companion: an explained empty installer. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SoundInvariant from '@deepseek-ai/dsh-client-ui-sound/invariant'

describe('invariant companion', () => {
  it('reserves package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(SoundInvariant).await()).resolves.toBeDefined()
  })
})
