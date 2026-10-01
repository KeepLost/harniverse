/**
 * Package-owned invariant companion for encrypted credentials.
 * @module @deepseek-ai/dsh-credentials-encrypted/invariant
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'credentials-encrypted-invariant'
/** Service required for package invariant registration. */
export const inject = ['invariants']

/**
 * No runtime invariant: the credential definition owns credentials/updated dispatch;
 * encryption, commit rollback, key erasure, and locked startup require controlled I/O
 * and key-lifetime observations provided by this package's tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register ownership of the encrypted-provider invariant companion.
 * @param ctx - context carrying the invariant service.
 * @returns the registration disposer after setup.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-credentials-encrypted', install))
