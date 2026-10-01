/** Forwarding requests carried by the real SSH peer into real loopback TCP sockets. */
import { once } from 'node:events'
import type { EventEmitter } from 'node:events'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { Connection, TcpipRequestInfo } from 'ssh2'

export function serveForwarding(peer: Connection, events: EventEmitter, holds: Set<string>) {
  const listeners = new Map<number, Server>()
  const sockets = new Set<Socket>()
  const binds: { bindAddr: string; bindPort: number }[] = []
  const destinations: TcpipRequestInfo[] = []
  const own = (socket: Socket) => {
    sockets.add(socket)
    socket.on('error', () => {}) // Failed destination tests intentionally refuse sockets.
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  peer.on('tcpip', (accept, reject, info) => {
    destinations.push(info)
    events.emit('tcpip', accept)
    if (holds.has('tcpip')) return
    const socket = own(createConnection({ host: info.destIP, port: info.destPort }))
    socket.once('error', () => { reject() })
    socket.once('connect', () => {
      const stream = accept()
      socket.once('close', () => { stream.resume(); stream.destroy() })
      stream.on('error', () => socket.destroy())
      stream.once('close', () => socket.destroy())
      socket.pipe(stream).pipe(socket)
    })
  })
  peer.on('request', (accept, reject, name, info: { bindAddr: string; bindPort: number }) => {
    events.emit(name)
    if (holds.has(name)) return
    if (name === 'cancel-tcpip-forward') {
      const listener = listeners.get(info.bindPort)
      listeners.delete(info.bindPort)
      listener?.close()
      accept?.()
      return
    }
    if (name !== 'tcpip-forward') { reject?.(); return }
    binds.push(info)
    const listener = createServer((incoming) => {
      const socket = own(incoming)
      const address = listener.address()
      if (!address || typeof address === 'string') { socket.destroy(); return }
      peer.forwardOut(info.bindAddr, address.port, '127.0.0.1', socket.remotePort!, (error, stream) => {
        if (error) { socket.destroy(); return }
        socket.once('close', () => { stream.resume(); stream.destroy() })
        stream.on('error', () => socket.destroy())
        stream.once('close', () => socket.destroy())
        socket.pipe(stream).pipe(socket)
      })
    })
    listener.once('error', () => reject?.())
    listener.listen(info.bindPort, info.bindAddr, () => {
      const address = listener.address()
      if (!address || typeof address === 'string') throw new Error('Fixture listener address missing')
      listeners.set(address.port, listener)
      accept?.(address.port)
    })
  })
  async function close() {
    const closing = [...sockets].map(socket => once(socket, 'close'))
    for (const socket of sockets) socket.destroy()
    await Promise.all(closing)
    await Promise.all([...listeners.values()].map(listener => new Promise<void>((resolve) => { listener.close(() => { resolve() }) })))
    listeners.clear()
  }
  peer.once('close', () => { void close() })
  return { close, binds, destinations, listeners }
}

export async function echoServer() {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {}) // The test closes active forwarding sockets.
    socket.once('close', () => sockets.delete(socket))
    socket.pipe(socket)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture echo address missing')
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

export async function exchange(port: number, text: string) {
  const socket = createConnection({ host: '127.0.0.1', port })
  const received = once(socket, 'data')
  socket.write(text)
  try {
    const data: unknown = (await received)[0]
    if (!Buffer.isBuffer(data)) throw new Error('Fixture expected bytes')
    return data.toString()
  }
  finally { socket.destroy() }
}
