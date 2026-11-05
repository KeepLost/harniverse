/**
 * Execution-world selection: the deployment-level switch that decides whether
 * sessions compose the host-local capability family or the VM family. Pure
 * resolution only — the boot bridge reads the stored preference, the provider
 * package owns availability probing, and the composition rows gate on the
 * published `$DSH_EXEC_WORLD` value.
 * @module @deepseek-ai/dsh-vm
 */

/** Environment value the app boot bridge publishes before the config tree mounts. */
export const EXEC_WORLD_ENV = 'DSH_EXEC_WORLD'

/** One selectable execution world; the composition swaps capability families on it. */
export type ExecWorldPreference = 'local' | 'vm'

/** Availability facts one world provider reports without booting a world. */
export interface ExecWorldAvailability {
  /** Provider binary runs and reports a version; absent means unusable. */
  providerVersion: string | undefined
  /** Provider-side runtime assets needed to boot are present. */
  assetsReady: boolean
}

/** Resolved execution world the composition mounts. */
export type ExecWorld = 'local' | 'vm'

/**
 * Resolve the execution world for one start: `vm` requires both the stored
 * `vm` preference and a healthy provider; anything else composes `local`.
 * A host that lost its provider therefore degrades to the local family
 * instead of failing the app start.
 * @param preference - stored or env-forced preference.
 * @param availability - provider probe facts for this host.
 * @returns the world the composition rows gate on.
 */
export function resolveExecWorld(preference: ExecWorldPreference, availability: ExecWorldAvailability): ExecWorld {
  if (preference !== 'vm') return 'local'
  return availability.providerVersion !== undefined && availability.assetsReady ? 'vm' : 'local'
}
