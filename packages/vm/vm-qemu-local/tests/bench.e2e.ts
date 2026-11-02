import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { probeWorld } from '../src/index.ts'
import { openWorld, type WorldHandle } from '../src/vm.ts'

/**
 * T8 and T10 evidence against a real guest. T8: honest real-workload numbers
 * under TCG — sha256 over 20 MiB of urandom, tar+gzip over a 100 MiB tree,
 * and the control-protocol fs datapoints (the workspace-form decision input;
 * 9p adoption itself is out of scope). T10: boot repeatability (three
 * consecutive ready times within ±20 %) and RSS drift over 100 fs ops (<10 %).
 * Numbers print as `[bench]` lines; MEASUREMENTS.md records a full run.
 */

const probe = probeWorld()
const worldAvailable = probe.qemuVersion !== undefined && probe.assetsReady

/** Resolve the QEMU process id behind a world (the wrapper execs in place, keeping its pid). */
function qemuPidOf(world: WorldHandle): number {
  const pid = world.descriptor.pid
  if (pid === undefined) throw new Error('world descriptor exposes no pid')
  return pid
}

/** Read one numeric field (kB) from the QEMU process's /proc status. */
function rssKibOf(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const match = /VmRSS:\s+(\d+) kB/.exec(status)
  if (match === null) throw new Error(`VmRSS missing for pid ${pid}`)
  return Number(match[1])
}

/** Time one guest command host-side and return the milliseconds it took. */
async function timeExec(world: WorldHandle, argv: readonly string[]): Promise<number> {
  const started = performance.now()
  const result = await world.exec(argv)
  if (result.code !== 0) {
    throw new Error(`${argv.join(' ')} exited ${result.code}: ${result.stderr.toString('utf8')}`)
  }
  return performance.now() - started
}

describe.skipIf(!worldAvailable)('vm-qemu-local: honest measurements over a real micro-VM', () => {
  it('T8: reports real-workload numbers for hashing, archiving, and protocol fs', async () => {
    const world = await openWorld({ readyTimeoutMs: 20_000 })
    try {
      console.log(`[bench] environment: qemu=${probe.qemuVersion} accel=${world.descriptor.accel} `
        + `cpus=${world.descriptor.cpus} memoryMiB=${world.descriptor.memoryMiB} `
        + `sandboxed=${world.descriptor.sandboxed} readyMs=${world.descriptor.readyMs}`)

      // sha256 over 20 MiB of urandom: generation is not the measurement.
      // The applet has no /bin symlink in the minirootfs; busybox resolves it.
      await world.exec(['/bin/dd', 'if=/dev/urandom', 'of=/tmp/bench-20m', 'bs=1M', 'count=20'])
      const shaMs = await timeExec(world, ['/bin/busybox', 'sha256sum', '/tmp/bench-20m'])
      console.log(`[bench] sha256 20MiB: ${shaMs.toFixed(0)} ms (${(20 / (shaMs / 1000)).toFixed(1)} MiB/s)`)
      await world.exec(['/bin/rm', '/tmp/bench-20m'])

      // tar+gzip over 100 MiB: zeros keep the tree generation cheap and the
      // compression cost representative of a best-case payload. /tmp is the
      // ramfs-backed initramfs root, so the input must fit beside the archive.
      await world.exec(['/bin/dd', 'if=/dev/zero', 'of=/tmp/bench-100m', 'bs=1M', 'count=100'])
      const tarMs = await timeExec(world, ['/bin/tar', '-czf', '/tmp/bench-100m.tgz', '-C', '/tmp', 'bench-100m'])
      const listing = (await world.exec(['/bin/ls', '-l', '/tmp/bench-100m.tgz'])).stdout.toString('utf8')
      console.log(`[bench] tar+gzip 100MiB: ${tarMs.toFixed(0)} ms (${(100 / (tarMs / 1000)).toFixed(1)} MiB/s) ${listing.trim()}`)
      await world.exec(['/bin/rm', '/tmp/bench-100m', '/tmp/bench-100m.tgz'])

      // Protocol fs datapoint: a sampled 1 MiB through world.fs in 64 KiB
      // chunks (well under both the 512 KiB write cap and the 10 s control
      // reply budget — larger payloads approach the reply timeout linearly,
      // the known ≈0.2 MiB/s control-UART ceiling). Sampled, not saturated:
      // the per-op costs extrapolate; T4 owns the file-count matrix.
      const chunk = Buffer.alloc(64 * 1024, 0x61)
      const writeStart = performance.now()
      for (let index = 0; index < 16; index += 1) await world.fs.writeFile(`/tmp/proto-${index}.bin`, chunk)
      const writeMs = performance.now() - writeStart
      const readStart = performance.now()
      for (let index = 0; index < 16; index += 1) {
        if ((await world.fs.readFile(`/tmp/proto-${index}.bin`)).length !== chunk.length) throw new Error('readback length mismatch')
      }
      const readMs = performance.now() - readStart
      console.log(`[bench] protocol fs 1MiB/64KiB chunks: write ${writeMs.toFixed(0)} ms `
        + `(${(1 / (writeMs / 1000)).toFixed(2)} MiB/s), read ${readMs.toFixed(0)} ms (${(1 / (readMs / 1000)).toFixed(2)} MiB/s)`)

      // Every workload completed; the numbers above are the deliverable.
      expect(shaMs).toBeGreaterThan(0)
      expect(tarMs).toBeGreaterThan(0)
      expect(writeMs).toBeGreaterThan(0)
      expect(readMs).toBeGreaterThan(0)
    } finally {
      await world.destroy()
    }
  }, 180_000)

  it('T10: three boots agree within ±20 % and 100 fs ops drift RSS by under 10 %', async () => {
    const readyTimes: number[] = []
    for (let boot = 0; boot < 3; boot += 1) {
      const world = await openWorld({ readyTimeoutMs: 30_000 })
      readyTimes.push(world.descriptor.readyMs)
      await world.destroy()
    }
    const median = [...readyTimes].sort((a, b) => a - b)[1]!
    console.log(`[bench] boot readyMs x3: ${readyTimes.map(ms => ms.toFixed(0)).join(' / ')} (median ${median.toFixed(0)})`)
    for (const ms of readyTimes) {
      expect(Math.abs(ms - median) / median, `boot ${ms} vs median ${median}`).toBeLessThanOrEqual(0.2)
    }

    const world = await openWorld({ readyTimeoutMs: 30_000 })
    try {
      const qemuPid = qemuPidOf(world)
      const before = rssKibOf(qemuPid)
      const payload = Buffer.alloc(1024, 0x63)
      for (let op = 0; op < 100; op += 1) await world.fs.writeFile(`/tmp/drift-${op}.bin`, payload)
      for (let op = 0; op < 100; op += 1) await world.fs.readFile(`/tmp/drift-${op}.bin`)
      const after = rssKibOf(qemuPid)
      const drift = Math.abs(after - before) / before
      console.log(`[bench] rss: ${before} KiB -> ${after} KiB over 100 write+read pairs (${(drift * 100).toFixed(1)} % drift)`)
      expect(drift).toBeLessThan(0.1)
    } finally {
      await world.destroy()
    }
  }, 180_000)
})
