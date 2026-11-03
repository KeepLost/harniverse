import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { probeWorld, QemuLocalWorld } from '@deepseek-ai/dsh-vm-qemu-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import VmFileSystem from '../src/index.ts'

/**
 * Real-composition e2e: the provider serves `ctx.fs` over one real QEMU
 * world and model-facing file operations run against the guest's own
 * filesystem, policy-checked host-side. Skips without a usable binary or
 * staged assets (CI lanes provision neither).
 */

const probe = probeWorld()
const worldAvailable = probe.qemuVersion !== undefined && probe.assetsReady

describe.skipIf(!worldAvailable)('fs-vm: real world composition', () => {
  it('round-trips reads, guarded writes, edits, and policy denials inside the guest', async () => {
    const ctx = new Context()
    const world = new QemuLocalWorld(ctx, {})
    await world.ready
    await ctx.vm.fs.mkdir('/workspace', { recursive: true })
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/workspace' })
    await ctx.plugin(VmFileSystem)
    try {
      const target = await ctx.fs.resolve('/workspace/notes.txt')
      await expect(ctx.fs.writeText(target, 'first line\n', { kind: 'createIfAbsent' }, undefined, { mode: 'danger-full-access', workspaceRoot: '/workspace' })).resolves.toMatchObject({ operation: 'create' })
      await expect(ctx.fs.readText(target)).resolves.toBe('first line\n')
      const observed = await ctx.fs.stat(target)
      expect(observed).toMatchObject({ type: 'file', size: 11 })
      if (observed === undefined) throw new Error('stat unexpectedly absent')

      const version = observed.version
      await expect(ctx.fs.writeText(target, 'second line\n', { kind: 'replaceIfVersion', version }, undefined, { mode: 'danger-full-access', workspaceRoot: '/workspace' })).resolves.toMatchObject({ operation: 'update', before: 'first line\n' })
      await expect(ctx.fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version }, undefined, { mode: 'danger-full-access', workspaceRoot: '/workspace' })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })

      await expect(ctx.fs.editText(target, { oldString: 'second', newString: 'third', replaceAll: false }, undefined, undefined, { mode: 'danger-full-access', workspaceRoot: '/workspace' })).resolves.toMatchObject({ before: 'second line\n', after: 'third line\n' })
      await expect(ctx.fs.readText(target)).resolves.toBe('third line\n')

      const entries = await ctx.fs.listDir(await ctx.fs.resolve('/workspace'))
      expect(entries.map(entry => entry.name)).toEqual(['notes.txt'])

      await expect(ctx.fs.writeText(target, 'x', undefined, undefined, { mode: 'read-only', workspaceRoot: '/workspace' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      const outside = await ctx.fs.resolve('/etc/hostname')
      await expect(ctx.fs.writeText(outside, 'x', undefined, undefined, { mode: 'workspace-write', workspaceRoot: '/workspace' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(world.descriptor.isolation).toBe('full')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)
})
