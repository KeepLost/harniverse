/** Package-owned runtime invariant companion. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { PeerRecord } from '@deepseek-ai/dsh-peer-protocol'

/** Companion plugin name. */
export const name = 'peer-host-invariant'
/** The invariant registry owns registration lifetime. */
export const inject = ['invariants']
/**
 * Asserts the coherence of emitted peer records: a `peer/paired` record is a
 * first-sighting (identical first/last seen timestamps, active, invitation-
 * admitted), and every emitted record carries a canonical instance id.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure): void => {
  ctx.on('peer/paired', (record: PeerRecord) => {
    if (!canonical(record) || record.firstSeenAt !== record.lastSeenAt) {
      fail(`peer/paired emitted an incoherent first-sighting record for ${record.instanceId}`)
    }
  })
  ctx.on('peer/removed', (record: PeerRecord) => {
    if (!canonical(record)) {
      fail(`peer/removed emitted a record without a canonical identity for ${record.instanceId}`)
    }
  })
}

/** Whether the record carries a canonical lowercase-UUID instance id and parseable sightings.
 * @param record - one emitted peer record.
 * @returns whether the identity fields are canonical.
 */
function canonical(record: PeerRecord): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.instanceId)
    && !Number.isNaN(Date.parse(record.firstSeenAt)) && !Number.isNaN(Date.parse(record.lastSeenAt))
}

/** @param ctx - companion context registering package ownership. @returns effect-scoped disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-peer-host', install))
