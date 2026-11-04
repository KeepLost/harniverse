import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { probeWorld } from '../src/index.ts'
import { openWorld } from '../src/vm.ts'
import { applyWorkspaceDiff, diffWorkspaceTars, packWorkspaceTar, readWorkspaceTar } from '../src/workspace.ts'

/**
 * M5 data-plane evidence against a real QEMU microvm: snapshot import into
 * `/workspace`, diff export back, and the round-trip through a second boot —
 * plus honest throughput lines for 10/100 MiB payloads and the one-transfer
 * busy guard. Skips without a usable binary or staged assets (CI lanes
 * provision neither).
 */

const probe = probeWorld()
const worldAvailable = probe.qemuVersion !== undefined && probe.assetsReady

const MIB = 1024 * 1024

function qemuProcessCount(): number | undefined {
  if (process.platform !== 'linux') return undefined
  const result = spawnSync('pgrep', ['-c', '-f', 'qemu-system-x86_64'], { encoding: 'utf8' })
  if (result.status !== 0) return undefined
  return Number(result.stdout.trim())
}

describe.skipIf(!worldAvailable)('vm-qemu-local: workspace data plane', () => {
  it('imports a snapshot, exports the diff, and round-trips it through a second boot', { timeout: 180_000 }, async () => {
    const before = qemuProcessCount()
    const base = packWorkspaceTar([
      { path: 'notes/a.txt', kind: 'file', data: Buffer.from('hello workspace\n') },
      { path: 'notes/b.txt', kind: 'file', data: Buffer.from('second file\n') },
      { path: 'bin/payload.bin', kind: 'file', data: Buffer.alloc(10 * MIB, 7) },
    ])
    const world = await openWorld({ workspace: { import: base }, readyTimeoutMs: 20_000 })
    try {
      const imported = await world.workspace.import()
      expect(imported.bytes).toBe(base.length)
      await expect(world.fs.readFile('/workspace/notes/a.txt')).resolves.toEqual(Buffer.from('hello workspace\n'))
      await expect(world.fs.stat('/workspace/bin/payload.bin')).resolves.toMatchObject({ size: 10 * MIB })

      await world.fs.writeFile('/workspace/notes/a.txt', 'hello modified\n')
      await world.fs.unlink('/workspace/notes/b.txt')
      await world.fs.writeFile('/workspace/new.txt', 'brand new\n')

      const exported = await world.workspace.export()
      expect(exported.bytes).toBeGreaterThan(0)
      const diff = diffWorkspaceTars(base, exported.tar)
      expect(diff.changed.map(entry => entry.path).sort()).toEqual(['new.txt', 'notes/a.txt'])
      expect(diff.removed).toEqual(['notes/b.txt'])

      const next = applyWorkspaceDiff(base, diff)
      const second = await openWorld({ workspace: { import: next }, readyTimeoutMs: 20_000 })
      try {
        await second.workspace.import()
        await expect(second.fs.readFile('/workspace/notes/a.txt')).resolves.toEqual(Buffer.from('hello modified\n'))
        await expect(second.fs.readFile('/workspace/new.txt')).resolves.toEqual(Buffer.from('brand new\n'))
        await expect(second.fs.stat('/workspace/notes/b.txt')).rejects.toMatchObject({ code: 'ENOENT' })
        const again = await second.workspace.export()
        expect(diffWorkspaceTars(next, again.tar)).toEqual({ changed: [], removed: [] })
      } finally {
        await second.destroy()
      }
    } finally {
      await world.destroy()
    }
    if (before !== undefined) {
      expect(qemuProcessCount()).toBe(before)
    }
  })

  it('moves 10 and 100 MiB payloads at data-plane speed', { timeout: 300_000 }, async () => {
    for (const sizeMiB of [10, 100]) {
      const payload = packWorkspaceTar([{ path: 'bulk.bin', kind: 'file', data: Buffer.alloc(sizeMiB * MIB, 3) }])
      // The workspace lives in the guest's ramfs root, so the guest needs
      // headroom beyond the payload; 512 MiB carries the 100 MiB case.
      const world = await openWorld({ workspace: { import: payload }, memoryMiB: 512, readyTimeoutMs: 20_000 })
      try {
        const importStart = Date.now()
        await world.workspace.import()
        const importMs = Date.now() - importStart
        const exportStart = Date.now()
        const exported = await world.workspace.export()
        const exportMs = Date.now() - exportStart
        expect(exported.bytes).toBe(exported.tar.length)
        const files = readWorkspaceTar(exported.tar)
        expect(files.find(entry => entry.path === 'bulk.bin')?.kind).toBe('file')
        console.log(`[bench] workspace ${sizeMiB} MiB: import ${importMs}ms (${(sizeMiB / (importMs / 1000)).toFixed(1)} MiB/s), export ${exportMs}ms (${(sizeMiB / (exportMs / 1000)).toFixed(1)} MiB/s incl. tar+fsync)`)
        expect(sizeMiB / (importMs / 1000)).toBeGreaterThan(5)
      } finally {
        await world.destroy()
      }
    }
  })

  it('answers busy for a second transfer while one runs', { timeout: 120_000 }, async () => {
    const payload = packWorkspaceTar([{ path: 'busy.bin', kind: 'file', data: Buffer.alloc(50 * MIB, 5) }])
    const world = await openWorld({ workspace: { import: payload }, readyTimeoutMs: 20_000 })
    try {
      const first = world.workspace.import()
      await expect(world.workspace.import()).rejects.toThrow('busy')
      await expect(first).resolves.toMatchObject({ bytes: payload.length })
    } finally {
      await world.destroy()
    }
  })
})
