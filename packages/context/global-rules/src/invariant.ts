/** Package-owned invariant companion for `@deepseek-ai/dsh-global-rules`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-global-rules'

/** Cordis companion plugin name. */
export const name = 'global-rules-invariant'
/** The invariant service owns registration of this companion. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider is a stateless file adapter over one
 * resolved path — it emits no cordis events and owns no registry, and the
 * read/write/conflict round-trips are pinned by this package's suites. No
 * two independently observable facts can diverge here.
 */
const install: InvariantInstaller = () => {}

/** Register the package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
