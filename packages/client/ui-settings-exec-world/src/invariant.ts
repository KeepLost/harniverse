/** Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-settings-exec-world`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-exec-world'

/** Cordis companion plugin name. */
export const name = 'ui-settings-exec-world-invariant'
/** The invariant service owns registration of this companion. */
export const inject = ['invariants']

/**
 * No runtime invariant: the section is a pure editor over the host
 * `exec-world` settings namespace (registration, validation, and disposal
 * owned by the settings service); the boot bridge and composition rows own
 * the selection semantics and are exercised by the settings package's
 * suites.
 */
const install: InvariantInstaller = () => {}

/** Register the package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
