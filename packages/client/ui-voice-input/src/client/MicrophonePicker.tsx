/**
 * The input-device picker for the Voice input settings section: enumerates
 * audio inputs (the system-default row first), keeps the list live through
 * `devicechange`, marks a disconnected selection, and previews the selected
 * device's live level while the section is visible. Device ids are
 * browser-instance facts, so selection writes the browser-local microphone
 * store — never the speech settings namespace.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Select } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { RecordingError, type DevicePreview } from './audio.ts'
import type { MicrophoneDevice } from './microphone-device.ts'
import { NS } from './locales.ts'
import css from './MicrophonePicker.module.css'

/** One selectable input row; `unavailable` marks a disconnected selection. */
interface DeviceChoice extends MicrophoneDevice {
  unavailable?: boolean
}

/** Level-meter bar count. */
const LEVEL_BARS = 8

/** Live level bars drawn over one preview tap, without React state. */
function LevelMeter({ preview, label }: { preview: DevicePreview; label: string }): ReactElement {
  const meter = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const bars = Array.from((meter.current as HTMLSpanElement).children)
    let frame = 0
    const draw = (): void => {
      const count = Math.round(Math.max(0, Math.min(1, preview.level())) * bars.length)
      for (const [index, bar] of bars.entries()) bar.setAttribute('data-active', String(index < count))
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => { cancelAnimationFrame(frame) }
  }, [preview])
  return (
    <span ref={meter} className={css.levelMeter} role="img" aria-label={label}>
      {Array.from({ length: LEVEL_BARS }, (_, index) => <span key={index} />)}
    </span>
  )
}

/** Props: the settings section's injected device verbs and locale. */
export interface MicrophonePickerProps extends PropsLocale<typeof NS> {
  /** Selector hook over the persisted device selection. */
  useMicrophoneDevice: SnapshotSelectorHook<MicrophoneDevice>
  /** Persist one selection. */
  selectMicrophone: (device: MicrophoneDevice) => void
  /** Open one device (empty id = system default) for live level monitoring. */
  createDevicePreview: (deviceId: string, onEnded: () => void) => Promise<DevicePreview>
}

/** Render the input-device select with its live level preview. */
export function MicrophonePicker({ t, useMicrophoneDevice, selectMicrophone, createDevicePreview }: MicrophonePickerProps) {
  const selected = useMicrophoneDevice(value => value)
  const [devices, setDevices] = useState<DeviceChoice[]>([{ id: '', label: '' }])
  const [preview, setPreview] = useState<DevicePreview | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const media = (navigator as Partial<Navigator>).mediaDevices
    const lifetime = new AbortController()
    let monitor: DevicePreview | undefined
    let acquiring = false
    let enumeration = 0

    const release = (): void => {
      acquiring = false
      if (monitor !== undefined) {
        monitor.dispose()
        monitor = undefined
      }
      setPreview(undefined)
    }

    const fail = (failure: unknown): void => {
      if (lifetime.signal.aborted) return
      setError(failure instanceof RecordingError
        ? t(failure.kind === 'denied' ? 'mic.denied' : failure.kind === 'unsupported' ? 'settings.device.unsupported' : 'mic.failed')
        : `${t('mic.failed')}${failure instanceof Error ? failure.message : String(failure)}`)
    }

    const acquire = async (): Promise<void> => {
      acquiring = true
      try {
        const handle = await createDevicePreview(selected.id, () => {
          if (lifetime.signal.aborted) return
          release()
          void refresh()
        })
        if (lifetime.signal.aborted) {
          handle.dispose()
          return
        }
        monitor = handle
        setPreview(handle)
        setError(null)
      } catch (failure: unknown) {
        if (lifetime.signal.aborted) return
        acquiring = false
        fail(failure)
      }
    }

    const refresh = async (): Promise<void> => {
      const request = ++enumeration
      try {
        if (!media) throw new RecordingError('unsupported')
        // Before permission, browsers may hide device ids and labels; absence
        // then does not establish disconnection.
        const inputs = (await media.enumerateDevices()).filter(device => device.kind === 'audioinput')
        if (lifetime.signal.aborted || request !== enumeration) return
        const known = inputs.length === 0 || inputs.some(device => device.label !== '')
        const missing = selected.id !== '' && known && !inputs.some(device => device.deviceId === selected.id)
        const system = inputs.find(device => device.deviceId === 'default')
        const physical = system === undefined ? undefined : inputs.find(device =>
          device.groupId === system.groupId && device.deviceId !== 'default' && device.deviceId !== 'communications')
        const choices: DeviceChoice[] = [
          { id: '', label: physical?.label ?? system?.label ?? '' },
          ...inputs
            .filter(device => device.deviceId !== '' && device.deviceId !== 'default' && device.deviceId !== 'communications')
            .map(device => ({ id: device.deviceId, label: device.label })),
        ]
        setDevices((previous) => {
          if (selected.id === '' || choices.some(device => device.id === selected.id)) return choices
          const knownDevice = previous.find(device => device.id === selected.id)
          const index = Math.max(1, previous.findIndex(device => device.id === selected.id))
          return [
            ...choices.slice(0, index),
            { id: selected.id, label: knownDevice?.label ?? selected.label, unavailable: missing },
            ...choices.slice(index),
          ]
        })
        if (missing) release()
        else if (!document.hidden && monitor === undefined && !acquiring) await acquire()
      } catch (failure: unknown) {
        if (request === enumeration) fail(failure)
      }
    }

    const visibility = (): void => {
      if (document.hidden) release()
      else void refresh()
    }

    media?.addEventListener('devicechange', () => { void refresh() }, { signal: lifetime.signal })
    document.addEventListener('visibilitychange', visibility, { signal: lifetime.signal })
    void refresh()
    return () => {
      lifetime.abort()
      release()
    }
  }, [createDevicePreview, selected.id, selected.label, t])

  const choices = devices.filter(device => !device.unavailable || device.id === selected.id)
  const selectedUnavailable = choices.find(device => device.id === selected.id)?.unavailable ?? false

  const deviceName = (device: DeviceChoice, index: number): string => {
    if (device.id === '') {
      return device.label === '' ? t('settings.device.system') : t('settings.device.systemNamed', { name: device.label })
    }
    if (device.label !== '') return device.label
    if (device.id === selected.id && selected.label !== '') return selected.label
    return t('settings.device.unnamed', { number: String(index) })
  }

  return (
    <span className={css.device}>
      <Select
        className={css.select}
        value={selected.id}
        onChange={(event) => {
          const device = choices.find(item => item.id === event.target.value)
          /* v8 ignore next 1 -- browsers coerce an unknown select value to a listed option or '', so the miss arm is defensive only. */
          if (device !== undefined) selectMicrophone({ id: device.id, label: device.id === '' ? '' : device.label })
        }}
      >
        {choices.map((device, index) => (
          <option key={device.id} value={device.id} disabled={device.unavailable}>
            {deviceName(device, index)}
            {device.unavailable === true ? ` — ${t('settings.device.unavailable')}` : ''}
          </option>
        ))}
      </Select>
      {preview !== undefined && !selectedUnavailable && <LevelMeter preview={preview} label={t('settings.device.level')} />}
      {error !== null && <span className={css.error} role="alert">{error}</span>}
    </span>
  )
}
