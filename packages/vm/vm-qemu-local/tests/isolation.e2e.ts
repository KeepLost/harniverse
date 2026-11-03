import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeWorld } from '../src/index.ts'
import { resolveWrapPath } from '../src/qemu.ts'
import { openWorld } from '../src/vm.ts'

/**
 * T5 and T7 evidence against a real guest. T5: the guest sees its own root
 * filesystem and process space only — no host directories, a handful of
 * guest PIDs, and `lo` as the only network interface. T7: when the sandbox
 * wrapper is staged and the host runs as root, the QEMU child runs as uid
 * 65534 under Landlock, a root-only canary outside the scratch directory
 * reads EACCES, and writes outside the scratch directory are denied.
 */

const probe = probeWorld()
const worldAvailable = probe.qemuVersion !== undefined && probe.assetsReady
const wrapPath = resolveWrapPath(probe.assetsDir)
const canDrop = wrapPath !== undefined && process.geteuid?.() === 0

/** Run one supervised command line through the wrapper and collect results. */
function runWrapped(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-vm-t7-scratch-'))
  try {
    const result = spawnSync(wrapPath ?? 'qemu-wrap', ['--scratch', scratch, '--', ...args], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe.skipIf(!worldAvailable)('vm-qemu-local: guest isolation over a real micro-VM', () => {
  it('T5: the guest filesystem, process space, and network are its own', async () => {
    const world = await openWorld({ readyTimeoutMs: 20_000 })
    try {
      const rootListing = (await world.exec(['/bin/ls', '/'])).stdout.toString('utf8')
        .split('\n').map(entry => entry.trim()).filter(entry => entry.length > 0).sort()
      // The root is exactly the pinned minirootfs layout plus agent mounts —
      // no host-specific trees can appear inside an initramfs-backed guest.
      expect(rootListing).toEqual([
        'bin', 'dev', 'etc', 'home', 'init', 'lib', 'media', 'mnt', 'opt',
        'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var',
      ])

      const psOutput = (await world.exec(['/bin/ps'])).stdout.toString('utf8')
      const commLines = psOutput.split('\n').map(line => line.trim()).filter(line => line.length > 0).slice(1)
      // Kernel threads aside, a fresh guest owns exactly its init and this
      // probe; a shared host would surface foreign process names here.
      const userland = commLines.filter(line => !line.includes(' ['))
      expect(userland.some(line => /\/init$/.test(line))).toBe(true)
      expect(userland.filter(line => /\/ps$/.test(line)).length).toBe(1)
      expect(userland.filter(line => !/(\/init|\/ps)$/.test(line))).toEqual([])

      const netInterfaces = (await world.fs.list('/sys/class/net')).map(entry => entry.name)
      expect(netInterfaces).toEqual(['lo'])
    } finally {
      await world.destroy()
    }
  }, 60_000)

  it('T5: guest writes never land on the host filesystem', async () => {
    const world = await openWorld({ readyTimeoutMs: 20_000 })
    try {
      await world.fs.writeFile('/tmp/host-probe', 'guest-only')
      expect(existsSync('/tmp/host-probe')).toBe(false)
    } finally {
      await world.destroy()
    }
  }, 60_000)

  it.skipIf(!canDrop)('T7: the wrapped QEMU child runs as uid 65534 and the sandbox denies the outside world', async () => {
    const canaryDir = mkdtempSync(join(tmpdir(), 'dsh-vm-t7-canary-'))
    const canary = join(canaryDir, 'canary')
    writeFileSync(canary, 'host secret')
    chmodSync(canary, 0o600)
    try {
      const identity = runWrapped(['/usr/bin/id'])
      expect(identity.status).toBe(0)
      expect(identity.stdout).toContain('uid=65534(nobody)')

      const denied = runWrapped(['/bin/cat', canary])
      expect(denied.status).not.toBe(0)
      expect(denied.stderr).toContain('Permission denied')

      const escapePath = join(canaryDir, 'escape')
      const escape = runWrapped(['/bin/sh', '-c', `echo leaked > ${escapePath}`])
      expect(escape.status).not.toBe(0)
      expect(existsSync(escapePath)).toBe(false)

      const world = await openWorld({ readyTimeoutMs: 20_000 })
      try {
        expect(world.descriptor.sandboxed).toBe(true)
        expect(await world.ping(5_000)).toBeGreaterThan(0)
        const status = readFileSync(join('/proc', String(world.descriptor.pid), 'status'), 'utf8')
        expect(/^Uid:\t65534\t65534\t65534\t65534$/m.test(status)).toBe(true)
      } finally {
        await world.destroy()
      }
    } finally {
      rmSync(canaryDir, { recursive: true, force: true })
    }
  }, 60_000)
})
