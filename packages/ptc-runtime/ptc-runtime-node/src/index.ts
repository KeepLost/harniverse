/** Node PTC provider with uniform admission and configurable evaluation and process ownership. */
import z from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcProgramFormat, PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveLaunch } from './launch.ts'
import { validateConfig } from './config.ts'
import { createExecution } from './execution.ts'
import { PolicyProcesses } from './policy-processes.ts'
import type { Config, ResolvedConfig } from './config.ts'
export type { Config } from './config.ts'
export type { LaunchConfig } from './launch.ts'

interface LiveRun { controller: AbortController; finished: Promise<void> }

/** Node execution under file policy, with optional owner-scoped retained memory. */
export class NodePtcRuntime extends PtcRuntime {
  static inject = ['fs', 'subprocess', 'sandbox', 'sandboxPolicy']
  static Config: z<Config> = z.object({
    executionMode: z.union([z.const('per-call'), z.const('persistent-in-memory'), z.const('vm-script')]).default('per-call'),
    scriptPersistence: z.boolean().default(false),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(67_108_864),
    maxOldGenerationSizeMb: z.number().default(512),
    maxMessageBytes: z.number().default(134_217_728),
    maxPendingCalls: z.number().default(128),
    stopGraceMs: z.number().default(3_000),
    graceMs: z.number().default(3_000),
    launch: z.union([
      z.object({ kind: z.const('node-script').required(), executable: z.string().required(), bootstrapPath: z.string() }),
      z.object({ kind: z.const('embedded').required(), executable: z.string().required() }),
    ]),
  })
  readonly language = 'typescript'
  readonly isolation = 'process'
  private readonly execution: ReturnType<typeof createExecution>
  private readonly processes: PolicyProcesses

  override get programFormat(): PtcProgramFormat { return this.execution.mode.format }
  override get retainsState(): boolean { return this.execution.mode.retainsState }
  override get executionInstructions(): string { return this.execution.mode.executionInstructions }
  private readonly config: ResolvedConfig
  private readonly live = new Set<LiveRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = { ...config, launch: resolveLaunch(config.launch) } as ResolvedConfig
    validateConfig(this.config)
    this.processes = new PolicyProcesses(ctx)
    this.execution = createExecution(ctx, this.config, this.processes)
    ctx.effect(() => async () => {
      this.disposed = true
      const active = [...this.live]
      for (const run of active) run.controller.abort('runtime disposed')
      const results = await Promise.allSettled([this.execution.dispose(), ...active.map(run => run.finished)])
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }, 'Node ptc-runtime cleanup')
  }

  override get sandboxMode(): SandboxMode | undefined { return this.ctx.sandboxPolicy.defaultMode }

  override release(owner: object): Promise<void> {
    return this.execution.release(owner)
  }

  override get timeout(): { defaultMs: number; maxMs: number } {
    return { defaultMs: Math.min(this.config.timeoutMs, this.config.maxTimeoutMs), maxMs: this.config.maxTimeoutMs }
  }

  /**
   * Resolve directory, deadline and file policy for the selected execution mode.
   * @param request - Program, bindings, optional cwd/deadline, and resolved authority.
   * @returns Complete execution inputs with a capped numeric budget or an explicit null deadline.
   */
  resolve(request: PtcRunRequest): PtcRunSpec {
    if (this.disposed) {
      const source = this.retainsState ? 'persistent PTC' : 'ptc-runtime-node'
      throw new Error(`${source}: resolve after disposal`)
    }
    return this.execution.resolve(request)
  }

  /**
   * Run a resolved program under the configured execution mode.
   * Session mode changes cancel admitted calls before process launch as well as active programs.
   * @param spec - Inputs returned by resolve for the configured mode.
   * @returns Logs, JSON completion or failure; retained processes remain until release or invalidation.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    if (this.disposed) throw new Error('ptc-runtime-node: run after disposal')
    const controller = new AbortController()
    const completion = Promise.withResolvers<void>()
    const unregister = spec.sandboxPolicy === undefined ? undefined : this.processes.register(spec.sandboxPolicy, async () => {
      controller.abort(new Error('sandbox mode changed'))
      await completion.promise
    })
    const live = { controller, finished: completion.promise }
    this.live.add(live)
    try {
      await this.processes.wait(spec.sandboxPolicy?.sessionId)
      // Disposal can begin while a previous policy's process cleanup is pending.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (this.disposed) throw new Error(`${this.retainsState ? 'persistent PTC' : 'ptc-runtime-node'}: run after disposal`)
      const signal = spec.signal === undefined ? controller.signal : AbortSignal.any([spec.signal, controller.signal])
      return await this.execution.run({ ...spec, signal })
    } finally {
      unregister?.()
      this.live.delete(live)
      completion.resolve()
    }
  }
}

export default NodePtcRuntime
