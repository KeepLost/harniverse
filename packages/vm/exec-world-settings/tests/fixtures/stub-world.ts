/**
 * Loader-fixture world provider: satisfies the `ctx.vm` seam shape without
 * booting anything, so the composition-tier suite can pin the vm-side row
 * gating on hosts without a VM provider. Every operation refuses — the suite
 * asserts composition, not execution.
 */

import { VmWorld } from '@deepseek-ai/dsh-vm'
import type {
  CollectExecOptions,
  ExecHandle,
  ExecOptions,
  ExecResult,
  VmWorldDescriptor,
  VmWorldExit,
  VmWorldFs,
} from '@deepseek-ai/dsh-vm'

/** Stub world registered as `ctx.vm` by the fixture composition. */
export class StubVmWorld extends VmWorld {
  override get descriptor(): VmWorldDescriptor {
    throw new Error('stub world has no descriptor')
  }

  override get exit(): Promise<VmWorldExit> {
    throw new Error('stub world never boots')
  }

  override async ping(): Promise<number> {
    throw new Error('stub world cannot ping')
  }

  override async exec(argv: string[], options?: CollectExecOptions): Promise<ExecResult> {
    void options
    throw new Error(`stub world cannot exec ${argv.join(' ')}`)
  }

  override async spawn(argv: string[], options?: ExecOptions): Promise<ExecHandle> {
    void options
    throw new Error(`stub world cannot spawn ${argv.join(' ')}`)
  }

  override get fs(): VmWorldFs {
    throw new Error('stub world has no filesystem')
  }

  override async destroy(): Promise<'clean'> {
    return 'clean'
  }
}

export default StubVmWorld
