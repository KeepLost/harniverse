/**
 * The governor settings page: the global resource-quota control surface.
 * The global memory budget (the one enforced quota — CPU, disk, and network
 * stay observation-only) is edited through the client settings scope, so a
 * write lands in the `governor:` settings section and the Host re-resolves
 * the budget; the effective value shown beside the form is read back through
 * the governor Remote.
 */
import { useEffect, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { GovernorConfig } from '@deepseek-ai/dsh-governor/client'
import type { SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formatBytes } from './bytes.ts'
import { NS } from './locales.ts'
import css from './GovernorSettingsSection.module.css'

/** The quota fields of the `governor` settings section this page edits. */
export interface GovernorQuotaSettings {
  /** Global memory budget: `'auto'` or an explicit byte count. */
  memory?: { limit?: 'auto' | number }
}

/** Effective runtime view returned by the governor `configGet` Remote. */
export type GovernorConfigRuntime = GovernorConfig & { globalLimitBytes: number }

/** Injected business face of the settings page. */
export interface GovernorSettingsInjected {
  hooks: {
    /** Settings scope snapshot bound by the renderer as useScope. */
    scope: SnapshotStore<SettingsScopeSnapshot<GovernorQuotaSettings>>
  }
  /** Write the global memory budget through the settings scope. */
  setMemoryLimit: (limit: 'auto' | number) => Promise<void>
  /** Fetch the host-resolved runtime config (the effective budget). */
  configGet: () => Promise<RemoteResult<GovernorConfigRuntime>>
  /** Bound translator for the section's copy. */
  t: PropsLocale<typeof NS>['t']
}

/** Full props composed by the settings-section slot. */
export type GovernorSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & InjectFace<GovernorSettingsInjected>

/** Delay before the trailing effective-budget reread covers the Host's async re-application. */
const RESYNC_MS = 600

/**
 * The global-quota form: an automatic-versus-custom memory budget with a
 * GiB draft, the host-resolved effective value, and the inheritance notes.
 * @param props - the settings-section currency, the locale seat, the scope snapshot hook, and the write/read callbacks.
 * @returns the settings page.
 */
export function GovernorSettingsSection(props: GovernorSettingsSectionProps) {
  const { t, setMemoryLimit, configGet } = props
  const scope = props.useScope(snapshot => snapshot)
  const [mode, setMode] = useState<'auto' | 'custom'>('auto')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [runtime, setRuntime] = useState<GovernorConfigRuntime | undefined>(undefined)
  const [runtimeState, setRuntimeState] = useState<'loading' | 'ready' | 'error'>('loading')

  const limit = scope.status === 'ready' ? scope.value?.memory?.limit : undefined
  useEffect(() => {
    if (typeof limit === 'number') {
      setMode('custom')
      setDraft((limit / 1024 ** 3).toFixed(1))
    } else {
      setMode('auto')
    }
  }, [limit])

  useEffect(() => {
    let alive = true
    const read = async () => {
      const result = await configGet()
      if (!alive) return
      if (result.ok) {
        setRuntime(result.value)
        setRuntimeState('ready')
      } else {
        setRuntimeState('error')
      }
    }
    void read()
    return () => { alive = false }
  }, [configGet])

  /** Reread the effective budget now and once more after the Host's async apply settles. */
  const resync = async () => {
    const read = async () => {
      const result = await configGet()
      if (result.ok) {
        setRuntime(result.value)
        setRuntimeState('ready')
      } else {
        setRuntimeState('error')
      }
    }
    await read()
    setTimeout(() => { void read() }, RESYNC_MS)
  }

  const disabled = busy || !scope.writable

  /** Validate the draft and push the chosen budget through the scope. */
  const apply = async () => {
    if (mode === 'auto') {
      setBusy(true)
      try {
        await setMemoryLimit('auto')
        await resync()
      } finally {
        setBusy(false)
      }
      return
    }
    const gib = Number(draft)
    if (!Number.isFinite(gib) || gib <= 0) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setBusy(true)
    try {
      await setMemoryLimit(Math.round(gib * 1024 ** 3))
      await resync()
    } finally {
      setBusy(false)
    }
  }

  if (scope.status === 'unavailable') {
    return (
      <section className={css.page} aria-label={t('settings.title')}>
        <p className={css.note}>{t('settings.unavailable')}</p>
      </section>
    )
  }

  return (
    <section className={css.page} aria-label={t('settings.title')}>
      <h2 className={css.title}>{t('settings.title')}</h2>
      <p className={css.note}>{t('settings.intro')}</p>
      <fieldset className={css.fieldset}>
        <legend className={css.legend}>{t('settings.limit.title')}</legend>
        <div className={css.modeRow}>
          <label className={css.radioLabel}>
            <input
              type="radio"
              name="governor-quota-mode"
              checked={mode === 'auto'}
              onChange={() => { setMode('auto') }}
              disabled={disabled}
            />
            <span>{t('settings.limit.auto')}</span>
          </label>
          <span className={css.hint}>{t('settings.limit.autoDesc')}</span>
        </div>
        <div className={css.modeRow}>
          <label className={css.radioLabel}>
            <input
              type="radio"
              name="governor-quota-mode"
              checked={mode === 'custom'}
              onChange={() => { setMode('custom') }}
              disabled={disabled}
            />
            <span>{t('settings.limit.custom')}</span>
          </label>
          {mode === 'custom' ? (
            <span className={css.customRow}>
              <input
                id="governor-quota-gib"
                className={css.number}
                type="number"
                min="0.5"
                step="0.5"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setInvalid(false)
                }}
                disabled={disabled}
                aria-invalid={invalid}
              />
              <label className={css.unitLabel} htmlFor="governor-quota-gib">{t('settings.limit.gib')}</label>
            </span>
          ) : null}
        </div>
        {invalid ? <p className={css.error} role="alert">{t('settings.limit.invalid')}</p> : null}
        <button type="button" className={css.apply} disabled={disabled} onClick={() => { void apply() }}>
          {t('settings.limit.apply')}
        </button>
      </fieldset>
      <p className={css.effective}>
        {runtimeState === 'ready' && runtime !== undefined
          ? t('settings.effective', { value: formatBytes(runtime.globalLimitBytes, t) })
          : runtimeState === 'loading'
            ? t('settings.effective.refreshing')
            : t('settings.effective.error')}
      </p>
      {!scope.writable ? <p className={css.note}>{t('settings.readonly')}</p> : null}
      <p className={css.note}>{t('settings.session.note')}</p>
      <p className={css.note}>{t('settings.swap.note')}</p>
    </section>
  )
}
