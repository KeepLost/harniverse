/** Published entry smoke: run with plain Node after the package-local build. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import ssh2 from 'ssh2'
import DefaultRemoteHostSsh, { RemoteHostSsh } from '../lib/index.js'
import { apply as installInvariant } from '../lib/invariant.js'

assert.equal(DefaultRemoteHostSsh, RemoteHostSsh)
assert.equal(typeof installInvariant, 'function')
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const parsed = ssh2.utils.parseKey(hostKey)
assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed))
const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
const peers = new Set()
const commands = []
let authentications = 0
const server = new ssh2.Server({ hostKeys: [hostKey] }, (peer) => {
  peers.add(peer)
  peer.on('error', () => {}) // Rejecting the fingerprint probe closes its handshake.
  peer.once('close', () => peers.delete(peer))
  peer.on('authentication', (auth) => {
    authentications++
    if (auth.method === 'password' && auth.password === 'fixture-password') auth.accept()
    else auth.reject()
  })
  peer.on('session', (accept) => {
    accept().on('exec', (accept, _reject, info) => {
      commands.push(info.command)
      const stream = accept()
      stream.on('data', data => stream.write(data))
      stream.on('end', () => {
        stream.stderr.write('stderr')
        stream.exit(3)
        stream.end()
      })
    })
  })
})
const ctx = new Context()
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await ctx.plugin(RemoteHostSsh)
  const config = { host: '127.0.0.1', port: address.port, username: 'fixture', fingerprint }
  assert.equal(await ctx.remoteHostSsh.probe(config), fingerprint)
  assert.equal(authentications, 0)
  const connection = await ctx.remoteHostSsh.open(config, { kind: 'password', password: 'fixture-password' })
  assert.deepEqual(await connection.exec('fixture-command', 'stdin'), {
    stdout: Buffer.from('stdin'), stderr: Buffer.from('stderr'), exitCode: 3, signal: null,
  })
  await ctx.fiber.dispose()
  await connection.closed
  assert.deepEqual(commands, ['fixture-command'])
} finally {
  await ctx.fiber.dispose()
  const closing = [...peers].map(peer => new Promise(resolve => peer.once('close', resolve)))
  for (const peer of peers) peer.end()
  await Promise.all(closing)
  await new Promise(resolve => server.close(resolve))
}
console.log('Built package: pinned probe, authentication, exec, invariant export and plugin disposal passed')
