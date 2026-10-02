/** Package-owned invariant companion for `@deepseek-ai/dsh-speech-openai`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-speech-openai'

/** Cordis companion plugin name. */
export const name = 'speech-openai-invariant'
/** The invariant service owns registration of this companion. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider is a stateless function of the resolved
 * preferences and the configured endpoint chain over the wire; its ordered
 * failover and authorization behavior are exercised by this package's suites
 * against scripted transports.
 */
const install: InvariantInstaller = () => {}

/** Register the package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
