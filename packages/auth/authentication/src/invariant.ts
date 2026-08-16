/** Package-owned invariant companion for inbound authentication. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-authentication'

/** Cordis companion plugin name. */
export const name = 'authentication-invariant'
/** Service required before package invariant registration. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('authentication/revoked', () => {
    if (ctx.get('authentication') === undefined) {
      fail('authentication/revoked emitted without a live authentication service')
    }
  })
}

/** Register the authentication lifecycle invariant. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
