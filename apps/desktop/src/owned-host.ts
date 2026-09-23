/** Spawn and control the one Host process owned by the Electron shell. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { DesktopHostReady, OwnedDesktopHost, OwnedHostCallbacks } from './main.ts'
import type { ShellActivity } from './ipc.ts'

type RequestKind = 'enroll' | 'activity' | 'update-tasks'
type ReplyKind = 'enrolled' | 'activity' | 'update-tasks'
type Enrollment = { grant: { id: string; name: string } }
type HostMessage =
  | { type: 'ready'; url: string; authentication: 'authenticated' }
  | { type: 'fatal'; message: string }
  | { type: 'shutdown-complete' }
  | { type: 'directory-pick' | 'directory-cancel'; requestId: number }
  | { type: ReplyKind; requestId: number; error: string }
  | { type: 'enrolled'; requestId: number; enrollment: Enrollment }
  | { type: 'activity'; requestId: number; activity: ShellActivity }
  | { type: 'update-tasks'; requestId: number; active: boolean; activity: ShellActivity }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, ...expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}
function text(value: unknown, limit = 4096): value is string { return typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0') }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function activity(value: unknown): value is ShellActivity {
  return record(value) && (value.status === 'unknown' ? keys(value, 'status')
    : (value.status === 'idle' || value.status === 'active') && keys(value, 'status', 'sessions', 'tasks')
      && count(value.sessions) && count(value.tasks)
      && (value.status === 'idle' ? value.sessions + value.tasks === 0 : value.sessions + value.tasks > 0))
}
function enrollment(value: unknown): value is Enrollment {
  if (!record(value) || !keys(value, 'enrollmentId', 'grant') || !text(value.enrollmentId, 128) || !record(value.grant)) return false
  const grant = value.grant
  const required = ['id', 'name', 'kind', 'revision', 'capabilities', 'createdAt']
  const optional = ['expiresAt', 'idleTimeoutMs', 'lastUsedAt']
  return required.every(key => Object.hasOwn(grant, key)) && Object.keys(grant).every(key => [...required, ...optional].includes(key))
    && text(grant.id, 128) && text(grant.name, 256) && grant.kind === 'device' && count(grant.revision) && grant.revision > 0
    && Array.isArray(grant.capabilities) && grant.capabilities.length <= 4 && grant.capabilities.length > 0
    && new Set(grant.capabilities).size === grant.capabilities.length
    && grant.capabilities.every((value: unknown) => typeof value === 'string'
      && ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'].includes(value))
    && typeof grant.createdAt === 'string' && Number.isFinite(Date.parse(grant.createdAt))
    && (grant.expiresAt === undefined || typeof grant.expiresAt === 'string' && Number.isFinite(Date.parse(grant.expiresAt)))
    && (grant.lastUsedAt === undefined || typeof grant.lastUsedAt === 'string' && Number.isFinite(Date.parse(grant.lastUsedAt)))
    && (grant.idleTimeoutMs === undefined || count(grant.idleTimeoutMs) && grant.idleTimeoutMs > 0)
}
function hostMessage(value: unknown): HostMessage | undefined {
  if (!record(value)) return
  if (value.type === 'ready' && keys(value, 'type', 'url', 'authentication') && text(value.url, 2048) && value.authentication === 'authenticated') {
    try {
      const url = new URL(value.url)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/u.test(url.port) || Number(url.port) < 1
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.href !== value.url) return
      return { type: 'ready', url: url.href, authentication: 'authenticated' }
    } catch { return }
  }
  if (value.type === 'fatal' && keys(value, 'type', 'message') && text(value.message, 65536)) return { type: value.type, message: value.message }
  if (value.type === 'shutdown-complete' && keys(value, 'type')) return { type: value.type }
  if (!count(value.requestId)) return
  const requestId = value.requestId
  if ((value.type === 'directory-pick' || value.type === 'directory-cancel') && keys(value, 'type', 'requestId')) return { type: value.type, requestId }
  if (value.type !== 'enrolled' && value.type !== 'activity' && value.type !== 'update-tasks') return
  if (keys(value, 'type', 'requestId', 'error') && text(value.error, 65536)) return { type: value.type, requestId, error: value.error }
  if (value.type === 'enrolled' && keys(value, 'type', 'requestId', 'enrollment') && enrollment(value.enrollment)) {
    return { type: value.type, requestId, enrollment: { grant: { id: value.enrollment.grant.id, name: value.enrollment.grant.name } } }
  }
  if (value.type === 'activity' && keys(value, 'type', 'requestId', 'activity') && activity(value.activity)) return { type: value.type, requestId, activity: value.activity }
  if (value.type === 'update-tasks' && keys(value, 'type', 'requestId', 'active', 'activity') && typeof value.active === 'boolean'
    && activity(value.activity) && value.active === (value.activity.status !== 'idle')) return { type: value.type, requestId, active: value.active, activity: value.activity }
}

/** Main-process deployment deadlines; no renderer controls subprocess configuration. */
export interface OwnedHostProcessOptions {
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  terminateTimeoutMs?: number
  killTimeoutMs?: number
  /** Private port override for isolated runtime tests; production keeps the stable browser origin. */
  port?: number
}

/** Preserve only OS/runtime necessities, then deliberately select Electron's Node entry mode. */
function launchEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'TZ', 'DISPLAY', 'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined
    && (allowed.has(name.toUpperCase()) || /^LC_[A-Z_]+$/iu.test(name))))
  if ((process.versions as Record<string, string | undefined>).electron !== undefined) environment.ELECTRON_RUN_AS_NODE = '1'
  return environment
}

interface CloseResult { code: number | null; signal: NodeJS.Signals | null }
interface Pending { type: ReplyKind; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** The shell owns the child handle; a loopback URL never grants ownership by itself. */
export class OwnedDesktopHostProcess implements OwnedDesktopHost {
  private child: ChildProcess | undefined
  private ready: DesktopHostReady | undefined
  private starting: Promise<DesktopHostReady> | undefined
  private settleStart: { resolve(value: DesktopHostReady): void; reject(error: Error): void } | undefined
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private stopping: Promise<void> | undefined
  private close: Promise<CloseResult> | undefined
  private closed: CloseResult | undefined
  private acknowledged = false
  private failure: Error | undefined
  private nextRequestId = 0
  private lastPickerId = -1
  private pickerId: number | undefined
  private readonly pending = new Map<number, Pending>()
  private readonly deadlines: Required<Omit<OwnedHostProcessOptions, 'port'>>

  constructor(private readonly entry: string, private readonly home: string, private readonly installAnchor: string,
    private readonly callbacks: OwnedHostCallbacks, private readonly options: OwnedHostProcessOptions = {}) {
    this.deadlines = { startupTimeoutMs: 60000, requestTimeoutMs: 10000, shutdownTimeoutMs: 15000,
      terminateTimeoutMs: 5000, killTimeoutMs: 5000, ...options }
    for (const [key, value] of Object.entries(this.deadlines)) {
      if (key !== 'port' && (!Number.isSafeInteger(value) || value < 1 || value > 300000)) throw new Error(`Invalid desktop Host deadline: ${key}`)
    }
    if (options.port !== undefined && (!count(options.port) || options.port > 65535)) throw new Error('Invalid desktop Host port.')
  }

  /** Start once; a startup failure retains ownership of any child until it closes. */
  start(): Promise<DesktopHostReady> {
    if (this.failure !== undefined || this.stopping !== undefined) return Promise.reject(this.failure ?? new Error('Desktop Host is stopping.'))
    if (this.starting !== undefined) return this.starting
    this.starting = new Promise((resolve, reject) => { this.settleStart = { resolve, reject } })
    try {
      mkdirSync(this.home, { recursive: true, mode: 0o700 })
      const child = spawn(process.execPath, ['--expose-internals', this.entry, this.home, this.installAnchor,
        ...this.options.port === undefined ? [] : ['--port', String(this.options.port)]], {
        cwd: this.home, env: launchEnvironment(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.child = child
      this.close = new Promise(resolve => child.once('close', (code, signal) => {
        this.closed = { code, signal }
        this.pickerId = undefined
        this.clearStartup()
        this.rejectPending(new Error('Desktop Host closed.'))
        resolve(this.closed)
        if (this.stopping === undefined) this.fail(new Error(`Desktop Host stopped (exit ${String(code)}, signal ${String(signal)}).`))
      }))
      child.stdout?.on('data', (chunk: string | Uint8Array) => { if (process.env.DSH_DESKTOP_DIAGNOSTICS === '1') process.stdout.write(chunk) })
      child.stderr?.on('data', (chunk: string | Uint8Array) => { if (process.env.DSH_DESKTOP_DIAGNOSTICS === '1') process.stderr.write(chunk) })
      child.once('error', (error) => { this.fail(error) })
      child.on('message', (value) => { this.receive(value) })
      child.once('disconnect', () => {
        if (!this.acknowledged) this.fail(new Error('Desktop Host disconnected without shutdown acknowledgement.'))
      })
      this.startupTimer = setTimeout(() => { this.fail(new Error('Desktop Host startup timed out.')) }, this.deadlines.startupTimeoutMs)
    } catch (error) { this.fail(error instanceof Error ? error : new Error('Desktop Host spawn failed.')) }
    return this.starting
  }

  /** Successful stop requires an acknowledgement and zero-status actual close without escalation. */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    const child = this.child
    const close = this.close
    if (child === undefined || close === undefined) return this.failure === undefined ? Promise.resolve() : Promise.reject(this.failure)
    this.clearStartup()
    this.settleStart?.reject(new Error('Desktop Host stopped during startup.'))
    this.settleStart = undefined
    this.rejectPending(new Error('Desktop Host is stopping.'))
    this.pickerId = undefined
    this.stopping = Promise.resolve().then(async () => {
      let forced = false
      if (this.closed === undefined && child.connected) {
        try { child.send({ type: 'shutdown' }, (error) => { if (error !== null) this.failure ??= error }) }
        catch (error) { this.failure ??= error instanceof Error ? error : new Error('Desktop shutdown request failed.') }
      }
      let result = this.closed ?? await this.waitForClose(close, this.deadlines.shutdownTimeoutMs)
      if (result === undefined) {
        forced = true
        child.kill('SIGTERM')
        result = await this.waitForClose(close, this.deadlines.terminateTimeoutMs)
      }
      if (result === undefined) {
        child.kill('SIGKILL')
        result = await this.waitForClose(close, this.deadlines.killTimeoutMs)
      }
      if (result === undefined) throw new Error('Desktop Host did not close after forced termination; ownership is retained.')
      this.ready = undefined
      if (forced) throw new Error('Desktop Host shutdown deadline required forced termination.')
      if (this.failure !== undefined) throw this.failure
      if (!this.acknowledged) throw new Error('Desktop Host closed without shutdown acknowledgement.')
      if (result.code !== 0 || result.signal !== null) throw new Error(`Desktop Host shutdown failed (exit ${String(result.code)}, signal ${String(result.signal)}).`)
    })
    return this.stopping
  }

  /** Authentication/service loss remains unknown; malformed replies reject. */
  async activity(): Promise<ShellActivity> { return await this.request('activity') as ShellActivity }
  /** Actual close or failed startup without a child permits Quit/disconnect recovery; never authorizes an update. */
  hasClosed(): boolean { return this.closed !== undefined || this.failure !== undefined && this.child === undefined }
  /** Return only the validated public Grant identity; key custody stays in the browser. */
  async enroll(publicKey: string): Promise<Enrollment> { return await this.request('enroll', publicKey) as Enrollment }
  /** Inspect, acquire, or release the owned Host's update admission gate. */
  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<ShellActivity> {
    return await this.request('update-tasks', action) as ShellActivity
  }

  private async waitForClose(close: Promise<CloseResult>, timeoutMs: number): Promise<CloseResult | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([close, new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { resolve(undefined) }, timeoutMs)
      })])
    }
    finally { clearTimeout(timer) }
  }
  private clearStartup(): void { clearTimeout(this.startupTimer); this.startupTimer = undefined }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.clearStartup()
    this.settleStart?.reject(error)
    this.settleStart = undefined
    this.rejectPending(error)
    if (this.ready !== undefined && this.stopping === undefined) {
      try { this.callbacks.onFailure(error) } catch { /* Callback errors cannot prevent owned child cleanup. */ }
    }
    void this.stop().catch(() => { /* The recorded failure remains available to the explicit stop caller. */ })
  }
  private receive(value: unknown): void {
    const message = hostMessage(value)
    if (message === undefined) { this.fail(new Error('Desktop Host sent an invalid private message.')); return }
    if (message.type === 'fatal') { this.fail(new Error(message.message)); return }
    if (message.type === 'shutdown-complete') {
      if (this.stopping === undefined || this.acknowledged) { this.fail(new Error('Unexpected desktop shutdown acknowledgement.')); return }
      this.acknowledged = true
      return
    }
    if (this.stopping !== undefined || this.closed !== undefined) return
    if (message.type === 'ready') {
      if (this.ready !== undefined) { this.fail(new Error('Duplicate desktop Host ready message.')); return }
      this.clearStartup()
      this.ready = { url: message.url }
      this.settleStart?.resolve(this.ready)
      this.settleStart = undefined
      return
    }
    if (this.ready === undefined) { this.fail(new Error('Desktop Host message arrived before ready.')); return }
    if (message.type === 'directory-cancel') { if (this.pickerId === message.requestId) this.pickerId = undefined; return }
    if (message.type === 'directory-pick') {
      if (message.requestId <= this.lastPickerId || this.pickerId !== undefined) { this.fail(new Error('Invalid desktop directory request.')); return }
      this.lastPickerId = message.requestId
      this.pickerId = message.requestId
      void this.answerDirectory(message.requestId)
      return
    }
    const pending = this.pending.get(message.requestId)
    if (pending === undefined) return
    if (pending.type !== message.type) { this.fail(new Error('Desktop Host response type mismatch.')); return }
    this.pending.delete(message.requestId)
    clearTimeout(pending.timer)
    if ('error' in message) pending.reject(new Error(message.error))
    else pending.resolve(message.type === 'enrolled' ? message.enrollment : message.activity)
  }
  private request(type: RequestKind, value?: string): Promise<unknown> {
    const child = this.child
    if (child === undefined || !child.connected || this.ready === undefined || this.failure !== undefined || this.stopping !== undefined) return Promise.reject(new Error('Desktop Host is unavailable.'))
    const requestId = this.nextRequestId++
    const message = type === 'enroll' ? { type, requestId, publicKey: value }
      : type === 'update-tasks' ? { type, requestId, action: value } : { type, requestId }
    return new Promise((resolve, reject) => {
      const refuse = (error: Error) => {
        const pending = this.pending.get(requestId)
        if (pending === undefined) return
        clearTimeout(pending.timer); this.pending.delete(requestId); reject(error)
      }
      const timer = setTimeout(() => {
        refuse(new Error(`Desktop Host ${type} request timed out.`))
        // A timed-out lock may already have paused admission; require explicit recovery.
        if (type === 'update-tasks' && value === 'lock') this.fail(new Error('Desktop update lock outcome is unknown.'))
      }, this.deadlines.requestTimeoutMs)
      this.pending.set(requestId, { type: type === 'enroll' ? 'enrolled' : type, resolve, reject, timer })
      try { child.send(message, (error) => { if (error !== null) refuse(error) }) }
      catch (error) { refuse(error instanceof Error ? error : new Error('Desktop request send failed.')) }
    })
  }
  private async answerDirectory(requestId: number): Promise<void> {
    let path: string | null = null
    try {
      const selection = await this.callbacks.pickDirectory()
      if (selection.kind === 'selected' && text(selection.path, 32768) && isAbsolute(selection.path)) path = selection.path
    } catch { /* A failed native dialog is cancellation. */ }
    if (this.pickerId !== requestId || this.stopping !== undefined || this.child?.connected !== true) return
    this.pickerId = undefined
    try { this.child.send({ type: 'directory-result', requestId, path }, (error) => { if (error !== null) this.fail(error) }) }
    catch (error) { this.fail(error instanceof Error ? error : new Error('Desktop directory response failed.')) }
  }
}
