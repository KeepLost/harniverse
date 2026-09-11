/** Shell-owned device enrollment gate that runs before browser plugins load. */
import { startTransition, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { BrowserAuthentication, BrowserAuthenticationRequired, type ClientAuthentication } from '@deepseek-ai/dsh-client-authentication'
import {
  clearBrowserDevice,
  generateBrowserDeviceKey,
  readBrowserDevice,
  signBrowserChallenge,
  writeBrowserDevice,
  type BrowserDevice,
} from './browser-device.ts'
import { markStartup, measureStartup } from './startup-timing.ts'
// document.css first: auth.css reads its tokens. This document renders before
// any plugin bundle is fetched, so it must carry both sheets itself. The dark
// set keys on the body attribute the Host's index tap already resolved from the
// durable preference (ui-theme injectBootTheme, applied to `/` and
// `/auth/manage` alike), so nothing here resolves a colour scheme.
import './document.css'
import './auth.css'

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

export async function exchangeBrowserSession(device: BrowserDevice, signal?: AbortSignal): Promise<string> {
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

function isAuthenticationRejection(reason: unknown): boolean {
  return reason instanceof Error && reason.message.endsWith('(401)')
}

/**
 * Render an ISO deadline as a locale-independent minute stamp. The document has
 * no locale service and this text is compared against host output, so a fixed
 * form beats a localized one.
 * @param iso - ISO 8601 instant.
 * @returns `YYYY-MM-DD HH:MM` in the instant's own (UTC) offset.
 */
function formatDeadline(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

/**
 * Put one credential on the clipboard.
 * @param value - text to copy.
 * @returns true when the browser accepted the write.
 */
async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    // Swallows the clipboard rejection only: an insecure origin has no
    // navigator.clipboard and a permissions policy can deny the write. The
    // caller reports the failure, and the text stays selectable either way.
    return false
  }
}

/** Copy control for a credential the user would otherwise retype by hand. */
function CopyButton({ label, value, onFailure }: {
  label: string
  value: string
  onFailure: (message: string) => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="dsh-auth-btn dsh-auth-secondary dsh-auth-compact dsh-auth-copy"
      aria-label={label}
      onClick={() => {
        void copyToClipboard(value).then((accepted) => {
          if (accepted) setCopied(true)
          else onFailure('浏览器拒绝了剪贴板访问，请手动选中文本复制')
        })
      }}
    >{copied ? '已复制' : '复制'}</button>
  )
}

/**
 * Waiting-for-approval state: the approval code the user compares against the
 * host, and the host command that approves this request.
 */
function PendingPairing({ pending, onCopyFailure }: {
  pending: PendingEnrollment
  onCopyFailure: (message: string) => void
}): React.JSX.Element {
  const command = `dsh auth device approve ${pending.id} --profile ${pending.kind === 'temporary' ? 'temporary' : 'owner'}`
  return (
    <div className="dsh-auth-pending">
      <p className="dsh-auth-status">
        <span className="dsh-auth-spinner" aria-hidden="true" />
        正在等待主机批准「{pending.name}」
      </p>
      <div className="dsh-auth-credential">
        <div className="dsh-auth-credential-body">
          <p className="dsh-auth-credential-label">批准码</p>
          <p className="dsh-auth-code">{pending.approvalCode}</p>
        </div>
        <CopyButton label="复制批准码" value={pending.approvalCode} onFailure={onCopyFailure} />
      </div>
      <div className="dsh-auth-command">
        <p className="dsh-auth-credential-label">在主机执行</p>
        <div className="dsh-auth-command-row">
          <code>{command}</code>
          <CopyButton label="复制主机命令" value={command} onFailure={onCopyFailure} />
        </div>
      </div>
      <p className="dsh-auth-hint">
        请先在主机终端核对批准码，再执行上面的命令。请求有效期至 {formatDeadline(pending.expiresAt)}，批准后本页面会自动继续。
      </p>
    </div>
  )
}

/** Shared card chrome for both authentication pages: mark, product line, title. */
function AuthCardHeader({ titleId, title, children }: {
  titleId: string
  title: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <header className="dsh-auth-head">
      <div className="dsh-auth-mark" aria-hidden="true">DSH</div>
      <div className="dsh-auth-titles">
        <p className="dsh-auth-eyebrow">DeepSeek Harness</p>
        <h1 id={titleId}>{title}</h1>
      </div>
      {children !== undefined && <div className="dsh-auth-head-actions">{children}</div>}
    </header>
  )
}

/** Browser device enrollment and signed reauthentication UI. */
export function AuthenticationGate({ onAuthenticated }: {
  onAuthenticated: (authentication: ClientAuthentication) => void
}): React.JSX.Element {
  const management = window.location.pathname === '/auth/manage'
  const [status, setStatus] = useState<AuthenticationStatusResponse>()
  const [device, setDevice] = useState<BrowserDevice>()
  const [pending, setPending] = useState<PendingEnrollment>()
  const [name, setName] = useState('my-device')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(true)
  const renewal = useRef<ClientAuthentication>()

  const authenticateDevice = async (candidate: BrowserDevice): Promise<void> => {
    try {
      const expiresAt = await exchangeBrowserSession(candidate)
      await renewal.current?.stop()
      renewal.current = new BrowserAuthentication({
        expiresAt,
        exchange: async (signal) => {
          try { return await exchangeBrowserSession(candidate, signal) }
          catch (reason) {
            if (isAuthenticationRejection(reason)) throw new BrowserAuthenticationRequired()
            throw reason
          }
        },
      })
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
          onAuthenticated(new BrowserAuthentication({ mode: 'bypass' }))
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
    return <AuthenticationManagement onLogout={async () => {
      await renewal.current?.stop()
      const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`退出认证失败 (${String(response.status)})`)
    }} />
  }

  return (
    <main className="dsh-auth">
      <section className="dsh-auth-card" aria-labelledby="dsh-auth-title">
        <AuthCardHeader titleId="dsh-auth-title" title="配对此设备" />
        {pending === undefined ? (
          <>
            <p className="dsh-auth-lede">
              {status?.sealed === true
                ? '此实例尚无已批准设备。创建配对请求后，请在主机终端批准第一个 owner。'
                : '为这台设备生成一对密钥并申请配对，主机批准后即可使用。'}
            </p>
            <form className="dsh-auth-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void enroll('device') }}>
              <div className="dsh-auth-field">
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
              </div>
              <div className="dsh-auth-actions">
                <button type="submit" className="dsh-auth-btn dsh-auth-primary" disabled={busy || name.length === 0}>
                  {busy ? '准备中...' : '配对个人设备'}
                </button>
                <button
                  type="button"
                  className="dsh-auth-btn dsh-auth-secondary"
                  disabled={busy || name.length === 0}
                  onClick={() => { void enroll('temporary') }}
                >
                  临时使用公用设备
                </button>
              </div>
            </form>
            <p className="dsh-auth-hint">
              私钥留在此浏览器且不可导出，服务器只保存公钥。公用设备的密钥仅存在于内存中，关闭页面即失效。
            </p>
          </>
        ) : (
          <PendingPairing pending={pending} onCopyFailure={setError} />
        )}
        {error !== undefined && <p className="dsh-auth-error" role="alert">{error}</p>}
        {error !== undefined && (
          <button className="dsh-auth-btn dsh-auth-secondary dsh-auth-retry" type="button" onClick={() => { void check() }} disabled={busy}>重新检查</button>
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
  /** Grant id awaiting revoke confirmation; at most one row asks at a time. */
  const [confirming, setConfirming] = useState<string>()

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
    <main className="dsh-auth dsh-auth-wide">
      <section className="dsh-auth-card" aria-labelledby="dsh-auth-manage-title">
        <AuthCardHeader titleId="dsh-auth-manage-title" title="设备与授权">
          <button type="button" className="dsh-auth-btn dsh-auth-ghost dsh-auth-compact" disabled={busy} onClick={() => { void logout() }}>
            退出当前会话
          </button>
        </AuthCardHeader>

        <section className="dsh-auth-block">
          <div className="dsh-auth-block-head">
            <h2>等待批准</h2>
            <span className="dsh-auth-count">{enrollments.length}</span>
          </div>
          <p className="dsh-auth-hint">批准前请与申请设备核对批准码。</p>
          <div className="dsh-auth-field dsh-auth-field-inline">
            <label htmlFor="dsh-auth-profile">新设备权限</label>
            <select id="dsh-auth-profile" value={profile} onChange={(event) => { setProfile(event.target.value as keyof typeof MANAGEMENT_PROFILES) }}>
              {Object.keys(MANAGEMENT_PROFILES).map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          {enrollments.length === 0 && <p className="dsh-auth-empty">没有等待批准的设备。</p>}
          <ul className="dsh-auth-list">
            {enrollments.map(request => (
              <li key={request.id} className="dsh-auth-row">
                <div className="dsh-auth-row-main">
                  <span className="dsh-auth-row-title">{request.name}</span>
                  <span className="dsh-auth-badge">{request.kind}</span>
                  <code className="dsh-auth-inline-code">{request.approvalCode}</code>
                  <span className="dsh-auth-row-meta">请求有效期至 {formatDeadline(request.expiresAt)}</span>
                </div>
                <div className="dsh-auth-row-actions">
                  <button type="button" className="dsh-auth-btn dsh-auth-primary dsh-auth-compact" disabled={busy} onClick={() => { void approve(request) }}>
                    批准
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="dsh-auth-block">
          <div className="dsh-auth-block-head">
            <h2>已批准</h2>
            <span className="dsh-auth-count">{grants.length}</span>
          </div>
          {grants.length === 0 && <p className="dsh-auth-empty">还没有已批准的设备。</p>}
          <ul className="dsh-auth-list">
            {grants.map(grant => (
              <li key={grant.id} className="dsh-auth-row">
                <div className="dsh-auth-row-main">
                  <span className="dsh-auth-row-title">{grant.name}</span>
                  <span className="dsh-auth-badge">{grant.kind}</span>
                  {grant.capabilities.map(capability => (
                    <span key={capability} className="dsh-auth-chip">{capability}</span>
                  ))}
                  <span className="dsh-auth-row-meta">
                    {grant.expiresAt === undefined ? '长期有效' : `有效期至 ${formatDeadline(grant.expiresAt)}`}
                  </span>
                </div>
                {/* Revoking cuts a device off immediately, so it asks once. */}
                <div className="dsh-auth-row-actions">
                  {confirming === grant.id ? (
                    <>
                      <button
                        type="button"
                        className="dsh-auth-btn dsh-auth-danger dsh-auth-compact"
                        disabled={busy}
                        onClick={() => { setConfirming(undefined); void revoke(grant.id) }}
                      >
                        确认撤销
                      </button>
                      <button
                        type="button"
                        className="dsh-auth-btn dsh-auth-ghost dsh-auth-compact"
                        disabled={busy}
                        onClick={() => { setConfirming(undefined) }}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="dsh-auth-btn dsh-auth-danger dsh-auth-compact"
                      disabled={busy}
                      onClick={() => { setConfirming(grant.id) }}
                    >
                      撤销
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="dsh-auth-block">
          <h2>应急访问</h2>
          <p className="dsh-auth-hint">短期 operator 令牌用于设备无法配对时的救急访问；它不能续期，也不能授权其他设备。</p>
          <div className="dsh-auth-actions">
            <button type="button" className="dsh-auth-btn dsh-auth-secondary" disabled={busy} onClick={() => { void issueEmergencyToken() }}>
              签发 5 分钟 operator 令牌
            </button>
          </div>
          {issuedToken !== undefined && (
            <div className="dsh-auth-token">
              <p className="dsh-auth-credential-label">一次性令牌</p>
              <div className="dsh-auth-command-row">
                <code>{issuedToken}</code>
                <CopyButton label="复制应急令牌" value={issuedToken} onFailure={setError} />
              </div>
              <p className="dsh-auth-hint">此令牌只显示一次，离开本页后无法再次查看。</p>
            </div>
          )}
        </section>

        {error !== undefined && <p className="dsh-auth-error" role="alert">{error}</p>}
      </section>
    </main>
  )
}

/** Render and await the shell enrollment gate before constructing browser modules. */
export function waitForBrowserAuthentication(root: Root): Promise<ClientAuthentication> {
  return new Promise((resolve) => {
    root.render(<AuthenticationGate onAuthenticated={resolve} />)
  })
}
