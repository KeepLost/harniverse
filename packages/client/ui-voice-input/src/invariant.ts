/** Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-voice-input`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-voice-input'

/** Cordis companion plugin name. */
export const name = 'client-ui-voice-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the microphone control and the settings section are
 * slot effects whose declaration, registration, and teardown are exercised
 * by this package; the speech seam and its providers own recognition
 * behavior, and the settings service owns preference persistence.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
