/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-chat-harniverse-client`.
 * @module @deepseek-ai/dsh-chat-harniverse-client/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { CARRIER_ENDPOINTS, isTypertEndpoint, isUnaryMethod } from './endpoints.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-chat-harniverse-client'

/** Cordis companion plugin name. */
export const name = 'chat-harniverse-client-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Closed-table relation: every request announced by `chat-harniverse/request`
 * addresses an entry of the endpoint table for its kind, so no request can
 * leave the client for an endpoint the bridge never declared.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('chat-harniverse/request', ({ kind, target }) => {
    const allowed = kind === 'unary' ? isUnaryMethod(target)
      : kind === 'typert' ? isTypertEndpoint(target)
        : CARRIER_ENDPOINTS[kind] === target
    if (!allowed) fail(`${kind} request addresses ${JSON.stringify(target)} outside the closed endpoint table`)
  }, { global: true })
}, { inject: ['harniverseClient'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
