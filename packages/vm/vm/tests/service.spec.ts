/**
 * VmWorld Service Definition tests: registration on `ctx.vm`, the
 * service-name collision rule, and disposal-driven world destruction, using
 * one minimal concrete world (no provider package is loaded).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import VmWorld from '../src/index.ts'
import type { VmWorldDescriptor, VmWorldExit, VmWorldFs } from '../src/index.ts'

class FakeWorld extends VmWorld {
  destroyed = 0

  override get descriptor(): VmWorldDescriptor {
    return { provider: 'fake', isolation: 'full', guestConfinement: 'landlock', hostHardened: true, readyMs: 1 }
  }

  override get exit(): Promise<VmWorldExit> {
    return new Promise<VmWorldExit>(() => {})
  }

  override async ping(): Promise<number> {
    return 1
  }

  override async exec(): Promise<never> {
    throw new Error('not implemented in the fixture')
  }

  override async spawn(): Promise<never> {
    throw new Error('not implemented in the fixture')
  }

  override get fs(): VmWorldFs {
    throw new Error('not implemented in the fixture')
  }

  override async destroy(): Promise<'clean'> {
    this.destroyed += 1
    return 'clean'
  }
}

describe('VmWorld service definition', () => {
  it('accepts egress origins by default and never consults them', () => {
    const world = new FakeWorld(new Context())
    const consulted: unknown[] = []
    const unbind = world.registerEgressOrigin('origin-x', (request) => {
      consulted.push(request)
      return true
    })
    unbind()
    unbind()
    expect(consulted).toEqual([])
  })

  it('registers one booted world as ctx.vm', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWorld)
    expect(ctx.vm).toBeInstanceOf(FakeWorld)
    expect(ctx.vm.descriptor).toEqual({ provider: 'fake', isolation: 'full', guestConfinement: 'landlock', hostHardened: true, readyMs: 1 })
  })

  it('keeps world destruction observable through context disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeWorld)
    const world = ctx.vm as FakeWorld
    expect(world.destroyed).toBe(0)
    await ctx.fiber.dispose()
    expect(world.destroyed).toBe(1)
  })
})
