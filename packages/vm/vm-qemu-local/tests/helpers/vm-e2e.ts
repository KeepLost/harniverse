import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildQemuArgv, DEFAULT_QEMU_BIN, defaultAssetsDir, isKvmWritable, resolveAccel } from '../../src/qemu.ts'
import { FrameReader, encodeFrame } from '../../src/frame.ts'
import type { GuestMessage } from '../../src/protocol.ts'

/** Raw-protocol boot for handshake e2e: real QEMU, manual framing. */
export interface RawWorld {
  child: ChildProcess
  socket: Socket
  runDir: string
  /** Await one guest message, failing on socket close or the deadline. */
  nextReply(timeoutMs: number): Promise<GuestMessage>
  /** Wait for the agent's announce beacon before writing into the UART. */
  awaitAnnounce(timeoutMs: number): Promise<void>
  send(message: unknown): void
  exit: Promise<{ code: number | null; signal: string | null }>
  close(): Promise<void>
}

/** Boot one real guest and connect to its control port without the lifecycle driver. */
export async function bootRawWorld(readyTimeoutMs = 20_000): Promise<RawWorld> {
  const runDir = mkdtempSync(join(tmpdir(), 'dsh-vm-raw-'))
  const controlSocketPath = join(runDir, 'ctl.sock')
  const argv = buildQemuArgv({
    qemuBin: DEFAULT_QEMU_BIN,
    accel: resolveAccel(isKvmWritable(), 'auto'),
    memoryMiB: 256,
    cpus: 2,
    kernelPath: join(defaultAssetsDir(), 'vmlinuz-virt'),
    initrdPath: join(defaultAssetsDir(), 'initramfs.cpio.gz'),
    controlSocketPath,
    consoleLogPath: join(runDir, 'console.log'),
  })
  const child = spawn(argv[0] ?? DEFAULT_QEMU_BIN, argv.slice(1), { stdio: 'ignore' })
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => { resolve({ code, signal }) })
  })

  const deadline = Date.now() + readyTimeoutMs
  let socket: Socket | undefined
  while (socket === undefined) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error('control socket never appeared')
    socket = await new Promise<Socket | undefined>((resolve) => {
      const attempt = connect(controlSocketPath)
      attempt.once('connect', () => { resolve(attempt) })
      attempt.once('error', () => { resolve(undefined) })
    })
    if (socket === undefined) await new Promise(resolve => setTimeout(resolve, 200))
  }

  const reader = new FrameReader()
  const pending: string[] = []
  const waiters: { resolve: (payload: string) => void; reject: (error: Error) => void }[] = []
  let closed = false
  socket.on('data', (chunk) => {
    for (const payload of reader.push(chunk)) {
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter.resolve(payload)
      else pending.push(payload)
    }
  })
  socket.on('close', () => {
    closed = true
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('control port closed'))
  })

  const nextReply = async (timeoutMs: number): Promise<GuestMessage> => {
    const buffered = pending.shift()
    if (buffered !== undefined) return JSON.parse(buffered) as GuestMessage
    if (closed) throw new Error('control port closed')
    const payload = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('reply timeout')) }, timeoutMs)
      waiters.push({
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
    return JSON.parse(payload) as GuestMessage
  }

  return {
    child,
    socket,
    runDir,
    exit,
    send(message) {
      socket.write(encodeFrame(JSON.stringify(message)))
    },
    nextReply,
    async awaitAnnounce(timeoutMs) {
      // Writing before the agent opened the port loses bytes to the UART
      // FIFO; the beacon is the safe cue that ttyS1 is being served.
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const message = await nextReply(Math.max(deadline - Date.now(), 1))
        if (message.t === 'announce') return
      }
    },
    async close() {
      socket.destroy()
      child.kill('SIGKILL')
      await exit
      rmSync(runDir, { recursive: true, force: true })
    },
  }
}
