import { useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

interface ModelPolicySectionProps {
  controller: ModelsSettingsStore
  useSnapshot: SnapshotSelectorHook<ModelsSettingsState>
  api: Pick<IApiClient, 'settings'>
  t: (key: keyof typeof en) => string
}

function namespaceOf(state: ModelsSettingsState, ns: string): SettingsNamespaceView | undefined {
  return state.namespaces.get(ns)
}

function sectionText(namespace: SettingsNamespaceView | undefined): string {
  const value = namespace?.user
  return JSON.stringify(value === undefined ? {} : value, null, 2)
}

function parseObject(text: string): object {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The settings section must be a JSON object.')
  }
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function PolicyEditor(props: {
  namespace: SettingsNamespaceView | undefined
  title: string
  hint: string
  saveLabel: string
  readOnly: boolean
  api: Pick<IApiClient, 'settings'>
  t: (key: keyof typeof en) => string
}): ReactNode {
  const [text, setText] = useState(() => sectionText(props.namespace))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | undefined>(undefined)

  if (props.namespace === undefined) return <p className={styles.notice}>{props.t('policyUnavailable')}</p>
  const { namespace } = props
  const save = (): void => {
    let section: object
    try {
      section = parseObject(text)
    } catch (error: unknown) {
      setStatus(messageOf(error))
      return
    }
    setBusy(true)
    setStatus(undefined)
    void props.api.settings.replace({
      ns: namespace.ns,
      section,
      expectedRevision: namespace.revision,
    }).then((response) => {
      if (!response.result.ok) {
        setStatus(response.result.error.message)
        return
      }
      setText(sectionText(response.result.value))
      setStatus(props.t('policySaved'))
    }).catch((error: unknown) => {
      setStatus(messageOf(error))
    }).finally(() => { setBusy(false) })
  }

  return (
    <section className={styles.policyCard} aria-label={props.title}>
      <h2 className={styles.policyTitle}>{props.title}</h2>
      <p className={styles.policyHint}>{props.hint}</p>
      <textarea
        className={styles.policyEditor}
        value={text}
        onChange={(event) => { setText(event.currentTarget.value); setStatus(undefined) }}
        disabled={props.readOnly || busy}
        spellCheck={false}
        aria-label={props.title}
      />
      {status === undefined ? null : <p className={styles.notice}>{status}</p>}
      <button className={styles.primaryButton} type="button" onClick={save} disabled={props.readOnly || busy}>
        {busy ? props.t('applying') : props.saveLabel}
      </button>
    </section>
  )
}

/** Independent settings page for Model Profile and Model Route documents. */
export function ModelPolicySection(props: ModelPolicySectionProps): ReactNode {
  const state = props.useSnapshot(snapshot => snapshot)
  if (state.status === 'idle') void props.controller.load()
  return (
    <div className={styles.section}>
      <h1 className={styles.title}>{props.t('policyTitle')}</h1>
      <p className={styles.intro}>{props.t('policyIntro')}</p>
      <PolicyEditor
        namespace={namespaceOf(state, 'model-profiles')}
        title={props.t('profileDefinitions')}
        hint={props.t('profileDefinitionsHint')}
        saveLabel={props.t('saveProfiles')}
        readOnly={!state.writable}
        api={props.api}
        t={props.t}
      />
      <PolicyEditor
        namespace={namespaceOf(state, 'model-routes')}
        title={props.t('routeDefinitions')}
        hint={props.t('routeDefinitionsHint')}
        saveLabel={props.t('saveRoutes')}
        readOnly={!state.writable}
        api={props.api}
        t={props.t}
      />
    </div>
  )
}
