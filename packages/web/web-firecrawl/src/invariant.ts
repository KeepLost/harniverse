/** Package-owned invariant companion for `@deepseek-ai/dsh-web-firecrawl`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-firecrawl'

/** Cordis companion plugin name. */
export const name = 'web-firecrawl-invariant'
/** The invariant service owns registration of this companion. */
export const inject = ['invariants']

/** No runtime invariant: search/fetch state is owned by the aggregate web seam. */
const install: InvariantInstaller = () => {}

/** Register the package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
