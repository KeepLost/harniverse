/** Stored-transport dialing: direct routes, loopback validation, and SSH forwards. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import { withPeerOrigin, withPeerTransport } from '../src/transport.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** One seeded record value, or a thunk that needs its registry home before it can be written. */
type RecordSeed = ((home: string) => Promise<unknown>) | Record<string, unknown>

/** One remote-hosts registry home carrying the named records, or record thunks seeded with it. */
async function registryHost(seeds: RecordSeed[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'peer-transport-'))
  roots.push(home)
  const resolved: unknown[] = []
  for (const seed of seeds) {
    resolved.push(typeof seed === 'function' ? await seed(home) : seed)
  }
  await writeFile(join(home, 'remote-hosts.json'), JSON.stringify({ version: 1, hosts: resolved }))
  return home
}

interface FakeConnection {
  forward(host: string, port: number): Promise<{ port: number; close(): Promise<void> }>
  dispose(): Promise<void>
}

/** A context whose optional SSH provider records dials and serves local forwards. */
function sshContext(
  connections: FakeConnection[],
  options: { failOpen?: boolean } = {},
): Context {
  const ctx = new Context()
  const provider = {
    open: async () => {
      const connection: FakeConnection = {
        forward: async () => {
          const port = 44_000 + connections.length
          return { port, close: async () => { forwarded.push(port) } }
        },
        dispose: async () => { disposed += 1 },
      }
      connections.push(connection)
      return connection
    },
  }
  if (options.failOpen !== true) ctx.provide('remoteHostSsh', provider)
  return ctx
}

const forwarded: number[] = []
let disposed = 0

/** One valid SHA-256 fingerprint for registry records. */
const fingerprint = (): string => `SHA256:${randomBytes(32).toString('base64').replace(/=+$/, '')}`

/** One key-auth record whose private key file exists in the test home.
 * @param home - registry home the key file is written into.
 */
async function keyRecord(home: string): Promise<unknown> {
  const keyPath = join(home, 'id_ed25519')
  await writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nprobe\n-----END PRIVATE KEY-----\n')
  return {
    id: '45454545-4545-4455-8455-454545454545', name: 'keybox', host: 'keybox.invalid', port: 22, username: 'runner',
    fingerprint: fingerprint(), platform: 'linux', architecture: 'x64',
    authentication: { kind: 'key', keyPath }, reverseMappings: [],
  }
}

it('dials direct routes without touching the SSH provider', async () => {
  const origins: string[] = []
  const value = await withPeerOrigin(sshContext([]), '/tmp', { kind: 'direct' }, 'https://build.example.org:8443',
    async (origin) => { origins.push(origin); return 'ok' })
  expect(value).toBe('ok')
  expect(origins).toEqual(['https://build.example.org:8443'])
})

it('forwards an ssh route through the recorded host and closes the tunnel afterwards', async () => {
  forwarded.length = 0
  disposed = 0
  const connections: FakeConnection[] = []
  const home = await registryHost([keyRecord])
  const origins: string[] = []
  const value = await withPeerOrigin(sshContext(connections), home, { kind: 'ssh', host: 'keybox' },
    'http://127.0.0.1:8080', async (origin) => { origins.push(origin); return 42 })
  expect(value).toBe(42)
  expect(origins).toHaveLength(1)
  const port = new URL(origins[0]!).port
  expect(origins[0]).toBe(`http://127.0.0.1:${port}`)
  expect(connections).toHaveLength(1)
  expect(forwarded).toEqual([Number(port)])
  expect(disposed).toBe(1)
})

it('resolves one stored target through its recorded transport', async () => {
  const home = await registryHost([keyRecord])
  const target: PeerTarget = {
    targetInstanceId: '3f2a8f9e-1111-4222-8333-444455556666',
    displayName: 'Build workstation',
    endpoint: { origin: 'http://127.0.0.1:8080' },
    transport: { kind: 'ssh', host: 'keybox' },
    grantName: 'peer-x', grantId: 'g', status: 'active', addedAt: '2026-01-01T00:00:00.000Z',
  }
  const value = await withPeerTransport(sshContext([]), home, target, async origin => origin)
  expect(value).toContain('http://127.0.0.1:')
})

it('rejects ssh routes whose endpoint is not a loopback http origin, with or without the service', async () => {
  const home = await registryHost([keyRecord])
  await expect(withPeerOrigin(sshContext([]), home, { kind: 'ssh', host: 'keybox' }, 'https://build.example.org:8443', async () => 'x'))
    .rejects.toThrowError(/ssh targets require an http:\/\/127\.0\.0\.1/)
  await expect(withPeerOrigin(sshContext([]), home, { kind: 'ssh', host: 'keybox' }, 'http://localhost:8080', async () => 'x'))
    .rejects.toThrowError(/ssh targets require an http:\/\/127\.0\.0\.1/)
  await expect(withPeerOrigin(sshContext([], { failOpen: true }), home, { kind: 'ssh', host: 'keybox' }, 'http://127.0.0.1:8080', async () => 'x'))
    .rejects.toThrowError(/needs the remote-hosts-ssh service/)
})

it('names a missing remote-hosts record and maps host logins onto closed credentials', async () => {
  const home = await registryHost([])
  await expect(withPeerOrigin(sshContext([]), home, { kind: 'ssh', host: 'box' }, 'http://127.0.0.1:8080', async () => 'x'))
    .rejects.toThrowError(/no remote host named "box"/)
  const agentHome = await registryHost([{
    id: '44444444-4444-4444-8444-444444444444', name: 'box', host: 'box.invalid', port: 22, username: 'runner',
    fingerprint: fingerprint(), platform: 'linux', architecture: 'x64',
    authentication: { kind: 'agent', socket: '/run/agent.sock' }, reverseMappings: [],
  }])
  const connections: FakeConnection[] = []
  await expect(withPeerOrigin(sshContext(connections), agentHome, { kind: 'ssh', host: 'box' }, 'http://127.0.0.1:8080', async () => 'x'))
    .resolves.toBe('x')
  expect(connections).toHaveLength(1)
})

it('rejects stored logins it cannot express headlessly', async () => {
  const home = await registryHost([{
    id: '46464646-4646-4466-8466-464646464646', name: 'box', host: 'box.invalid', port: 22, username: 'runner',
    fingerprint: fingerprint(), platform: 'linux', architecture: 'x64',
    authentication: { kind: 'key', keyPath: '/nonexistent/key', passphraseRef: 'passphrase' }, reverseMappings: [],
  }])
  await expect(withPeerOrigin(sshContext([]), home, { kind: 'ssh', host: 'box' }, 'http://127.0.0.1:8080', async () => 'x'))
    .rejects.toThrowError(/UNSUPPORTED_CREDENTIALS/)
})
