/** Private desktop Consumer of authentication, session status, terminal and scheduler capabilities. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { ALL_AUTHENTICATION_CAPABILITIES, type AuthenticationGrantSummary } from '@deepseek-ai/dsh-authentication'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-scheduler'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from './admission.ts'
import { parseHostCommand, type HostActivity } from './protocol.ts'

interface DeviceReceipt { publicKey: string; enrollmentId: string; grantId: string; grantRevision: number }

declare module '@deepseek-ai/cordis' {
  interface Context { desktopControl: DesktopControl }
}

/** Loaded only in the shell-owned profile, with no HTTP Remote or public bootstrap route. */
export default class DesktopControl extends Service {
  static inject = ['authentication', 'sessions', 'apiProxy', 'terminalController', 'scheduler', 'desktopAdmission', 'agents']
  private enrollment: Promise<{ enrollmentId: string; grant: AuthenticationGrantSummary }> | undefined
  private key: string | undefined
  private receipt: DeviceReceipt | undefined
  private available = true
  private generation = 0
  private update: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, private readonly config: { home: string }) {
    super(ctx, 'desktopControl')
    if (typeof config.home !== 'string' || !isAbsolute(config.home)) throw new Error('Desktop control requires its private home.')
    ctx.on('authentication/unavailable', () => { this.available = false; this.generation++ })
    ctx.on('authentication/available', () => { this.available = true; this.generation++ })
    ctx.on('authentication/revoked', () => { this.generation++ })
  }

  /** Restore only the exact private enrollment receipt; no registry-wide device inference. */
  async [Service.init](): Promise<void> {
    let file
    try { file = await open(join(this.config.home, '.desktop-device.json'), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
      if ((await file.stat()).size > 4096) throw new Error('Invalid desktop device receipt.')
      const value: unknown = JSON.parse(await file.readFile('utf8'))
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid desktop device receipt.')
      const receipt = value as Record<string, unknown>
      if (Object.keys(receipt).length !== 4
        || !['publicKey', 'enrollmentId', 'grantId', 'grantRevision'].every(key => Object.hasOwn(receipt, key))
        || parseHostCommand({ type: 'enroll', requestId: 0, publicKey: receipt.publicKey }) === undefined
        || typeof receipt.enrollmentId !== 'string' || !/^[\w-]{1,128}$/u.test(receipt.enrollmentId)
        || typeof receipt.grantId !== 'string' || !/^[\w-]{1,128}$/u.test(receipt.grantId)
        || !Number.isSafeInteger(receipt.grantRevision) || (receipt.grantRevision as number) < 1) throw new Error('Invalid desktop device receipt.')
      this.receipt = receipt as unknown as DeviceReceipt
      this.key = this.receipt.publicKey
    } finally { await file.close() }
  }

  /** Stop private admissions and settle enrollment/update mutations before provider teardown. */
  async quiesce(): Promise<void> {
    this.ctx.desktopAdmission.stop()
    await Promise.allSettled([this.enrollment, this.update])
    // Close stops Agent admission synchronously and releases scheduler idle waits
    // before Cordis begins dependency teardown of the scheduler and Agent factory.
    const closed = await Promise.allSettled(this.ctx.agents.list().map(agent => this.ctx.agents.close(agent.id)))
    const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length > 0) throw new AggregateError(failures, 'Desktop Agents did not close cleanly.')
  }

  /** Approve only the exact enrollment created here from the validated shell-generated key. */
  enroll(publicKey: string): Promise<{ enrollmentId: string; grant: AuthenticationGrantSummary }> {
    if (this.ctx.desktopAdmission.stopping) return Promise.reject(new Error('Host is stopping.'))
    if (this.key !== undefined && this.key !== publicKey) return Promise.reject(new Error('A different device already owns this Host connection.'))
    this.key = publicKey
    if (this.receipt !== undefined) return this.existingEnrollment()
    return this.enrollment ??= (async () => {
      if (this.ctx.authentication.mode !== 'authenticated') throw new Error('Desktop requires authenticated mode.')
      const name = `Desktop ${createHash('sha256').update(publicKey).digest('hex').slice(0, 20)}`
      const request = await this.ctx.authentication.requestEnrollment({ name, kind: 'device', publicKey }, '127.0.0.1')
      if (request.kind !== 'accepted') throw new Error(`Desktop enrollment rejected: ${request.reason}`)
      if (this.ctx.desktopAdmission.stopping) throw new Error('Host is stopping.')
      const grant = await this.ctx.authentication.approveEnrollment(request.value.id, { capabilities: ALL_AUTHENTICATION_CAPABILITIES })
      const receipt: DeviceReceipt = { publicKey, enrollmentId: request.value.id, grantId: grant.id, grantRevision: grant.revision }
      try {
        const file = await open(join(this.config.home, '.desktop-device.json'), 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(receipt) + '\n'); await file.sync() } finally { await file.close() }
      } catch (error) { await this.ctx.authentication.revokeGrant(grant.id); throw error }
      this.receipt = receipt
      return { enrollmentId: request.value.id, grant }
    })()
  }

  private async existingEnrollment(): Promise<{ enrollmentId: string; grant: AuthenticationGrantSummary }> {
    const grant = await this.currentGrant()
    if (grant === undefined || this.receipt === undefined) throw new Error('Desktop device Grant is revoked or unavailable; use ordinary authentication recovery.')
    return { enrollmentId: this.receipt.enrollmentId, grant }
  }

  private async currentGrant(): Promise<AuthenticationGrantSummary | undefined> {
    if (!this.available || this.receipt === undefined || this.ctx.authentication.mode !== 'authenticated') return
    const grants = await this.ctx.authentication.listGrants()
    if ((await this.ctx.authentication.status()).sealed) return
    return grants.find(grant => grant.id === this.receipt?.grantId && grant.revision === this.receipt.grantRevision
      && grant.capabilities.includes('harniverse.observe')
      && (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > Date.now())
      && (grant.idleTimeoutMs === undefined || Date.parse(grant.lastUsedAt ?? grant.createdAt) + grant.idleTimeoutMs > Date.now()))
  }

  /** Observe existing runtime APIs without attaching cold sessions or starting agents. */
  async activity(): Promise<HostActivity> {
    const generation = this.generation
    if (!this.available || this.receipt === undefined || this.ctx.desktopAdmission.stopping) return { status: 'unknown' }
    try {
      if (await this.currentGrant() === undefined) return { status: 'unknown' }
      let sessions = 0
      let tasks = 0
      const scheduledBefore = this.ctx.scheduler.listAll().filter(schedule => schedule.status === 'active').length
      for (const session of this.ctx.sessions.list()) {
        const response = await this.ctx.apiProxy.sessions.status({ rpcId: RpcId('desktop-activity'), payload: { sessionId: session.id } })
        if (!response.result.ok) return { status: 'unknown' }
        const status = response.result.value
        if (status.running || status.closing || status.queue.length > 0 || status.interactions.length > 0) sessions++
        tasks += status.jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
        tasks += this.ctx.terminalController.list(session.id).filter(terminal => terminal.state === 'running').length
      }
      // An active schedule can autonomously admit work after this sample.
      tasks += Math.max(scheduledBefore, this.ctx.scheduler.listAll().filter(schedule => schedule.status === 'active').length)
      tasks += this.ctx.desktopAdmission.pending
      // These values may change while the awaited status calls complete.
      if (!this.observationIsCurrent(generation) || await this.currentGrant() === undefined
        || !this.observationIsCurrent(generation)) return { status: 'unknown' }
      return { status: sessions + tasks > 0 ? 'active' : 'idle', sessions, tasks }
    } catch {
      // Authentication loss and unavailable services are unknown, never idle.
      return { status: 'unknown' }
    }
  }

  private observationIsCurrent(generation: number): boolean {
    return this.available && generation === this.generation && !this.ctx.desktopAdmission.stopping
  }

  /** Serialize update decisions; a failed lock releases admission and preserves the unknown/active distinction. */
  updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<HostActivity> {
    const operation = this.update.then(async () => {
      const gate = this.ctx.desktopAdmission
      if (gate.stopping) return { status: 'unknown' as const }
      if (action === 'unlock') gate.locked = false
      if (action === 'lock') gate.locked = true
      const activity = await this.activity()
      if (action === 'lock' && activity.status !== 'idle') gate.locked = false
      return activity
    })
    this.update = operation.catch(() => undefined)
    return operation
  }
}
