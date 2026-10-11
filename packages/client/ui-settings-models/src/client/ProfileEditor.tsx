/**
 * One Profile editor card: a display name, an optional explanation, the
 * allowed models (one checkbox per catalog model, with an optional
 * reasoning-effort restriction), the allowed chains, and the default target
 * selected when the Profile is applied. Editing normalizes duplicate model
 * entries to one per model — the wildcard entry (no effort) already admits
 * every effort, so duplicates only ever narrow to one effort.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { EntryNameField, PolicyEditorFooter } from './EditorCommon.tsx'
import type {
  PolicyDocProfile, PolicyRouteRow, PolicySelection, PolicyTarget,
} from './policy-store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link ProfileEditor}. */
export interface ProfileEditorProps {
  /** Stable document key of the edited Profile. */
  id: string
  /** Existing entry, or undefined for a new one. */
  profile: PolicyDocProfile | undefined
  /** Every configured chain, pickable as an allowance. */
  routes: readonly PolicyRouteRow[]
  /** Live catalog the model allowances offer. */
  catalog: readonly ModelProviderGroup[]
  /** Whether the deployment accepts writes. */
  readOnly: boolean
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Persist the edited Profile; resolves true once the write landed. */
  save: (profile: PolicyDocProfile) => Promise<boolean>
  /** Dismiss the card; the argument says whether a write landed. */
  onClose: (changed: boolean) => void
}

/** Select value of a default target pointing at the allowed model at `index`. */
function modelTargetValue(index: number): string {
  return `model:${String(index)}`
}

/** Select value of a default target pointing at the chain `routeId`. */
function routeTargetValue(routeId: string): string {
  return `route:${routeId}`
}

/**
 * Render one Profile editor.
 * @param props - the entry, the chains, the catalog, and the write surface.
 * @returns the editor card.
 */
export function ProfileEditor(props: ProfileEditorProps): ReactNode {
  const { t } = props
  const [name, setName] = useState(props.profile?.name ?? '')
  const [description, setDescription] = useState(props.profile?.description ?? '')
  const [models, setModels] = useState<readonly PolicySelection[]>(() => props.profile?.models.map(entry => ({ ...entry })) ?? [])
  const [routes, setRoutes] = useState<readonly string[]>(() => [...props.profile?.routes ?? []])
  const [target, setTarget] = useState<string>(() => {
    const profile = props.profile
    const existing = profile?.defaultTarget
    if (profile === undefined || existing === undefined) return ''
    if (existing.kind === 'route') return routeTargetValue(existing.route)
    const index = profile.models.findIndex(entry =>
      entry.provider === existing.selection.provider
      && entry.model === existing.selection.model
      && entry.reasoningEffort === existing.selection.reasoningEffort)
    return index === -1 ? '' : modelTargetValue(index)
  })
  const [busy, setBusy] = useState(false)

  const entryIndexOf = (provider: string, model: string): number =>
    models.findIndex(entry => entry.provider === provider && entry.model === model)

  const toggleModel = (provider: string, model: string, allowed: boolean): void => {
    setModels((current) => {
      const kept = current.filter(entry => !(entry.provider === provider && entry.model === model))
      return allowed ? [...kept, { provider, model }] : kept
    })
  }

  const setModelEffort = (provider: string, model: string, effort: string | undefined): void => {
    setModels(current => [
      ...current.filter(entry => !(entry.provider === provider && entry.model === model)),
      { provider, model, ...effort === undefined ? {} : { reasoningEffort: effort } },
    ])
  }

  const toggleRoute = (routeId: string, allowed: boolean): void => {
    setRoutes((current) => {
      const kept = current.filter(id => id !== routeId)
      return allowed ? [...kept, routeId] : kept
    })
  }

  const commit = (): void => {
    const selection = decodeTarget(target)
    /* v8 ignore next -- the footer refuses to commit while no target decodes */
    if (selection === undefined) return
    setBusy(true)
    void props.save({
      ...name.trim() === '' ? {} : { name: name.trim() },
      ...description.trim() === '' ? {} : { description: description.trim() },
      models: models.map(entry => ({ ...entry })),
      routes: [...routes],
      defaultTarget: selection,
    }).then((ok) => {
      if (ok) props.onClose(true)
    }).finally(() => { setBusy(false) })
  }

  function decodeTarget(value: string): PolicyTarget | undefined {
    if (value === '') return undefined
    if (value.startsWith('route:')) {
      const routeId = value.slice('route:'.length)
      return routes.includes(routeId) ? { kind: 'route', route: routeId } : undefined
    }
    const index = Number(value.slice('model:'.length))
    const selection = models[index]
    return selection === undefined ? undefined : { kind: 'model', selection }
  }

  const listed: readonly { provider: string; model: string }[] = props.catalog.flatMap(group =>
    group.models.map(model => ({ provider: group.id, model: model.id })))
  const offCatalog: { provider: string; model: string }[] = []
  for (const entry of models) {
    const absent = !listed.some(candidate => candidate.provider === entry.provider && candidate.model === entry.model)
    const unseen = !offCatalog.some(candidate => candidate.provider === entry.provider && candidate.model === entry.model)
    if (absent && unseen) offCatalog.push({ provider: entry.provider, model: entry.model })
  }

  const decodedTarget = decodeTarget(target)
  const canCommit = !props.readOnly && !busy && decodedTarget !== undefined

  return (
    <section className={styles['editor']} aria-label={t('profilesTitle')}>
      <div className={styles['editorHeader']}>
        <h3 className={styles['editorTitle']}>{props.profile === undefined ? t('addProfile') : t('edit')}</h3>
        <span className={styles['rowMeta']}>{props.id}</span>
      </div>
      <EntryNameField
        id="policy-profile-name"
        value={name}
        onChange={setName}
        t={t}
        disabled={props.readOnly || busy}
      />
      <div className={styles['field']}>
        <label className={styles['fieldLabel']} htmlFor="policy-profile-description">{t('entryDescription')}</label>
        <input
          id="policy-profile-description"
          className={styles['input']}
          value={description}
          disabled={props.readOnly || busy}
          onChange={(event) => { setDescription(event.currentTarget.value) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('allowedModels')}</span>
        <ul className={styles['allowanceList']}>
          {props.catalog.map(group => (
            <li key={group.id}>
              <p className={styles['allowanceGroup']}>{group.name}</p>
              <ul>
                {group.models.map((model) => {
                  const index = entryIndexOf(group.id, model.id)
                  const entry = index === -1 ? undefined : models[index]
                  const efforts = model.reasoning?.efforts
                  return (
                    <li key={model.id} className={styles['allowanceRow']}>
                      <label>
                        <input
                          type="checkbox"
                          checked={index !== -1}
                          disabled={props.readOnly || busy}
                          onChange={(event) => { toggleModel(group.id, model.id, event.currentTarget.checked) }}
                        />
                        {model.name}
                      </label>
                      {index === -1 || (efforts === undefined && entry?.reasoningEffort === undefined)
                        ? null
                        : (
                          <select
                            className={styles['selectInput']}
                            aria-label={t('targetEffort')}
                            value={entry?.reasoningEffort ?? ''}
                            disabled={props.readOnly || busy}
                            onChange={(event) => {
                              setModelEffort(group.id, model.id, event.currentTarget.value === '' ? undefined : event.currentTarget.value)
                            }}
                          >
                            <option value="">{t('effortAny')}</option>
                            {(efforts ?? []).map(effort => (
                              <option key={effort.id} value={effort.id}>{effort.name}</option>
                            ))}
                            {efforts !== undefined && entry?.reasoningEffort !== undefined
                            && !efforts.some(effort => effort.id === entry.reasoningEffort)
                              ? <option value={entry.reasoningEffort}>{entry.reasoningEffort}</option>
                              : null}
                          </select>
                        )}
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
          {offCatalog.length === 0 ? null : (
            <li>
              <p className={styles['allowanceGroup']}>{t('offCatalogGroup')}</p>
              <ul>
                {offCatalog.map(entry => (
                  <li key={`${entry.provider}\u0000${entry.model}`} className={styles['allowanceRow']}>
                    <label>
                      <input
                        type="checkbox"
                        checked
                        disabled={props.readOnly || busy}
                        onChange={(event) => { toggleModel(entry.provider, entry.model, event.currentTarget.checked) }}
                      />
                      {`${entry.provider} · ${entry.model}`}
                    </label>
                    <span className={styles['rowTag']}>{t('unavailableTag')}</span>
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('allowedRoutes')}</span>
        <ul className={styles['allowanceList']}>
          {props.routes.map(route => (
            <li key={route.id} className={styles['allowanceRow']}>
              <label>
                <input
                  type="checkbox"
                  checked={routes.includes(route.id)}
                  disabled={props.readOnly || busy}
                  onChange={(event) => { toggleRoute(route.id, event.currentTarget.checked) }}
                />
                {route.name ?? route.id}
              </label>
            </li>
          ))}
          {props.routes.length === 0 ? <p className={styles['rowSummary']}>{t('routeEmpty')}</p> : null}
        </ul>
      </div>
      <div className={styles['field']}>
        <label className={styles['fieldLabel']} htmlFor="policy-default-target">{t('defaultTargetLabel')}</label>
        <select
          id="policy-default-target"
          className={styles['selectInput']}
          value={target}
          disabled={props.readOnly || busy}
          onChange={(event) => { setTarget(event.currentTarget.value) }}
        >
          <option value="">{t('defaultTargetNone')}</option>
          {models.map((entry, index) => (
            <option key={`${entry.provider}/${entry.model}/${String(index)}`} value={modelTargetValue(index)}>
              {`${entry.provider} · ${entry.model}${entry.reasoningEffort === undefined ? '' : ` · ${entry.reasoningEffort}`}`}
            </option>
          ))}
          {routes.map(routeId => (
            <option key={routeId} value={routeTargetValue(routeId)}>
              {props.routes.find(route => route.id === routeId)?.name ?? routeId}
            </option>
          ))}
        </select>
        {decodedTarget === undefined ? <p className={styles['error']}>{t('profileNeedsDefaultTarget')}</p> : null}
      </div>
      <PolicyEditorFooter
        t={props.t}
        busy={busy}
        submitDisabled={!canCommit}
        onCancel={() => { props.onClose(false) }}
        onSubmit={commit}
      />
    </section>
  )
}
