/**
 * Named one-shot subagent providers backed by OAR's default runtime registry.
 * OAR owns native processes; installation checks occur on delegation.
 *
 * @module @deepseek-ai/dsh-subagent-oar
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defaultRuntimes } from '@botiverse/oar'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { startOarRun, type OarRunSpec } from './run.ts'

export const name = 'subagent-oar'
export const inject = ['subagents']

const DEFAULT_PROVIDER_NAME = 'oar'

/** Native runtime selection and deployment settings for one provider instance. */
export interface Config {
  /** OAR default-runtime id; unknown ids fail during plugin activation. */
  runtime: string
  /** Name registered on ctx.subagents (default oar). */
  providerName?: string
  /** Native model id; omission preserves the runtime's model selection. */
  model?: string
  /** Native reasoning effort; unsupported choices fail during startup. */
  effort?: string
  /** Explicit entries applied after ambient credential scrubbing; null removes a value. */
  env?: Record<string, string | null>
  /** Native launch arguments, including permission settings; omission uses OAR defaults. */
  launchArgs?: string[]
  /** Optional turn deadline in milliseconds after startup; omission uses parent cancellation only. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  runtime: z.string().min(1).required(),
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  effort: z.string().min(1),
  env: z.dict(z.union([z.string(), z.const(null)])).default({}),
  launchArgs: z.array(z.string()).default([]),
  timeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
})

/** The embedded OAR runtime declares `engines.node >= 24`; the provider refuses older Hosts loudly. */
function assertSupportedNode(): void {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(major) || major < 24) {
    throw new Error(
      `subagent-oar: the embedded OAR runtime requires Node >= 24.0.0; this Host runs Node ${process.versions.node}`,
    )
  }
}

/**
 * Register one provider using a runtime in OAR's default registry.
 * @param ctx - context carrying the shared subagent service.
 * @param config - runtime, registry name, native settings, and turn deadline.
 */
export function apply(ctx: Context, config: Config): void {
  assertSupportedNode()
  const runtime = defaultRuntimes.require(config.runtime)
  const timeoutMs = config.timeoutMs
  const providerName = config.providerName ?? DEFAULT_PROVIDER_NAME
  if (timeoutMs !== undefined) {
    assertPositiveFinite('subagent-oar', 'timeoutMs', timeoutMs)
    if (timeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`subagent-oar: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    }
  }
  const spec: OarRunSpec = {
    runtime,
    ...config.model === undefined ? {} : { model: config.model },
    ...config.effort === undefined ? {} : { effort: config.effort },
    env: config.env ?? {},
    launchArgs: config.launchArgs ?? [],
    ...timeoutMs === undefined ? {} : { timeoutMs },
    onError: (error) => {
      ctx.logger.warn('subagent-oar "%s": %s', providerName, error.message)
    },
  }
  const provider: SubagentProvider = {
    name: providerName,
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    // OAR runtimes are one-shot by construction; the retained one-shot provider shape is the correct seam for them.
    // oxlint-disable-next-line typescript/no-deprecated -- external one-shot runtimes cannot be continuable children.
    start: request => startOarRun(request, spec),
  }
  ctx.subagents.registerProvider(provider)
}
