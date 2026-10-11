/**
 * One fallback-chain editor card: a display name plus an ordered list of
 * concrete targets picked from the live catalog. Targets outside the catalog
 * stay editable and carry a badge, because catalog membership is advisory —
 * a provider that stopped advertising a model does not invalidate the chain.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { IconChevronDownOutline14, IconChevronUpOutline14, IconPlusOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { EditorFooter } from './EditorFooter.tsx'
import type { PolicyDocRoute, PolicySelection } from './policy-store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link RouteEditor}. */
export interface RouteEditorProps {
  /** Stable document key of the edited chain. */
  id: string
  /** Existing entry, or undefined for a new one. */
  route: PolicyDocRoute | undefined
  /** Live catalog the pickers offer. */
  catalog: readonly ModelProviderGroup[]
  /** Whether the deployment accepts writes. */
  readOnly: boolean
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Persist the edited chain; resolves true once the write landed. */
  save: (route: PolicyDocRoute) => Promise<boolean>
  /** Dismiss the card; the argument says whether a write landed. */
  onClose: (changed: boolean) => void
}

/** One editable concrete target of the chain. */
interface TargetDraft {
  provider: string
  model: string
  reasoningEffort: string | undefined
}

/** Catalog models of one provider; empty when the provider is unknown. */
function modelsOf(catalog: readonly ModelProviderGroup[], provider: string): readonly { id: string; name: string }[] {
  return catalog.find(group => group.id === provider)?.models ?? []
}

/** Efforts the catalog offers for one provider/model pair, when it supports reasoning. */
function effortsOf(catalog: readonly ModelProviderGroup[], target: TargetDraft): readonly { id: string; name: string }[] | undefined {
  return catalog.find(group => group.id === target.provider)
    ?.models.find(model => model.id === target.model)
    ?.reasoning?.efforts
}

/**
 * The first catalog model of a provider, keeping the current id when the new
 * provider still serves it.
 */
function modelAfterProviderChange(
  catalog: readonly ModelProviderGroup[],
  provider: string,
  model: string,
): string {
  const models = modelsOf(catalog, provider)
  return models.some(candidate => candidate.id === model) ? model : (models[0]?.id ?? model)
}

/**
 * Render one fallback-chain editor.
 * @param props - the entry, the catalog, and the write surface.
 * @returns the editor card.
 */
export function RouteEditor(props: RouteEditorProps): ReactNode {
  const { t } = props
  const [name, setName] = useState(props.route?.name ?? '')
  const [targets, setTargets] = useState<readonly TargetDraft[]>(() =>
    (props.route?.targets ?? []).map(target => ({
      provider: target.provider,
      model: target.model,
      reasoningEffort: target.reasoningEffort,
    })))
  const [busy, setBusy] = useState(false)

  const patch = (index: number, next: Partial<TargetDraft>): void => {
    setTargets(current => current.map((target, at) => at === index ? { ...target, ...next } : target))
  }

  const move = (index: number, delta: -1 | 1): void => {
    setTargets((current) => {
      const to = index + delta
      /* v8 ignore next -- the move buttons are disabled at the list boundaries */
      if (to < 0 || to >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      if (moved === undefined) return current
      next.splice(to, 0, moved)
      return next
    })
  }

  const add = (): void => {
    const group = props.catalog[0]
    const model = group?.models[0]
    /* v8 ignore next -- the catalog drops empty groups, and the button is disabled over an empty one */
    if (group === undefined || model === undefined) return
    setTargets(current => [...current, { provider: group.id, model: model.id, reasoningEffort: undefined }])
  }

  const commit = (): void => {
    const doc = {
      ...name.trim() === '' ? {} : { name: name.trim() },
      targets: targets.map((target): PolicySelection => ({
        provider: target.provider,
        model: target.model,
        ...target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort },
      })),
    }
    setBusy(true)
    void props.save(doc).then((ok) => {
      if (ok) props.onClose(true)
    }).finally(() => { setBusy(false) })
  }

  const canCommit = !props.readOnly && !busy && targets.length > 0

  return (
    <section className={styles['editor']} aria-label={t('routesTitle')}>
      <div className={styles['editorHeader']}>
        <h3 className={styles['editorTitle']}>{props.route === undefined ? t('addRoute') : t('edit')}</h3>
        <span className={styles['rowMeta']}>{props.id}</span>
      </div>
      <div className={styles['field']}>
        <label className={styles['fieldLabel']} htmlFor="policy-route-name">{t('entryName')}</label>
        <input
          id="policy-route-name"
          className={styles['input']}
          value={name}
          placeholder={t('entryNamePlaceholder')}
          disabled={props.readOnly || busy}
          onChange={(event) => { setName(event.currentTarget.value) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('targetOrder')}</span>
        <ul className={styles['targetList']}>
          {targets.map((target, index) => {
            const models = modelsOf(props.catalog, target.provider)
            const efforts = effortsOf(props.catalog, target)
            const offered = efforts !== undefined || target.reasoningEffort !== undefined
            const available = models.some(model => model.id === target.model)
            return (
              <li key={index} className={styles['targetRow']}>
                <select
                  className={styles['selectInput']}
                  aria-label={t('targetProvider')}
                  value={target.provider}
                  disabled={props.readOnly || busy}
                  onChange={(event) => {
                    const provider = event.currentTarget.value
                    patch(index, {
                      provider,
                      model: modelAfterProviderChange(props.catalog, provider, target.model),
                      reasoningEffort: undefined,
                    })
                  }}
                >
                  {props.catalog.map(group => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                  {props.catalog.some(group => group.id === target.provider)
                    ? null
                    : <option value={target.provider}>{target.provider}</option>}
                </select>
                <select
                  className={styles['selectInput']}
                  aria-label={t('targetModel')}
                  value={target.model}
                  disabled={props.readOnly || busy}
                  onChange={(event) => { patch(index, { model: event.currentTarget.value, reasoningEffort: undefined }) }}
                >
                  {models.map(model => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                  {available
                    ? null
                    : <option value={target.model}>{target.model}</option>}
                </select>
                {offered
                  ? (
                    <select
                      className={styles['selectInput']}
                      aria-label={t('targetEffort')}
                      value={target.reasoningEffort ?? ''}
                      disabled={props.readOnly || busy}
                      onChange={(event) => {
                        patch(index, { reasoningEffort: event.currentTarget.value === '' ? undefined : event.currentTarget.value })
                      }}
                    >
                      <option value="">{t('effortAny')}</option>
                      {(efforts ?? []).map(effort => (
                        <option key={effort.id} value={effort.id}>{effort.name}</option>
                      ))}
                      {efforts !== undefined && target.reasoningEffort !== undefined
                      && !efforts.some(effort => effort.id === target.reasoningEffort)
                        ? <option value={target.reasoningEffort}>{target.reasoningEffort}</option>
                        : null}
                    </select>
                  )
                  : null}
                {available ? null : <span className={styles['rowTag']}>{t('unavailableTag')}</span>}
                <button
                  type="button"
                  className={styles['iconButton']}
                  aria-label={t('moveUp')}
                  disabled={props.readOnly || busy || index === 0}
                  onClick={() => { move(index, -1) }}
                >
                  <IconChevronUpOutline14 size={14} />
                </button>
                <button
                  type="button"
                  className={styles['iconButton']}
                  aria-label={t('moveDown')}
                  disabled={props.readOnly || busy || index === targets.length - 1}
                  onClick={() => { move(index, 1) }}
                >
                  <IconChevronDownOutline14 size={14} />
                </button>
                <button
                  type="button"
                  className={styles['iconButtonDanger']}
                  aria-label={t('removeTarget')}
                  disabled={props.readOnly || busy}
                  onClick={() => { setTargets(current => current.filter((_, at) => at !== index)) }}
                >
                  <IconTrashOutline16 size={14} />
                </button>
              </li>
            )
          })}
        </ul>
        <button type="button" className={styles['addModelButton']} disabled={props.readOnly || busy || props.catalog.length === 0} onClick={add}>
          <IconPlusOutline16 size={14} />
          {t('addTarget')}
        </button>
        {targets.length === 0 ? <p className={styles['error']}>{t('routeNeedsTarget')}</p> : null}
      </div>
      <EditorFooter
        t={props.t}
        busy={busy}
        submitDisabled={!canCommit}
        submitLabel="apply"
        submitBusyLabel="applying"
        onCancel={() => { props.onClose(false) }}
        onSubmit={commit}
      />
    </section>
  )
}
