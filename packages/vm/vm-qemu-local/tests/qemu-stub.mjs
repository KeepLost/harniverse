// Node stand-in for the QEMU binary in unit tests: binds the chardev control
// socket named on its command line and speaks the micro-VM control protocol.
// Modes via DSH_STUB_MODE:
//   (unset)          welcome + pong + clean exit on shutdown
//   reject-version   answer every hello with a version error, then close
//   hang             bind and accept, never reply (drives request timeouts)
//   ignore-shutdown  keep serving after shutdown (drives the SIGKILL fallback)
//   no-bind          stay alive without binding the socket (drives ready deadline)
//   exit-now         exit before doing anything (drives fail-fast exit handling)
import { createServer } from 'node:net'
import { unlinkSync } from 'node:fs'

const mode = process.env.DSH_STUB_MODE ?? ''
if (mode === 'exit-now') process.exit(0)

const serialPaths = []
for (let index = 0; index < process.argv.length; index++) {
  if (process.argv[index] === '-serial' && process.argv[index + 1]?.startsWith('unix:')) {
    const spec = process.argv[index + 1].slice('unix:'.length)
    const path = spec.split(',')[0]
    if (path !== '') serialPaths.push(path)
  }
}
const socketPath = serialPaths.at(-1)
if (socketPath === undefined) throw new Error('stub: no unix -serial on argv')
try {
  unlinkSync(socketPath)
} catch {
  // No stale socket.
}

if (mode === 'no-bind') {
  setInterval(() => {}, 60_000)
} else {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    const send = (payload) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      const frame = Buffer.allocUnsafe(4 + body.length)
      frame.writeUInt32BE(body.length, 0)
      body.copy(frame, 4)
      socket.write(frame)
    }
    // Real agents beacon announce until their first decoded frame; one
    // beacon is enough for the host's handshake to proceed.
    send({ t: 'announce', v: 1, caps: ['ping'], agent: 'qemu-stub' })
    socket.on('data', (chunk) => {
      if (mode === 'hang') return
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 4) break
        const length = buffer.readUInt32BE(0)
        if (buffer.length < 4 + length) break
        const payload = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
        buffer = buffer.subarray(4 + length)
        if (payload.t === 'hello') {
          if (mode === 'reject-version' || payload.v !== 1) {
            send({ t: 'error', code: 'version', minV: 1, maxV: 1, message: 'stub rejection' })
            socket.end()
            return
          }
          if (mode === 'hello-pong') {
            send({ t: 'pong', n: 1 })
            return
          }
          if (mode === 'hello-garbage') {
            const garbage = Buffer.from('this is not json', 'utf8')
            const frame = Buffer.allocUnsafe(4 + garbage.length)
            frame.writeUInt32BE(garbage.length, 0)
            garbage.copy(frame, 4)
            socket.write(frame)
            return
          }
          if (mode === 'welcome-v2') {
            send({ t: 'welcome', v: 2, caps: ['ping'], agent: 'qemu-stub' })
            return
          }
          send({ t: 'welcome', v: 1, caps: ['ping'], agent: 'qemu-stub' })
        } else if (payload.t === 'ping') {
          send({ t: 'pong', n: payload.n })
        } else if (payload.t === 'shutdown') {
          // ignore-shutdown keeps serving: the host must fall back to SIGKILL.
          if (mode === 'ignore-shutdown') continue
          socket.end()
          server.close(() => process.exit(0))
        }
      }
    })
  })
  server.listen(socketPath)
}
