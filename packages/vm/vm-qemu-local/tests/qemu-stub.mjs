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
const VERSION = 2
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
    send({ t: 'announce', v: VERSION, caps: ['ping', 'exec', 'fs'], agent: 'qemu-stub' })
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
          if (mode === 'reject-version' || payload.v !== VERSION) {
            send({ t: 'error', code: 'version', minV: VERSION, maxV: VERSION, message: 'stub rejection' })
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
          if (mode === 'welcome-v3') {
            send({ t: 'welcome', v: 3, caps: ['ping', 'exec', 'fs'], agent: 'qemu-stub' })
            return
          }
          send({ t: 'welcome', v: VERSION, caps: ['ping', 'exec', 'fs'], agent: 'qemu-stub' })
        } else if (payload.t === 'ping') {
          send({ t: 'pong', n: payload.n })
        } else if (payload.t === 'exec') {
          // Minimal echo exec so service-level unit tests can drive the seam.
          // Output and exit ride a later tick than the start ack, the way a
          // real agent's child scheduling spaces them from the ack write.
          send({ t: 'exec.started', id: payload.id, pid: 4242 })
          setTimeout(() => {
            send({ t: 'exec.out', id: payload.id, s: 'o', d: Buffer.from(payload.argv.join(' '), 'utf8').toString('base64') })
            send({ t: 'exec.exit', id: payload.id, code: 0, signal: null })
          }, 5)
        } else if (payload.t === 'exec.signal') {
          send({ t: 'exec.acked', id: payload.id })
        } else if (payload.t === 'fs') {
          if (payload.op === 'stat') send({ t: 'fs.ok', id: payload.id, st: { kind: 'file', size: 1, mode: 0o644, mtimeMs: 1 } })
          else if (payload.op === 'read') send({ t: 'fs.ok', id: payload.id, d: Buffer.from('x', 'utf8').toString('base64') })
          else if (payload.op === 'list') send({ t: 'fs.ok', id: payload.id, entries: [{ name: 'a', kind: 'file' }] })
          else send({ t: 'fs.ok', id: payload.id })
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
