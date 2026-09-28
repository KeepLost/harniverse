import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthSecrets, ConnectivityResult, PickKeyFileResult, RemoteHostId, RemoteHostView, ReverseMapping, UpsertHostInput } from '@deepseek-ai/dsh-remote-hosts/types'
import {
  IconCloseOutline16, IconFolderOpenOutline16, IconGlobeOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createRemoteHostsViewStore } from './stores.ts'
import { NS } from './locales.ts'
import css from './remote-hosts.module.css'

interface RemoteHostsActions {
  list: () => Promise<RemoteResult<RemoteHostView[]>>
  upsert: (input: UpsertHostInput) => Promise<RemoteResult<RemoteHostView>>
  verify: (input: { host: string; port?: number; username: string; secrets: AuthSecrets }) => Promise<RemoteResult<ConnectivityResult>>
  pickKeyFile: () => Promise<RemoteResult<PickKeyFileResult>>
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
  platform: 'linux' | 'darwin' | 'win32'
  architecture: 'x64' | 'arm64'
  kind: 'password' | 'key'
  secret: string
  credential: string
  manualPaste: boolean
  keyPath: string
  remember: boolean
  mappings: ReverseMapping[]
  mappingLocalHost: string
  mappingLocalPort: string
  mappingOrigin: string
}

/** Evidence from the last successful test, invalidated by any edit to what it tested. */
type Tested = ConnectivityResult

const initialDraft: Draft = {
  name: '', host: '', port: '22', username: '', platform: 'linux',
  architecture: 'x64', kind: 'password', secret: '', credential: '', manualPaste: false, keyPath: '',
  remember: true, mappings: [], mappingLocalHost: '127.0.0.1', mappingLocalPort: '3000', mappingOrigin: '',
}

/** Fields whose change invalidates a completed connectivity test. */
const testedFields = ['host', 'port', 'username', 'kind', 'secret', 'credential'] as const

/** Target fields a connectivity test prefills only until the operator overrides them. */
const detectedFields = ['platform', 'architecture'] as const

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
  active, actions, list, upsert, verify, pickKeyFile, connect, openRemote, disconnect, remove, closeView, t,
}: RemoteHostsViewProps) {
  const [hosts, setHosts] = useState<RemoteHostView[]>([])
  const [draft, setDraft] = useState(initialDraft)
  const [tested, setTested] = useState<Tested | undefined>()
  const overrides = useRef(new Set<(typeof detectedFields)[number]>())
  const [editing, setEditing] = useState(false)
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
    // A test only describes the exact target and credentials it ran with.
    if ((testedFields as readonly string[]).includes(key)) setTested(undefined)
    // A detected default never overrides an operator's explicit target choice.
    if (key === 'platform' || key === 'architecture') overrides.current.add(key)
  }

  const secrets = (): AuthSecrets => draft.kind === 'password'
    ? { kind: 'password', password: draft.credential }
    : { kind: 'key', privateKey: draft.secret, ...(draft.credential.length > 0 ? { passphrase: draft.credential } : {}) }

  const openEditor = (): void => {
    setDraft(initialDraft)
    setTested(undefined)
    overrides.current.clear()
    setError(undefined)
    setEditing(true)
  }

  const closeEditor = (): void => {
    setEditing(false)
    setTested(undefined)
  }

  const testConnection = async (): Promise<void> => {
    setBusy('test')
    setError(undefined)
    try {
      const result = await verify({ host: draft.host, port: Number(draft.port), username: draft.username, secrets: secrets() })
      const issue = resultError(result)
      if (issue) throw issue
      /* v8 ignore next -- resultError rejects every non-ok result before this successful-test branch. */
      if (result.ok) {
        setTested(result.value)
        setDraft(previous => ({
          ...previous,
          ...(overrides.current.has('platform') ? {} : { platform: result.value.platform }),
          ...(overrides.current.has('architecture') ? {} : { architecture: result.value.architecture }),
        }))
      }
    } catch (cause) {
      setTested(undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const chooseKeyFile = async (): Promise<void> => {
    setBusy('pick')
    setError(undefined)
    try {
      const result = await pickKeyFile()
      const issue = resultError(result)
      if (issue) throw issue
      // A cancelled chooser leaves the form untouched.
      if (result.ok && result.value.path !== undefined && result.value.content !== undefined) {
        setDraft(previous => ({ ...previous, secret: result.value.content as string, keyPath: result.value.path as string }))
        setTested(undefined)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
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
    // The form only offers save once a test passed, and every tested edit clears it.
    if (tested === undefined) return
    setBusy('new')
    setError(undefined)
    const authentication = draft.kind === 'password' ? { kind: 'password' as const } : { kind: 'key' as const }
    const submitted = secrets()
    const input: UpsertHostInput = {
      name: draft.name, host: draft.host, port: Number(draft.port), username: draft.username,
      fingerprint: tested.fingerprint, platform: draft.platform, architecture: draft.architecture,
      authentication, reverseMappings: draft.mappings,
      ...(draft.remember ? { secrets: submitted, storeCredentials: true } : {}),
    }
    try {
      const result = await upsert(input)
      const issue = resultError(result)
      if (issue) throw issue
      /* v8 ignore next -- resultError rejects every non-ok result before this successful-save branch. */
      if (!draft.remember && result.ok) {
        const connected = await connect(result.value.id, submitted)
        const connectionIssue = resultError(connected)
        if (connectionIssue) throw connectionIssue
      }
      closeEditor()
      setDraft(initialDraft)
      overrides.current.clear()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const onDrawerKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || busy !== undefined) return
    event.preventDefault()
    closeEditor()
  }

  const connectedCount = hosts.filter(host => host.state === 'connected').length

  return (
    <section className={css.view} aria-label={t('title')}>
      <header className={css.header}>
        <span className={css.title}>{t('title')}</span>
        <span className={css.summary}>{t('summary', { count: String(connectedCount) })}</span>
        <span className={css.headerActions}>
          <button type="button" disabled={busy !== undefined} onClick={() => { void refresh() }}>{t('refresh')}</button>
          <button type="button" disabled={busy !== undefined} onClick={openEditor}>{t('add')}</button>
          {/* v8 ignore next -- the shell supplies this callback in product composition. */}
          <button type="button" className={css.close} aria-label={t('close')} onClick={closeView}><IconCloseOutline16 /></button>
        </span>
      </header>
      <div className={css.body}>
        {error ? <p className={css.alert} role="alert">{error}</p> : null}
        {hosts.length === 0 && !editing ? <p className={css.note}>{t('empty')}</p> : null}
        {hosts.length > 0 ? (
          <ul className={css.cards}>
            {hosts.map(host => (
              <li className={css.card} key={host.id}>
                <div className={css.cardMain}>
                  <IconGlobeOutline14 />
                  <div><strong>{host.name}</strong><span>
                    {host.username}@{host.host}:{String(host.port)} · {host.platform}/{host.architecture}
                  </span></div>
                </div>
                <span className={css.statePill} data-state={host.state}>{stateLabel(t, host.state)}</span>
                <div className={css.rowActions}>
                  {host.state === 'connected'
                    ? <><button type="button" onClick={() => { openRemote(host.id) }}>{t('openRemote')}</button><button type="button" disabled={busy === host.id} onClick={() => { void withBusy(host.id, () => disconnect(host.id)) }}>{t('disconnect')}</button></>
                    : <button type="button" disabled={busy === host.id || host.state === 'connecting' || host.state === 'deploying'} onClick={() => { void withBusy(host.id, () => connect(host.id)) }}>{t('connect')}</button>}
                  <button type="button" disabled={busy === host.id} onClick={() => { void withBusy(host.id, () => remove(host.id)) }}>{t('remove')}</button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {editing ? (
          <div className={css.drawer} role="dialog" aria-label={t('addTitle')} onKeyDown={onDrawerKeyDown}>
            <header className={css.drawerHeader}>
              <span className={css.drawerTitle}>{t('addTitle')}</span>
              <button type="button" className={css.drawerClose} aria-label={t('close')} title={t('close')} onClick={closeEditor}><IconCloseOutline16 /></button>
            </header>
            <form className={css.drawerBody} onSubmit={(event) => { event.preventDefault(); void submit() }}>
              <div className={css.formGrid}>
                <label htmlFor="remote-host-name">{t('name')}<input id="remote-host-name" required value={draft.name} onChange={(event) => { update('name', event.target.value) }} /></label>
                <label htmlFor="remote-host-address">{t('host')}<input id="remote-host-address" required value={draft.host} onChange={(event) => { update('host', event.target.value) }} /></label>
                <label htmlFor="remote-host-port">{t('port')}<input id="remote-host-port" required inputMode="numeric" value={draft.port} onChange={(event) => { update('port', event.target.value) }} /></label>
                <label htmlFor="remote-host-username">{t('username')}<input id="remote-host-username" required value={draft.username} onChange={(event) => { update('username', event.target.value) }} /></label>
                <label htmlFor="remote-host-platform">{t('platform')}<select id="remote-host-platform" value={draft.platform} onChange={(event) => { update('platform', event.target.value as Draft['platform']) }}><option value="linux">Linux</option><option value="darwin">macOS</option><option value="win32">Windows</option></select></label>
                <label htmlFor="remote-host-architecture">{t('architecture')}<select id="remote-host-architecture" value={draft.architecture} onChange={(event) => { update('architecture', event.target.value as Draft['architecture']) }}><option value="x64">x64</option><option value="arm64">arm64</option></select></label>
                <label htmlFor="remote-host-auth">{t('auth')}<select id="remote-host-auth" value={draft.kind} onChange={(event) => { update('kind', event.target.value as Draft['kind']) }}><option value="password">{t('password')}</option><option value="key">{t('privateKey')}</option></select></label>
                {draft.kind === 'password' ? (
                  <label htmlFor="remote-host-credential" className={css.wideField}>{t('password')}<input id="remote-host-credential" type="password" required autoComplete="new-password" value={draft.credential} onChange={(event) => { update('credential', event.target.value) }} /></label>
                ) : (
                  <div className={css.keySection}>
                    <div className={css.keyFileRow}>
                      <button type="button" className={css.keyFileButton} disabled={draft.manualPaste || busy !== undefined} onClick={() => { void chooseKeyFile() }}><IconFolderOpenOutline16 />{t('chooseKeyFile')}</button>
                      <span className={css.keyFilePath} title={draft.keyPath}>{draft.keyPath === '' ? t('noKeyFile') : draft.keyPath}</span>
                    </div>
                    <p className={css.keyFileHint}>{t('keyFileHint')}</p>
                    <label className={css.checkbox}><input type="checkbox" checked={draft.manualPaste} onChange={(event) => { update('manualPaste', event.target.checked) }} />{t('manualPaste')}</label>
                    <label htmlFor="remote-host-key" className={css.wideField}>{t('privateKey')}<textarea id="remote-host-key" required disabled={!draft.manualPaste} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={draft.secret} onChange={(event) => { update('secret', event.target.value) }} /></label>
                    <label htmlFor="remote-host-credential" className={css.wideField}>{t('passphrase')}<input id="remote-host-credential" type="password" autoComplete="new-password" value={draft.credential} onChange={(event) => { update('credential', event.target.value) }} /></label>
                  </div>
                )}
                <label className={css.checkbox}><input type="checkbox" checked={draft.remember} onChange={(event) => { update('remember', event.target.checked) }} />{t('saveCredentials')}</label>
                <div className={css.mappingEditor}>
                  <strong>{t('reverseMappings')}</strong>
                  <p className={css.mappingHint}>{t('mappingHint')}</p>
                  <ul className={css.mappingList}>
                    {draft.mappings.map((mapping, index) => <li className={css.mappingRow} key={`${mapping.remoteOriginalOrigin}-${String(index)}`}><span>{mapping.remoteOriginalOrigin} → {mapping.localHost}:{String(mapping.localPort)}</span><button type="button" className={css.mappingRemove} aria-label={t('removeMapping')} title={t('removeMapping')} onClick={() => { setDraft(previous => ({ ...previous, mappings: previous.mappings.filter((_, itemIndex) => itemIndex !== index) })) }}><IconCloseOutline16 /></button></li>)}
                  </ul>
                  <div className={css.mappingFields}>
                    <input aria-label={t('localHost')} value={draft.mappingLocalHost} onChange={(event) => { update('mappingLocalHost', event.target.value) }} />
                    <input aria-label={t('localPort')} inputMode="numeric" value={draft.mappingLocalPort} onChange={(event) => { update('mappingLocalPort', event.target.value) }} />
                    <input aria-label={t('remoteOrigin')} placeholder="https://remote.example" value={draft.mappingOrigin} onChange={(event) => { update('mappingOrigin', event.target.value) }} />
                    <button type="button" onClick={addMapping}>{t('addMapping')}</button>
                  </div>
                </div>
              </div>
              <p className={css.testHint}>{t('testHint')}</p>
              {tested ? <p className={css.tested} role="status">{t('testPassed')} · {tested.fingerprint}</p> : null}
              <div className={css.drawerActions}>
                <button type="button" disabled={busy !== undefined} onClick={() => { void testConnection() }}>{t('test')}</button>
                <button type="submit" className={css.primary} disabled={tested === undefined || busy !== undefined}>{t('save')}</button>
                <button type="button" disabled={busy !== undefined} onClick={closeEditor}>{t('cancel')}</button>
              </div>
            </form>
          </div>
        ) : null}
      </div>
    </section>
  )
}
