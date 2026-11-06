/**
 * Loader-fixture world provider: satisfies the `ctx.vm` seam shape without
 * booting anything, records the egress origins subprocess-vm binds, and
 * answers the driver's simulated dials through the recorded approvers, so
 * the composition tier can pin the approval chain on hosts without a VM
 * provider; the QEMU-gated e2e boots the real provider.
 */

import { VmWorld } from '@deepseek-ai/dsh-vm'
import type {
  EgressPolicy,
  EgressRequest,
  ExecHandle,
  ExecOptions,
  ExecResult,
  VmWorldDescriptor,
  VmWorldExit,
  VmWorldFs,
} from '@deepseek-ai/dsh-vm'

interface RecordedSpawn {
  argv: string[]
  options: ExecOptions | undefined
  settle: (exit: { code: number; signal: null }) => void
}

/** Stub world registered as `ctx.vm` by the fixture composition. */
export class StubVmWorld extends VmWorld {
  readonly egressOrigins = new Map<string, EgressPolicy>()
  readonly spawns: RecordedSpawn[] = []
  lastSpawn: RecordedSpawn | undefined

  override get descriptor(): VmWorldDescriptor {
    return { provider: 'stub-egress', isolation: 'full', guestConfinement: 'landlock', hostHardened: false, readyMs: 0 }
  }

  override get exit(): Promise<VmWorldExit> {
    return new Promise<VmWorldExit>(() => {})
  }

  override async ping(): Promise<number> {
    return 0
  }

  override async exec(): Promise<ExecResult> {
    throw new Error('stub world cannot exec')
  }

  override async spawn(argv: string[], options: ExecOptions): Promise<ExecHandle> {
    const listeners = new Set<(stream: 'stdout' | 'stderr', chunk: Buffer) => void>()
    let settled: (exit: { code: number; signal: null }) => void = () => {}
    const exit = new Promise<{ code: number; signal: null }>((resolve) => { settled = resolve })
    const recorded: RecordedSpawn = { argv, options, settle: settled }
    this.spawns.push(recorded)
    this.lastSpawn = recorded
    return {
      id: this.spawns.length,
      pid: 10_000 + this.spawns.length,
      writeStdin: () => {},
      closeStdin: () => {},
      signal: async () => {},
      exit,
      onOutput: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
  }

  override registerEgressOrigin(origin: string, approver: EgressPolicy): () => void {
    this.egressOrigins.set(origin, approver)
    return () => { this.egressOrigins.delete(origin) }
  }

  /** Simulate one guest egress dial attributed to a bound origin. */
  async dial(origin: string | undefined, host: string, port: number): Promise<boolean> {
    const approver = origin === undefined ? undefined : this.egressOrigins.get(origin)
    if (approver === undefined) return false
    const request: EgressRequest = { host, port, ...(origin === undefined ? {} : { origin }) }
    try {
      return await approver(request)
    } catch {
      return false
    }
  }

  override get fs(): VmWorldFs {
    throw new Error('stub world has no filesystem')
  }

  override async destroy(): Promise<'clean'> {
    return 'clean'
  }
}

export default StubVmWorld
