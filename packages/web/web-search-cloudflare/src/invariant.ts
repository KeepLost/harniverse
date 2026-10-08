/** Package-owned invariant companion for `@deepseek-ai/dsh-web-search-cloudflare`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-search-cloudflare'

/** Cordis companion plugin name. */
export const name = 'web-search-cloudflare-invariant'
/** The invariant service owns registration of this companion. */
export const inject = ['invariants']

/** No runtime invariant: this adapter owns no independent event/data relation. */
const install: InvariantInstaller = () => {}

/** Register the package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
