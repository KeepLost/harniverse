/**
 * Confinement provider for one execution world (`ctx.vm`): the world itself
 * is the enforcement. A world's processes cannot reach host files, host
 * processes, or the network by construction — the descriptor's
 * `isolation: 'full'` is a topology fact, not a policy promise — so
 * `danger-full-access` sessions already run under the strongest boundary the
 * harness can name, and callers never route that mode through `confine`.
 *
 * The confined modes are a different question: `read-only` and
 * `workspace-write` speak about file effects INSIDE the world, and the v0
 * world agent ships no in-guest confinement backend to enforce them. This
 * provider therefore fails closed for both modes rather than passing argv
 * through with a `'full'` stamp it cannot honor — a silent pass-through would
 * advertise a boundary that does not exist.
 *
 * ponytail: the ceiling is the v0 guest (busybox userspace, no Landlock in
 * guest). The upgrade path is an in-guest backend (Landlock inside a richer
 * rootfs, or op-level enforcement in the world agent); when one exists, this
 * provider gains a real `ConfinedArgv` for the confined modes and the
 * fail-closed throw disappears.
 * @module @deepseek-ai/dsh-sandbox-vm
 */

import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** World-boundary confinement: full host isolation, fail-closed in-world modes. */
export class VmSandboxProvider extends SandboxProvider {
  static inject = ['vm']

  // oxlint-disable-next-line typescript/require-await -- the refusal is the whole operation; async keeps it a rejection.
  override async confine(_argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    // The world boundary already separates the world from the host; the
    // confined modes describe file effects inside the world, which the v0
    // guest cannot enforce. Refusing keeps the vocabulary honest.
    throw new SandboxUnavailableError(
      policy.mode,
      `the v0 world guest has no in-guest confinement backend for mode "${policy.mode}"; the world boundary itself is the enforcement — run world sessions in danger-full-access`,
    )
  }
}

export default VmSandboxProvider
