/** Package-owned invariant companion for `@deepseek-ai/dsh-exec-world-settings`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-exec-world-settings'

/** Cordis companion plugin name. */
export const name = 'exec-world-settings-invariant'
/** The invariant service owns registration of this companion. */
export const inject = ['invariants']

/**
 * No runtime invariant: the settings service owns namespace uniqueness,
 * validation, and registration disposal; the published switchboard is a pure
 * function of each resolved value (`resolveExecWorld` plus the provider
 * probe) and is exercised by this package's suites.
 */
const install: InvariantInstaller = () => {}

/** Register the package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
