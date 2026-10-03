/** Package-owned invariant companion for `@deepseek-ai/dsh-speech-sensevoice`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-speech-sensevoice'

/** Cordis companion plugin name. */
export const name = 'speech-sensevoice-invariant'
/** The invariant service owns registration of this companion. */
export const inject = ['invariants']

/**
 * No runtime invariant: asset verification is a pure function of the pinned
 * manifest and the on-disk bytes, checked at every inspect/prepare/transcribe
 * boundary by this package's suites; the registry's registration and disposal
 * effects are exercised by `@deepseek-ai/dsh-speech`.
 */
const install: InvariantInstaller = () => {}

/** Register the package's explained empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
