import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureInstanceIdentity, peerHelloMessage, peerInstanceId } from '@deepseek-ai/dsh-peer-protocol'
import PeerHost from '../src/index.ts'
import * as PeerHostInvariant from '../src/invariant.ts'

const directories: string[] = []

describe('invariant companion', () => {
  it('registers under the package name and asserts the event-to-store relation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'peer-invariant-'))
    directories.push(home)
    await ensureInstanceIdentity(home)
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(PeerHost, { dshHome: home })
    await expect(ctx.plugin(PeerHostInvariant).await()).resolves.toBeDefined()
    const identity = {
      instanceId: peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666'),
      displayName: 'Laptop', platform: 'darwin', arch: 'arm64', version: '1.0.0-rc.3',
    }
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const challenge = (await ctx.peerHost.challenge()).challenge
    await ctx.peerHost.hello({
      challenge,
      identity,
      proof: {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
        signature: sign('sha256', Buffer.from(peerHelloMessage(identity.instanceId, challenge), 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
      },
    })
    await ctx.peerHost.removePeer(peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666'))
    // A violation throws InvariantError out of emit; each fail path is covered by one emission.
    expect(() => { ctx.emit('peer/paired', { instanceId: 'nope', displayName: 'x', platform: 'linux', arch: 'x64', version: '1',
      surface: { delegate: true, message: true, list: true }, pairedVia: 'invitation', status: 'active',
      firstSeenAt: '2026-11-18T08:00:00.000Z', lastSeenAt: '2026-11-18T08:00:00.000Z' }) }).toThrow(/incoherent/)
    expect(() => { ctx.emit('peer/paired', { instanceId: peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666'), displayName: 'x', platform: 'linux', arch: 'x64', version: '1',
      surface: { delegate: true, message: true, list: true }, pairedVia: 'invitation', status: 'active',
      firstSeenAt: '2026-11-18T08:00:00.000Z', lastSeenAt: '2026-11-18T08:00:01.000Z' }) }).toThrow(/incoherent/)
    expect(() => { ctx.emit('peer/removed', { instanceId: 'nope', displayName: 'x', platform: 'linux', arch: 'x64', version: '1',
      surface: { delegate: true, message: true, list: true }, pairedVia: 'invitation', status: 'active',
      firstSeenAt: '2026-11-18T08:00:00.000Z', lastSeenAt: '2026-11-18T08:00:00.000Z' }) }).toThrow(/canonical identity/)
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
})
