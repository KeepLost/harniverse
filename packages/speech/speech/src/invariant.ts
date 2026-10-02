/** Package-owned invariant companion for `@deepseek-ai/dsh-speech`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-speech'

/** Cordis companion plugin name. */
export const name = 'speech-invariant'
/** The invariant service owns registration of this companion. */
export const inject = ['invariants']

/**
 * No runtime invariant: the registry is an in-memory map whose registration
 * and disposal effects are exercised by this package's suites; the settings
 * service owns preference validation, and each provider owns its own asset
 * verification. No two independently observable facts can diverge here.
 */
const install: InvariantInstaller = () => {}

/** Register the package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
