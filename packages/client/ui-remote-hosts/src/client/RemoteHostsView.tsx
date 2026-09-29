import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthSecrets, ConnectivityResult, KeyFilePicker, PickKeyFileResult, RemoteHostId, RemoteHostView, ReverseMapping, UpsertHostInput } from '@deepseek-ai/dsh-remote-hosts/types'
import {
  IconCloseOutline16, IconFolderOpenOutline16, IconGlobeOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { KeyDirectoryPickingHooks } from './contract.ts'
import type { createRemoteHostsViewStore } from './stores.ts'
import { NS } from './locales.ts'
import css from './remote-hosts.module.css'

interface RemoteHostsActions {
  list: () => Promise<RemoteResult<RemoteHostView[]>>
  upsert: (input: UpsertHostInput) => Promise<RemoteResult<RemoteHostView>>
  verify: (input: { host: string; port?: number; username: string; secrets: AuthSecrets }) => Promise<RemoteResult<ConnectivityResult>>
  keyFilePicker: () => Promise<RemoteResult<KeyFilePicker>>
  pickKeyFile: () => Promise<RemoteResult<PickKeyFileResult>>
  connect: (id: RemoteHostId, secrets?: AuthSecrets) => Promise<RemoteResult<RemoteHostView>>
  openRemote: (id: RemoteHostId) => void
  disconnect: (id: RemoteHostId) => Promise<RemoteResult<void>>
  remove: (id: RemoteHostId) => Promise<RemoteResult<void>>
}

export type RemoteHostsViewProps =
  PropsRuntime<'center.view'>
  & PropsRenderSlots<'remoteHosts.keyDirectoryFlow'>
  & PropsStore<ReturnType<typeof createRemoteHostsViewStore>>
  & InjectFace<RemoteHostsActions & { closeView: () => void }>
  & KeyDirectoryPickingHooks
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
const testedFields = ['host', 'port', 'username', 'kind', 'secret', 'credential', 'keyPath', 'manualPaste'] as const

/** Target fields a connectivity test prefills only until the operator overrides them. */
const detectedFields = ['platform', 'architecture'] as const

/** Path separator of a host path, read off the picked/typed path itself: a POSIX root or a Windows drive/UNC prefix. */
function hostPathSeparator(path: string): '/' | '\\' {
  return path.startsWith('/') || path === '' ? '/' : /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') ? '\\' : '/'
}

/** The remote-hosts failure reason carried by the carrier's `remote-host-failed` code. */
function failureReason(failure: RemoteFailure): string {
  const reason = (failure.details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : failure.code
}

/** A host failure as operator copy: the package's closed codes localize, foreign codes keep their wire message. */
function remoteIssue(t: RemoteHostsViewProps['t'], failure: RemoteFailure): string {
  switch (failureReason(failure)) {
    case 'KEY_PICKER_UNAVAILABLE': return t('errorKeyPickUnavailable')
    case 'KEY_PICKER_FAILED': return t('errorKeyPickFailed')
    case 'KEY_FILE_TOO_LARGE': return t('errorKeyFileTooLarge')
    case 'KEY_FILE_READ_FAILED': return t('errorKeyFileReadFailed')
    case 'INVALID_INPUT': return t('errorInvalidInput')
    case 'VERIFY_FAILED': return t('errorVerifyFailed')
    default: return typeof failure.message === 'string' && failure.message !== '' ? failure.message : t('actionFailed')
  }
}

function resultError<T>(t: RemoteHostsViewProps['t'], result: RemoteResult<T>): Error | undefined {
  return result.ok ? undefined : new Error(remoteIssue(t, result.error))
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
  active, actions, list, upsert, verify, keyFilePicker, pickKeyFile, connect, openRemote, disconnect, remove, closeView,
  useKeyDirectoryFlow, renderSlot, t,
}: RemoteHostsViewProps) {
  const [hosts, setHosts] = useState<RemoteHostView[]>([])
  const [draft, setDraft] = useState(initialDraft)
  const [tested, setTested] = useState<Tested | undefined>()
  const overrides = useRef(new Set<(typeof detectedFields)[number]>())
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [pickerKind, setPickerKind] = useState<KeyFilePicker['kind'] | undefined>()
  const [keyFlowOpen, setKeyFlowOpen] = useState(false)
  const keyPathInput = useRef<HTMLInputElement>(null)
  const keyDirectoryFlowAvailable = useKeyDirectoryFlow(occupied => occupied)

  const refresh = useCallback(async () => {
    const result = await list()
    if (result.ok) setHosts(result.value)
    else setError(remoteIssue(t, result.error))
  }, [list, t])

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
  // The composed interaction decides the affordance; a failed probe or an
  // unknown kind hides it (the seam's documented default), leaving manual entry.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void keyFilePicker().then(
      (result) => { if (!cancelled) setPickerKind(result.ok ? result.value.kind : 'absent') },
      () => { if (!cancelled) setPickerKind('absent') },
    )
    return () => { cancelled = true }
  }, [active, keyFilePicker])

  if (!active) return null

  const withBusy = async (id: string, task: () => Promise<RemoteResult<unknown>>): Promise<void> => {
    setBusy(id)
    setError(undefined)
    try {
      const result = await task()
      if (!result.ok) throw new Error(remoteIssue(t, result.error))
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
    : draft.manualPaste
      ? { kind: 'key', privateKey: draft.secret, ...(draft.credential.length > 0 ? { passphrase: draft.credential } : {}) }
      : { kind: 'key', privateKeyPath: draft.keyPath, ...(draft.credential.length > 0 ? { passphrase: draft.credential } : {}) }

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

  /**
   * The draft's own problem as operator copy, or nothing when it is worth
   * sending. Test and save would otherwise reach the Host and come back as the
   * generic `INVALID_INPUT`, which names no field.
   * @returns localized copy for the first blocking field, or undefined.
   */
  const draftIssue = (): string | undefined => {
    if (draft.kind === 'password') return draft.credential === '' ? t('errorPasswordEmpty') : undefined
    if (draft.manualPaste) return draft.secret === '' ? t('errorInlineKeyEmpty') : undefined
    if (draft.keyPath === '') return t('errorKeyPathEmpty')
    // A key path ending in either separator names a directory: the browse
    // flow adopts a directory and expects the operator to complete the name.
    return /[/\\]$/.test(draft.keyPath) ? t('errorKeyPathDirectory') : undefined
  }

  const testConnection = async (): Promise<void> => {
    const issue = draftIssue()
    if (issue !== undefined) {
      setTested(undefined)
      setError(issue)
      return
    }
    setBusy('test')
    setError(undefined)
    try {
      const result = await verify({ host: draft.host, port: Number(draft.port), username: draft.username, secrets: secrets() })
      const issue = resultError(t, result)
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
      if (!result.ok) {
        setError(remoteIssue(t, result.error))
        return
      }
      // A cancelled chooser leaves the form untouched.
      if (result.value.path !== undefined) {
        const path = result.value.path
        setDraft(previous => ({ ...previous, keyPath: path }))
        setTested(undefined)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  // A confirmed browse directory becomes the key path's directory part; the
  // operator completes the file name in the focused path input.
  const adoptKeyDirectory = (directory: string): void => {
    setKeyFlowOpen(false)
    setDraft(previous => ({ ...previous, keyPath: directory + hostPathSeparator(directory) }))
    setTested(undefined)
    keyPathInput.current?.focus()
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
      const issue = resultError(t, result)
      if (issue) throw issue
      /* v8 ignore next -- resultError rejects every non-ok result before this successful-save branch. */
      if (!draft.remember && result.ok) {
        const connected = await connect(result.value.id, submitted)
        const connectionIssue = resultError(t, connected)
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
                      <label htmlFor="remote-host-key-path" className={css.keyPathLabel}>{t('keyPath')}</label>
                      <input
                        id="remote-host-key-path"
                        ref={keyPathInput}
                        className={css.keyPathInput}
                        disabled={draft.manualPaste}
                        placeholder={t('keyPathPlaceholder')}
                        value={draft.keyPath}
                        onChange={(event) => { update('keyPath', event.target.value) }}
                      />
                      {pickerKind !== 'absent' && pickerKind !== undefined && !(pickerKind === 'browse' && !keyDirectoryFlowAvailable) ? (
                        <button
                          type="button"
                          className={css.keyFileButton}
                          disabled={draft.manualPaste || busy !== undefined}
                          onClick={() => { if (pickerKind === 'native') void chooseKeyFile(); else setKeyFlowOpen(true) }}
                        ><IconFolderOpenOutline16 />{t('chooseKeyDirectory')}</button>
                      ) : null}
                    </div>
                    <p className={css.keyFileHint}>{t(draft.manualPaste ? 'keyFileHintPaste' : pickerKind === 'browse' ? 'keyFileHintBrowse' : pickerKind === 'native' ? 'keyFileHint' : 'keyFileHintPath')}</p>
                    <label className={css.checkbox}><input type="checkbox" checked={draft.manualPaste} onChange={(event) => { update('manualPaste', event.target.checked) }} />{t('manualPaste')}</label>
                    {draft.manualPaste ? (
                      <label htmlFor="remote-host-key" className={css.wideField}>{t('privateKey')}<textarea id="remote-host-key" required placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={draft.secret} onChange={(event) => { update('secret', event.target.value) }} /></label>
                    ) : null}
                    <label htmlFor="remote-host-credential" className={css.wideField}>{t('passphrase')}<input id="remote-host-credential" type="password" autoComplete="new-password" value={draft.credential} onChange={(event) => { update('credential', event.target.value) }} /></label>
                    {pickerKind === 'browse' ? renderSlot('remoteHosts.keyDirectoryFlow', {
                      open: keyFlowOpen,
                      busy: busy === 'pick',
                      onPicked: adoptKeyDirectory,
                      onCancel: () => { setKeyFlowOpen(false) },
                      onError: (message) => { setKeyFlowOpen(false); setError(message) },
                    }) : null}
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
