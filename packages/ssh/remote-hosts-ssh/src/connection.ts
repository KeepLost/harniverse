/** One SSH transport, its bounded operations and all resources derived from it. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { createServer, Socket } from 'node:net'
import ssh2, { type OpenSSHAgent as SshAgent, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { RemoteHostSshError, isRecord, validPort, validText } from './errors.ts'
import type { Config, RemoteHostSshConnection, RemoteHostSshExecResult, RemoteHostSshForward, RemoteHostSshReverseConfig, RemoteHostSshTarget } from './types.ts'

const { Client, OpenSSHAgent } = ssh2

type Resource = Pick<EventEmitter, 'once' | 'on'> & {
  destroy(): unknown
  unpipe?(): unknown
  resume?(): unknown
  stderr?: { resume?(): unknown }
}
type Operation<T> = { succeed(value: T): void; fail(): void; active(): boolean }
interface Tunnel {
  active(): boolean
  own<T extends Resource>(resource: T): T
  wait(task: Promise<void>): void
  close: () => Promise<void>
}

function sftpCall<T>(start: (callback: (error: Error | undefined | null, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    start((error, value) => { if (error) reject(error); else resolve(value) })
  })
}

function sftpDone(start: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    start((error) => { if (error) reject(error); else resolve() })
  })
}

function release(resource: Resource): void {
  // ssh2's destroy sends CHANNEL_CLOSE; its close event still waits for the
  // readable side to drain, including channels paused by a broken pipe.
  resource.unpipe?.()
  resource.resume?.()
  resource.stderr?.resume?.()
  resource.destroy()
}

/** Internal connection implementation; consumers receive RemoteHostSshConnection. */
export class SshTransport implements RemoteHostSshConnection {
  private readonly client = new Client()
  private readonly lifetime = new AbortController()
  readonly signal = this.lifetime.signal
  readonly closed: Promise<void>
  private readonly socket = new Socket()
  private readonly resources = new Map<Resource, Promise<void>>()
  private readonly draining = new Set<Promise<unknown>>()
  private readonly cleanup = new Set<() => Promise<void>>()
  private readonly reverseMappings = new Map<number, { config: RemoteHostSshReverseConfig; tunnel: Tunnel }>()
  private readonly pendingPorts = new Set<number>()

  /** @param limits - Bounds validated by the mounting service. */
  constructor(private readonly limits: Required<Config>) {
    this.closed = new Promise<void>((resolve) => {
      this.socket.once('close', () => {
        this.stop(new RemoteHostSshError('CLOSED'))
        // ssh2 flushes its pending channel callbacks in this same close dispatch.
        queueMicrotask(() => {
          void Promise.all([
            ...this.resources.values(), ...this.draining,
            ...[...this.cleanup].map(close => close()),
          ]).then(() => { resolve() })
        })
      })
    })
    this.socket.on('error', () => { this.stop(new RemoteHostSshError('CONNECT_FAILED')) })
    this.client.on('error', () => { this.stop(new RemoteHostSshError('CONNECT_FAILED')) })
    this.client.on('tcp connection', (details, accept, reject) => {
      const mapping = this.reverseMappings.get(details.destPort)
      if (details.destIP !== '127.0.0.1' || !mapping?.tunnel.active()) { reject(); return }
      const { config, tunnel } = mapping
      const socket = tunnel.own(new Socket())
      const pending = this.operation<void>((op) => {
        socket.once('close', () => { if (op.active()) { reject(); op.succeed() } })
        socket.once('connect', () => {
          if (!op.active() || !tunnel.active()) { reject(); socket.destroy(); op.succeed(); return }
          const stream = tunnel.own(accept())
          this.pipe(socket, stream)
          op.succeed()
        })
        socket.connect({ host: config.localHost, port: config.localPort })
      }).catch(() => { socket.destroy() })
      tunnel.wait(pending)
    })
  }

  /**
   * @param target - Validated SSH endpoint.
   * @param auth - Explicit authentication options.
   * @param pin - Approved fingerprint, or undefined for a rejecting probe.
   * @param signal - Establishment cancellation.
   * @returns observed fingerprint after authentication or a completed rejecting probe.
   */
  async connect(target: RemoteHostSshTarget, auth: ConnectConfig, pin: string | undefined, signal?: AbortSignal): Promise<string> {
    let observed: string | undefined
    try {
      return await this.operation<string>((op) => {
        this.client.once('ready', () => {
          if (observed !== undefined) op.succeed(observed)
          else op.fail()
        })
        this.socket.connect({ host: target.host, port: target.port ?? 22 })
        this.client.connect({
          ...auth, sock: this.socket, username: target.username,
          ...(typeof auth.agent === 'string' ? { agent: this.agent(auth.agent) } : {}),
          readyTimeout: this.limits.connectTimeoutMs,
          keepaliveInterval: 10_000, keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => {
            const digest = createHash('sha256').update(key).digest()
            observed = `SHA256:${digest.toString('base64').replace(/=+$/, '')}`
            if (pin === undefined) return false
            const accepted = timingSafeEqual(digest, Buffer.from(pin.slice(7), 'base64'))
            if (!accepted) this.stop(new RemoteHostSshError('HOST_KEY_MISMATCH'))
            return accepted
          },
        })
      }, signal, this.limits.connectTimeoutMs)
    } catch (error) {
      await this.dispose()
      if (pin === undefined && observed !== undefined && !signal?.aborted) return observed
      throw error
    }
  }

  private agent(path: string): SshAgent {
    const agent = new OpenSSHAgent(path)
    // ssh2's stock agent owns sockets independently of Client.destroy().
    // Keep its protocol implementation but bind every socket to this transport.
    agent.getStream = (callback) => {
      if (this.signal.aborted) { callback(new RemoteHostSshError('CLOSED')); return }
      const socket = this.track(new Socket(), false)
      let answered = false
      const fail = () => {
        if (answered) return
        answered = true
        socket.destroy()
        callback(new RemoteHostSshError('CONNECT_FAILED'))
      }
      socket.once('connect', () => {
        if (answered) return
        answered = true
        callback(undefined, socket)
      })
      socket.once('error', fail)
      socket.once('close', fail)
      try { socket.connect(path) } catch { fail() }
    }
    return agent
  }

  /** Cancel admission first, then release every resource without remote process control. */
  private stop(error: RemoteHostSshError): void {
    if (this.signal.aborted) return
    this.lifetime.abort(error)
    for (const resource of this.resources.keys()) release(resource)
    this.socket.destroy()
  }

  /** @returns completion after owned resources stop; never controls remote processes. */
  dispose(): Promise<void> {
    this.stop(new RemoteHostSshError('CLOSED'))
    return this.closed
  }

  private track<T extends Resource>(resource: T, fatal = true): T {
    const closed = new Promise<void>((resolve) => {
      resource.once('close', () => { this.resources.delete(resource); resolve() })
    })
    resource.on('error', () => { if (fatal) this.stop(new RemoteHostSshError('OPERATION_FAILED')) })
    this.resources.set(resource, closed)
    if (this.signal.aborted) release(resource)
    return resource
  }

  private operation<T>(start: (op: Operation<T>) => void, signal?: AbortSignal, timeout = this.limits.operationTimeoutMs): Promise<T> {
    if (this.signal.aborted) return Promise.reject(new RemoteHostSshError('CLOSED'))
    if (signal?.aborted) return Promise.reject(new RemoteHostSshError('ABORTED'))
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const clear = () => {
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.signal.removeEventListener('abort', closed)
      }
      const closed = () => {
        if (settled) return
        clear()
        const reason: unknown = this.signal.reason
        reject(reason instanceof RemoteHostSshError ? reason : new RemoteHostSshError('CLOSED'))
      }
      const abort = () => { this.stop(new RemoteHostSshError('ABORTED')) }
      const timer = setTimeout(() => { this.stop(new RemoteHostSshError('TIMED_OUT')) }, timeout)
      this.signal.addEventListener('abort', closed, { once: true })
      signal?.addEventListener('abort', abort, { once: true })
      const op: Operation<T> = {
        active: () => !settled,
        succeed: (value) => { if (!settled) { clear(); resolve(value) } },
        fail: () => { if (!settled) { clear(); reject(new RemoteHostSshError('OPERATION_FAILED')) } },
      }
      try { start(op) } catch { this.stop(new RemoteHostSshError('OPERATION_FAILED')) }
    })
  }

  /**
   * @param command - Server-native command; no provider-authored shell wrapping.
   * @param input - Optional stdin bytes followed by EOF.
   * @param signal - Cancellation closes this connection.
   * @returns bounded output bytes and independent exit metadata.
   */
  async exec(command: string, input?: string | Buffer, signal?: AbortSignal): Promise<RemoteHostSshExecResult> {
    if (!validText(command) || (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input))) {
      throw new RemoteHostSshError('INVALID_ARGUMENT')
    }
    return this.operation((op) => {
      this.client.exec(command, (error, stream) => {
        if (error) { op.fail(); return }
        this.track(stream)
        if (!op.active()) { release(stream); return }
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let bytes = 0
        let exitCode: number | null = null
        let exitSignal: string | null = null
        const collect = (chunks: Buffer[], data: Buffer) => {
          if (!op.active()) return
          bytes += data.length
          if (bytes > this.limits.maxOutputBytes) this.stop(new RemoteHostSshError('LIMIT_EXCEEDED'))
          else chunks.push(Buffer.from(data))
        }
        stream.on('data', (data: Buffer) => { collect(stdout, data) })
        stream.stderr.on('data', (data: Buffer) => { collect(stderr, data) })
        stream.on('exit', (code: number | null, remoteSignal?: string) => {
          exitCode = code ?? null
          exitSignal = remoteSignal ?? null
        })
        stream.once('close', () => {
          op.succeed({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, signal: exitSignal })
        })
        stream.end(input)
      })
    }, signal)
  }

  private withSftp<T>(path: string, task: (sftp: SFTPWrapper) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!validText(path)) return Promise.reject(new RemoteHostSshError('INVALID_ARGUMENT'))
    return this.operation<T>((op) => {
      this.client.sftp((error, sftp) => {
        if (error) { op.fail(); return }
        this.track(sftp)
        if (!op.active()) { sftp.destroy(); return }
        const closed = this.resources.get(sftp)
        const done = task(sftp).then(async (value) => {
          sftp.end()
          await closed
          op.succeed(value)
        }, async () => {
          sftp.end()
          await closed
          op.fail()
        })
        this.draining.add(done)
        void done.then(() => { this.draining.delete(done) })
      })
    }, signal)
  }

  /**
   * @param localPath - Local source file.
   * @param remotePath - Destination in a caller-owned private remote directory.
   * @param signal - Cancellation closes this connection and drains fastPut.
   */
  async upload(localPath: string, remotePath: string, signal?: AbortSignal): Promise<void> {
    if (!validText(localPath)) throw new RemoteHostSshError('INVALID_ARGUMENT')
    return this.withSftp(remotePath, async (sftp) => {
      // fastPut opens with default permissions before applying mode, and skips
      // chmod for empty files. Secure the destination before transferring bytes.
      const handle = await sftpCall<Buffer>((cb) => { sftp.open(remotePath, 'a', { mode: 0o600 }, cb) })
      try { await sftpDone((cb) => { sftp.fchmod(handle, 0o600, cb) }) }
      finally { if (!this.signal.aborted) await sftpDone((cb) => { sftp.close(handle, cb) }) }
      if (this.signal.aborted) throw new RemoteHostSshError('CLOSED')
      await sftpDone((cb) => { sftp.fastPut(localPath, remotePath, { mode: 0o600, concurrency: 4 }, cb) })
    }, signal)
  }

  /**
   * @param path - Server-native file path.
   * @param signal - Cancellation closes this connection.
   * @returns complete file bytes within maxReadBytes; overflow rejects.
   */
  readFile(path: string, signal?: AbortSignal): Promise<Buffer> {
    return this.withSftp(path, async (sftp) => {
      const handle = await sftpCall<Buffer>((cb) => { sftp.open(path, 'r', cb) })
      const chunks: Buffer[] = []
      let bytes = 0
      try {
        while (true) {
          const buffer = Buffer.alloc(Math.min(32_768, this.limits.maxReadBytes - bytes + 1))
          if (this.signal.aborted) throw new RemoteHostSshError('CLOSED')
          const read = await sftpCall<number>((cb) => { sftp.read(handle, buffer, 0, buffer.length, bytes, cb) })
          if (read === 0) return Buffer.concat(chunks, bytes)
          bytes += read
          if (bytes > this.limits.maxReadBytes) {
            this.stop(new RemoteHostSshError('LIMIT_EXCEEDED'))
            throw new RemoteHostSshError('LIMIT_EXCEEDED')
          }
          chunks.push(buffer.subarray(0, read))
        }
      } finally {
        if (!this.signal.aborted) await sftpDone((cb) => { sftp.close(handle, cb) })
      }
    }, signal)
  }

  /**
   * @param path - Server-native path to resolve.
   * @param signal - Cancellation closes this connection.
   * @returns the server's canonical path.
   */
  realpath(path: string, signal?: AbortSignal): Promise<string> {
    return this.withSftp(path, sftp => sftpCall<string>((cb) => { sftp.realpath(path, cb) }), signal)
  }

  /**
   * @param path - One new remote directory, created with mode 0700.
   * @param signal - Cancellation closes this connection.
   */
  mkdir(path: string, signal?: AbortSignal): Promise<void> {
    return this.withSftp(path, sftp => sftpDone((cb) => { sftp.mkdir(path, { mode: 0o700 }, cb) }), signal)
  }

  private pipe(socket: Socket, stream: ClientChannel): void {
    socket.once('close', () => { release(stream) })
    socket.once('error', () => { release(stream) })
    stream.once('close', () => socket.destroy())
    stream.once('error', () => socket.destroy())
    socket.pipe(stream).pipe(socket)
  }

  private tunnel(removeListener: () => Promise<void>): Tunnel {
    const lifetime = new AbortController()
    const resources = new Set<Resource>()
    const pending = new Set<Promise<void>>()
    let disposal: Promise<void> | undefined
    const tunnel: Tunnel = {
      active: () => !lifetime.signal.aborted && !this.signal.aborted,
      own: (resource) => {
        this.track(resource, false)
        resources.add(resource)
        resource.once('close', () => resources.delete(resource))
        if (!tunnel.active()) release(resource)
        return resource
      },
      wait: (task) => {
        pending.add(task)
        void task.then(() => pending.delete(task))
      },
      close: () => {
        if (disposal) return disposal
        lifetime.abort()
        const removed = removeListener()
        const closed = [...resources].map(resource => this.resources.get(resource))
        for (const resource of resources) release(resource)
        const deadline = setTimeout(() => { this.stop(new RemoteHostSshError('TIMED_OUT')) }, this.limits.operationTimeoutMs)
        disposal = Promise.all([removed, ...closed, ...pending]).then(async () => {
          // A channel-open reply can arrive after close began. own() releases
          // that channel immediately, but its close event must still be joined.
          await Promise.all([...resources].flatMap(resource => this.resources.get(resource) ?? []))
        }).finally(() => {
          clearTimeout(deadline)
          this.cleanup.delete(tunnel.close)
        })
        return disposal
      },
    }
    this.cleanup.add(tunnel.close)
    return tunnel
  }

  /**
   * @param remoteHost - Fixed remote destination for accepted loopback sockets.
   * @param remotePort - Destination TCP port.
   * @param signal - Listener-establishment cancellation only.
   * @returns the local ephemeral port and an idempotent, draining close operation.
   */
  async forward(remoteHost: string, remotePort: number, signal?: AbortSignal): Promise<RemoteHostSshForward> {
    if (!validText(remoteHost) || !validPort(remotePort)) throw new RemoteHostSshError('INVALID_ARGUMENT')
    let tunnel: Tunnel | undefined
    try {
      return await this.operation<RemoteHostSshForward>((op) => {
        const server = createServer((socket) => {
          const owner = tunnel
          if (!owner) { socket.destroy(); return }
          owner.own(socket)
          if (!owner.active()) return
          const pending = this.operation<void>((channelOp) => {
            this.client.forwardOut('127.0.0.1', socket.remotePort ?? 0, remoteHost, remotePort, (error, stream) => {
              if (error) { socket.destroy(); channelOp.succeed(); return }
              owner.own(stream)
              if (!owner.active() || socket.destroyed || !channelOp.active()) release(stream)
              else this.pipe(socket, stream)
              channelOp.succeed()
            })
          }).catch(() => { socket.destroy() })
          owner.wait(pending)
        })
        const owner = this.tunnel(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
        tunnel = owner
        server.on('error', () => { op.fail(); void owner.close() })
        server.listen({ host: '127.0.0.1', port: 0, signal: this.signal }, () => {
          if (!op.active()) { void owner.close(); return }
          const address = server.address()
          if (!address || typeof address === 'string') { op.fail(); return }
          op.succeed({ port: address.port, close: owner.close })
        })
      }, signal)
    } catch (error) {
      await tunnel?.close()
      throw error
    }
  }

  /**
   * @param config - Exact approved local destination and optional remote loopback port.
   * @param signal - Binding-establishment cancellation only.
   * @returns the remote port and an idempotent, draining unbind operation.
   */
  async reverse(config: RemoteHostSshReverseConfig, signal?: AbortSignal): Promise<RemoteHostSshForward> {
    if (!isRecord(config) || !validText(config.localHost) || !validPort(config.localPort) || !validPort(config.remotePort ?? 0, true)) {
      throw new RemoteHostSshError('INVALID_ARGUMENT')
    }
    const requested = config.remotePort ?? 0
    if (requested && (this.reverseMappings.has(requested) || this.pendingPorts.has(requested))) {
      throw new RemoteHostSshError('INVALID_ARGUMENT')
    }
    if (requested) this.pendingPorts.add(requested)
    // Snapshot caller-owned configuration before an asynchronous bind can complete.
    const destination = { ...config }
    try {
      return await this.operation<RemoteHostSshForward>((op) => {
        this.client.forwardIn('127.0.0.1', requested, (error, port) => {
          if (error) { op.fail(); return }
          if (!op.active()) return // Cancellation has already destroyed the whole transport.
          if (!validPort(port) || (requested !== 0 && port !== requested) || this.reverseMappings.has(port)) {
            this.stop(new RemoteHostSshError('OPERATION_FAILED'))
            return
          }
          const tunnel = this.tunnel(async () => {
            this.reverseMappings.delete(port)
            if (this.signal.aborted) return
            await this.operation<void>((closeOp) => {
              this.client.unforwardIn('127.0.0.1', port, (error) => {
                if (error) this.stop(new RemoteHostSshError('OPERATION_FAILED'))
                else closeOp.succeed()
              })
            }).catch(() => {}) // A lost transport removes its remote listeners.
          })
          this.reverseMappings.set(port, { config: destination, tunnel })
          op.succeed({ port, close: tunnel.close })
        })
      }, signal)
    } finally { if (requested) this.pendingPorts.delete(requested) }
  }
}
