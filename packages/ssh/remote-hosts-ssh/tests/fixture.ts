/** Real SSH protocol peer with fresh, process-local RSA credentials. */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { Server, utils, type Connection, type ParsedKey, type ServerChannel } from 'ssh2'
import { serveSftp, type FixtureFile } from './sftp-fixture.ts'
import { serveForwarding } from './forwarding-fixture.ts'

const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs1', format: 'pem' }).toString()
const parsed = utils.parseKey(hostKey)
if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Fixture host key invalid')
export const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64url').replaceAll('-', '+').replaceAll('_', '/')}`

const identity = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
export const privateKey = identity.export({ type: 'pkcs1', format: 'pem' }).toString()
export const encryptedKey = identity.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'fixture-passphrase' }).toString()
function parseIdentity(): ParsedKey {
  const key = utils.parseKey(privateKey)
  if (key instanceof Error || Array.isArray(key)) throw new Error('Fixture identity invalid')
  return key
}
const publicKey = parseIdentity()

export async function fixture() {
  const peers = new Set<Connection>()
  const commands: string[] = []
  const authentications: string[] = []
  const channels = new Set<ServerChannel>()
  const events = new EventEmitter()
  const files = new Map<string, FixtureFile>()
  const holds = new Set<string>()
  const forwarding: ReturnType<typeof serveForwarding>[] = []
  const server = new Server({ hostKeys: [hostKey] }, (peer) => {
    peers.add(peer)
    peer.on('error', () => {}) // Rejected host keys deliberately terminate the handshake.
    peer.on('close', () => { peers.delete(peer) })
    peer.on('authentication', (auth) => {
      authentications.push(auth.method)
      events.emit('authentication')
      if (holds.has('authentication')) return
      if (auth.method === 'password' && auth.password === 'fixture-password') auth.accept()
      else if (auth.method === 'publickey' && auth.key.data.equals(publicKey.getPublicSSH())
        && (!auth.signature || publicKey.verify(auth.blob!, auth.signature, auth.hashAlgo))) auth.accept()
      else auth.reject(['password', 'publickey'])
    })
    peer.on('ready', () => {
      forwarding.push(serveForwarding(peer, events, holds))
      peer.on('session', (accept) => {
        const session = accept()
        session.on('sftp', (accept) => {
          events.emit('sftp')
          if (!holds.has('sftp')) serveSftp(accept(), files, events, holds)
        })
        session.on('exec', (accept, _reject, info) => {
          commands.push(info.command)
          const stream = accept()
          channels.add(stream)
          stream.on('error', () => {}) // Cancellation closes active fixture channels.
          stream.once('close', () => { channels.delete(stream) })
          events.emit('exec', info.command)
          if (info.command === 'hang') return
          const input: Buffer[] = []
          stream.on('data', (chunk: Buffer) => input.push(chunk))
          stream.on('end', () => {
            if (info.command.includes('uname -s')) {
              // The connectivity probe expects a zero exit and one platform answer.
              stream.write('Linux\nx86_64\n')
              stream.exit(0)
              stream.end()
              return
            }
            stream.write(Buffer.concat(input))
            stream.stderr.write('fixture-stderr')
            if (info.command === 'signal') stream.exit('TERM', false, 'fixture signal')
            else if (info.command !== 'no-exit') stream.exit(7)
            stream.end()
          })        })
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('Fixture address missing')
  return {
    config: { host: '127.0.0.1', port: address.port, username: 'fixture', fingerprint },
    peers, commands, authentications, channels, files, events, forwarding, holds,
    async close() {
      const closing = [...peers].map(peer => new Promise<void>((resolve) => { peer.once('close', () => { resolve() }) }))
      for (const peer of peers) peer.end()
      await Promise.all(closing)
      await Promise.all(forwarding.map(item => item.close()))
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
