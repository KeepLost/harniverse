import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProtocol, utils } from 'ssh2'
import { expect, it } from 'vitest'
import RemoteHostSsh from '../src/index.ts'
import { fixture, privateKey } from './fixture.ts'

it.each([false, true])('owns explicit agent sockets, including stalled agents (%s)', async (stall) => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-agent-'))
  const path = process.platform === 'win32' ? String.raw`\\.\pipe\ssh-fixture-${randomUUID()}` : join(directory, 'agent.sock')
  const sockets = new Set<Socket>()
  const key = utils.parseKey(privateKey)
  if (key instanceof Error || Array.isArray(key)) throw new Error('Invalid fixture key')
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {}) // Cancellation terminates an in-flight agent exchange.
    socket.once('close', () => sockets.delete(socket))
    if (stall) { socket.resume(); return }
    const protocol = new AgentProtocol(false)
    protocol.on('error', () => socket.destroy())
    protocol.on('identities', (request) => { protocol.getIdentitiesReply(request, [key]) })
    protocol.on('sign', (request, _publicKey, data, options) => { protocol.signReply(request, key.sign(data, options.hash)) })
    socket.pipe(protocol).pipe(socket)
  }).listen(path)
  await once(server, 'listening')
  const host = await fixture()
  const ctx = new Context()
  const service = new RemoteHostSsh(ctx)
  try {
    if (stall) {
      const controller = new AbortController()
      const connected = once(server, 'connection')
      const result = expect(service.open(host.config, { kind: 'agent', socket: path }, controller.signal))
        .rejects.toMatchObject({ code: 'ABORTED' })
      await connected
      controller.abort()
      await result
    } else {
      const connection = await service.open(host.config, { kind: 'agent', socket: path })
      expect(host.authentications).toEqual(['publickey', 'publickey'])
      await connection.dispose()
    }
    await expect.poll(() => sockets.size).toBe(0)
  } finally {
    await ctx.fiber.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})
