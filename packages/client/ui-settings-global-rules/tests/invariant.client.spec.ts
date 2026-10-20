/** The package's invariant companion: an explained empty installer. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as GlobalRulesInvariant from '@deepseek-ai/dsh-client-ui-settings-global-rules/invariant'

describe('invariant companion', () => {
  it('reserves package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(GlobalRulesInvariant).await()).resolves.toBeDefined()
  })
})
