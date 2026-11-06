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

export * from './frame.ts'
export * from './protocol.ts'
export * from './qemu.ts'
export * from './exec.ts'
export * from './fs.ts'
export * from './egress.ts'
export * from './vm.ts'
export * from './workspace.ts'

import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { VmWorld } from '@deepseek-ai/dsh-vm'
import type { CollectExecOptions, EgressPolicy, ExecHandle, ExecOptions, ExecResult } from '@deepseek-ai/dsh-vm'
import { openWorld } from './vm.ts'
import type { OpenWorldOptions, VmDeps, WorldDescriptor, WorldExit, WorldHandle } from './vm.ts'
import type { VmWorldFs } from '@deepseek-ai/dsh-vm'

/** Deployment-owned boot facts for one QEMU world; no model argument selects these. */
export interface Config {
  /** Directory holding `vmlinuz-virt` and `initramfs.cpio.gz`; default the package's staged assets. */
  assetsDir?: string
  /** QEMU binary; default `qemu-system-x86_64` from PATH. */
  qemuBin?: string
  /** Acceleration preference; `auto` (default) picks KVM when `/dev/kvm` is writable, else TCG. */
  accel?: 'auto' | 'kvm' | 'tcg'
  /** Guest memory in MiB. Default 256. */
  memoryMiB?: number
  /** Guest vCPU count. Default 2. */
  cpus?: number
  /** Handshake deadline in milliseconds. Default 15 000. */
  readyTimeoutMs?: number
  /** Grace period for a guest-requested shutdown before SIGKILL, in milliseconds. Default 5 000. */
  shutdownTimeoutMs?: number
  /** Host-side hardening of the QEMU child: `auto` (default) stages the wrapper when present; `off` spawns directly. */
  sandbox?: 'auto' | 'off'
  /**
   * Guest egress surface: `ask` consults origin-registered approval sources,
   * `deny` (the default) refuses every guest egress dial outright.
   */
  egress?: 'ask' | 'deny'
}

/** An egress origin registered before the world settled, awaiting its live binding. */
interface PendingEgressOrigin {
  origin: string
  approver: EgressPolicy
  live: (() => void) | undefined
  disposed: boolean
}



/**
 * One QEMU-backed execution world registered as `ctx.vm`. Boot failure fails
 * the plugin load (fail-closed): a context that loads this provider either
 * sees a handshake-complete world or no world at all.
 */
export class QemuLocalWorld extends VmWorld {
  static Config = schema.object({
    assetsDir: schema.string(),
    qemuBin: schema.string(),
    accel: schema.union(['auto', 'kvm', 'tcg']).default('auto'),
    memoryMiB: schema.number().default(256),
    cpus: schema.number().default(2),
    readyTimeoutMs: schema.number().default(15_000),
    shutdownTimeoutMs: schema.number().default(5_000),
    sandbox: schema.union(['auto', 'off']).default('auto'),
    egress: schema.union(['ask', 'deny']).default('deny'),
  })
  /** Boot settlement: resolves with the world handle or fails the plugin. */
  readonly ready: Promise<WorldHandle>
  private handle: WorldHandle | undefined
  private readonly pendingOrigins = new Map<string, PendingEgressOrigin>()

  constructor(ctx: Context, config: Config, deps: VmDeps = {}) {
    super(ctx)
    const options: OpenWorldOptions = {}
    if (config.assetsDir !== undefined) options.assetsDir = config.assetsDir
    if (config.qemuBin !== undefined) options.qemuBin = config.qemuBin
    if (config.accel !== undefined) options.accel = config.accel
    if (config.memoryMiB !== undefined) options.memoryMiB = config.memoryMiB
    if (config.cpus !== undefined) options.cpus = config.cpus
    if (config.readyTimeoutMs !== undefined) options.readyTimeoutMs = config.readyTimeoutMs
    if (config.shutdownTimeoutMs !== undefined) options.shutdownTimeoutMs = config.shutdownTimeoutMs
    if (config.sandbox !== undefined) options.sandbox = config.sandbox
    if (config.egress !== undefined) options.egress = config.egress
    this.ready = openWorld(options, deps)
    void this.ready.then((handle) => {
      this.handle = handle
      for (const entry of this.pendingOrigins.values()) {
        entry.live = handle.egress.register(entry.origin, entry.approver)
        if (entry.disposed) entry.live()
      }
      this.pendingOrigins.clear()
    }, () => {})
  }

  /** Bind one egress-origin token to an approval callback on this world. */
  override registerEgressOrigin(origin: string, approver: EgressPolicy): () => void {
    const handle = this.handle
    if (handle !== undefined) return handle.egress.register(origin, approver)
    const entry: PendingEgressOrigin = { origin, approver, live: undefined, disposed: false }
    this.pendingOrigins.set(origin, entry)
    return () => {
      if (entry.disposed) return
      entry.disposed = true
      entry.live?.()
    }
  }

  protected async [Service.init](): Promise<void> {
    await this.ready
  }

  private world(): WorldHandle {
    if (this.handle === undefined) throw new Error('vm-qemu-local: the world has not settled')
    return this.handle
  }

  override get descriptor(): WorldDescriptor {
    return this.world().descriptor
  }

  override get exit(): Promise<WorldExit> {
    return this.world().exit
  }

  override async ping(timeoutMs?: number): Promise<number> {
    return await this.world().ping(timeoutMs)
  }

  override async exec(argv: string[], options?: CollectExecOptions): Promise<ExecResult> {
    return await this.world().exec(argv, options)
  }

  override async spawn(argv: string[], options?: ExecOptions): Promise<ExecHandle> {
    return await this.world().spawn(argv, options)
  }

  override get fs(): VmWorldFs {
    return this.world().fs
  }

  override async destroy(): Promise<'clean' | 'killed'> {
    return await this.world().destroy()
  }
}

export default QemuLocalWorld


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
