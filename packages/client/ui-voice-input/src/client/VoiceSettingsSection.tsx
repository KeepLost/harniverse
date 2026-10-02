/**
 * The Settings → Voice input section: recognizer selection, language hint,
 * push-to-talk key, local model precision, cloud API key, and the local
 * model's download/prepare control with its settled status — one column over
 * the speech settings namespace (writes through the shared settings scope)
 * and the `speech.prepare` RPC.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './VoiceSettingsSection.module.css'

/** Speech namespace mirror plus the prepare verb, injected by apply. */
export interface VoiceSettingsInjected {
  /** Shared settings-namespace scope for the `speech` section. */
  scope: {
    getSnapshot(): {
      status: 'loading' | 'ready' | 'unavailable'
      value: VoiceSection | undefined
      user: unknown
      writable: boolean
    }
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<void>
    unset(field: string): Promise<void>
  }
  /** The speech RPC face of the shared connection client. */
  api: {
    speech: {
      prepare(payload: {}, signal?: AbortSignal): Promise<{
        rpcId: unknown
        result: { ok: true; value: { status: 'ready' | 'unprepared' | 'failed'; detail?: string } } | { ok: false; error: { code: string; message: string } }
      }>
    }
  }
}

/** Speech settings section as the wire resolves it (apiKey redacted). */
export interface VoiceSection {
  recognizer?: 'off' | 'sensevoice' | 'openai-compatible'
  language?: string
  pushToTalkKey?: string
  modelVariant?: 'int8' | 'fp32'
  apiKey?: string
}

/** Component props: the section owner share's close verb, locale, and the inject face. */
export type VoiceSettingsSectionProps = Pick<PropsRuntime<'settings.section'>, 'close'> & PropsLocale<typeof NS> & VoiceSettingsInjected

/** One labeled row: control on its own line under the label. */
function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className={css.row}>
      <span className={css.rowLabel}>{label}</span>
      {children}
    </label>
  )
}

/** Render the Voice input settings column. */
export function VoiceSettingsSection({ t, scope, api }: VoiceSettingsSectionProps) {
  const snapshot = scope.getSnapshot()
  const [, force] = useState(0)
  useEffect(() => scope.subscribe(() => { force(count => count + 1) }), [scope])
  const section = snapshot.value ?? {}
  const overridden = (field: string): boolean => {
    const user = snapshot.user
    return typeof user === 'object' && user !== null && field in user
  }
  const write = useCallback((field: string, value: unknown): void => {
    if (value === '' || value === undefined) {
      void scope.unset(field)
      return
    }
    void scope.set(field, value)
  }, [scope])

  const [preparing, setPreparing] = useState(false)
  const [prepareStatus, setPrepareStatus] = useState<{ status: 'ready' | 'unprepared' | 'failed'; detail?: string } | null>(null)
  const [prepareError, setPrepareError] = useState<string | null>(null)
  const onPrepare = (): void => {
    if (preparing) return
    setPreparing(true)
    setPrepareError(null)
    void api.speech.prepare({}).then((response) => {
      if (response.result.ok) setPrepareStatus(response.result.value)
      else setPrepareError(response.result.error.message)
    }).catch((error: unknown) => {
      setPrepareError(error instanceof Error ? error.message : String(error))
    }).finally(() => { setPreparing(false) })
  }

  const disabled = !snapshot.writable
  return (
    <div className={css.section}>
      <p className={css.description}>{t('settings.description')}</p>
      <Row label={t('settings.recognizer')}>
        <select
          className={css.control}
          value={section.recognizer ?? 'off'}
          disabled={disabled}
          onChange={(event) => { write('recognizer', event.target.value) }}
        >
          <option value="off">{t('settings.recognizer.off')}</option>
          <option value="sensevoice">{t('settings.recognizer.sensevoice')}</option>
          <option value="openai-compatible">{t('settings.recognizer.openai-compatible')}</option>
        </select>
      </Row>
      <Row label={t('settings.language')}>
        <input
          className={css.control}
          value={section.language ?? ''}
          placeholder={t('settings.language.placeholder')}
          disabled={disabled}
          onChange={(event) => { write('language', event.target.value.trim() || '') }}
        />
      </Row>
      <Row label={t('settings.pushToTalkKey')}>
        <input
          className={css.control}
          value={section.pushToTalkKey ?? ''}
          placeholder={t('settings.pushToTalkKey.placeholder')}
          disabled={disabled}
          onChange={(event) => { write('pushToTalkKey', event.target.value.trim().toLowerCase() || '') }}
        />
      </Row>
      <Row label={t('settings.modelVariant')}>
        <select
          className={css.control}
          value={section.modelVariant ?? 'int8'}
          disabled={disabled}
          onChange={(event) => { write('modelVariant', event.target.value) }}
        >
          <option value="int8">{t('settings.modelVariant.int8')}</option>
          <option value="fp32">{t('settings.modelVariant.fp32')}</option>
        </select>
      </Row>
      <Row label={t('settings.apiKey')}>
        <input
          className={css.control}
          type="password"
          value=""
          placeholder={overridden('apiKey') ? t('settings.apiKey.set') : t('settings.apiKey.placeholder')}
          disabled={disabled}
          onChange={(event) => { write('apiKey', event.target.value) }}
        />
      </Row>
      <div className={css.prepare}>
        <button type="button" className={css.prepareButton} onClick={onPrepare} disabled={preparing || disabled}>
          {preparing ? t('settings.preparing') : t('settings.prepare')}
        </button>
        {prepareError !== null && <span className={css.prepareStatus} role="alert">{`${t('settings.prepare.failed')}${prepareError}`}</span>}
        {prepareError === null && preparing && <span className={css.prepareStatus} role="status">{t('settings.preparing')}</span>}
        {prepareError === null && !preparing && prepareStatus !== null && (
          <span className={css.prepareStatus} role="status" title={prepareStatus.detail ?? undefined}>
            {prepareStatus.status === 'ready'
              ? t('settings.prepare.ready')
              : prepareStatus.status === 'unprepared'
                ? t('settings.prepare.unprepared')
                : `${t('settings.prepare.failed')}${prepareStatus.detail ?? ''}`}
          </span>
        )}
      </div>
    </div>
  )
}
