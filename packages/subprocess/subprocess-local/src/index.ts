/**
 * Local Service Provider for the subprocess capability seam. Each spawn is a detached
 * process tree with the spec's per-stream stdio dispositions. Normal disposal
 * terminates and joins live trees; Node's synchronous exit phase force-stops
 * any trees the service still owns. It has no config: every disposition and
 * limit arrives on the spec, so the deployment-varying choices stay with the
 * caller's config (the bash executor's, the LSP host's, …).
 * @module @deepseek-ai/dsh-subprocess-local
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as nodePty from 'node-pty'
import type { IPtyForkOptions } from 'node-pty'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { childEnv, spawnSubprocess } from './spawn.ts'
import type { LocalSubprocessHandle, SpawnInternals } from './spawn.ts'
import { applyAddressSpaceLimit } from './metering.ts'
import { createProcessInspector } from './process-inspector.ts'
import type { ProcessInspector } from './process-inspector.ts'
import { LocalTerminalHandle } from './terminal.ts'

/**
 * Local subprocess service: detached process trees, Node-shaped stdio
 * dispositions (raw pipes, inherit, bounded tail-keep collection with spill
 * files), credential-scrubbed environment, and tree-scoped signalling with
 * SIGTERM→grace→SIGKILL escalation, plus synchronous final termination during
 * JavaScript-observable host exit.
 */
export class LocalSubprocessRuntime extends SubprocessRuntime {
  /** Live handles retained for normal disposal and synchronous host-exit finalization. */
  private live = new Set<LocalSubprocessHandle>()
  /** Live terminals retained through normal quiescence or host-exit finalization. */
  private terminals = new Set<LocalTerminalHandle>()
  /** Test hook: spill and platform knobs forwarded to spawnSubprocess. */
  internals: SpawnInternals = {}
  /** Test hook for platform process inspection; production resolves lazily on terminal spawn. */
  terminalInspector: ProcessInspector | undefined
  /** Whether `prlimit` can front address-space-limited spawns; optimistic until the background probe settles. */
  private prlimitAvailable = process.platform === 'linux'

  constructor(ctx: Context) {
    super(ctx)
    // Probe in the background, never blocking service start: a blocking probe
    // defers every inject-dependent fiber (bash executors, their tools) past
    // the first assembled model request in compositions that boot them lazily.
    void this.probePrlimit().then((result) => { this.prlimitAvailable = result })
    ctx.effect(() => {
      const onHostExit = (): void => { this.terminateForHostExit() }
      process.prependListener('exit', onHostExit)
      return async () => {
        try {
          await this.disposeManagedProcesses()
        } finally {
          process.off('exit', onHostExit)
        }
      }
    }, 'local subprocess teardown')
  }

  /**
   * Resolve `prlimit` availability for address-space-limited spawns: the
   * explicit test override wins, non-Linux platforms have no util-linux, and
   * Linux resolves the binary on PATH once per boot.
   * @returns whether rlimit prefixing is available.
   */
  protected async probePrlimit(): Promise<boolean> {
    if (this.internals.prlimitAvailable !== undefined) {
      return this.internals.prlimitAvailable
    }
    if ((this.internals.platform ?? process.platform) !== 'linux') {
      return false
    }
    return await this.resolveExecutable('prlimit').then(() => true, () => false)
  }

  private terminateForHostExit(): void {
    for (const handle of this.live) {
      try {
        handle.terminateForHostExit()
      } catch (_ordinaryTreeTerminationFailed) {
        // Host exit cannot await or report one target; continue with the rest.
      }
    }
    for (const terminal of this.terminals) {
      try {
        terminal.terminateForHostExit()
      } catch (_terminalTerminationFailed) {
        // One terminal must not prevent final termination of another target.
      }
    }
  }

  private async disposeManagedProcesses(): Promise<void> {
    // Terminate (escalating), then await WHOLE-TREE exit — not just the
    // direct child's settlement — so even a TERM-trapping descendant cannot
    // outlive the fiber. Keep both sets authoritative while these waits are
    // pending so a shorter process-level exit bound can still force-kill them.
    const pending: Promise<unknown>[] = []
    for (const handle of this.live) {
      handle.terminate()
      // Spawn-failure rejections already settled and left the live set.
      pending.push(handle.done.catch(() => {}).then(() => handle.waitForExit()))
    }
    for (const terminal of this.terminals) {
      pending.push(terminal.terminate())
    }
    const outcomes = await Promise.allSettled(pending)
    const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected'
      ? [outcome.reason as unknown]
      : [])
    if (failures.length > 0) this.terminateForHostExit()
    this.live.clear()
    this.terminals.clear()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'local subprocess teardown failed')
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-local: executable must be non-empty')
    signal?.throwIfAborted()
    const environment = childEnv(env)
    const absolute = isAbsolute(command)
    if (!absolute && (command.includes('/') || (process.platform === 'win32' && command.includes('\\')))) {
      throw new Error(
        `subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const candidates = absolute ? [command] : this.executableCandidates(command, environment)
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      try {
        const info = await stat(candidate)
        if (!info.isFile()) continue
        await access(candidate, constants.X_OK)
        signal?.throwIfAborted()
        return candidate
      } catch {
        // Try the next PATH candidate; the final miss receives one stable error.
      }
    }
    signal?.throwIfAborted()
    throw new Error(absolute
      ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file`
      : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`)
  }

  private executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
    const path = environmentValue(env, 'PATH') ?? ''
    const extensions = process.platform === 'win32' && extname(command) === ''
      ? (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']
    return path.split(delimiter).flatMap(directory =>
      extensions.map(extension => resolve(process.cwd(), directory, command + extension)))
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const argv = applyAddressSpaceLimit(spec.argv, spec.limits, {
      platform: process.platform,
      // The internals override stays live at spawn time for tests; production
      // reads the cached boot probe result.
      prlimitAvailable: this.internals.prlimitAvailable ?? this.prlimitAvailable,
    })
    const handle = spawnSubprocess(argv === spec.argv ? spec : { ...spec, argv }, this.internals)
    this.live.add(handle)
    // Release ownership only once the whole TREE is gone, not at direct-child
    // settlement — a TERM-trapping helper that outlives the leader must stay
    // owned so teardown can still escalate it. For the common no-survivor
    // case waitForExit resolves immediately after settlement.
    const release = (): Promise<void> =>
      handle.waitForExit().then(() => { this.live.delete(handle) })
    handle.done.then(release, release)
    if (spec.correlation !== undefined) {
      const correlation = spec.correlation
      if (handle.pid > 0) this.ctx.emit('subprocess/spawned', { correlation, handle })
      const reportExit = (outcome: SubprocessOutcome): void => {
        this.ctx.emit('subprocess/exited', { correlation, handle, outcome })
      }
      // Spawn-level failures carry no pid and no exit facts; metering
      // consumers still need the paired exit to drop the command from
      // their live sets.
      handle.done.then(reportExit, () => { reportExit({ exitCode: null, signal: null }) })
    }
    return handle
  }

  // Local PTY allocation is synchronous, but the provider contract permits remote asynchronous allocation.
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const file = spec.argv[0]
    if (file === undefined || file.length === 0) {
      throw new Error('subprocess-local: terminal argv must contain a program')
    }
    spec.signal?.throwIfAborted()
    const options: IPtyForkOptions = {
      name: 'dumb',
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env: childEnv(spec.env),
    }
    const inspector = this.terminalInspector ?? createProcessInspector()
    const terminal = nodePty.spawn(file, [...spec.argv.slice(1)], options)
    const handle = new LocalTerminalHandle(terminal, inspector, spec.graceMs)
    this.terminals.add(handle)
    if (spec.correlation !== undefined) {
      const correlation = spec.correlation
      // node-pty throws synchronously on a failed spawn, so a live terminal
      // handle always carries a real pid.
      this.ctx.emit('subprocess/terminal-spawned', { correlation, handle })
      const reportExit = (outcome: SubprocessOutcome): void => {
        this.ctx.emit('subprocess/terminal-exited', { correlation, handle, outcome })
      }
      // The terminal outcome promise resolves for every exit path (a failed
      // node-pty spawn throws before a handle exists), so this rejection arm
      // only keeps the pairing symmetric with plain spawns.
      /* v8 ignore next -- see comment above */
      handle.done.then(reportExit, () => { reportExit({ exitCode: null, signal: null }) })
    }
    const release = async (): Promise<void> => {
      await handle.terminate()
      this.terminals.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }
}

/** Read a Windows environment key using the platform's case-insensitive semantics. */
function environmentValue(env: NodeJS.ProcessEnv, name: 'PATH' | 'PATHEXT'): string | undefined {
  const exact = env[name]
  if (exact !== undefined || process.platform !== 'win32') return exact
  const normalized = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1]
}

export default LocalSubprocessRuntime
