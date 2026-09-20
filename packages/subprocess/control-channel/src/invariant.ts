/** Package-owned invariant companion for `@deepseek-ai/dsh-control-channel`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-control-channel'

/** Cordis companion plugin name. */
export const name = 'control-channel-invariant'
/** The invariant service owns registration of this companion. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns pure frame, bound, and lifecycle
 * rules with no session-event relationship of its own; the PTC and SSH
 * providers that transport these frames own their execution invariants.
 */
const install: InvariantInstaller = () => {}

/** Register the package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
