/** Shell-owned device enrollment gate that runs before browser plugins load. */
import { startTransition, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Root } from 'react-dom/client'
import {
  clearBrowserDevice,
  generateBrowserDeviceKey,
  readBrowserDevice,
  signBrowserChallenge,
  writeBrowserDevice,
  type BrowserDevice,
} from './browser-device.ts'
import { markStartup, measureStartup } from './startup-timing.ts'

interface AuthenticationStatusResponse {
  mode: 'authenticated' | 'bypass'
  sealed: boolean
  authenticated: boolean
}

interface PendingEnrollment {
  state: 'pending'
  id: string
  approvalCode: string
  name: string
  kind: 'device' | 'temporary'
  expiresAt: string
}

interface ApprovedEnrollment {
  state: 'approved'
  id: string
  grantId: string
  grantRevision: number
  capabilities: string[]
  expiresAt: string
}

type EnrollmentStatus = PendingEnrollment | ApprovedEnrollment

interface GrantSummary {
  id: string
  name: string
  kind: 'device' | 'api-client' | 'temporary'
  revision: number
  capabilities: string[]
  createdAt: string
  expiresAt?: string
}

function parseStatus(value: unknown): AuthenticationStatusResponse {
  if (typeof value !== 'object' || value === null
    || !['authenticated', 'bypass'].includes(String((value as { mode?: unknown }).mode))
    || typeof (value as { sealed?: unknown }).sealed !== 'boolean'
    || typeof (value as { authenticated?: unknown }).authenticated !== 'boolean') {
    throw new Error('认证服务返回了无效状态')
  }
  return value as AuthenticationStatusResponse
}

async function responseJson(response: Response, failure: string): Promise<unknown> {
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).trim()
    const translated = ({
      'device name must contain 1-64 letters, numbers, spaces, dots, underscores, or hyphens': '设备名称必须包含 1 至 64 个字母、数字、空格、点、下划线或连字符',
      'browser generated an invalid device key; use a current browser and retry': '浏览器生成了无效设备密钥，请使用新版浏览器重试',
      'device name is already registered or awaiting approval; choose another name': '设备名称已注册或正在等待批准，请换一个名称',
      'enrollment service failed; see server log': '配对服务失败，请查看服务器日志',
      'authentication unavailable': '认证服务不可用',
      'rate limited': '请求过于频繁，请稍后重试',
    } as Record<string, string>)[body] ?? body
    const detail = translated.length > 0 && translated.length <= 256 ? `：${translated}` : ''
    throw new Error(`${failure}${detail} (${String(response.status)})`)
  }
  return response.json()
}

function parseEnrollment(value: unknown): EnrollmentStatus {
  if (typeof value !== 'object' || value === null || !['pending', 'approved'].includes(String((value as { state?: unknown }).state))) {
    throw new Error('认证服务返回了无效配对状态')
  }
  return value as EnrollmentStatus
}

async function exchangeBrowserSession(device: BrowserDevice, signal?: AbortSignal): Promise<string> {
  if (device.grantId === undefined) throw new Error('设备尚未获批准')
  markStartup('auth-challenge-start')
  const challenge = await responseJson(await fetch('/auth/challenge', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grantId: device.grantId, purpose: 'browser-session' }),
    ...signal === undefined ? {} : { signal },
  }), '设备挑战失败') as { id: string; payload: string }
  markStartup('auth-challenge-end')
  measureStartup('auth-challenge', 'auth-challenge-start', 'auth-challenge-end')
  const signature = await signBrowserChallenge(device.privateKey, challenge.payload)
  markStartup('auth-exchange-start')
  const result = await responseJson(await fetch('/auth/exchange', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: challenge.id, signature }),
    ...signal === undefined ? {} : { signal },
  }), '设备认证失败')
  markStartup('auth-exchange-end')
  measureStartup('auth-exchange', 'auth-exchange-start', 'auth-exchange-end')
  if (typeof result !== 'object' || result === null || typeof (result as { expiresAt?: unknown }).expiresAt !== 'string') {
    throw new Error('认证服务返回了无效会话')
  }
  return (result as { expiresAt: string }).expiresAt
}

/** Cancellable owner of one browser-session renewal chain. */
export interface BrowserSessionRenewal {
  /** Stop future renewal and wait for any exchange already in flight. */
  stop(): Promise<void>
}

const activeRenewals = new Set<BrowserSessionRenewal>()
const RENEWAL_REQUEST_TIMEOUT_MS = 10_000
const RENEWAL_RETRY_BASE_MS = 1_000
const RENEWAL_RETRY_MAX_MS = 10_000

function isAuthenticationRejection(reason: unknown): boolean {
  return reason instanceof Error && reason.message.endsWith('(401)')
}

/** Keep a browser session short while renewing it through device possession. */
export function maintainBrowserSession(
  device: BrowserDevice,
  expiresAt: string,
  recover: () => void = () => { window.location.reload() },
): BrowserSessionRenewal {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let inFlightAbort: AbortController | undefined
  let stopped = false
  let deadline = Date.parse(expiresAt)
  let renewAt = Number.POSITIVE_INFINITY
  let terminalDeadline = false
  let retryAttempt = 0

  const isStopped = (): boolean => stopped

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const arm = (delay: number, action: () => void): void => {
    if (stopped) return
    clearTimer()
    timer = setTimeout(() => {
      timer = undefined
      action()
    }, Math.max(1, delay))
  }

  const schedule = (): void => {
    if (stopped) return
    const remaining = deadline - Date.now()
    if (!Number.isFinite(deadline)) {
      recoverOnce()
      return
    }
    if (terminalDeadline) {
      arm(remaining, recoverOnce)
      return
    }
    renewAt = Date.now() + Math.max(1, Math.floor(Math.max(0, remaining) / 2))
    arm(renewAt - Date.now(), renewNow)
  }

  const scheduleRetry = (): void => {
    retryAttempt += 1
    const delay = Math.min(
      RENEWAL_RETRY_MAX_MS,
      RENEWAL_RETRY_BASE_MS * 2 ** Math.min(30, retryAttempt - 1),
    )
    arm(delay, renewNow)
  }

  const removeWakeListeners = (): void => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }

  function recoverOnce(): void {
    if (stopped) return
    stopped = true
    clearTimer()
    inFlightAbort?.abort()
    removeWakeListeners()
    activeRenewals.delete(renewal)
    recover()
  }

  function renewNow(): void {
    if (isStopped() || terminalDeadline || inFlight !== undefined) return
    clearTimer()
    const priorDeadline = deadline
    const controller = new AbortController()
    inFlightAbort = controller
    const timeout = setTimeout(() => { controller.abort() }, RENEWAL_REQUEST_TIMEOUT_MS)
    const operation = (async (): Promise<void> => {
      try {
        const nextExpiry = await exchangeBrowserSession(device, controller.signal)
        if (isStopped()) return
        const nextDeadline = Date.parse(nextExpiry)
        if (!Number.isFinite(nextDeadline) || nextDeadline <= Date.now()) {
          recoverOnce()
          return
        }
        deadline = nextDeadline
        retryAttempt = 0
        terminalDeadline = nextDeadline <= priorDeadline
        schedule()
      } catch (reason) {
        if (isStopped()) return
        if (isAuthenticationRejection(reason)) {
          recoverOnce()
        } else {
          scheduleRetry()
        }
      } finally {
        clearTimeout(timeout)
        inFlight = undefined
        inFlightAbort = undefined
      }
    })()
    inFlight = operation
  }

  function onFocus(): void {
    if (Date.now() >= renewAt) renewNow()
  }

  function onOnline(): void {
    renewNow()
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible' && Date.now() >= renewAt) renewNow()
  }

  const renewal: BrowserSessionRenewal = {
    async stop() {
      if (!stopped) {
        stopped = true
        clearTimer()
        inFlightAbort?.abort()
        removeWakeListeners()
        activeRenewals.delete(renewal)
      }
      await inFlight?.catch(() => {})
    },
  }
  activeRenewals.add(renewal)
  window.addEventListener('focus', onFocus)
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisibilityChange)
  schedule()
  return renewal
}

/** Stop and drain every renewal chain owned by this page. */
export async function stopBrowserSessionRenewal(): Promise<void> {
  await Promise.all([...activeRenewals].map(renewal => renewal.stop()))
}

/** Stop renewal before clearing the current short browser session. */
export async function logoutBrowserSession(): Promise<void> {
  await stopBrowserSessionRenewal()
  const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
  if (!response.ok) throw new Error(`退出认证失败 (${String(response.status)})`)
}

/** Browser device enrollment and signed reauthentication UI. */
export function AuthenticationGate({ onAuthenticated }: {
  onAuthenticated: (renewal?: BrowserSessionRenewal) => void
}): React.JSX.Element {
  const management = window.location.pathname === '/auth/manage'
  const [status, setStatus] = useState<AuthenticationStatusResponse>()
  const [device, setDevice] = useState<BrowserDevice>()
  const [pending, setPending] = useState<PendingEnrollment>()
  const [name, setName] = useState('my-device')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(true)
  const renewal = useRef<BrowserSessionRenewal>()

  const authenticateDevice = async (candidate: BrowserDevice): Promise<void> => {
    try {
      const expiresAt = await exchangeBrowserSession(candidate)
      await renewal.current?.stop()
      renewal.current = maintainBrowserSession(candidate, expiresAt)
    } catch (reason) {
      if (candidate.kind === 'device' && isAuthenticationRejection(reason)) await clearBrowserDevice()
      throw reason
    }
    if (management) {
      setStatus({ mode: 'authenticated', sealed: false, authenticated: true })
    } else {
      const transferred = renewal.current
      renewal.current = undefined
      onAuthenticated(transferred)
    }
  }

  const refreshEnrollment = async (candidate: BrowserDevice): Promise<void> => {
    if (candidate.enrollmentId === undefined) return
    const value = parseEnrollment(await responseJson(
      await fetch(`/auth/enrollment?id=${encodeURIComponent(candidate.enrollmentId)}`, { credentials: 'same-origin' }),
      '配对状态请求失败',
    ))
    if (value.state === 'pending') {
      startTransition(() => { setPending(value) })
      return
    }
    const approved: BrowserDevice = {
      name: candidate.name,
      kind: candidate.kind,
      privateKey: candidate.privateKey,
      grantId: value.grantId,
    }
    if (approved.kind === 'device') await writeBrowserDevice(approved)
    setDevice(approved)
    setPending(undefined)
    await authenticateDevice(approved)
  }

  const check = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      markStartup('auth-status-start')
      const next = parseStatus(await responseJson(
        await fetch('/auth/status', { credentials: 'same-origin' }),
        '认证状态请求失败',
      ))
      markStartup('auth-status-end')
      measureStartup('auth-status', 'auth-status-start', 'auth-status-end')
      if (next.authenticated) {
        const stored = await readBrowserDevice().catch(() => undefined)
        if (stored?.grantId !== undefined) {
          setDevice(stored)
          await authenticateDevice(stored)
          return
        }
        if (management) {
          setStatus(next)
          return
        }
        if (next.mode === 'bypass') {
          onAuthenticated()
          return
        }
        startTransition(() => { setStatus(next) })
        return
      }
      startTransition(() => { setStatus(next) })
      const stored = await readBrowserDevice().catch(() => undefined)
      if (stored === undefined) return
      setDevice(stored)
      if (stored.grantId !== undefined) await authenticateDevice(stored)
      else await refreshEnrollment(stored)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void check() }, [])

  useEffect(() => () => { void renewal.current?.stop() }, [])

  useEffect(() => {
    if (device?.enrollmentId === undefined) return
    const interval = setInterval(() => {
      void refreshEnrollment(device).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
    }, 2_000)
    return () => { clearInterval(interval) }
  }, [device])

  const enroll = async (kind: 'device' | 'temporary'): Promise<void> => {
    if (name.length === 0 || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const generated = await generateBrowserDeviceKey()
      const enrollment = parseEnrollment(await responseJson(await fetch('/auth/enrollment', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, kind, publicKey: generated.publicKey }),
      }), '创建配对请求失败'))
      if (enrollment.state !== 'pending') throw new Error('配对请求未进入等待状态')
      const next: BrowserDevice = {
        name,
        kind,
        privateKey: generated.privateKey,
        enrollmentId: enrollment.id,
      }
      if (kind === 'device') await writeBrowserDevice(next)
      setDevice(next)
      setPending(enrollment)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  if (management && status?.authenticated === true) {
    return <AuthenticationManagement onLogout={() => logoutBrowserSession()} />
  }

  return (
    <main className="dsh-auth-gate">
      <section className="dsh-auth-panel" aria-labelledby="dsh-auth-title">
        <div className="dsh-auth-mark" aria-hidden="true">DSH</div>
        <p className="dsh-auth-eyebrow">DeepSeek Harness</p>
        <h1 id="dsh-auth-title">配对此设备</h1>
        {pending === undefined ? (
          <>
            <p className="dsh-auth-copy">
              {status?.sealed === true
                ? '此实例尚无已批准设备。创建请求后，请在主机终端批准第一个 owner。'
                : '使用此浏览器生成的设备密钥配对。私钥不可导出，服务器只保存公钥。'}
            </p>
            <form onSubmit={(event: FormEvent) => { event.preventDefault(); void enroll('device') }}>
              <label htmlFor="dsh-auth-device-name">设备名称</label>
              <input
                id="dsh-auth-device-name"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(event) => { setName(event.target.value) }}
                disabled={busy}
                autoFocus
              />
              <button type="submit" disabled={busy || name.length === 0}>
                {busy ? '准备中...' : '配对个人设备'}
              </button>
              <button type="button" disabled={busy || name.length === 0} onClick={() => { void enroll('temporary') }}>
                临时使用公用设备
              </button>
            </form>
          </>
        ) : (
          <div className="dsh-auth-copy">
            <p>配对请求正在等待批准。请核对批准码：</p>
            <p><code>{pending.approvalCode}</code></p>
            <p>主机命令：<code>dsh auth device approve {pending.id} --profile {pending.kind === 'temporary' ? 'temporary' : 'owner'}</code></p>
            <p>批准后本页面会自动继续。</p>
          </div>
        )}
        {error !== undefined && <p className="dsh-auth-error" role="alert">{error}</p>}
        {error !== undefined && (
          <button className="dsh-auth-retry" type="button" onClick={() => { void check() }} disabled={busy}>重新检查</button>
        )}
      </section>
    </main>
  )
}

const MANAGEMENT_PROFILES = {
  observer: ['harniverse.observe'],
  operator: ['harniverse.observe', 'harniverse.operate'],
  administrator: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer'],
  owner: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
} as const

function AuthenticationManagement({ onLogout }: { onLogout: () => Promise<void> }): React.JSX.Element {
  const [enrollments, setEnrollments] = useState<PendingEnrollment[]>([])
  const [grants, setGrants] = useState<GrantSummary[]>([])
  const [profile, setProfile] = useState<keyof typeof MANAGEMENT_PROFILES>('operator')
  const [issuedToken, setIssuedToken] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(true)

  const reload = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const [nextEnrollments, nextGrants] = await Promise.all([
        responseJson(await fetch('/auth/manage/enrollments', { credentials: 'same-origin' }), '读取配对请求失败'),
        responseJson(await fetch('/auth/manage/grants', { credentials: 'same-origin' }), '读取设备列表失败'),
      ])
      if (!Array.isArray(nextEnrollments) || !Array.isArray(nextGrants)) throw new Error('认证服务返回了无效管理列表')
      setEnrollments(nextEnrollments as PendingEnrollment[])
      setGrants(nextGrants as GrantSummary[])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void reload() }, [])

  const approve = async (request: PendingEnrollment): Promise<void> => {
    setBusy(true)
    try {
      const temporary = request.kind === 'temporary'
      await responseJson(await fetch('/auth/manage/enrollment/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: request.id,
          capabilities: temporary ? MANAGEMENT_PROFILES.operator : MANAGEMENT_PROFILES[profile],
          ...(temporary && { expiresInMs: 60 * 60_000, idleTimeoutMs: 15 * 60_000 }),
        }),
      }), '批准配对失败')
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  const revoke = async (grantId: string): Promise<void> => {
    setBusy(true)
    try {
      await responseJson(await fetch('/auth/manage/grant/revoke', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grantId }),
      }), '撤销设备失败')
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  const issueEmergencyToken = async (): Promise<void> => {
    setBusy(true)
    try {
      const value = await responseJson(await fetch('/auth/manage/token', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilities: MANAGEMENT_PROFILES.operator, ttlMs: 5 * 60_000 }),
      }), '签发应急令牌失败') as { accessToken: string }
      setIssuedToken(value.accessToken)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const logout = async (): Promise<void> => {
    setBusy(true)
    try {
      await onLogout()
      window.location.reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  return (
    <main className="dsh-auth-gate">
      <section className="dsh-auth-panel" aria-labelledby="dsh-auth-manage-title">
        <p className="dsh-auth-eyebrow">DeepSeek Harness</p>
        <h1 id="dsh-auth-manage-title">设备与授权</h1>
        <button type="button" disabled={busy} onClick={() => { void logout() }}>退出当前会话</button>
        <label htmlFor="dsh-auth-profile">新设备权限</label>
        <select id="dsh-auth-profile" value={profile} onChange={(event) => { setProfile(event.target.value as keyof typeof MANAGEMENT_PROFILES) }}>
          {Object.keys(MANAGEMENT_PROFILES).map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <h2>等待批准</h2>
        {enrollments.length === 0 && <p>没有等待批准的设备。</p>}
        {enrollments.map(request => (
          <div key={request.id}>
            <strong>{request.name}</strong> <code>{request.approvalCode}</code> ({request.kind})
            <button type="button" disabled={busy} onClick={() => { void approve(request) }}>批准</button>
          </div>
        ))}
        <h2>已批准</h2>
        {grants.map(grant => (
          <div key={grant.id}>
            <strong>{grant.name}</strong> ({grant.kind}) <small>{grant.capabilities.join(', ')}</small>
            <button type="button" disabled={busy} onClick={() => { void revoke(grant.id) }}>撤销</button>
          </div>
        ))}
        <h2>应急访问</h2>
        <button type="button" disabled={busy} onClick={() => { void issueEmergencyToken() }}>签发 5 分钟 operator 令牌</button>
        {issuedToken !== undefined && <p><code>{issuedToken}</code><br />此令牌只显示一次，不能续期，也不能授权其他设备。</p>}
        {error !== undefined && <p className="dsh-auth-error" role="alert">{error}</p>}
      </section>
    </main>
  )
}

/** Render and await the shell enrollment gate before constructing browser modules. */
export function waitForBrowserAuthentication(root: Root): Promise<BrowserSessionRenewal | undefined> {
  return new Promise((resolve) => {
    root.render(<AuthenticationGate onAuthenticated={resolve} />)
  })
}
