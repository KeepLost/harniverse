/**
 * VmSandboxProvider tests: registration on `ctx.sandbox`, real confined argv
 * through the in-guest Landlock wrapper when the world proves the backend,
 * fail-closed refusal when it does not, and abort passthrough.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import { VmWorld } from '@deepseek-ai/dsh-vm'
import type { VmWorldDescriptor, VmWorldExit } from '@deepseek-ai/dsh-vm'
import VmSandboxProvider from '../src/index.ts'

class BoundaryWorld extends VmWorld {
  constructor(ctx: Context, readonly confinement: VmWorldDescriptor['guestConfinement']) {
    super(ctx)
  }

  override get descriptor(): VmWorldDescriptor {
    return { provider: 'fake', isolation: 'full', guestConfinement: this.confinement, hostHardened: true, readyMs: 0 }
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

async function setup(confinement: VmWorldDescriptor['guestConfinement'] = 'landlock'): Promise<Context> {
  const ctx = new Context()
  new BoundaryWorld(ctx, confinement)
  await ctx.plugin(VmSandboxProvider)
  return ctx
}

describe('VmSandboxProvider', () => {
  it('registers over the world as ctx.sandbox', async () => {
    const ctx = await setup()
    expect(ctx.sandbox).toBeInstanceOf(VmSandboxProvider)
    await ctx.fiber.dispose()
  })

  it('wraps argv with the in-guest Landlock wrapper under read-only', async () => {
    const ctx = await setup()
    const confined: ConfinedArgv = await ctx.sandbox.confine(['bash', '-c', 'ls'], { mode: 'read-only', workspaceRoot: '/workspace' })
    expect(confined.argv).toEqual(['/bin/dsh-vm-confine', '--ro', '/', '--rw', '/dev/null', '--', 'bash', '-c', 'ls'])
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toEqual(['permission denied'])
    expect(confined.runnerFailureRules).toEqual([{ fatalSignatures: ['dsh-vm-confine:'] }])
    await ctx.fiber.dispose()
  })

  it('grants the workspace and the world temp area under workspace-write', async () => {
    const ctx = await setup()
    const confined = await ctx.sandbox.confine(['bash'], { mode: 'workspace-write', workspaceRoot: '/workspace' })
    expect(confined.argv).toEqual([
      '/bin/dsh-vm-confine', '--ro', '/',
      '--rw', '/dev/null', '--rw', '/tmp', '--rw', '/workspace',
      '--', 'bash',
    ])
    expect(confined.enforcement).toBe('full')
    await ctx.fiber.dispose()
  })

  it('fails closed for every confined mode when the guest proves no backend', async () => {
    const ctx = await setup('none')
    const policy = { mode: 'read-only' as const, workspaceRoot: '/ws' }
    await expect(ctx.sandbox.confine(['bash'], policy)).rejects.toBeInstanceOf(SandboxUnavailableError)
    await expect(ctx.sandbox.confine(['bash'], policy)).rejects.toThrow('the world guest reports no in-guest confinement backend')
    await expect(ctx.sandbox.confine(['bash'], { mode: 'workspace-write', workspaceRoot: '/ws' })).rejects.toMatchObject({
      code: SANDBOX_UNAVAILABLE,
    })
    await ctx.fiber.dispose()
  })

  it('surfaces a caller abort before any wrap', async () => {
    const ctx = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.sandbox.confine(['bash'], { mode: 'read-only', workspaceRoot: '/ws' }, controller.signal)).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})
