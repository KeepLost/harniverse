/** Package-owned invariant companion for `@deepseek-ai/dsh-execution-descriptor`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-execution-descriptor'

/** Cordis companion plugin name. */
export const name = 'execution-descriptor-invariant'
/** The invariant service owns registration of this companion. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns pure descriptor validation with no
 * session-event relationship; the execution providers that publish and
 * consume descriptors own their runtime invariants.
 */
const install: InvariantInstaller = () => {}

/** Register the package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
