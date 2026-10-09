/**
 * The archive dock: a full-width row above the composer of an imported
 * archive that says the conversation is read-only and continues it in a new
 * session under a chosen agent preset. Renders nothing on any other session.
 */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `sessionImport` projection-key merge this dock reads.
import type {} from '@deepseek-ai/dsh-session-import/client'
import type { ArchiveDockInjected } from './controller.ts'
import type { NS } from './locales.ts'
import type { createArchiveDockStore } from './stores.ts'
import css from './ArchiveDock.module.css'

/** Full props composed by the `conversation.input.dock` slot. */
export type ArchiveDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsStore<ReturnType<typeof createArchiveDockStore>>
  & PropsLocale<typeof NS>
  & InjectFace<ArchiveDockInjected>

/**
 * Render the archive dock for one session.
 * @param props - the dock currency, the shared dock store, the session-bound operation face, and the translator.
 * @returns the dock row on an imported archive, else nothing.
 */
export function ArchiveDock(props: ArchiveDockProps) {
  const { t, useProjection, useStore, sessionId, loadPresets, continueArchive } = props
  const archive = useProjection('sessionImport', value => value ?? null)
  const presets = useStore(state => state.presets)
  const pending = useStore(state => state.pending.includes(sessionId))
  const error = useStore(state => state.errors[sessionId])
  const [preset, setPreset] = useState('')
  const isArchive = archive !== null
  useEffect(() => {
    if (isArchive && presets.status === 'idle') void loadPresets()
  }, [isArchive, presets.status, loadPresets])
  if (archive === null) return null
  return (
    <section className={css.dock} aria-label={t('archive.title')}>
      <div className={css.text}>
        <strong className={css.heading}>{t('archive.title')}</strong>
        <span>{t('archive.body')}</span>
        {archive.sourceCwd === undefined ? null : <span className={css.meta}>{t('archive.source', { cwd: archive.sourceCwd })}</span>}
      </div>
      <div className={css.actions}>
        <label className={css.field}>
          <span className={css.label}>{t('archive.preset')}</span>
          <select
            className={css.select}
            value={preset}
            disabled={pending}
            onChange={(event) => { setPreset(event.currentTarget.value) }}
          >
            <option value="">{t('archive.presetDefault')}</option>
            {presets.options.map(option => (
              <option key={option.id} value={option.id}>{option.name ?? option.id}</option>
            ))}
          </select>
        </label>
        <Button variant="primary" size="sm" disabled={pending} onClick={() => { void continueArchive(preset) }}>
          {pending ? t('archive.continuing') : t('archive.continue')}
        </Button>
      </div>
      {error === undefined ? null : <p className={css.error} role="alert">{t('archive.continueError', { message: error })}</p>}
    </section>
  )
}
