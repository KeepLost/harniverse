/**
 * One notification event row: title, description, the volume slider, the
 * sound selector pill (built-ins, mute, local file), and — when a local
 * audio reference is set — the file's name with replace and preview
 * actions. Plain data and callbacks only; the section owns every write.
 */

import { useEffect, useState } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { BUILTIN_SOUND_KEYS, soundFieldFor, volumeFieldFor } from '../sound-settings.ts'
import type { SoundChannel, SoundEventKind } from '../sound-settings.ts'
import type { SoundLocaleKey } from './locales.ts'
import css from './SoundSection.module.css'

/** One row's plain data, assembled by the section. */
export interface EventRowData {
  kind: SoundEventKind
  channel: SoundChannel
  title: string
  description: string
  /** Current sound value (built-in key, `none`, `local`, or `audio:<id>`). */
  sound: string
  /** Current volume (0–1). */
  volume: number
}

/** Actions one row drives; the section resolves fields and writes. */
export interface EventRowActions {
  /** Persist one sound value for the row's field. */
  setSound: (field: string, value: string) => void
  /** Persist one volume for the row's field. */
  setVolume: (field: string, volume: number) => void
  /** Preview one sound value at one volume. */
  preview: (value: string, volume: number) => void
  /** Ask the browser for one local audio file; undefined on cancel. */
  chooseFile: () => Promise<string | undefined>
  /** Resolve one `audio:<id>` reference's display name ('' when unresolvable). */
  audioName: (id: string) => Promise<string>
}

/** Translator carrying the section's dictionary. */
export type EventRowTranslate = (key: SoundLocaleKey, params?: Record<string, unknown>) => string

/** One row's props. */
export interface EventRowProps {
  row: EventRowData
  /** Whether controls accept input (scope ready and writable). */
  disabled: boolean
  /** Locale translator. */
  t: EventRowTranslate
  /** Row actions. */
  actions: EventRowActions
}

/** Menu item id of the local-file option. */
const LOCAL_ITEM = 'local'

/**
 * Render one event row.
 * @param props - the row's data, disabled flag, translator, and actions.
 * @returns the row element tree.
 */
export function EventRow({ row, disabled, t, actions }: EventRowProps) {
  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState<string | undefined>(undefined)
  const soundField = soundFieldFor(row.kind, row.channel)
  const volumeField = volumeFieldFor(row.kind, row.channel)
  const isAudioRef = row.sound.startsWith('audio:')

  useEffect(() => {
    let cancelled = false
    if (!isAudioRef) {
      setFileName(undefined)
      return () => { cancelled = true }
    }
    void actions.audioName(row.sound).then((name) => {
      if (!cancelled) setFileName(name === '' ? t('sound.unresolved') : name)
    })
    return () => { cancelled = true }
  }, [actions, isAudioRef, row.sound, t])

  /** Resolve the selector pill's display label for the current value. */
  const labelOf = (value: string): string => {
    if (value === 'none') return t('sound.none')
    if (value === 'local') return fileName ?? t('file.choose')
    if (value.startsWith('audio:')) return fileName ?? t('sound.local')
    if (value === 'ding' || value === 'chime' || value === 'bell' || value === 'complete' || value === 'success') {
      return t(`sound.${value}`)
    }
    return t('sound.none')
  }

  /** Menu selection: built-ins preview, the local item opens the picker. */
  const onSelect = (id: string): void => {
    setOpen(false)
    if (id !== LOCAL_ITEM) {
      actions.setSound(soundField, id)
      if (id !== 'none') actions.preview(id, row.volume)
      return
    }
    void actions.chooseFile().then((value) => {
      if (value === undefined) return
      actions.setSound(soundField, value)
      actions.preview(value, row.volume)
    })
  }

  const percent = Math.round(Math.min(Math.max(row.volume, 0), 1) * 100)

  return (
    <div className={css.event}>
      <div className={css.eventTop}>
        <span className={css.eventText}>
          <span className={css.titleText}>{row.title}</span>
          <span className={css.desc}>{row.description}</span>
        </span>
        <span className={css.volume}>
          <span className={css.volumeLabel}>{t('volume')}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={percent}
            disabled={disabled}
            aria-label={`${row.title} ${t('volume')}`}
            onChange={(event) => { actions.setVolume(volumeField, Number(event.currentTarget.value) / 100) }}
          />
          <output className={css.percent}>{t('volume.percent', { value: String(percent) })}</output>
        </span>
      </div>
      <div className={css.eventBottom}>
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={[
            ...BUILTIN_SOUND_KEYS.map(key => ({ id: key, label: t(`sound.${key}`) })),
            { id: 'none', label: t('sound.none') },
            { id: LOCAL_ITEM, label: t('sound.local') },
          ]}
          selectedId={isAudioRef || row.sound === 'local' ? LOCAL_ITEM : row.sound === '' ? 'none' : row.sound}
          onSelect={onSelect}
          align="start"
          portal
          anchor={(
            <button
              type="button"
              className={css.selector}
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={disabled}
              onClick={() => { setOpen(value => !value) }}
            >
              {labelOf(row.sound)}
              <IconChevronDownOutline14 className={css.chevron} />
            </button>
          )}
        />
        {(isAudioRef || row.sound === 'local') && (
          <span className={css.fileRow}>
            {isAudioRef && fileName !== undefined && (
              <span className={css.fileName} title={fileName}>{fileName}</span>
            )}
            {isAudioRef && fileName !== undefined && (
              <button
                type="button"
                className={css.fileButton}
                disabled={disabled}
                onClick={() => { actions.preview(row.sound, row.volume) }}
              >{t('file.play')}</button>
            )}
            <button
              type="button"
              className={css.fileButton}
              disabled={disabled}
              onClick={() => {
                void actions.chooseFile().then((value) => {
                  if (value === undefined) return
                  actions.setSound(soundField, value)
                  actions.preview(value, row.volume)
                })
              }}
            >{isAudioRef ? t('file.replace') : t('file.choose')}</button>
          </span>
        )}
      </div>
    </div>
  )
}
