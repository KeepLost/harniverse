import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as PluginDiagnosticsCordisInvariant from '../src/invariant.ts'

describe('plugin-diagnostics-cordis invariant companion', () => {
  it('registers the package-owned empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(PluginDiagnosticsCordisInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.plugin(PluginDiagnosticsCordisInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
