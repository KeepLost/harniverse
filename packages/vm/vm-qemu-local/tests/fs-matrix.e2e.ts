import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, renameSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeWorld } from '../src/index.ts'
import { GuestFsError } from '../src/fs.ts'
import { openWorld } from '../src/vm.ts'

/**
 * T4 evidence against a real guest: the eight-op fs set behaves like the
 * host reference on the same tree, error codes included, and a 1000-file
 * write+readback cycle completes with byte-exact contents. Skips without a
 * usable binary or staged assets.
 */

const probe = probeWorld()
const worldAvailable = probe.qemuVersion !== undefined && probe.assetsReady

describe.skipIf(!worldAvailable)('vm-qemu-local: fs semantics matrix over a real micro-VM', () => {
  it('T4: the eight ops match the host reference, error codes included', async () => {
    const world = await openWorld({ readyTimeoutMs: 20_000 })
    try {
      const hostRoot = mkdtempSync(join(tmpdir(), 'dsh-vm-t4-host-'))
      const guestRoot = '/tmp/t4'
      const cases = ['alpha.txt', 'with space.txt', 'nested']

      // mkdir + writeFile (single-level, matching the host reference)
      await world.fs.mkdir(guestRoot)
      await world.fs.mkdir(join(guestRoot, 'nested'))
      mkdirSync(join(hostRoot, 'nested'))
      const payload = 'matrix payload'
      await world.fs.writeFile(join(guestRoot, 'alpha.txt'), payload)
      writeFileSync(join(hostRoot, 'alpha.txt'), payload)
      await world.fs.writeFile(join(guestRoot, 'with space.txt'), payload)
      writeFileSync(join(hostRoot, 'with space.txt'), payload)

      // readFile equality
      expect((await world.fs.readFile(join(guestRoot, 'alpha.txt'))).toString('utf8'))
        .toBe(readFileSync(join(hostRoot, 'alpha.txt'), 'utf8'))

      // stat equality on shape: type and size
      const guestStat = await world.fs.stat(join(guestRoot, 'alpha.txt'))
      const hostStat = statSync(join(hostRoot, 'alpha.txt'))
      expect(guestStat.kind).toBe('file')
      expect(guestStat.size).toBe(hostStat.size)
      const guestDirStat = await world.fs.stat(join(guestRoot, 'nested'))
      expect(guestDirStat.kind).toBe('dir')

      // list equality
      expect((await world.fs.list(guestRoot)).map(entry => entry.name).sort()).toEqual(readdirSync(hostRoot).sort())
      expect(cases.length).toBe(3)

      // rename equality
      await world.fs.rename(join(guestRoot, 'alpha.txt'), join(guestRoot, 'nested', 'moved.txt'))
      renameSync(join(hostRoot, 'alpha.txt'), join(hostRoot, 'nested', 'moved.txt'))
      expect((await world.fs.list(guestRoot)).map(entry => entry.name).sort()).toEqual(readdirSync(hostRoot).sort())
      expect((await world.fs.readFile(join(guestRoot, 'nested', 'moved.txt'))).toString('utf8'))
        .toBe(readFileSync(join(hostRoot, 'nested', 'moved.txt'), 'utf8'))

      // error parity: ENOENT, ENOTEMPTY, then success paths
      const guestMissing = await world.fs.readFile(join(guestRoot, 'gone')).catch((error: unknown) => error)
      const hostMissing = await new Promise<unknown>((resolve) => {
        try {
          resolve(readFileSync(join(hostRoot, 'gone')))
        } catch (error) {
          resolve(error)
        }
      })
      expect(guestMissing).toBeInstanceOf(GuestFsError)
      expect((guestMissing as GuestFsError).code).toBe((hostMissing as NodeJS.ErrnoException).code)

      const guestNotEmpty = await world.fs.rmdir(guestRoot).catch((error: unknown) => error)
      expect(guestNotEmpty).toBeInstanceOf(GuestFsError)
      expect((guestNotEmpty as GuestFsError).code).toBe('ENOTEMPTY')

      const guestNestedNotEmpty = await world.fs.rmdir(join(guestRoot, 'nested')).catch((error: unknown) => error)
      const hostNestedNotEmpty = await new Promise<unknown>((resolve) => {
        try {
          rmdirSync(join(hostRoot, 'nested'))
          resolve(undefined)
        } catch (error) {
          resolve(error)
        }
      })
      expect((guestNestedNotEmpty as GuestFsError).code).toBe((hostNestedNotEmpty as NodeJS.ErrnoException).code)

      // unlink + rmdir success parity
      await world.fs.unlink(join(guestRoot, 'nested', 'moved.txt'))
      unlinkSync(join(hostRoot, 'nested', 'moved.txt'))
      await world.fs.unlink(join(guestRoot, 'with space.txt'))
      unlinkSync(join(hostRoot, 'with space.txt'))
      await world.fs.rmdir(join(guestRoot, 'nested'))
      rmdirSync(join(hostRoot, 'nested'))
      expect((await world.fs.list(guestRoot)).map(entry => entry.name).sort()).toEqual(readdirSync(hostRoot).sort())
      rmSync(hostRoot, { recursive: true, force: true })
    } finally {
      await world.destroy()
    }
  }, 120_000)

  it('T4: 1000-file write+readback cycle returns byte-exact contents', async () => {
    const world = await openWorld({ readyTimeoutMs: 20_000 })
    try {
      const count = 1000
      await world.fs.mkdir('/tmp/t4bench')
      const startedAt = Date.now()
      for (let i = 0; i < count; i++) {
        await world.fs.writeFile(`/tmp/t4bench/f-${i}`, `payload-${i}-0123456789abcdef`)
      }
      for (let i = 0; i < count; i++) {
        const content = (await world.fs.readFile(`/tmp/t4bench/f-${i}`)).toString('utf8')
        if (content !== `payload-${i}-0123456789abcdef`) throw new Error(`content mismatch at f-${i}`)
      }
      const elapsedMs = Date.now() - startedAt
      // Pass line is semantic: every byte round-trips. The wall time is the
      // recorded TCG data point; no hard throughput line on this lane.
      console.log(`T4: ${count}-file guest write+readback round trip: ${elapsedMs}ms (${count * 2} ops)`)
      expect(elapsedMs).toBeGreaterThan(0)
    } finally {
      await world.destroy()
    }
  }, 300_000)
})
