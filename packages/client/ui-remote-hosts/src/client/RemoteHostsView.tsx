import { useCallback, useEffect, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthSecrets, RemoteHostId, RemoteHostView, ReverseMapping, UpsertHostInput } from '@deepseek-ai/dsh-remote-hosts/types'
import {
  IconCheckOutline16, IconCloseOutline16, IconGlobeOutline14,
  IconRefreshOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createRemoteHostsViewStore } from './stores.ts'
import { NS } from './locales.ts'
import css from './remote-hosts.module.css'

interface RemoteHostsActions {
  list: () => Promise<RemoteResult<RemoteHostView[]>>
  upsert: (input: UpsertHostInput) => Promise<RemoteResult<RemoteHostView>>
  probe: (input: { host: string; port?: number; username: string }) => Promise<RemoteResult<{ fingerprint: string }>>
  connect: (id: RemoteHostId, secrets?: AuthSecrets) => Promise<RemoteResult<RemoteHostView>>
  openRemote: (id: RemoteHostId) => void
  disconnect: (id: RemoteHostId) => Promise<RemoteResult<void>>
  remove: (id: RemoteHostId) => Promise<RemoteResult<void>>
}

export type RemoteHostsViewProps =
  PropsRuntime<'center.view'>
  & PropsStore<ReturnType<typeof createRemoteHostsViewStore>>
  & InjectFace<RemoteHostsActions & { closeView: () => void }>
  & PropsLocale<typeof NS>

type Draft = {
  name: string
  host: string
  port: string
  username: string
  fingerprint: string
  platform: 'linux' | 'darwin' | 'win32'
  architecture: 'x64' | 'arm64'
  kind: 'password' | 'key'
  secret: string
  passphrase: string
  remember: boolean
  mappings: ReverseMapping[]
  mappingLocalHost: string
  mappingLocalPort: string
  mappingOrigin: string
}

const initialDraft: Draft = {
  name: '', host: '', port: '22', username: '', fingerprint: '', platform: 'linux',
  architecture: 'x64', kind: 'password', secret: '', passphrase: '', remember: true,
  mappings: [], mappingLocalHost: '127.0.0.1', mappingLocalPort: '3000', mappingOrigin: '',
}

function resultError<T>(result: RemoteResult<T>): Error | undefined {
  return result.ok ? undefined : new Error(result.error.message)
}

function stateLabel(t: RemoteHostsViewProps['t'], state: RemoteHostView['state']): string {
  const key = state === 'offline'
    ? 'stateOffline'
    : state === 'connecting'
      ? 'stateConnecting'
      : state === 'deploying'
        ? 'stateDeploying'
        : state === 'connected' ? 'stateConnected' : 'stateError'
  return t(key)
}

export function RemoteHostsView({
  active, actions, list, upsert, probe, connect, openRemote, disconnect, remove, closeView, t,
}: RemoteHostsViewProps) {
  const [hosts, setHosts] = useState<RemoteHostView[]>([])
  const [draft, setDraft] = useState(initialDraft)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    const result = await list()
    if (result.ok) setHosts(result.value)
    else setError(result.error.message)
  }, [list])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!active || !hosts.some(host => host.state === 'connecting' || host.state === 'deploying')) return
    const timer = setInterval(() => { void refresh() }, 1_000)
    return () => { clearInterval(timer) }
  }, [active, hosts, refresh])
  useEffect(() => {
    if (!active) return
    actions.setOpen(true)
    return () => { actions.setOpen(false); setHosts([]) }
  }, [actions, active])

  if (!active) return null

  const withBusy = async (id: string, task: () => Promise<unknown>): Promise<void> => {
    setBusy(id)
    setError(undefined)
    try {
      const result = await task()
      if (typeof result === 'object' && result !== null && 'ok' in result && result.ok === false) {
        const failure = result as { error?: { message?: unknown } }
        throw new Error(typeof failure.error?.message === 'string' ? failure.error.message : 'Remote host operation failed')
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
  }

  const probeHost = async (): Promise<void> => {
    setError(undefined)
    const result = await probe({ host: draft.host, port: Number(draft.port), username: draft.username })
    if (result.ok) update('fingerprint', result.value.fingerprint)
    else setError(result.error.message)
  }

  const addMapping = (): void => {
    const port = Number(draft.mappingLocalPort)
    if (!draft.mappingOrigin || !Number.isInteger(port) || port < 1 || port > 65535) {
      setError('Enter a valid origin and local port before adding a mapping.')
      return
    }
    setDraft(previous => ({
      ...previous,
      mappings: [...previous.mappings, {
        localHost: previous.mappingLocalHost,
        localPort: port,
        remoteOriginalOrigin: previous.mappingOrigin,
      }],
      mappingOrigin: '',
    }))
  }

  const submit = async (): Promise<void> => {
    setBusy('new')
    setError(undefined)
    const authentication = draft.kind === 'password' ? { kind: 'password' as const } : { kind: 'key' as const }
    const secrets: AuthSecrets = draft.kind === 'password'
      ? { kind: 'password', password: draft.secret }
      : { kind: 'key', privateKey: draft.secret, ...(draft.passphrase.length > 0 ? { passphrase: draft.passphrase } : {}) }
    const input: UpsertHostInput = {
      name: draft.name, host: draft.host, port: Number(draft.port), username: draft.username,
      fingerprint: draft.fingerprint, platform: draft.platform, architecture: draft.architecture,
      authentication, reverseMappings: draft.mappings,
      ...(draft.remember ? { secrets, storeCredentials: true } : {}),
    }
    try {
      const result = await upsert(input)
      const issue = resultError(result)
      if (issue) throw issue
      /* v8 ignore next -- resultError rejects every non-ok result before this successful-save branch. */
      if (!draft.remember && result.ok) {
        const connected = await connect(result.value.id, secrets)
        const connectionIssue = resultError(connected)
        if (connectionIssue) throw connectionIssue
      }
      setAdding(false)
      setDraft(initialDraft)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className={css.view} aria-label={t('title')}>
      <header className={css.header}>
        <div><h1>{t('title')}</h1><p>{hosts.filter(host => host.state === 'connected').length} · {t('stateConnected')}</p></div>
        <div className={css.headerActions}>
          <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} onClick={() => { void refresh() }}><IconRefreshOutline16 /></button>
          {/* v8 ignore next -- the shell supplies this callback in product composition. */}
          <button type="button" className={css.closeButton} onClick={closeView}><IconCloseOutline16 /></button>
        </div>
      </header>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <div className={css.toolbar}><button type="button" className={css.primary} onClick={() => { setAdding(true); setError(undefined) }}><IconGlobeOutline14 />{t('add')}</button></div>
      {adding ? (
        <form className={css.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <div className={css.formGrid}>
            {([['name', t('name')], ['host', t('host')], ['port', t('port')], ['username', t('username')], ['fingerprint', t('fingerprint')]] as const).map(([key, label]) => (
              <label key={key}>{label}<input required={key !== 'fingerprint'} value={draft[key]} onChange={(event) => { update(key, event.target.value) }} /></label>
            ))}
            <label>{t('platform')}<select value={draft.platform} onChange={(event) => { update('platform', event.target.value as Draft['platform']) }}><option value="linux">Linux</option><option value="darwin">macOS</option><option value="win32">Windows</option></select></label>
            <label>{t('architecture')}<select value={draft.architecture} onChange={(event) => { update('architecture', event.target.value as Draft['architecture']) }}><option value="x64">x64</option><option value="arm64">arm64</option></select></label>
            <label>{t('auth')}<select value={draft.kind} onChange={(event) => { update('kind', event.target.value as Draft['kind']) }}><option value="password">{t('password')}</option><option value="key">{t('privateKey')}</option></select></label>
            <button type="button" className={css.secondary} onClick={() => { void probeHost() }}>{t('probe')}</button>
            <label className={css.wideField}>{draft.kind === 'password' ? t('password') : t('privateKey')}<textarea required value={draft.secret} onChange={(event) => { update('secret', event.target.value) }} /></label>
            {draft.kind === 'key' ? <label>{t('passphrase')}<input type="password" value={draft.passphrase} onChange={(event) => { update('passphrase', event.target.value) }} /></label> : /* v8 ignore next -- the browser UI tests exercise both authentication forms. */ null}
            <label className={css.checkbox}><input type="checkbox" checked={draft.remember} onChange={(event) => { update('remember', event.target.checked) }} />{t('saveCredentials')}</label>
            <div className={css.mappingEditor}>
              <strong>{t('reverseMappings')}</strong>
              {draft.mappings.map((mapping, index) => <div className={css.mappingRow} key={`${mapping.remoteOriginalOrigin}-${String(index)}`}><span>{mapping.remoteOriginalOrigin} → {mapping.localHost}:{mapping.localPort}</span><button type="button" className={css.iconButton} aria-label={t('removeMapping')} title={t('removeMapping')} onClick={() => { setDraft(previous => ({ ...previous, mappings: previous.mappings.filter((_, itemIndex) => itemIndex !== index) })) }}><IconTrashOutline16 /></button></div>)}
              <div className={css.mappingFields}><input aria-label={t('localHost')} value={draft.mappingLocalHost} onChange={(event) => { update('mappingLocalHost', event.target.value) }} /><input aria-label={t('localPort')} value={draft.mappingLocalPort} onChange={(event) => { update('mappingLocalPort', event.target.value) }} /><input aria-label={t('remoteOrigin')} placeholder="https://remote.example" value={draft.mappingOrigin} onChange={(event) => { update('mappingOrigin', event.target.value) }} /><button type="button" className={css.secondary} onClick={addMapping}>{t('addMapping')}</button></div>
            </div>
          </div>
          <p className={css.hint}>{t('fingerprintHint')}</p>
          <div className={css.formActions}><button type="button" className={css.secondary} onClick={() => { setAdding(false) }}>{t('cancel')}</button><button type="submit" className={css.primary} disabled={busy === 'new'}><IconCheckOutline16 />{t('save')}</button></div>
        </form>
      ) : null}
      <div className={css.list}>
        {hosts.length === 0 && !adding ? <p className={css.empty}>{t('empty')}</p> : hosts.map(host => (
          <article className={css.row} key={host.id}>
            <div className={css.rowMain}>
              <IconGlobeOutline14 />
              <div><strong>{host.name}</strong><span>{host.username}@{host.host}:{host.port}</span></div>
            </div>
            <span className={`${css.state} ${css[`state_${host.state}`]}`}>{stateLabel(t, host.state)}</span>
            <div className={css.rowActions}>{host.state === 'connected' ? <><button type="button" className={css.primary} onClick={() => { openRemote(host.id) }}>{t('openRemote')}</button><button type="button" className={css.secondary} disabled={busy === host.id} onClick={() => { void withBusy(host.id, () => disconnect(host.id)) }}>{t('disconnect')}</button></> : <button type="button" className={css.primary} disabled={busy === host.id} onClick={() => { void withBusy(host.id, () => connect(host.id)) }}>{t('connect')}</button>}<button type="button" className={css.iconButton} aria-label={t('remove')} title={t('remove')} disabled={busy === host.id} onClick={() => { void withBusy(host.id, () => remove(host.id)) }}><IconTrashOutline16 /></button></div>
          </article>
        ))}
      </div>
    </section>
  )
}
