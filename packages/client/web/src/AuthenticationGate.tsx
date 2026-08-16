/** Shell-owned login gate that runs before any browser plugin code loads. */
import { startTransition, useEffect, useState, type FormEvent } from 'react'
import type { Root } from 'react-dom/client'

interface AuthenticationStatusResponse {
  mode: 'authenticated' | 'bypass'
  sealed: boolean
  authenticated: boolean
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

/** Browser login form rendered by the shell before the plugin graph exists. */
export function AuthenticationGate({ onAuthenticated }: { onAuthenticated: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<AuthenticationStatusResponse>()
  const [token, setToken] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(true)

  const check = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch('/auth/status', { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`认证状态请求失败 (${String(response.status)})`)
      const next = parseStatus(await response.json())
      if (next.authenticated) {
        onAuthenticated()
        return
      }
      startTransition(() => { setStatus(next) })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void check() }, [])

  const login = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (token.length === 0 || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!response.ok) {
        throw new Error(response.status === 401 ? '访问令牌无效' : `登录失败 (${String(response.status)})`)
      }
      setToken('')
      onAuthenticated()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="dsh-auth-gate">
      <section className="dsh-auth-panel" aria-labelledby="dsh-auth-title">
        <div className="dsh-auth-mark" aria-hidden="true">DSH</div>
        <p className="dsh-auth-eyebrow">DeepSeek Harness</p>
        <h1 id="dsh-auth-title">连接此工作台</h1>
        {status?.sealed === true ? (
          <p className="dsh-auth-copy">此实例没有可用令牌。请在主机上运行 <code>dsh auth token add &lt;name&gt;</code>，然后重试。</p>
        ) : (
          <p className="dsh-auth-copy">输入主机生成的访问令牌。令牌只用于建立此浏览器会话，不会存入浏览器存储。</p>
        )}
        {status?.sealed !== true && (
          <form onSubmit={(event) => { void login(event) }}>
            <label htmlFor="dsh-auth-token">访问令牌</label>
            <input
              id="dsh-auth-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => { setToken(event.target.value) }}
              disabled={busy}
              autoFocus
            />
            <button type="submit" disabled={busy || token.length === 0}>{busy ? '验证中...' : '进入工作台'}</button>
          </form>
        )}
        {error !== undefined && <p className="dsh-auth-error" role="alert">{error}</p>}
        {(status?.sealed === true || error !== undefined) && (
          <button className="dsh-auth-retry" type="button" onClick={() => { void check() }} disabled={busy}>重新检查</button>
        )}
      </section>
    </main>
  )
}

/** Render and await the shell login gate before constructing browser modules. */
export function waitForBrowserAuthentication(root: Root): Promise<void> {
  return new Promise((resolve) => {
    root.render(<AuthenticationGate onAuthenticated={resolve} />)
  })
}
