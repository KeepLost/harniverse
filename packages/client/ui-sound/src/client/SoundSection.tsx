/**
 * The sound notification settings section: a header (title, intro, master
 * and quiet switches), a main/subagent tab bar, and six per-event rows
 * (sound selector pill + volume slider, with a local-file row when an audio
 * reference is set). Every write rides the `ui-sound` settings scope; sound
 * picks preview immediately.
 */

import { useState } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SoundChannel, SoundEventKind, SoundSettings } from '../sound-settings.ts'
import { SOUND_EVENT_KINDS, soundFieldFor, volumeFieldFor } from '../sound-settings.ts'
import { EventRow } from './EventRow.tsx'
import type { EventRowActions, EventRowData } from './EventRow.tsx'
import css from './SoundSection.module.css'

/** Registration-side business face of the sound section. */
export interface SoundSectionInjected {
  hooks: {
    /** The bound `ui-sound` settings scope, bound by the renderer as useSoundSettings. */
    settings: SettingsScope<SoundSettings>
  }
  /** Write one field through the settings scope. */
  setField: (field: string, value: unknown) => Promise<void>
  /** Ask the browser for one local audio file; undefined on cancel. */
  chooseFile: () => Promise<string | undefined>
  /** Resolve one `audio:<id>` reference's display name ('' when unresolvable). */
  audioName: (id: string) => Promise<string>
  /** Preview one sound value at one volume. */
  preview: (value: string, volume: number) => void
}

/** Full component props. */
export type SoundSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.sound'>
  & InjectFace<SoundSectionInjected>

/** The section's tab vocabulary, mirroring {@link SoundChannel}. */
type Tab = SoundChannel

/**
 * Render the sound notification settings page.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function SoundSection(props: SoundSectionProps) {
  const { t, setField, chooseFile, audioName, preview } = props
  const snapshot: SettingsScopeSnapshot<SoundSettings> = props.useSettings((value: SettingsScopeSnapshot<SoundSettings>) => value)
  const settings = snapshot.value
  const writable = snapshot.writable && snapshot.status === 'ready'
  const [tab, setTab] = useState<Tab>('main')
  const [writeError, setWriteError] = useState<string | undefined>(undefined)
  const [overrides, setOverrides] = useState<Record<string, string | number | boolean>>({})

  /** Write one field with an optimistic local override until the scope lands. */
  const write = (field: string, value: string | number | boolean): void => {
    setOverrides(previous => ({ ...previous, [field]: value }))
    void setField(field, value).catch((error: unknown) => {
      setWriteError(error instanceof Error ? error.message : String(error))
    })
  }

  /** One field's display value: the optimistic override until the scope catches up. */
  const fieldOf = (field: string): string | number | boolean | undefined => {
    const override = overrides[field]
    if (settings === undefined) return override
    const stored = (settings as unknown as Record<string, string | number | boolean>)[field]
    return override !== undefined && override !== stored ? override : stored
  }

  /** Build one event row's plain data from the current section state. */
  const rowOf = (kind: SoundEventKind): EventRowData => ({
    kind,
    channel: tab,
    title: t(`event.${kind}`),
    description: t(`event.${kind}.desc`),
    sound: String(fieldOf(soundFieldFor(kind, tab)) ?? ''),
    volume: Number(fieldOf(volumeFieldFor(kind, tab)) ?? 1),
  })

  const actions: EventRowActions = {
    setSound: (field, value) => { write(field, value) },
    setVolume: (field, volume) => { write(field, volume) },
    preview,
    chooseFile,
    audioName,
  }

  const rows = SOUND_EVENT_KINDS.map(rowOf)

  const eventsDim = settings === undefined
    || !settings.enabled
    || (tab === 'subagent' && settings.ignoreSubagent)

  return (
    <div className={css.section}>
      <header className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.intro}>{t('intro')}</p>
        {snapshot.status !== 'ready' && <p className={css.notice}>{t('unavailable')}</p>}
        {!snapshot.writable && <p className={css.notice}>{t('readonly')}</p>}
        {writeError !== undefined && <p className={css.error}>{t('writeFailed', { message: writeError })}</p>}
      </header>
      <div className={css.list}>
        <label className={css.row}>
          <input
            type="checkbox"
            checked={settings?.enabled !== false}
            disabled={!writable}
            onChange={(event) => { write('enabled', event.target.checked) }}
          />
          <span className={css.rowText}>
            <span className={css.titleText}>{t('master')}</span>
            <span className={css.desc}>{t('masterDesc')}</span>
          </span>
        </label>
        <label className={css.row}>
          <input
            type="checkbox"
            checked={settings?.quietCurrent === true}
            disabled={!writable}
            onChange={(event) => { write('quietCurrent', event.target.checked) }}
          />
          <span className={css.rowText}>
            <span className={css.titleText}>{t('quietCurrent')}</span>
            <span className={css.desc}>{t('quietCurrentDesc')}</span>
          </span>
        </label>
        <div className={css.tabs} role="tablist" aria-label={t('title')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'main'}
            className={tab === 'main' ? `${css.tab} ${css.tabActive}` : css.tab}
            onClick={() => { setTab('main') }}
          >{t('tab.main')}</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'subagent'}
            className={tab === 'subagent' ? `${css.tab} ${css.tabActive}` : css.tab}
            onClick={() => { setTab('subagent') }}
          >{t('tab.subagent')}</button>
        </div>
        {tab === 'subagent' && (
          <label className={css.row}>
            <input
              type="checkbox"
              checked={settings?.ignoreSubagent === true}
              disabled={!writable}
              onChange={(event) => { write('ignoreSubagent', event.target.checked) }}
            />
            <span className={css.rowText}>
              <span className={css.titleText}>{t('ignoreSubagent')}</span>
              <span className={css.desc}>{t('ignoreSubagentDesc')}</span>
            </span>
          </label>
        )}
        {tab === 'subagent' && <p className={css.hint}>{t('subagentHint')}</p>}
        <div className={eventsDim ? `${css.events} ${css.eventsDisabled}` : css.events}>
          {rows.map(row => (
            <EventRow
              key={`${row.channel}-${row.kind}`}
              row={row}
              disabled={!writable}
              t={t}
              actions={actions}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
