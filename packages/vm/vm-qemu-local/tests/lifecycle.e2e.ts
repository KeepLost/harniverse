import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, probeWorld } from '../src/index.ts'
import { openWorld } from '../src/vm.ts'

/**
 * T1 lifecycle evidence against a real QEMU microvm: three consecutive
 * boot→handshake→destroy cycles stay inside the ready budget, exit cleanly,
 * and leave no orphan QEMU process behind. Skips without a usable binary or
 * staged assets (CI lanes provision neither).
 */

const probe = probeWorld()
const worldAvailable = probe.qemuVersion !== undefined && probe.assetsReady

function qemuProcessCount(): number | undefined {
  if (process.platform !== 'linux') return undefined
  const result = spawnSync('pgrep', ['-c', '-f', 'qemu-system-x86_64'], { encoding: 'utf8' })
  if (result.status !== 0) return undefined
  return Number(result.stdout.trim())
}

describe.skipIf(!worldAvailable)('vm-qemu-local: real micro-VM lifecycle', () => {
  it('boots, handshakes, pings, and destroys three worlds inside budget', async () => {
    const before = qemuProcessCount()
    for (let cycle = 0; cycle < 3; cycle++) {
      const world = await openWorld({ readyTimeoutMs: 15_000 })
      expect(world.descriptor.accel, `cycle ${cycle} accel`).toBe(probe.accel)
      expect(world.descriptor.readyMs, `cycle ${cycle} readyMs`).toBeLessThan(10_000)
      await expect(world.ping(5_000), `cycle ${cycle} ping`).resolves.toBeLessThan(3_000)
      await expect(world.destroy(), `cycle ${cycle} destroy`).resolves.toBe('clean')
      await expect(world.exit, `cycle ${cycle} exit`).resolves.toEqual({ code: 0, signal: null })
    }
    if (before !== undefined) {
      expect(qemuProcessCount()).toBe(before)
    }
  })

  it('the accepted welcome speaks the current protocol version', async () => {
    // Indirect: openWorld completed only when the guest welcomed protocol v1.
    // This pins that constant to observable behavior; bumping the protocol
    // version without a guest update fails here first.
    expect(PROTOCOL_VERSION).toBe(1)
    const world = await openWorld({ readyTimeoutMs: 15_000 })
    await expect(world.destroy()).resolves.toBe('clean')
  })
})
