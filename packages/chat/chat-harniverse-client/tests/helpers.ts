/** Shared setup for the client suites. */

import { Context } from '@deepseek-ai/cordis'
import HarniverseClient from '../src/index.ts'
import { internals } from '../src/internals.ts'
import { FakeCarrier, MemoryCredentials } from './fixtures/carrier.ts'

export const REMOTE_HOST = '3f2a8c6e-1b4d-4e7a-9c05-8d2e6f1a7b39'

/** The replaced external effects, restored by {@link restoreInternals}. */
const originals = { fetch: internals.fetch, createSocket: internals.createSocket }

/** Restore the production effects. */
export function restoreInternals(): void {
  internals.fetch = originals.fetch
  internals.createSocket = originals.createSocket
}

/** Boot credentials and a client against a fake carrier. */
export async function bootClient(options: {
  carrier?: FakeCarrier
  credentials?: Record<string, string>
  config?: Partial<ConstructorParameters<typeof HarniverseClient>[1]>
} = {}): Promise<{ ctx: Context; client: HarniverseClient; carrier: FakeCarrier }> {
  const carrier = options.carrier ?? new FakeCarrier()
  internals.fetch = carrier.fetch
  const ctx = new Context()
  const values = new Map(Object.entries(options.credentials ?? {
    DSH_CHAT_BRIDGE_GRANT_ID: 'grant-1',
    DSH_CHAT_BRIDGE_SIGNING: carrier.signingKey,
  }))
  await ctx.plugin(MemoryCredentials, values)
  await ctx.plugin(HarniverseClient, {
    origin: 'http://127.0.0.1:3080',
    grantIdRef: 'DSH_CHAT_BRIDGE_GRANT_ID',
    signingKeyRef: 'DSH_CHAT_BRIDGE_SIGNING',
    requestTimeoutMs: 30_000,
    muxRenewAfterMs: 540_000,
    reconnectMinMs: 1_000,
    reconnectMaxMs: 30_000,
    ...options.config,
  })
  return { ctx, client: ctx.harniverseClient, carrier }
}
