/**
 * The global rules section: a monospace editor over the harness home's
 * `AGENTS.md`. One load on mount, byte-accounted editing against the cap the
 * host reported, optimistic conflict detection through the content-derived
 * version token, and an explicit reload path when an external edit wins.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import css from './GlobalRulesSection.module.css'

/** The loaded file state the editor tracks between saves. */
interface LoadedRules {
  readonly content: string
  /** Content token from the last load or save; empty when the file was absent. */
  readonly version: string
  readonly exists: boolean
  readonly displayPath: string
  readonly maxBytes: number
}

/** Registration-side business face for the section. */
export interface GlobalRulesSectionInjected {
  /** The `globalRules` verbs over the live connection. */
  api: ConnectionHandle['api']['globalRules']
}

/** Props the renderer binds for the section. */
export type GlobalRulesSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.global-rules'>
  & InjectFace<GlobalRulesSectionInjected>

/** One notice the actions row reports to assistive technology. */
type Notice = { kind: 'idle' } | { kind: 'saved' } | { kind: 'conflict' } | { kind: 'error'; message: string }

const encoder = new TextEncoder()

/** Human-readable binary-unit byte count for the counter and cap notice. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Render the Global rules settings page. */
export function GlobalRulesSection({ t, api }: GlobalRulesSectionProps) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [loaded, setLoaded] = useState<LoadedRules>()
  const [loadMessage, setLoadMessage] = useState('')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>({ kind: 'idle' })

  const load = useCallback(async () => {
    setPhase('loading')
    setNotice({ kind: 'idle' })
    try {
      const response = await api.read({})
      const result = response.result
      if (!result.ok) {
        setLoadMessage(result.error.code === 'global-rules-unavailable' ? t('unavailable') : result.error.message)
        setPhase('failed')
        return
      }
      const value = result.value
      setLoaded({
        content: value.content,
        version: value.version ?? '',
        exists: value.exists,
        displayPath: value.displayPath,
        maxBytes: value.maxBytes,
      })
      setDraft(value.content)
      setPhase('ready')
    } catch (error: unknown) {
      setLoadMessage(error instanceof Error ? error.message : String(error))
      setPhase('failed')
    }
  }, [api, t])

  useEffect(() => { void load() }, [load])

  const usedBytes = useMemo(() => encoder.encode(draft).length, [draft])
  const overCap = loaded !== undefined && usedBytes > loaded.maxBytes
  const dirty = loaded !== undefined && draft !== loaded.content

  if (phase === 'loading') {
    return (
      <section className={css.page} aria-label={t('title')}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.hint}>{t('loading')}</p>
      </section>
    )
  }

  if (phase === 'failed' || loaded === undefined) {
    return (
      <section className={css.page} aria-label={t('title')}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.error} role="alert">{t('loadFailed', { message: loadMessage === '' ? t('unknownError') : loadMessage })}</p>
        <div className={css.actions}>
          <Button variant="primary" onClick={() => { void load() }}>{t('retry')}</Button>
        </div>
      </section>
    )
  }

  // The early returns above guarantee `loaded` is present here; the disabled
  // props below are the single invocation gate (no in-handler re-guard).
  const save = async (): Promise<void> => {
    setSaving(true)
    setNotice({ kind: 'idle' })
    try {
      const response = await api.write({
        content: draft,
        ...(loaded.version !== '' ? { expectedVersion: loaded.version } : {}),
      })
      const result = response.result
      if (result.ok) {
        setLoaded({ ...loaded, content: draft, version: result.value.version, exists: true })
        setNotice({ kind: 'saved' })
        return
      }
      if (result.error.code === 'global-rules-conflict') {
        setNotice({ kind: 'conflict' })
        return
      }
      setNotice({ kind: 'error', message: result.error.message })
    } catch (error: unknown) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={css.page} aria-label={t('title')}>
      <div className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.intro}>{t('intro', { path: loaded.displayPath })}</p>
        {!loaded.exists && <p className={css.hint}>{t('notExists')}</p>}
      </div>
      <textarea
        className={css.editor}
        aria-label={t('editorLabel')}
        spellCheck={false}
        value={draft}
        placeholder={t('placeholder')}
        onChange={(event) => {
          setDraft(event.target.value)
          if (notice.kind !== 'idle') setNotice({ kind: 'idle' })
        }}
      />
      <div className={css.meta}>
        <span className={css.counter}>{t('bytes', { used: formatBytes(usedBytes), max: formatBytes(loaded.maxBytes) })}</span>
        {overCap && (
          <span className={css.error} role="alert">
            {t('overCap', { used: formatBytes(usedBytes), max: formatBytes(loaded.maxBytes) })}
          </span>
        )}
      </div>
      <div className={css.actions}>
        <Button variant="primary" disabled={!dirty || saving || overCap} onClick={() => { void save() }}>
          {saving ? t('saving') : t('save')}
        </Button>
        <Button variant="ghost" disabled={!dirty || saving} onClick={() => {
          setDraft(loaded.content)
          setNotice({ kind: 'idle' })
        }}>
          {t('revert')}
        </Button>
        <span className={css.notice} aria-live="polite">
          {notice.kind === 'saved' && t('saved')}
          {notice.kind === 'error' && t('saveFailed', { message: notice.message === '' ? t('unknownError') : notice.message })}
          {notice.kind === 'conflict' && (
            <>
              {t('conflict')}
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => { void load() }}>{t('reload')}</Button>
            </>
          )}
        </span>
      </div>
    </section>
  )
}
