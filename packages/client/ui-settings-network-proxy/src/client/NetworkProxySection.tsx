/**
 * The network proxy section: the off / system / manual radio fieldset over
 * the host `network-proxy` settings namespace. Writes go through the bound
 * settings scope field-by-field (mode, url, noProxy — an emptied optional
 * clears its override), and the host plugin applies the route live; the form
 * itself holds only the draft.
 */

import { useEffect, useState } from 'react'
import type { SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NetworkProxySectionValue, ProxyMode } from './decode.ts'
import css from './NetworkProxySection.module.css'

/** Registration-side business face for the section. */
export interface NetworkProxySectionInjected {
  hooks: {
    /** Settings scope snapshot bound by the renderer as useScope. */
    scope: SnapshotStore<SettingsScopeSnapshot<NetworkProxySectionValue>>
  }
  /** Queue one field write through the bound settings scope. */
  set: (field: string, value: unknown) => Promise<void>
  /** Clear one field override through the bound settings scope. */
  unset: (field: string) => Promise<void>
}

/** Props the renderer binds for the section. */
export type NetworkProxySectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.network-proxy'>
  & InjectFace<NetworkProxySectionInjected>

/** The editable form state; list fields render as comma-separated drafts. */
interface Draft {
  readonly mode: ProxyMode
  readonly url: string
  readonly noProxy: string
}

/** One notice the actions row reports to assistive technology. */
type Notice = { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; message: string }

/**
 * Whether a manual proxy address is one the transport can route.
 * @param candidate - the trimmed address draft.
 * @returns true for a parseable http(s) URL.
 */
export function usableProxyUrl(candidate: string): boolean {
  if (candidate === '') return false
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Seed one draft from the resolved section. */
function toDraft(value: NetworkProxySectionValue): Draft {
  return { mode: value.mode, url: value.url ?? '', noProxy: (value.noProxy ?? []).join(',') }
}

/** Render the Network proxy settings page. */
export function NetworkProxySection({ t, useScope, set, unset }: NetworkProxySectionProps) {
  const scope = useScope(snapshot => snapshot)
  const [draft, setDraft] = useState<Draft | null>(null)
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
    setDraft(toDraft(current))
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
  const view: Draft = draft ?? toDraft(current)
  const disabled = busy || !scope.writable
  const trimmedUrl = view.url.trim()
  const urlUsable = trimmedUrl !== '' && usableProxyUrl(trimmedUrl)
  const urlRejected = trimmedUrl !== '' && !urlUsable
  const mode = view.mode

  // The disabled props are the single invocation gate (no in-handler re-guard).
  const save = async (): Promise<void> => {
    setBusy(true)
    setNotice({ kind: 'idle' })
    try {
      if (view.mode !== current.mode) await set('mode', view.mode)
      const url = view.url.trim()
      if (url === '') {
        if (current.url !== undefined) await unset('url')
      } else if (url !== current.url) {
        await set('url', url)
      }
      const list = view.noProxy.split(',').map(part => part.trim()).filter(part => part !== '')
      if (list.length === 0) {
        if (current.noProxy !== undefined) await unset('noProxy')
      } else if (list.join(',') !== (current.noProxy ?? []).join(',')) {
        await set('noProxy', list)
      }
      setNotice({ kind: 'saved' })
      setDirty(false)
    } catch (error: unknown) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const modes: readonly { value: ProxyMode; label: string; desc: string }[] = [
    { value: 'off', label: t('mode.off'), desc: t('mode.offDesc') },
    { value: 'system', label: t('mode.system'), desc: t('mode.systemDesc') },
    { value: 'manual', label: t('mode.manual'), desc: t('mode.manualDesc') },
  ]

  return (
    <section className={css.page} aria-label={t('title')}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.note}>{t('intro')}</p>
      <fieldset className={css.fieldset}>
        {modes.map(entry => (
          <div key={entry.value} className={css.modeRow}>
            <label className={css.radioLabel}>
              <input
                type="radio"
                name="network-proxy-mode"
                checked={mode === entry.value}
                onChange={() => {
                  setDraft({ mode: entry.value, url: view.url, noProxy: view.noProxy })
                  setDirty(true)
                  setNotice({ kind: 'idle' })
                }}
                disabled={disabled}
              />
              <span>{entry.label}</span>
            </label>
            <span className={css.hint}>{entry.desc}</span>
            {entry.value === 'manual' && mode === 'manual' ? (
              <span className={css.manualRows}>
                <label className={css.fieldLabel} htmlFor="network-proxy-url">{t('url.label')}</label>
                <Input
                  id="network-proxy-url"
                  className={css.input}
                  type="text"
                  value={view.url}
                  placeholder={t('url.placeholder')}
                  onChange={(event) => {
                    setDraft({ mode: 'manual', url: event.target.value, noProxy: view.noProxy })
                    setDirty(true)
                    setNotice({ kind: 'idle' })
                  }}
                  disabled={disabled}
                  aria-invalid={urlRejected}
                />
                <label className={css.fieldLabel} htmlFor="network-proxy-no-proxy">{t('noProxy.label')}</label>
                <Input
                  id="network-proxy-no-proxy"
                  className={css.input}
                  type="text"
                  value={view.noProxy}
                  placeholder={t('noProxy.placeholder')}
                  onChange={(event) => {
                    setDraft({ mode: 'manual', url: view.url, noProxy: event.target.value })
                    setDirty(true)
                    setNotice({ kind: 'idle' })
                  }}
                  disabled={disabled}
                />
              </span>
            ) : null}
          </div>
        ))}
        {urlRejected ? <p className={css.error} role="alert">{t('url.invalid')}</p> : null}
        <div className={css.actions}>
          <Button variant="primary" disabled={disabled || !dirty || (mode === 'manual' && !urlUsable)} onClick={() => { void save() }}>
            {busy ? t('saving') : t('save')}
          </Button>
          <Button variant="ghost" disabled={disabled || !dirty} onClick={() => {
            setDraft(toDraft(current))
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
