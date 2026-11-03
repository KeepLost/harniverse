/**
 * VmSandboxProvider tests: registration on `ctx.sandbox`, fail-closed
 * refusal for every confined mode with the world-boundary rationale, and
 * abort passthrough.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { VmWorld } from '@deepseek-ai/dsh-vm'
import type { VmWorldDescriptor, VmWorldExit } from '@deepseek-ai/dsh-vm'
import VmSandboxProvider from '../src/index.ts'

class BoundaryWorld extends VmWorld {
  override get descriptor(): VmWorldDescriptor {
    return { provider: 'fake', isolation: 'full', hostHardened: true, readyMs: 0 }
  }

  override get exit(): Promise<VmWorldExit> {
    return new Promise<VmWorldExit>(() => {})
  }

  override async ping(): Promise<number> {
    return 0
  }

  override async exec(): Promise<never> {
    throw new Error('not implemented in the fixture')
  }

  override async spawn(): Promise<never> {
    throw new Error('not implemented in the fixture')
  }

  override get fs(): never {
    throw new Error('not implemented in the fixture')
  }

  override async destroy(): Promise<'clean'> {
    return 'clean'
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  new BoundaryWorld(ctx)
  await ctx.plugin(VmSandboxProvider)
  return ctx
}

describe('VmSandboxProvider', () => {
  it('registers over the world as ctx.sandbox', async () => {
    const ctx = await setup()
    expect(ctx.sandbox).toBeInstanceOf(VmSandboxProvider)
    await ctx.fiber.dispose()
  })

  it('fails closed for read-only with the world-boundary rationale', async () => {
    const ctx = await setup()
    const policy = { mode: 'read-only' as const, workspaceRoot: '/ws' }
    await expect(ctx.sandbox.confine(['bash'], policy)).rejects.toBeInstanceOf(SandboxUnavailableError)
    await expect(ctx.sandbox.confine(['bash'], policy)).rejects.toThrow('no in-guest confinement backend for mode "read-only"')
    await ctx.fiber.dispose()
  })

  it('fails closed for workspace-write the same way', async () => {
    const ctx = await setup()
    await expect(ctx.sandbox.confine(['bash'], { mode: 'workspace-write', workspaceRoot: '/ws' })).rejects.toMatchObject({
      code: SANDBOX_UNAVAILABLE,
    })
    await ctx.fiber.dispose()
  })

  it('surfaces a caller abort before the refusal', async () => {
    const ctx = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.sandbox.confine(['bash'], { mode: 'read-only', workspaceRoot: '/ws' }, controller.signal)).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})
