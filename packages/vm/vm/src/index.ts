/**
 * Execution-world Service Definition (`ctx.vm`): one live world — a
 * hardware-isolated guest the harness drives from the host. The service owns
 * no transport, hypervisor, or protocol concept; a provider package
 * (`@deepseek-ai/dsh-vm-qemu-local`) boots the world and registers here. The
 * ctx capability providers (`@deepseek-ai/dsh-subprocess-vm`,
 * `@deepseek-ai/dsh-fs-vm`, `@deepseek-ai/dsh-sandbox-vm`) translate this
 * seam into the `ctx.subprocess` / `ctx.fs` / `ctx.sandbox` contracts, so
 * model-facing tools run unchanged inside the world.
 * @module @deepseek-ai/dsh-vm
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  CollectExecOptions,
  EgressPolicy,
  ExecHandle,
  ExecOptions,
  ExecResult,
  VmWorldDescriptor,
  VmWorldExit,
  VmWorldFs,
} from './types.ts'

export { ExecOptionsError, ExecOutputLimitError, ExecStartError, GuestFsError } from './errors.ts'
export { EXEC_WORLD_ENV, resolveExecWorld } from './exec-world.ts'
export type { ExecWorld, ExecWorldAvailability, ExecWorldPreference } from './exec-world.ts'
export type {
  CollectExecOptions,
  EgressPolicy,
  EgressRequest,
  ExecExit,
  ExecHandle,
  ExecOptions,
  ExecOutputListener,
  ExecResult,
  GuestEntry,
  GuestStat,
  VmWorldDescriptor,
  VmWorldExit,
  VmWorldFs,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    vm: VmWorld
  }
}

/**
 * One booted execution world. Implementations boot in the constructor, settle
 * in `[Service.init]`, and destroy their world on context disposal — a
 * consumer never sees a half-booted world, and no world outlives its context.
 *
 * Implementations must honor these semantics:
 * - Every path argument is a path INSIDE the world; a host path is never
 *   valid here, and implementations never read one.
 * - The guest cannot reach host files, processes, or the network by
 *   construction; egress exists only through the provider's approval-gated
 *   relay (`EgressPolicy`), which denies when unapproved.
 * - `destroy` is idempotent and resolves once the world's processes cannot
 *   run anymore, however it was stopped.
 */
export abstract class VmWorld extends Service {
  constructor(ctx: Context) {
    super(ctx, 'vm')
    ctx.effect(() => () => {
      void this.destroy().catch((error: unknown) => {
        // Disposal must not strand the context on one world's failed teardown;
        // the world's child is gone or orphaned either way and the next boot
        // owns recovery.
        ctx.logger.error('vm: world destruction failed during disposal', error)
      })
    })
  }

  /** Neutral facts of this world: provider id, isolation, hardening, boot time. */
  abstract get descriptor(): VmWorldDescriptor

  /** Resolves when the world's child terminates, however it was stopped. */
  abstract get exit(): Promise<VmWorldExit>

  /**
   * Round-trip one ping through the world's agent.
   * @param timeoutMs - reply deadline; provider default applies when omitted.
   * @returns observed round-trip time in milliseconds.
   */
  abstract ping(timeoutMs?: number): Promise<number>

  /**
   * Run one exec to completion inside the world and collect its output.
   * @param argv - world command line.
   * @param options - env, cwd, pty, stdin, timeout, and output bound.
   * @returns exit state plus collected stdout and stderr.
   */
  abstract exec(argv: string[], options?: CollectExecOptions): Promise<ExecResult>

  /**
   * Start one streaming exec inside the world.
   * @param argv - world command line.
   * @param options - env, cwd, and pty selection.
   * @returns the streaming exec handle.
   */
  abstract spawn(argv: string[], options?: ExecOptions): Promise<ExecHandle>

  /** Filesystem operations for this world's interior. */
  abstract get fs(): VmWorldFs

  /**
   * Bind one egress-origin token to an approval callback. The token travels
   * on execs (`ExecOptions.origin`) and returns on every egress dial that
   * exec's process tree initiates; a dial whose origin has no registered
   * approver denies. Worlds without a guest egress surface accept the
   * registration and never consult it.
   * @param origin - opaque token unique within this world.
   * @param approver - approval callback receiving the attributed dial.
   * @returns disposer that unbinds the token.
   */
  registerEgressOrigin(origin: string, approver: EgressPolicy): () => void {
    void origin
    void approver
    return () => {}
  }

  /**
   * Stop the world.
   * @returns `clean` when the world exited after its own shutdown path (or
   * had already exited), `killed` when forceful termination was required.
   */
  abstract destroy(): Promise<'clean' | 'killed'>
}

export default VmWorld
