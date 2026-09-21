/** Connection owner for one authenticated, integrity-checked POSIX execution world. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { helloSchema, remotePath, type Hello } from './schemas.ts'
import { capturedProfileSchema, parseWorldDescription, type WorldDescription, type CapturedRemoteProfile } from './world.ts'

/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
export interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Absolute remote Node executable; a completed handshake proves it runnable in the execution world. */
  node: string
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Optional local OpenSSH configuration, owned by the deployment. */
  sshConfig?: string
  /** Optional preinstalled built PTC entry, paired with its expected digest. */
  bootstrapPath?: string
  /** SHA-256 of bootstrapPath; both fields must be supplied together. */
  bootstrapHash?: string
  /** Immutable Profile selection, captured before this connection is mounted. */
  profile: CapturedRemoteProfile
  /** Connection and administrative-request deadline. */
  requestTimeoutMs?: number
  /** Remote helper lease; heartbeat loss starts remote managed cleanup. */
  leaseMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { ssh: SshConnection }
}

const configSchema = z.object({
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/),
  node: remotePath, helper: remotePath, workspace: remotePath,
  helperHash: z.string().regex(/^[a-f0-9]{64}$/), sshConfig: remotePath.optional(),
  bootstrapPath: remotePath.optional(), bootstrapHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  profile: capturedProfileSchema,
  requestTimeoutMs: z.number().int().min(100).max(60_000).default(30_000),
  leaseMs: z.number().int().min(3000).max(600_000).default(30_000),
}).strict().refine(value => (value.bootstrapPath === undefined) === (value.bootstrapHash === undefined), 'bootstrapPath and bootstrapHash must be paired')

// Verify the installed artifact before importing any of its code. All arguments
// are shell-quoted separately; neither an SSH alias nor a model selects code.
const launch = "import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{pathToFileURL}from'node:url';const p=process.argv[1];if(createHash('sha256').update(await readFile(p)).digest('hex')!==process.argv[2])throw Error('SSH helper integrity mismatch');await import(pathToFileURL(p).href)"
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Loss invalidates this connection. A new connection captures a new remote revision. */
export class SshConnection extends Service {
  static Config: schema<Config> = schema.object({
    host: schema.string().required(), node: schema.string().required(), helper: schema.string().required(),
    helperHash: schema.string().required(), workspace: schema.string().required(), sshConfig: schema.string(),
    bootstrapPath: schema.string(), bootstrapHash: schema.string(),
    profile: schema.any().required(), requestTimeoutMs: schema.number().default(30_000), leaseMs: schema.number().default(30_000),
  })
  readonly ready: Promise<Hello>
  private readonly config: z.infer<typeof configSchema>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly childClosed: Promise<void>
  private readonly peer: SshRpcPeer
  private readonly lifetime = new AbortController()
  private heartbeat: NodeJS.Timeout | undefined
  private disposal: Promise<void> | undefined
  private failure: Error | undefined
  private description: WorldDescription | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH execution requires a POSIX Host')
    this.config = configSchema.parse(config)
    const command = [config.node, '--disable-sigusr1', '--input-type=module', '-e', launch, config.helper, config.helperHash].map(quote).join(' ')
    this.child = spawn('ssh', [
      ...(config.sshConfig === undefined ? [] : ['-F', config.sshConfig]),
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      '-o', 'ClearAllForwardings=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
      config.host, command,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.childClosed = new Promise((resolve) => { this.child.once('close', () => { resolve() }) })
    this.child.stderr.resume()
    this.peer = new SshRpcPeer(this.child.stdout, this.child.stdin)
    this.child.once('error', (error) => { this.fail(error) })
    this.child.once('close', () => { this.fail(new Error('SSH helper disconnected; remote outcome is unknown')) })
    this.peer.once('closed', (error: Error) => { this.fail(error) })
    this.ready = this.start()
    void this.ready.catch((error: unknown) => { this.fail(error instanceof Error ? error : new Error(String(error))) })
    ctx.effect(() => () => this.dispose())
  }

  protected async [Service.init](): Promise<void> { await this.ready }

  /**
   * Issue one bounded RPC against the connected helper.
   * @param method - the protocol method name.
   * @param params - its validated payload.
   * @param result - the schema every successful reply body must satisfy.
   * @param signal - cancellation for this request alone.
   * @param wait - true to use the connection lifetime instead of the administrative request timeout.
   * @returns the parsed reply body.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T> {
    signal?.throwIfAborted()
    await this.ready
    if (this.failure !== undefined) throw this.failure
    const signals = [this.lifetime.signal]
    if (signal !== undefined) signals.push(signal)
    if (!wait) signals.push(AbortSignal.timeout(this.config.requestTimeoutMs))
    return this.peer.request(method, params, result, AbortSignal.any(signals))
  }

  /**
   * This description is pinned for the connection, including the captured Host Profile revision.
   * @returns the immutable world descriptor the helper verified at connect.
   */
  async describeWorld(): Promise<WorldDescription> {
    await this.ready
    if (this.failure !== undefined) throw this.failure
    return this.description as WorldDescription
  }

  /** Verified remote Node executable for the paired PTC runtime. */
  get nodeExecutable(): string {
    if (this.failure !== undefined) throw this.failure
    return this.config.node
  }

  /** Verified preinstalled PTC entry; unconfigured runtimes fail before program execution. */
  get bootstrapPath(): string {
    if (this.failure !== undefined) throw this.failure
    if (this.config.bootstrapPath === undefined) throw new Error('SSH PTC requires a configured bootstrapPath and bootstrapHash')
    return this.config.bootstrapPath
  }

  /** Notify consumers so their registrations disappear when transport authority is lost. */
  get signal(): AbortSignal { return this.lifetime.signal }

  /** Join helper cleanup when reachable, then close and join the owned OpenSSH process. */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    try {
      await this.ready
      if (this.failure === undefined) await this.peer.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs))
    } catch {
      // A lost transport cannot acknowledge remote cleanup; its lease owns it.
    } finally {
      this.fail(new Error('SSH connection disposed'))
      this.child.kill('SIGTERM')
      const force = setTimeout(() => { this.child.kill('SIGKILL') }, 1000)
      try { await this.childClosed } finally { clearTimeout(force) }
      await this.peer.dispose()
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.lifetime.abort(error)
    this.peer.close(error)
    this.child.kill('SIGTERM')
    const force = setTimeout(() => { this.child.kill('SIGKILL') }, 1000)
    force.unref()
    void this.childClosed.then(() => { clearTimeout(force) })
  }

  private async start(): Promise<Hello> {
    const hello = await this.peer.request('hello', {
      protocol: SSH_PROTOCOL_VERSION, workspace: this.config.workspace, leaseMs: this.config.leaseMs,
      profile: this.config.profile,
    }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    if (hello.hash !== this.config.helperHash) throw new Error('SSH helper digest mismatch')
    this.description = parseWorldDescription(await this.peer.request('world.describe', {}, z.unknown(), AbortSignal.timeout(this.config.requestTimeoutMs)))
    if (this.description.descriptor.workspaceRoot !== hello.workspace) throw new Error('SSH world workspace differs from handshake')
    let pending = false
    this.heartbeat = setInterval(() => {
      if (pending) return
      pending = true
      void this.peer.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2))
        .catch((error: unknown) => { this.fail(error instanceof Error ? error : new Error(String(error))) })
        .finally(() => { pending = false })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }
}

export { parseWorldDescription } from './world.ts'
export type { CapturedRemoteProfile, WorldDescription } from './world.ts'
export type { Hello } from './schemas.ts'
export default SshConnection
