import { describe, expect, it } from 'vitest'
import { GuestFsError, probeWorld } from '../src/index.ts'
import { openWorld } from '../src/vm.ts'

/**
 * fs smoke against a real guest: every op of the eight-op set round-trips
 * once and guest errnos surface as Node-style codes. The full semantic
 * matrix against a host-side reference is the next milestone's T4.
 */

const probe = probeWorld()
const worldAvailable = probe.qemuVersion !== undefined && probe.assetsReady

describe.skipIf(!worldAvailable)('vm-qemu-local: fs over a real micro-VM', () => {
  it('round-trips the eight-op set', async () => {
    const world = await openWorld({ readyTimeoutMs: 15_000 })
    try {
      await world.fs.mkdir('/tmp/m1', { recursive: true })
      await world.fs.writeFile('/tmp/m1/file.txt', 'round-trip')
      await expect(world.fs.readFile('/tmp/m1/file.txt')).resolves.toEqual(Buffer.from('round-trip'))

      const stat = await world.fs.stat('/tmp/m1/file.txt')
      expect(stat.kind).toBe('file')
      expect(stat.size).toBe(10)
      expect(stat.mode & 0o777).toBe(0o644)

      const dirStat = await world.fs.stat('/tmp/m1')
      expect(dirStat.kind).toBe('dir')

      const entries = await world.fs.list('/tmp/m1')
      expect(entries).toEqual([{ name: 'file.txt', kind: 'file' }])

      await world.fs.rename('/tmp/m1/file.txt', '/tmp/m1/renamed.txt')
      await expect(world.fs.list('/tmp/m1')).resolves.toEqual([{ name: 'renamed.txt', kind: 'file' }])

      await world.fs.unlink('/tmp/m1/renamed.txt')
      await world.fs.rmdir('/tmp/m1')

      const missing = await world.fs.stat('/tmp/gone').catch((error: unknown) => error)
      expect(missing).toBeInstanceOf(GuestFsError)
      expect(missing).toMatchObject({ code: 'ENOENT' })
    } finally {
      await world.destroy()
    }
  })

  it('surfaces semantic errors for wrong kinds and non-empty directories', async () => {
    const world = await openWorld({ readyTimeoutMs: 15_000 })
    try {
      await world.fs.mkdir('/tmp/m2')
      await world.fs.writeFile('/tmp/m2/kept.txt', 'x')
      const readDir = await world.fs.readFile('/tmp/m2').catch((error: unknown) => error)
      expect(readDir).toMatchObject({ name: 'GuestFsError', code: 'EISDIR' })
      const busy = await world.fs.rmdir('/tmp/m2').catch((error: unknown) => error)
      expect(busy).toMatchObject({ name: 'GuestFsError', code: 'ENOTEMPTY' })
      const existing = await world.fs.mkdir('/tmp/m2').catch((error: unknown) => error)
      expect(existing).toMatchObject({ name: 'GuestFsError', code: 'EEXIST' })
      await world.fs.unlink('/tmp/m2/kept.txt')
      await world.fs.rmdir('/tmp/m2')
    } finally {
      await world.destroy()
    }
  })
})
