/**
 * QEMU command-line planning and environment probing for the micro-VM world.
 *
 * The plan targets the `pc` machine with `-nodefaults`, two ISA serials
 * (ttyS0 logs the guest console to a file; ttyS1 carries the control
 * protocol over a host unix socket), and — by construction — no network
 * device of any kind: no `-netdev`, `-nic`, or `-net` argument is ever
 * emitted, so the guest has no NIC to speak of. The `microvm` machine routes
 * only its first ISA serial, so it cannot host the control channel yet.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Hardware acceleration mode the QEMU process uses. */
export type QemuAccel = 'kvm' | 'tcg'

/** Default QEMU binary resolved from PATH. */
export const DEFAULT_QEMU_BIN = 'qemu-system-x86_64'

/** Fully resolved inputs for one world's QEMU command line. */
export interface QemuPlanInput {
  /** QEMU binary to execute as argv[0]. */
  qemuBin: string
  accel: QemuAccel
  memoryMiB: number
  cpus: number
  kernelPath: string
  initrdPath: string
  controlSocketPath: string
  consoleLogPath: string
}

/**
 * Resolve the effective acceleration from the host state.
 * @param kvmWritable - whether `/dev/kvm` is open for writing.
 * @param requested - `'auto'` prefers KVM, or an explicit mode.
 * @returns `kvm` when requested (implicitly or explicitly) and available, else `tcg`.
 */
export function resolveAccel(kvmWritable: boolean, requested: 'auto' | QemuAccel): QemuAccel {
  if (requested === 'kvm') return 'kvm'
  if (requested === 'tcg') return 'tcg'
  return kvmWritable ? 'kvm' : 'tcg'
}

/**
 * Whether `/dev/kvm` is open for writing on this host.
 * @returns true when the device node accepts writes.
 */
export function isKvmWritable(): boolean {
  try {
    accessSync('/dev/kvm', constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Build the full QEMU argv for one micro-VM world.
 * @param input - resolved plan inputs; paths must be absolute.
 * @returns argv starting with `qemuBin`, with ttyS0 as console log, ttyS1 as
 * the control socket, and never a network device.
 */
export function buildQemuArgv(input: QemuPlanInput): string[] {
  return [
    input.qemuBin,
    '-M', 'pc',
    '-accel', input.accel,
    '-cpu', input.accel === 'kvm' ? 'host' : 'max',
    '-m', String(input.memoryMiB),
    '-smp', String(input.cpus),
    '-kernel', input.kernelPath,
    '-initrd', input.initrdPath,
    '-append', 'console=ttyS0 rdinit=/init loglevel=3 panic=-1',
    '-no-reboot',
    '-nodefaults',
    '-display', 'none',
    '-serial', `file:${input.consoleLogPath}`,
    '-serial', `unix:${input.controlSocketPath},server=on,wait=off`,
  ]
}

/** Result of probing one QEMU binary for a version line. */
export interface QemuVersionProbe {
  /** QEMU binary that was probed. */
  qemuBin: string
  /** Parsed `QEMU emulator version` line, or `undefined` when the binary is unusable. */
  qemuVersion: string | undefined
}

/**
 * Parse the first version line of `qemu-system-x86_64 --version` output.
 * @param stdout - raw `--version` stdout.
 * @returns the version text after `QEMU emulator version`, or `undefined`.
 */
export function parseQemuVersion(stdout: string): string | undefined {
  const match = /QEMU emulator version ([^\s]+)/.exec(stdout)
  return match?.[1]
}

/**
 * Locate this package's root directory (the one holding its `package.json`)
 * by walking up from a starting directory.
 * @param startDir - directory inside or below the package.
 * @returns the package root directory.
 * @throws Error when no `package.json` naming this package is found upward.
 */
export function findPackageRoot(startDir: string): string {
  let dir = startDir
  for (;;) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
        if (manifest.name === '@deepseek-ai/dsh-vm-qemu-local') return dir
      } catch {
        // Unreadable manifest: keep walking up.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no package root found above ${startDir}`)
    dir = parent
  }
}

/** Directory containing this module's compiled or source form. */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/**
 * Default assets directory holding `vmlinuz-virt` and `initramfs.cpio.gz`
 * produced by `assets/build-rootfs.sh`.
 */
/**
 * Default assets directory holding `vmlinuz-virt` and `initramfs.cpio.gz`
 * produced by `assets/build-rootfs.sh`.
 * @returns the package-local `.cache/assets` path.
 */
export function defaultAssetsDir(): string {
  return join(findPackageRoot(moduleDir), '.cache', 'assets')
}

/** File name of the sandbox wrapper inside the assets directory. */
export const QEMU_WRAP_NAME = 'qemu-wrap'

/**
 * Locate the staged sandbox wrapper, if any.
 * @param assetsDir - directory that may hold a `qemu-wrap` binary.
 * @param platform - host platform to gate on; defaults to the real platform.
 * @returns the executable wrapper path, or `undefined` when absent,
 * non-executable, or off-Linux.
 */
export function resolveWrapPath(assetsDir: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'linux') return undefined
  const wrapPath = join(assetsDir, QEMU_WRAP_NAME)
  try {
    accessSync(wrapPath, constants.X_OK)
    return wrapPath
  } catch {
    return undefined
  }
}

/**
 * Plan one supervised command line: the wrapper runs the child with
 * Landlock (whole tree read-only, the scratch directory writable), rlimits,
 * and a uid drop to 65534 when the host is root.
 * @param wrapPath - executable wrapper path.
 * @param scratchDir - the only directory the child may write.
 * @param argv - the command line to supervise; argv[0] is the executable.
 * @returns argv with the wrapper prepended.
 */
export function buildWrappedArgv(wrapPath: string, scratchDir: string, argv: readonly string[]): string[] {
  return [wrapPath, '--scratch', scratchDir, '--', ...argv]
}
