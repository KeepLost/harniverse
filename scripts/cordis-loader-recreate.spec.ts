/** A Loader entry created again under a just-removed id starts after the previous fiber finished unloading. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, onTestFinished } from 'vitest'

describe('Loader entry recreation', () => {
  it('starts the recreated entry only after the removed fiber released what it held', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Loader)
    const events: string[] = []
    let holder = 0
    ctx.loader.builtins.seated = {
      name: 'seated',
      apply(owner: Context) {
        if (holder !== 0) {
          events.push(`refused by ${String(holder)}`)
          throw new Error('the seat is taken')
        }
        holder = events.push('taken')
        owner.effect(() => async () => {
          await new Promise(resolve => setTimeout(resolve, 20))
          holder = 0
          events.push('released')
        })
      },
    }
    // Reconciled as Include reconciles a file: the row leaves in one pass and returns in the next.
    const row: EntryOptions = { id: 'seat', name: 'cordis:seated' }
    await ctx.loader.root.update([row])
    await ctx.loader.await()
    await ctx.loader.root.update([])
    await ctx.loader.root.update([row])
    await ctx.loader.await()
    expect(events).toEqual(['taken', 'released', 'taken'])
    expect(ctx.loader.resolve('seat').fiber?.state).toBe(FiberState.ACTIVE)
  })
})
