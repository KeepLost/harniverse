/** The production effects: platform fetch and a real `ws` connection carrying the Authorization header. */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { internals } from '../src/internals.ts'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

describe('internals', () => {
  it('fetches through the platform fetch', async () => {
    const server = createServer((_request, response) => { response.end('pong') })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    closers.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
    const { port } = server.address() as AddressInfo
    const response = await internals.fetch(`http://127.0.0.1:${String(port)}/`)
    expect(await response.text()).toBe('pong')
  })

  it('opens a real WebSocket with custom headers and delivers messages', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => { server.on('listening', resolve) })
    closers.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
    const authorizations: Array<string | undefined> = []
    server.on('connection', (socket, request) => {
      authorizations.push(request.headers.authorization)
      socket.send('hello')
    })
    const { port } = server.address() as AddressInfo
    const socket = internals.createSocket(new URL(`ws://127.0.0.1:${String(port)}/api/events.mux`), { authorization: 'Bearer abc' })
    const received = await new Promise<string>((resolve) => {
      socket.on('message', (data) => { resolve(String(data)) })
    })
    expect(received).toBe('hello')
    expect(authorizations).toEqual(['Bearer abc'])
    const closed = new Promise<number>((resolve) => { socket.on('close', resolve) })
    socket.close(1000)
    expect(await closed).toBe(1000)
  })
})
