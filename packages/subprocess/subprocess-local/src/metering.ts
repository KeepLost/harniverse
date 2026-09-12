/**
 * Address-space-limit application for local spawns: the degraded enforcement
 * tier where cgroupfs is unavailable. `prlimit --as` bounds the child's
 * VIRTUAL address space — an approximation of resident memory the README and
 * Agent Note state plainly — and applies to the whole spawned tree because
 * rlimits are inherited across fork/exec.
 * @module @deepseek-ai/dsh-subprocess-local/metering
 */

import type { SubprocessLimits } from '@deepseek-ai/dsh-subprocess'

/** Knobs deciding whether the rlimit prefix applies. */
export interface AddressSpaceLimitOptions {
  /** Host platform; only Linux carries util-linux `prlimit`. */
  readonly platform: NodeJS.Platform
  /** Result of the boot-time `prlimit` availability probe. */
  readonly prlimitAvailable: boolean
}

/**
 * Return the argv that actually runs when one spawn asks for a memory bound.
 * Linux with `prlimit` available fronts the original argv with
 * `prlimit --as=<bytes> --`; every other combination returns the input
 * unchanged (no hidden defaults — the caller's watchdog remains the only
 * protection there).
 * @param argv - original spawn argv.
 * @param limits - requested resource bounds.
 * @param options - platform and probe facts.
 * @returns the argv to spawn.
 */
export function applyAddressSpaceLimit(
  argv: readonly string[],
  limits: SubprocessLimits | undefined,
  options: AddressSpaceLimitOptions,
): readonly string[] {
  const maxMemoryBytes = limits?.maxMemoryBytes
  if (maxMemoryBytes === undefined || !Number.isFinite(maxMemoryBytes) || maxMemoryBytes <= 0) return argv
  if (options.platform !== 'linux' || !options.prlimitAvailable) return argv
  return ['prlimit', `--as=${Math.floor(maxMemoryBytes)}`, '--', ...argv]
}
