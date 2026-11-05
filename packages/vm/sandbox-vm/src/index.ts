/**
 * Confinement provider for one execution world (`ctx.vm`): the world itself
 * is the enforcement against the host — a world's processes cannot reach
 * host files, processes, or the network by construction — while the
 * confined modes speak about file effects INSIDE the world and ride the
 * guest's kernel-enforcing backend. When the world's descriptor proves
 * that backend (`guestConfinement: 'landlock'`, announced by the guest
 * agent's boot-time functional probe), `confine` wraps argv with the
 * in-guest Landlock wrapper staged in the world's rootfs; the wrapper
 * restricts itself and `execvp`s the caller's argv unchanged, so there is
 * no runner process left between the wrap and the confined command.
 *
 * The grant spelling mirrors the host Landlock dialect
 * (`@deepseek-ai/dsh-sandbox-local`): read everywhere, write only
 * `/dev/null` under `read-only`, plus the workspace root and the world's
 * temp area under `workspace-write`. Denials surface as EACCES
 * (`permission denied`), and the wrapper's own failures carry the
 * `dsh-vm-confine:` stderr prefix with exit codes 2/3/127.
 *
 * A world whose guest reports no backend still fails closed for both
 * confined modes rather than passing argv through with an `'full'` stamp
 * it cannot honor — a silent pass-through would advertise a boundary that
 * does not exist.
 * @module @deepseek-ai/dsh-sandbox-vm
 */

import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-vm'

/** Absolute path of the wrapper inside the world's rootfs. */
const WRAPPER = '/bin/dsh-vm-confine'

/** In-guest writable roots one mode grants — the world-side spelling of the host Landlock dialect. */
function readWriteRoots(policy: SandboxPolicy): string[] {
  return policy.mode === 'read-only' ? ['/dev/null'] : ['/dev/null', '/tmp', policy.workspaceRoot]
}

/** World-boundary confinement with in-guest Landlock file effects. */
export class VmSandboxProvider extends SandboxProvider {
  static inject = ['vm']

  // oxlint-disable-next-line typescript/require-await -- the seam rejects, it does not throw.
  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    const { guestConfinement } = this.ctx.vm.descriptor
    if (guestConfinement !== 'landlock') {
      // The world boundary still separates the world from the host; the
      // confined modes describe file effects inside the world, which this
      // guest cannot enforce. Refusing keeps the vocabulary honest.
      throw new SandboxUnavailableError(
        policy.mode,
        `the world guest reports no in-guest confinement backend (guest confinement: ${guestConfinement}); `
          + 'the world boundary itself is the host enforcement — run world sessions in danger-full-access',
      )
    }
    const grants: string[] = ['--ro', '/']
    for (const root of readWriteRoots(policy)) {
      grants.push('--rw', root)
    }
    return {
      argv: [WRAPPER, ...grants, '--', ...argv],
      enforcement: 'full',
      denialSignatures: ['permission denied'],
      runnerFailureRules: [{ fatalSignatures: ['dsh-vm-confine:'] }],
    }
  }
}

export default VmSandboxProvider
