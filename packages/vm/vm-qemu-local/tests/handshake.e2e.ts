import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, probeWorld } from '../src/index.ts'
import { bootRawWorld } from './helpers/vm-e2e.ts'

/**
 * T9 handshake evidence against the real guest agent: a version the guest
 * does not speak is rejected with a typed error and the guest powers off,
 * while the current version is welcomed and pinged. Skips without a usable
 * binary or staged assets.
 */

const probe = probeWorld()
const worldAvailable = probe.qemuVersion !== undefined && probe.assetsReady

/** Skip the agent's announce beacons; return the first non-beacon message. */
async function nextNonBeacon(world: Awaited<ReturnType<typeof bootRawWorld>>): Promise<Exclude<Awaited<ReturnType<typeof world.nextReply>>, { t: 'announce' }>> {
  for (;;) {
    const reply = await world.nextReply(5_000)
    if (reply.t !== 'announce') return reply
  }
}

describe.skipIf(!worldAvailable)('vm-qemu-local: real guest handshake dialect', () => {
  it('rejects an unsupported protocol version with a typed error, then powers off', async () => {
    const world = await bootRawWorld()
    try {
      await world.awaitAnnounce(5_000)
      world.send({ t: 'hello', v: PROTOCOL_VERSION + 1, caps: ['ping'] })
      const reply = await nextNonBeacon(world)
      expect(reply).toMatchObject({ t: 'error', code: 'version', minV: 1, maxV: 1 })
      await expect(world.exit).resolves.toEqual({ code: 0, signal: null })
    } finally {
      await world.close()
    }
  }, 30_000)

  it('welcomes the current version, answers ping, and powers off on shutdown', async () => {
    const world = await bootRawWorld()
    try {
      await world.awaitAnnounce(5_000)
      world.send({ t: 'hello', v: PROTOCOL_VERSION, caps: ['ping'] })
      const welcome = await nextNonBeacon(world)
      expect(welcome).toMatchObject({ t: 'welcome', v: PROTOCOL_VERSION })
      if (welcome.t !== 'welcome') throw new Error('unreachable')

      const pingNumber = 4242
      world.send({ t: 'ping', n: pingNumber })
      await expect(world.nextReply(5_000)).resolves.toMatchObject({ t: 'pong', n: pingNumber })

      world.send({ t: 'shutdown' })
      await expect(world.exit).resolves.toEqual({ code: 0, signal: null })
    } finally {
      await world.close()
    }
  }, 30_000)
})
