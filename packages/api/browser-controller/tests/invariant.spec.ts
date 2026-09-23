/** The package's invariant companion: ownership reservation without a runtime audit. */
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as BrowserInvariant from '../src/invariant.ts'

describe('browser-controller invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(BrowserInvariant)
    await fiber.await()
    expect(BrowserInvariant.name).toBe('browser-controller-invariant')
    expect(BrowserInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('browser/opened') }).not.toThrow()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
