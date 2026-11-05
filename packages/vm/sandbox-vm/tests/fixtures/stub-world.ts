/**
 * Loader-fixture world provider: satisfies the `ctx.vm` seam shape without
 * booting anything, so the composition tier can pin sandbox-vm's wrap and
 * refusal behavior on hosts without a VM provider. The descriptor's
 * confinement fact rides `$DSH_STUB_GUEST_CONFINEMENT` so one fixture
 * serves both the backend-present and backend-absent compositions; every
 * operation refuses — the suite asserts wrapping, not execution.
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
    return {
      provider: 'stub',
      isolation: 'full',
      guestConfinement: process.env.DSH_STUB_GUEST_CONFINEMENT === 'none' ? 'none' : 'landlock',
      hostHardened: false,
      readyMs: 0,
    }
  }

  override get exit(): Promise<VmWorldExit> {
    return new Promise<VmWorldExit>(() => {})
  }

  override async ping(): Promise<number> {
    return 0
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
