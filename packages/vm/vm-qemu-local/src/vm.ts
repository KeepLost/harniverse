/**
 * Micro-VM world lifecycle: spawn QEMU, meet the guest agent on the
 * virtio-serial control port, and own teardown.
 *
 * The QEMU process is an ordinary child — never a daemon. `openWorld` fails
 * closed on missing assets, unusable binaries, handshake timeouts, and
 * protocol version rejection; `destroy` always ends in an observed process
 * exit and removes the run directory. Spawn, socket connection, temp
 * directory creation, and the clock are injectable for tests.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chown as nodeChown, copyFile as nodeCopyFile, mkdtemp as nodeMkdtemp, readFile as nodeReadFile, rm as nodeRm, truncate as nodeTruncate, writeFile as nodeWriteFile } from 'node:fs/promises'
import { connect as nodeConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameReader, encodeFrame } from './frame.ts'
import { DEFAULT_QEMU_BIN, buildQemuArgv, buildWrappedArgv, defaultAssetsDir, isKvmWritable, resolveAccel, resolveWrapPath, type QemuAccel } from './qemu.ts'
import { HOST_CAPS, PROTOCOL_VERSION, negotiateVersion, parseGuestMessage, type HostMessage } from './protocol.ts'
import { ExecSession } from './exec.ts'
import type { CollectExecOptions, ExecHandle, ExecOptions, ExecResult, VmWorldDescriptor, VmWorldExit } from '@deepseek-ai/dsh-vm'
import { WorldFs } from './fs.ts'
import { WorldEgress } from './egress.ts'
import { DEFAULT_EXPORT_CAPACITY_BYTES, WORKSPACE_HEADER_BYTES, WorldWorkspace, assertValidWorkspaceTar, buildWorkspaceImage, packWorkspaceTar } from './workspace.ts'
import type { EgressPolicy } from '@deepseek-ai/dsh-vm'

/** Assets (`vmlinuz-virt`, `initramfs.cpio.gz`) are absent from the assets directory. */
export class AssetsMissingError extends Error {
  constructor(public readonly assetsDir: string) {
    super(`micro-VM assets missing in ${assetsDir}: run packages/vm/vm-qemu-local/assets/build-rootfs.sh`)
    this.name = 'AssetsMissingError'
  }
}

/** The QEMU binary could not be spawned. */
export class QemuSpawnError extends Error {
  constructor(cause: Error, public readonly qemuBin: string) {
    super(`cannot spawn ${qemuBin}: ${cause.message}`)
    this.name = 'QemuSpawnError'
    this.cause = cause
  }
}

/** The guest did not complete the handshake before the ready deadline. */
export class WorldReadyTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`micro-VM not ready within ${timeoutMs}ms`)
    this.name = 'WorldReadyTimeoutError'
  }
}

/** The guest rejected the host's protocol version and closed the port. */
export class GuestVersionMismatchError extends Error {
  constructor(
    public readonly hostV: number,
    public readonly guestV: number | undefined,
    public readonly minV: number | undefined,
    public readonly maxV: number | undefined,
  ) {
    super(`protocol version rejected: host ${hostV}, guest ${guestV ?? '(absent)'}, guest range ${String(minV)}–${String(maxV)}`)
    this.name = 'GuestVersionMismatchError'
  }
}

/** The control channel closed or produced a non-negotiable handshake reply. */
export class WorldClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorldClosedError'
  }
}

/** The QEMU child exited before the handshake completed. */
export class WorldExitBeforeHandshakeError extends WorldClosedError {
  constructor(worldExit: WorldExit) {
    super(`qemu exited before handshake: code ${String(worldExit.code)} signal ${String(worldExit.signal)}`)
    this.name = 'WorldExitBeforeHandshakeError'
  }
}

/** Minimal child-process surface the world drives. */
export interface ChildLike {
  readonly pid?: number | undefined
  kill(signal?: NodeJS.Signals): void
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

/** Minimal stream socket surface the control channel drives. */
export interface SocketLike {
  write(data: Uint8Array | string): boolean
  destroy(): void
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'close', listener: (hadError: boolean) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

/** Sizing, asset locations, and deadlines for one world boot. */
export interface OpenWorldOptions {
  /** Directory holding `vmlinuz-virt` and `initramfs.cpio.gz`; defaults to the package `.cache/assets`. */
  assetsDir?: string
  /** QEMU binary to spawn; defaults to `qemu-system-x86_64` from PATH. */
  qemuBin?: string
  /** Acceleration preference; `auto` picks KVM when `/dev/kvm` is writable, else TCG. Default `auto`. */
  accel?: 'auto' | QemuAccel
  /** Guest memory in MiB. Default 256. */
  memoryMiB?: number
  /** Guest vCPU count. Default 2. */
  cpus?: number
  /** Handshake deadline in milliseconds. Default 15 000. */
  readyTimeoutMs?: number
  /** Grace period for a guest-requested shutdown before SIGKILL, in milliseconds. Default 5 000. */
  shutdownTimeoutMs?: number
  /**
 * Sandbox hardening for the QEMU child: `auto` (default) supervises QEMU
 * through the staged `qemu-wrap` when present — Landlock read-only tree
 * plus one writable scratch directory, rlimits, and a uid drop to 65534 on
 * root hosts; `off` spawns QEMU directly.
 */
  sandbox?: 'auto' | 'off'
  /**
   * Approval callback for this world's egress relay; when omitted every
   * `world.egress.open` denies.
   */
  egressPolicy?: EgressPolicy
  /**
   * Workspace data-plane configuration: attaches the virtio-blk import and
   * export images and enables `world.workspace`. Absent means the world has
   * no workspace devices and workspace operations fail.
   */
  workspace?: WorkspaceOptions
}

/** Workspace data-plane configuration for one world boot. */
export interface WorkspaceOptions {
  /**
   * Snapshot tar staged as the world's immutable import image; the guest
   * unpacks it into `/workspace` on `world.workspace.import()`. Absent stages
   * an empty snapshot (import then resets the workspace).
   */
  import?: Uint8Array
  /**
   * Export image capacity in bytes; the guest's export fails when the packed
   * snapshot outgrows it. Default {@link DEFAULT_EXPORT_CAPACITY_BYTES}
   * (1 GiB, matching the sandbox wrapper's per-file rlimit).
   */
  exportCapacityBytes?: number
}

/** Injectable environment seams; every field has a real default. */
export interface VmDeps {
  spawn?: (argv: readonly string[], options: { stdio: 'ignore' }) => ChildLike
  connect?: (socketPath: string) => Promise<SocketLike>
  mkdtemp?: (prefix: string) => Promise<string>
  now?: () => number
  /** Effective uid of the host process; defaults to `process.geteuid`. */
  euid?: () => number
  /** Ownership transfer for the scratch directory under root hosts. */
  chown?: (path: string, uid: number, gid: number) => Promise<void>
  /** Boot-asset staging into the scratch directory under root hosts. */
  copyFile?: (source: string, destination: string) => Promise<void>
  /** Workspace image staging before spawn. */
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
  /** Workspace export image sizing before spawn. */
  truncate?: (path: string, length: number) => Promise<void>
  /** Workspace export image read-back after the guest reports completion. */
  readFile?: (path: string) => Promise<Uint8Array>
}

/** Facts about one booted world: the neutral seam facts plus QEMU specifics. */
export interface WorldDescriptor extends VmWorldDescriptor {
  qemuBin: string
  accel: QemuAccel
  memoryMiB: number
  cpus: number
  pid: number | undefined
}

/** How the QEMU child terminated. */
export type WorldExit = VmWorldExit

/** Live handle for one booted world. */
export interface WorldHandle {
  readonly descriptor: WorldDescriptor
  /** Resolves when the QEMU child exits, however it was stopped. */
  readonly exit: Promise<WorldExit>
  /**
   * Round-trip one ping through the guest agent.
   * @param timeoutMs - reply deadline; default 5 000.
   * @returns observed round-trip time in milliseconds.
   */
  ping(timeoutMs?: number): Promise<number>
  /**
   * Run one guest exec to completion and collect its output.
   * @param argv - guest command line.
   * @param options - env, cwd, pty, stdin, timeout, and output bound.
   * @returns exit state plus collected stdout and stderr.
   */
  exec(argv: string[], options?: CollectExecOptions): Promise<ExecResult>
  /**
   * Start one guest exec and stream it.
   * @param argv - guest command line.
   * @param options - env, cwd, and pty selection.
   * @returns the streaming exec handle.
   */
  spawn(argv: string[], options?: ExecOptions): Promise<ExecHandle>
  /** Filesystem client for this world's guest. */
  readonly fs: WorldFs
  /** Host-side egress relay; opens deny unless this world's policy approves. */
  readonly egress: WorldEgress
  /**
   * Snapshot import/export over the world's data-plane images; operations
   * reject when the world booted without {@link WorkspaceOptions}.
   */
  readonly workspace: WorldWorkspace
  /**
   * Stop the world: ask the guest to power off, then ensure the child exited.
   * @returns `clean` when the child exited after the guest shutdown (or had
   * already exited), `killed` when SIGKILL was required.
   */
  destroy(): Promise<'clean' | 'killed'>
}

interface Waiter {
  match: (payload: string) => boolean
  resolve: (payload: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface EventSubscription {
  match: (payload: string) => boolean
  handler: (payload: string) => void
}

const CONNECT_RETRY_MS = 150

/**
 * Default child-process seam: run the planned argv under node's spawn.
 * @param argv - full command line; argv[0] falls back to the default QEMU binary.
 * @param options - spawn options forwarded verbatim.
 * @returns the spawned child.
 */
export function defaultSpawnProcess(argv: readonly string[], options: { stdio: 'ignore' }): ChildLike {
  const [bin = DEFAULT_QEMU_BIN, ...rest] = argv
  return nodeSpawn(bin, rest, options)
}
/** Per-attempt handshake budget; the guest UART can drop an early hello, so the host retries. */
const HANDSHAKE_ATTEMPT_MS = 3_000

function defaultConnect(socketPath: string): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    const socket = nodeConnect(socketPath)
    socket.once('connect', () => { resolve(socket) })
    socket.once('error', (error) => { reject(error) })
  })
}

class ControlChannel {
  private readonly reader = new FrameReader()
  private waiters: Waiter[] = []
  private events: EventSubscription[] = []
  private closeHandlers: ((error: Error) => void)[] = []

  constructor(private readonly socket: SocketLike) {
    socket.on('data', (chunk: Buffer) => {
      let payloads: string[]
      try {
        payloads = this.reader.push(chunk)
      } catch (error) {
        this.fail(new WorldClosedError(`control frame error: ${String(error)}`))
        socket.destroy()
        return
      }
      for (const payload of payloads) this.dispatch(payload)
    })
    socket.on('close', () => { this.fail(new WorldClosedError('control port closed')) })
    socket.on('error', (error) => { this.fail(new WorldClosedError(`control port error: ${error.message}`)) })
  }

  private dispatch(payload: string): void {
    const waiter = this.waiters.find(waiter => waiter.match(payload))
    if (waiter !== undefined) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      clearTimeout(waiter.timer)
      waiter.resolve(payload)
      return
    }
    for (const subscription of [...this.events]) {
      if (subscription.match(payload)) subscription.handler(payload)
    }
  }

  private fail(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.events = []
    for (const handler of this.closeHandlers.splice(0)) handler(error)
  }

  send(message: HostMessage): void {
    this.socket.write(encodeFrame(JSON.stringify(message)))
  }

  /**
   * Subscribe to unsolicited guest events.
   * @param match - event predicate; every matching payload reaches `handler`.
   * @param handler - event callback.
   * @returns the unsubscribe function.
   */
  onEvent(match: (payload: string) => boolean, handler: (payload: string) => void): () => void {
    const subscription: EventSubscription = { match, handler }
    this.events.push(subscription)
    return () => {
      this.events = this.events.filter(entry => entry !== subscription)
    }
  }

  /**
   * Observe the channel closing or failing.
   * @param handler - receives the closing error once.
   * @returns the unsubscribe function.
   */
  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.push(handler)
    return () => {
      this.closeHandlers = this.closeHandlers.filter(entry => entry !== handler)
    }
  }

  /**
   * Await the first reply matching `match` without sending anything.
   * @param match - reply predicate; the first matching payload resolves.
   * @param timeoutMs - reply deadline.
   */
  waitFor(match: (payload: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter.resolve !== resolve)
        reject(new WorldClosedError(`control reply timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiters.push({ match, resolve, reject, timer })
    })
  }

  /**
   * Send a message and await the first reply matching `match`.
   * @param message - host message to send.
   * @param match - reply predicate; the first matching payload resolves.
   * @param timeoutMs - reply deadline.
   */
  request(message: HostMessage, match: (payload: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter.resolve !== resolve)
        reject(new WorldClosedError(`control reply timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.waiters.push({ match, resolve, reject, timer })
      this.send(message)
    })
  }

  destroy(): void {
    this.socket.destroy()
  }
}

/**
 * Boot one micro-VM world and complete the protocol handshake.
 * @param options - world sizing, asset locations, and deadlines.
 * @param deps - injectable spawn/connect/mkdtemp/clock seams for tests.
 * @returns a handle bound to the running QEMU child.
 * @throws AssetsMissingError when kernel or initramfs are absent.
 * @throws QemuSpawnError when the QEMU binary cannot run.
 * @throws WorldReadyTimeoutError when the guest misses the ready deadline.
 * @throws GuestVersionMismatchError when the guest rejects the protocol version.
 * @throws WorldClosedError when the port closes or the handshake reply is unusable.
 */
export async function openWorld(options: OpenWorldOptions = {}, deps: VmDeps = {}): Promise<WorldHandle> {
  const now = deps.now ?? Date.now
  const spawnProcess = deps.spawn ?? defaultSpawnProcess
  const connect = deps.connect ?? defaultConnect
  const mkdtemp = deps.mkdtemp ?? nodeMkdtemp
  const euid = deps.euid ?? (() => process.geteuid?.() ?? -1)
  const chown = deps.chown ?? nodeChown
  const copyFile = deps.copyFile ?? nodeCopyFile
  const writeFile = deps.writeFile ?? nodeWriteFile
  const truncate = deps.truncate ?? nodeTruncate
  const readFile = deps.readFile ?? nodeReadFile

  const qemuBin = options.qemuBin ?? DEFAULT_QEMU_BIN
  const memoryMiB = options.memoryMiB ?? 256
  const cpus = options.cpus ?? 2
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000
  const assetsDir = options.assetsDir ?? defaultAssetsDir()
  const kernelPath = join(assetsDir, 'vmlinuz-virt')
  const initrdPath = join(assetsDir, 'initramfs.cpio.gz')
  if (!existsSync(kernelPath) || !existsSync(initrdPath)) throw new AssetsMissingError(assetsDir)

  const accel = resolveAccel(isKvmWritable(), options.accel ?? 'auto')
  const wrapPath = options.sandbox === 'off' ? undefined : resolveWrapPath(assetsDir)
  const runDir = await mkdtemp(join(tmpdir(), 'dsh-vm-qemu-'))
  const controlSocketPath = join(runDir, 'ctl.sock')
  // The workspace images are staged before spawn: the import payload is
  // immutable for the boot (the host never rewrites an attached image), and
  // the export image is pre-sized so guest writes stay inside the wrapper's
  // 1 GiB per-file rlimit.
  let importImagePath: string | undefined
  let exportImagePath: string | undefined
  if (options.workspace !== undefined) {
    const capacity = options.workspace.exportCapacityBytes ?? DEFAULT_EXPORT_CAPACITY_BYTES
    if (!Number.isSafeInteger(capacity) || capacity < WORKSPACE_HEADER_BYTES) {
      await nodeRm(runDir, { recursive: true, force: true })
      throw new Error(`workspace export capacity must be at least ${WORKSPACE_HEADER_BYTES} bytes`)
    }
    const tar = options.workspace.import ?? packWorkspaceTar([])
    try {
      assertValidWorkspaceTar(tar)
      importImagePath = join(runDir, 'ws-import.img')
      exportImagePath = join(runDir, 'ws-export.img')
      await writeFile(importImagePath, buildWorkspaceImage(tar))
      await writeFile(exportImagePath, new Uint8Array(0))
      await truncate(exportImagePath, capacity + (512 - (capacity % 512)) % 512)
    } catch (error) {
      await nodeRm(runDir, { recursive: true, force: true })
      throw error
    }
  }
  // The wrapper drops to uid 65534 before exec, so on root hosts the scratch
  // directory moves to that uid and boot assets are copied into it: the
  // guest-readable originals may sit under directories the dropped uid cannot
  // traverse, while /tmp always can.
  let bootKernelPath = kernelPath
  let bootInitrdPath = initrdPath
  if (wrapPath !== undefined && euid() === 0) {
    try {
      await chown(runDir, 65534, 65534)
      bootKernelPath = join(runDir, 'vmlinuz-virt')
      bootInitrdPath = join(runDir, 'initramfs.cpio.gz')
      await copyFile(kernelPath, bootKernelPath)
      await copyFile(initrdPath, bootInitrdPath)
      if (importImagePath !== undefined) await chown(importImagePath, 65534, 65534)
      if (exportImagePath !== undefined) await chown(exportImagePath, 65534, 65534)
    } catch (error) {
      await nodeRm(runDir, { recursive: true, force: true })
      throw error
    }
  }
  const qemuArgv = buildQemuArgv({
    qemuBin,
    accel,
    memoryMiB,
    cpus,
    kernelPath: bootKernelPath,
    initrdPath: bootInitrdPath,
    controlSocketPath,
    consoleLogPath: join(runDir, 'console.log'),
    ...(importImagePath !== undefined ? { importImagePath } : {}),
    ...(exportImagePath !== undefined ? { exportImagePath } : {}),
  })
  const argv = wrapPath === undefined ? qemuArgv : buildWrappedArgv(wrapPath, runDir, qemuArgv)

  const startedAt = now()
  const child = spawnProcess(argv, { stdio: 'ignore' })
  const spawnError = new Promise<never>((_, reject) => {
    child.on('error', (error) => { reject(new QemuSpawnError(error, qemuBin)) })
  })
  // The handshake races consume `spawnError` only while they run; swallow any
  // later emission so an already-settled world never surfaces it unhandled.
  void spawnError.catch(() => {})
  const exit = new Promise<WorldExit>((resolve) => {
    child.on('exit', (code, signal) => { resolve({ code, signal }) })
  })
  const exitBeforeHandshake = exit.then((worldExit) => {
    throw new WorldExitBeforeHandshakeError(worldExit)
  })
  void exitBeforeHandshake.catch(() => {})

  // The guest UART can drop a hello sent before the agent opened the port,
  // so connect-and-greet retries within one ready budget. Any QEMU exit or
  // spawn failure aborts immediately; exhausting the budget fails closed.
  const deadline = startedAt + readyTimeoutMs
  let welcomePayload: string | undefined
  let channel: ControlChannel | undefined
  for (;;) {
    const remaining = deadline - now()
    if (remaining <= 0) {
      child.kill('SIGKILL')
      throw new WorldReadyTimeoutError(readyTimeoutMs)
    }
    let socket: SocketLike
    try {
      socket = await Promise.race([connect(controlSocketPath), spawnError, exitBeforeHandshake])
    } catch (error) {
      if (error instanceof QemuSpawnError || error instanceof WorldExitBeforeHandshakeError) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(CONNECT_RETRY_MS, remaining)))
      continue
    }
    channel = new ControlChannel(socket)
    const attemptBudget = Math.min(deadline - now(), HANDSHAKE_ATTEMPT_MS)
    const isAnnounceOrWelcome = (payload: string): boolean => {
      const message = parseGuestMessage(payload)
      return message !== undefined && (message.t === 'announce' || message.t === 'welcome')
    }
    try {
      // The guest beacons `announce` once its control port is live; that
      // beacon is the host's cue that the request path is safe to use.
      await Promise.race([channel.waitFor(isAnnounceOrWelcome, attemptBudget), spawnError, exitBeforeHandshake])
      welcomePayload = await Promise.race([
        channel.request({ t: 'hello', v: PROTOCOL_VERSION, caps: HOST_CAPS }, () => true, attemptBudget),
        spawnError,
        exitBeforeHandshake,
      ])
      break
    } catch (error) {
      if (error instanceof QemuSpawnError || error instanceof WorldExitBeforeHandshakeError) throw error
      // The attempt timed out or the port dropped: drop the channel, then
      // reconnect and resend hello on the next iteration.
      channel.destroy()
      channel = undefined
    }
  }

  const reply = parseGuestMessage(welcomePayload)
  if (reply === undefined) {
    channel.destroy()
    child.kill('SIGKILL')
    throw new WorldClosedError(`unexpected handshake reply: ${welcomePayload}`)
  }
  if (reply.t === 'error' && reply.code === 'version') {
    channel.destroy()
    child.kill('SIGKILL')
    throw new GuestVersionMismatchError(PROTOCOL_VERSION, undefined, reply.minV, reply.maxV)
  }
  // A late `announce` answers the hello just as well: it proves the guest
  // is live at the negotiated version, and ping verifies both directions.
  if (reply.t !== 'announce' && reply.t !== 'welcome') {
    channel.destroy()
    child.kill('SIGKILL')
    throw new WorldClosedError(`unexpected handshake reply: ${welcomePayload}`)
  }
  if (!negotiateVersion(PROTOCOL_VERSION, reply.v).ok) {
    channel.destroy()
    child.kill('SIGKILL')
    throw new GuestVersionMismatchError(PROTOCOL_VERSION, reply.v, undefined, undefined)
  }

  let stopped = false
  void exit.then(() => {
    stopped = true
    channel.destroy()
    void nodeRm(runDir, { recursive: true, force: true })
  })

  const descriptor: WorldDescriptor = {
    qemuBin,
    accel,
    memoryMiB,
    cpus,
    pid: child.pid,
    provider: 'qemu-local',
    isolation: 'full',
    hostHardened: wrapPath !== undefined,
    readyMs: now() - startedAt,
  }

  let nextRequestId = 1
  const allocateId = (): number => {
    const id = nextRequestId
    nextRequestId += 1
    return id
  }
  const stoppedCall = (): Error => new WorldClosedError('world already stopped')
  // One stopped-guard covers every op surface: requests on a stopped world
  // fail fast instead of waiting out their reply deadline.
  const guardedTransport = {
    send: (message: HostMessage): void => {
      channel.send(message)
    },
    request: (message: HostMessage, match: (payload: string) => boolean, timeoutMs: number): Promise<string> => {
      if (stopped) return Promise.reject(stoppedCall())
      return channel.request(message, match, timeoutMs)
    },
    onEvent: channel.onEvent.bind(channel),
    onClose: channel.onClose.bind(channel),
  }
  const session = new ExecSession(guardedTransport, allocateId)
  const worldFs = new WorldFs(guardedTransport, allocateId)
  const egress = new WorldEgress(options.egressPolicy)
  const readExportImage = exportImagePath === undefined ? undefined : () => readFile(exportImagePath)
  const workspace = new WorldWorkspace(guardedTransport, allocateId, readExportImage)

  return {
    descriptor,
    exit,
    fs: worldFs,
    egress,
    workspace,
    ping(timeoutMs = 5_000) {
      if (stopped) return Promise.reject(stoppedCall())
      const sentAt = now()
      return channel
        .request({ t: 'ping', n: sentAt }, (payload) => {
          const message = parseGuestMessage(payload)
          return message !== undefined && message.t === 'pong' && message.n === sentAt
        }, timeoutMs)
        .then(() => now() - sentAt)
    },
    exec(argv: string[], options: CollectExecOptions = {}) {
      if (stopped) return Promise.reject(stoppedCall())
      return session.exec(argv, options)
    },
    spawn(argv: string[], options: ExecOptions = {}) {
      if (stopped) return Promise.reject(stoppedCall())
      return session.spawn(argv, options)
    },
    async destroy() {
      if (stopped) return 'clean'
      stopped = true
      await egress.closeAll()
      channel.send({ t: 'shutdown' })
      const graceful = await Promise.race<boolean>([
        exit.then(() => { return true }),
        new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, shutdownTimeoutMs) }),
      ])
      if (!graceful) child.kill('SIGKILL')
      await exit
      stopped = true
      await nodeRm(runDir, { recursive: true, force: true })
      return graceful ? 'clean' : 'killed'
    },
  }
}
