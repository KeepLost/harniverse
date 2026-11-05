/**
 * The execution world section: the host-local / VM world radio fieldset over
 * the host `exec-world` settings namespace. Writes go through the bound
 * settings scope as one `world` field; the namespace declares `applies:
 * 'restart'`, so the composed capability-family rows follow on the next
 * start — the form itself holds only the draft.
 */

import { useEffect, useState } from 'react'
import type { SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExecWorldPreferenceValue, ExecWorldSectionValue } from './decode.ts'
import css from './ExecWorldSection.module.css'

/** Registration-side business face for the section. */
export interface ExecWorldSectionInjected {
  hooks: {
    /** Settings scope snapshot bound by the renderer as useScope. */
    scope: SnapshotStore<SettingsScopeSnapshot<ExecWorldSectionValue>>
  }
  /** Queue the `world` field write through the bound settings scope. */
  set: (field: string, value: unknown) => Promise<void>
}

/** Props the renderer binds for the section. */
export type ExecWorldSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.exec-world'>
  & InjectFace<ExecWorldSectionInjected>

/** One notice the actions row reports to assistive technology. */
type Notice = { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; message: string }

/** Render the execution world settings page. */
export function ExecWorldSection({ t, useScope, set }: ExecWorldSectionProps) {
  const scope = useScope(snapshot => snapshot)
  const [draft, setDraft] = useState<ExecWorldPreferenceValue | null>(null)
  const [dirty, setDirty] = useState(false)
  const [syncedRevision, setSyncedRevision] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>({ kind: 'idle' })

  const current = scope.value
  // Adopt every clean revision: the first resolved section and each external
  // or settled write. A dirty draft (the user edited since the last sync) is
  // the user's until saved or reverted.
  useEffect(() => {
    if (current === undefined || dirty) return
    if (draft !== null && scope.revision === syncedRevision) return
    setDraft(current.world)
    setSyncedRevision(scope.revision)
  }, [current, dirty, draft, scope.revision, syncedRevision])

  if (scope.status !== 'ready' || current === undefined) {
    return (
      <section className={css.page} aria-label={t('title')}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.note}>{scope.status === 'unavailable' ? t('unavailable') : t('loading')}</p>
      </section>
    )
  }

  // The early return above guarantees `current` is present; before the first
  // adoption the draft falls back to the resolved section, and the disabled
  // props below are the single invocation gate (no in-handler re-guard).
  const view: ExecWorldPreferenceValue = draft ?? current.world
  const disabled = busy || !scope.writable

  // The disabled props are the single invocation gate (no in-handler re-guard).
  const save = async (): Promise<void> => {
    setBusy(true)
    setNotice({ kind: 'idle' })
    try {
      if (view !== current.world) await set('world', view)
      setNotice({ kind: 'saved' })
      setDirty(false)
    } catch (error: unknown) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const options: readonly { value: ExecWorldPreferenceValue; label: string; desc: string }[] = [
    { value: 'local', label: t('world.local'), desc: t('world.localDesc') },
    { value: 'vm', label: t('world.vm'), desc: t('world.vmDesc') },
  ]

  return (
    <section className={css.page} aria-label={t('title')}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.note}>{t('intro')}</p>
      <fieldset className={css.fieldset}>
        {options.map(entry => (
          <div key={entry.value} className={css.optionRow}>
            <label className={css.radioLabel}>
              <input
                type="radio"
                name="exec-world-world"
                checked={view === entry.value}
                onChange={() => {
                  setDraft(entry.value)
                  setDirty(true)
                  setNotice({ kind: 'idle' })
                }}
                disabled={disabled}
              />
              <span>{entry.label}</span>
            </label>
            <span className={css.hint}>{entry.desc}</span>
          </div>
        ))}
        <div className={css.actions}>
          <Button variant="primary" disabled={disabled || !dirty} onClick={() => { void save() }}>
            {busy ? t('saving') : t('save')}
          </Button>
          <Button variant="ghost" disabled={disabled || !dirty} onClick={() => {
            setDraft(current.world)
            setDirty(false)
            setNotice({ kind: 'idle' })
          }}>
            {t('revert')}
          </Button>
          <span className={css.notice} aria-live="polite">
            {notice.kind === 'saved' && t('saved')}
            {notice.kind === 'error' && t('saveFailed', { message: notice.message === '' ? t('unknownError') : notice.message })}
          </span>
        </div>
        {!scope.writable ? <p className={css.note}>{t('readonly')}</p> : null}
      </fieldset>
    </section>
  )
}
