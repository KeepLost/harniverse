/**
 * Model Policy settings section: structured editors over the `model-policy`
 * document. Routes are ordered fallback chains picked from the live catalog;
 * Profiles are named allowances (models plus chains) with one default target.
 * One editor is open at a time and every save replaces the whole user
 * document behind the revision it opened against, so concurrent edits surface
 * as conflicts instead of overwriting. Deployment-built-in entries render
 * locked, because the settings merge can only add on top of them.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal, Select } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import { ProfileEditor } from './ProfileEditor.tsx'
import { RequestRetryCard } from './RequestRetryCard.tsx'
import { RouteEditor } from './RouteEditor.tsx'
import { SectionError } from './SectionError.tsx'
import { freshProfileId, freshRouteId, policyDocOf } from './policy-store.ts'
import type {
  ModelPolicyState, ModelPolicyStore, PolicyDoc, PolicyProfileRow, PolicyRouteRow,
} from './policy-store.ts'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelPolicySection} (slot `inject`). */
export interface ModelPolicySectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelPolicyStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<ModelPolicyState>
  /** The Models store whose provider rows the request-retry card fans out to. */
  modelsController?: ModelsSettingsStore | undefined
  /** uSES subscription hook bound to the Models store. */
  modelsSnapshot?: SnapshotSelectorHook<ModelsSettingsState> | undefined
  /** Wire face for the request-retry card's settings writes. */
  api?: Pick<IApiClient, 'settings'> | undefined
  /** Shared mirror write fencing and successful-response fold. */
  writeFence?: (() => number) | undefined
  isCurrent?: ((fence: number) => boolean) | undefined
  acceptSettingsView?: ((view: SettingsNamespaceView, fence: number, authentication?: unknown) => boolean) | undefined
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type ModelPolicySectionProps = Partial<ModelPolicySectionInjected>

/** Which editor card is open, if any. */
type Editing =
  | { kind: 'route'; id: string }
  | { kind: 'route-new' }
  | { kind: 'profile'; id: string }
  | { kind: 'profile-new' }

/** One row pending delete confirmation. */
export type DeleteTarget =
  | { kind: 'route'; row: PolicyRouteRow }
  | { kind: 'profile'; row: PolicyProfileRow }

/** Replace every {key} placeholder in localized summary copy. */
function copy(template: string, values: Record<string, string>): string {
  let text = template
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{${key}}`, value)
  return text
}

/**
 * The user document a delete writes: the resolved document minus one entry.
 * Deleting a chain a Profile still references is refused before this runs.
 * @param doc - the resolved document.
 * @param target - the row being deleted.
 * @returns the document with the entry removed.
 */
export /** Props of the module-private {@link RowIdentity}. */
interface RowIdentityProps {
  name: string
  id: string
  builtin: boolean
  t: (key: keyof typeof en) => string
  children?: ReactNode
}

/** The identity half of a policy row: display name, document id, and the
 * badges the row carries (built-in, and whatever the caller appends). */
function RowIdentity(props: RowIdentityProps): ReactNode {
  return (
    <span className={styles['rowIdentity']}>
      <span className={styles['rowName']}>{props.name}</span>
      <span className={styles['rowMeta']}>{props.id}</span>
      {props.builtin ? <span className={styles['rowTag']}>{props.t('builtinTag')}</span> : null}
      {props.children}
    </span>
  )
}

export function docWithout(doc: PolicyDoc, target: DeleteTarget): PolicyDoc {
  if (target.kind === 'route') {
    const { [target.row.id]: _removedRoute, ...routes } = doc.routes
    return { ...doc, routes }
  }
  const { [target.row.id]: _removedProfile, ...profiles } = doc.profiles
  return {
    ...doc,
    profiles,
    defaultProfile: doc.defaultProfile === target.row.id ? 'unrestricted' : doc.defaultProfile,
  }
}

/**
 * Render the Model Policy section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelPolicySection(props: ModelPolicySectionProps): ReactNode {
  const { controller, useSnapshot, t } = props
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  return <Boundary injected={{
    controller,
    useSnapshot,
    modelsController: props.modelsController,
    modelsSnapshot: props.modelsSnapshot,
    api: props.api,
    writeFence: props.writeFence,
    isCurrent: props.isCurrent,
    acceptSettingsView: props.acceptSettingsView,
    t,
  }} />
}

function Boundary({ injected }: { injected: ModelPolicySectionInjected }): ReactNode {
  const principalGeneration = injected.useSnapshot(snapshot => snapshot.principalGeneration)
  return <Loaded key={principalGeneration} injected={injected} />
}

function Loaded({ injected }: { injected: ModelPolicySectionInjected }): ReactNode {
  const { controller, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  const models = injected.modelsSnapshot === undefined ? undefined : injected.modelsSnapshot(snapshot => snapshot)
  const [editing, setEditing] = useState<Editing | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [defaultBusy, setDefaultBusy] = useState(false)

  if (state.status === 'idle') void controller.load()
  if (models !== undefined && injected.modelsController !== undefined && models.status === 'idle') {
    void injected.modelsController.load()
  }
  if (state.status === 'error') {
    // The error status always carries text; the fallback satisfies the nullable type.
    /* v8 ignore next -- same defensive arm as the provider page */
    const errorText = state.error ?? ''
    return (
      <SectionError
        title={t('policyTitle')}
        message={`${t('loadFailed')}: ${errorText}`}
        retryLabel={t('retry')}
        onRetry={() => { void controller.load() }}
      />
    )
  }
  if (state.status === 'ready' && state.namespace === undefined) {
    return (
      <div className={styles['section']}>
        <h1 className={styles['title']}>{t('policyTitle')}</h1>
        <p className={styles['notice']}>{t('policyUnavailable')}</p>
      </div>
    )
  }

  const revision = state.namespace?.revision ?? 0
  const doc = policyDocOf(state.namespace)
  const readOnly = !state.writable
  const referencing = (routeId: string): readonly PolicyProfileRow[] =>
    state.profiles.filter(profile => profile.routes.includes(routeId))

  const runWrite = (next: PolicyDoc): Promise<boolean> =>
    controller.save(next, revision).then((outcome) => {
      if (outcome.kind === 'superseded') return false
      if (outcome.kind === 'conflict') {
        setActionError(t('conflict'))
        return false
      }
      if (outcome.kind === 'failed') {
        setActionError(outcome.message)
        return false
      }
      setSaved(true)
      return true
    })

  const closeEditor = (changed: boolean): void => {
    setEditing(undefined)
    if (changed) setSaved(true)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void controller.save(docWithout(doc, deleteTarget), revision).then((outcome) => {
      if (outcome.kind === 'superseded') return
      if (outcome.kind === 'conflict') {
        setDeleteFailure(t('conflict'))
        return
      }
      if (outcome.kind === 'failed') {
        setDeleteFailure(outcome.message)
        return
      }
      setDeleteTarget(undefined)
      setSaved(true)
    }).finally(() => { setDeleting(false) })
  }

  const changeDefault = (profileId: string): void => {
    setDefaultBusy(true)
    setActionError(undefined)
    void runWrite({ ...doc, defaultProfile: profileId }).finally(() => { setDefaultBusy(false) })
  }

  const newRouteId = freshRouteId(doc)
  const newProfileId = freshProfileId(doc)
  const routeEditorOpen = editing?.kind === 'route' || editing?.kind === 'route-new'
  const profileEditorOpen = editing?.kind === 'profile' || editing?.kind === 'profile-new'
  const routeBeingEdited = editing?.kind === 'route' ? editing.id : newRouteId
  const profileBeingEdited = editing?.kind === 'profile' ? editing.id : newProfileId

  return (
    <div className={styles['section']}>
      <h1 className={styles['title']}>{t('policyTitle')}</h1>
      <p className={styles['intro']}>{t('policyIntro')}</p>
      {readOnly ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {state.catalogError === null ? null : <p className={styles['notice']}>{t('catalogFailed')}</p>}
      {saved ? <p className={styles['savedNotice']} role="status" aria-live="polite">{t('policySaved')}</p> : null}
      {actionError === undefined ? null : <p className={styles['error']}>{actionError}</p>}

      {models !== undefined && injected.modelsController !== undefined && injected.api !== undefined
        ? (
          <RequestRetryCard
            rows={models.rows.map(row => ({ settingsNs: row.entry.settingsNs, settingsPath: row.entry.settingsPath }))}
            namespaces={models.namespaces}
            writable={models.writable}
            api={injected.api}
            writeFence={injected.writeFence ?? (() => 0)}
            isCurrent={injected.isCurrent ?? (() => true)}
            acceptSettingsView={injected.acceptSettingsView ?? (() => true)}
            t={t}
          />
        )
        : null}

      <h2 className={styles['groupTitle']}>{t('routesTitle')}</h2>
      <ul className={styles['rows']}>
        {state.routes.map(row => (
          <li key={row.id} className={styles['rowCard']}>
            <div className={styles['rowHead']}>
              <RowIdentity name={row.name ?? row.id} id={row.id} builtin={row.builtin} t={t} />
              <span className={styles['rowActions']}>
                <button type="button" className={styles['secondaryButton']} onClick={() => { setActionError(undefined); setEditing({ kind: 'route', id: row.id }) }}>
                  {t('edit')}
                </button>
                <button
                  type="button"
                  className={styles['dangerButton']}
                  disabled={readOnly || row.builtin || referencing(row.id).length > 0}
                  title={row.builtin || referencing(row.id).length > 0 ? t('routeReferenced') : undefined}
                  onClick={() => { setDeleteFailure(undefined); setDeleteTarget({ kind: 'route', row }) }}
                >
                  {t('remove')}
                </button>
              </span>
            </div>
            <p className={styles['rowSummary']}>
              {row.targets.map(target => `${target.provider}/${target.model}`).join(' → ')}
            </p>
          </li>
        ))}
        {state.routes.length === 0 ? <p className={styles['rowSummary']}>{t('routeEmpty')}</p> : null}
      </ul>
      {routeEditorOpen
        ? (
          <RouteEditor
            key={routeBeingEdited}
            id={routeBeingEdited}
            route={editing.kind === 'route' ? doc.routes[editing.id] : undefined}
            catalog={state.catalog}
            readOnly={readOnly}
            t={t}
            save={next => runWrite({ ...doc, routes: { ...doc.routes, [routeBeingEdited]: next } })}
            onClose={closeEditor}
          />
        )
        : (
          <button type="button" className={styles['addButton']} disabled={readOnly} onClick={() => { setActionError(undefined); setEditing({ kind: 'route-new' }) }}>
            {t('addRoute')}
          </button>
        )}

      <h2 className={styles['groupTitle']}>{t('profilesTitle')}</h2>
      <div className={styles['defaultRow']}>
        <label className={styles['fieldLabel']} htmlFor="policy-default-profile">{t('defaultProfileLabel')}</label>
        <Select
          id="policy-default-profile"
          value={state.defaultProfile}
          disabled={readOnly || defaultBusy || editing !== undefined}
          onChange={(event) => { changeDefault(event.currentTarget.value) }}
        >
          <option value="unrestricted">{t('unrestrictedOption')}</option>
          {state.profiles.map(row => <option key={row.id} value={row.id}>{row.name ?? row.id}</option>)}
        </Select>
      </div>
      <ul className={styles['rows']}>
        {state.profiles.map(row => (
          <li key={row.id} className={styles['rowCard']}>
            <div className={styles['rowHead']}>
              <RowIdentity name={row.name ?? row.id} id={row.id} builtin={row.builtin} t={t}>
                {state.defaultProfile === row.id ? <span className={styles['rowTag']}>{t('defaultTag')}</span> : null}
              </RowIdentity>
              <span className={styles['rowActions']}>
                <button type="button" className={styles['secondaryButton']} onClick={() => { setActionError(undefined); setEditing({ kind: 'profile', id: row.id }) }}>
                  {t('edit')}
                </button>
                <button
                  type="button"
                  className={styles['dangerButton']}
                  disabled={readOnly || row.builtin}
                  onClick={() => { setDeleteFailure(undefined); setDeleteTarget({ kind: 'profile', row }) }}
                >
                  {t('remove')}
                </button>
              </span>
            </div>
            <p className={styles['rowSummary']}>
              {copy(t('profileSummary'), {
                models: String(row.models.length),
                chains: String(row.routes.length),
              })}
            </p>
          </li>
        ))}
        {state.profiles.length === 0 ? <p className={styles['rowSummary']}>{t('profileEmpty')}</p> : null}
      </ul>
      {profileEditorOpen
        ? (
          <ProfileEditor
            key={profileBeingEdited}
            id={profileBeingEdited}
            profile={editing.kind === 'profile' ? doc.profiles[editing.id] : undefined}
            routes={state.routes}
            catalog={state.catalog}
            readOnly={readOnly}
            t={t}
            save={next => runWrite({ ...doc, profiles: { ...doc.profiles, [profileBeingEdited]: next } })}
            onClose={closeEditor}
          />
        )
        : (
          <button type="button" className={styles['addButton']} disabled={readOnly} onClick={() => { setActionError(undefined); setEditing({ kind: 'profile-new' }) }}>
            {t('addProfile')}
          </button>
        )}

      <Modal
        open={deleteTarget !== undefined}
        onClose={() => {
          /* v8 ignore next -- the dialog's own dismissal is inert while the write is in flight */
          if (!deleting) { setDeleteTarget(undefined); setDeleteFailure(undefined) }
        }}
        title={deleteTarget === undefined ? '' : copy(t('deletePolicyTitle'), { name: deleteTarget.row.name ?? deleteTarget.row.id })}
        closeLabel={t('close')}
        description={deleteTarget === undefined || deleteTarget.kind === 'route' ? t('deleteRouteBody') : t('deleteProfileBody')}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={() => { setDeleteTarget(undefined); setDeleteFailure(undefined) }}>
              {t('cancel')}
            </Button>
            <Button variant="outline" className={styles['deleteConfirm']} disabled={deleting} onClick={confirmDelete}>
              {deleting ? t('applying') : t('remove')}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
