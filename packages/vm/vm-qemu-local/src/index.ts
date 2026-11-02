/**
 * Local micro-VM execution-world seed: boots a QEMU `pc` guest that owns its
 * kernel, root filesystem, and process space, and has no network device by
 * construction.
 *
 * The host side plans the QEMU command line, meets the guest agent over the
 * second ISA serial port speaking a versioned length-prefixed JSON protocol,
 * and supervises the child process lifecycle: `probeWorld`, `openWorld`,
 * `ping`, `exec`, `spawn`, the `fs` client, and `destroy`.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_QEMU_BIN, defaultAssetsDir, isKvmWritable, parseQemuVersion, resolveAccel, resolveWrapPath, type QemuAccel } from './qemu.ts'
import type { OpenWorldOptions } from './vm.ts'

export * from './frame.ts'
export * from './protocol.ts'
export * from './qemu.ts'
export * from './exec.ts'
export * from './fs.ts'
export * from './egress.ts'
export * from './vm.ts'

/** Environment facts `probeWorld` reports without booting a world. */
export interface WorldProbe {
  /** QEMU binary that was probed. */
  qemuBin: string
  /** Version string when the binary runs and reports one, else `undefined`. */
  qemuVersion: string | undefined
  /** Acceleration the world would pick with these options. */
  accel: QemuAccel
  /** Assets directory the world would use. */
  assetsDir: string
  /** Whether both `vmlinuz-virt` and `initramfs.cpio.gz` are present. */
  assetsReady: boolean
  /** Whether the sandbox wrapper is staged and the world would run under it. */
  sandboxed: boolean
}

/**
 * Probe the local environment for a bootable world without starting one.
 * @param options - binary, assets directory, and acceleration overrides.
 * @returns probe facts; `qemuVersion` and `assetsReady` together gate e2e use.
 */
export function probeWorld(options: Pick<OpenWorldOptions, 'qemuBin' | 'assetsDir' | 'accel' | 'sandbox'> = {}): WorldProbe {
  const qemuBin = options.qemuBin ?? DEFAULT_QEMU_BIN
  const assetsDir = options.assetsDir ?? defaultAssetsDir()
  const version = spawnSync(qemuBin, ['--version'], { timeout: 5_000, encoding: 'utf8' })
  return {
    qemuBin,
    qemuVersion: version.status === 0 ? parseQemuVersion(version.stdout) : undefined,
    accel: resolveAccel(isKvmWritable(), options.accel ?? 'auto'),
    assetsDir,
    assetsReady: existsSync(join(assetsDir, 'vmlinuz-virt')) && existsSync(join(assetsDir, 'initramfs.cpio.gz')),
    sandboxed: options.sandbox !== 'off' && resolveWrapPath(assetsDir) !== undefined,
  }
}
