/** Loopback control-endpoint coverage: the child half of the Windows carrier. */
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInheritedControlChannel, SUBPROCESS_CONTROL_ENV } from '../src/control.ts'

afterEach(() => { vi.unstubAllEnvs() })

describe('loopback control endpoint', () => {
  it('connects a tcp marker to the named loopback endpoint', async () => {
    const server = createServer()
    const received: string[] = []
    server.once('connection', (socket) => {
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => { received.push(chunk) })
      socket.write('pong\n')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    vi.stubEnv(SUBPROCESS_CONTROL_ENV, `tcp:${String(port)}`)

    const channel = openInheritedControlChannel()
    await new Promise<void>((resolve) => { channel.once('connect', () => { resolve(undefined) }) })
    expect(process.env[SUBPROCESS_CONTROL_ENV]).toBeUndefined()
    channel.write('ping\n')
    const reply = await new Promise<string>((resolve) => { channel.once('data', (chunk: Buffer) => { resolve(chunk.toString()) }) })
    expect(reply.trim()).toBe('pong')
    // The server's data event may trail the client's reply by a tick.
    await vi.waitFor(() => { expect(received.join('')).toContain('ping') })
    channel.destroy()
    await new Promise<void>(resolve => server.close(() => { resolve(undefined) }))
  })

  it('rejects an invalid tcp marker port', () => {
    vi.stubEnv(SUBPROCESS_CONTROL_ENV, 'tcp:not-a-port')
    expect(() => openInheritedControlChannel()).toThrow('endpoint is invalid')
    expect(process.env[SUBPROCESS_CONTROL_ENV]).toBeUndefined()
  })
})
