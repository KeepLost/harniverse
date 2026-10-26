// @vitest-environment jsdom
/**
 * The input-device picker over scripted enumeration and preview verbs: the
 * system-default row plus named inputs (positional fallback names), live
 * refresh on devicechange, disconnected-selection marking with preview
 * release, the live level meter, hidden-tab release, and failure guidance.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RecordingError, type DevicePreview } from '../src/client/audio.ts'
import type { MicrophoneDevice } from '../src/client/microphone-device.ts'
import { MicrophonePicker } from '../src/client/MicrophonePicker.tsx'
import type { MicrophonePickerProps } from '../src/client/MicrophonePicker.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en) as unknown as MicrophonePickerProps['t']

/** One enumerable input descriptor. */
function info(deviceId: string, label: string, options: { groupId?: string; kind?: string } = {}): MediaDeviceInfo {
  return { deviceId, label, groupId: options.groupId ?? 'g1', kind: options.kind ?? 'audioinput' } as unknown as MediaDeviceInfo
}

/** Stub navigator.mediaDevices with a mutable device list and a devicechange channel. */
function stubMediaDevices(initial: MediaDeviceInfo[]): { fire(): void; setInputs(next: MediaDeviceInfo[]): void } {
  let inputs = initial
  const listeners: (() => void)[] = []
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: async () => inputs,
      addEventListener: (name: string, listener: () => void) => {
        if (name === 'devicechange') listeners.push(listener)
      },
    },
  })
  return {
    fire: () => { for (const listener of listeners) listener() },
    setInputs: (next) => { inputs = next },
  }
}

/** Scripted preview factory capturing ended callbacks and disposals. */
function previewStub(level = 0.5, rejection?: () => never) {
  const ended: Array<() => void> = []
  const events: string[] = []
  const createDevicePreview = vi.fn(async (_deviceId: string, onEnded: () => void): Promise<DevicePreview> => {
    if (rejection) rejection()
    ended.push(onEnded)
    return {
      level: () => level,
      dispose: () => { events.push('dispose') },
    }
  })
  return { createDevicePreview, events, triggerEnded: () => { ended.splice(0).forEach((callback) => { callback() }) } }
}

/** Manual-resolve promise for scripting late settlements. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Stub navigator.mediaDevices with one scripted enumerateDevices body. */
function stubEnumerate(enumerateDevices: () => Promise<MediaDeviceInfo[]>): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices, addEventListener: () => {} },
  })
}

/** Mount the picker reading one mutable selection. */
function mount(selection: MicrophoneDevice, preview: ReturnType<typeof previewStub> | MicrophonePickerProps['createDevicePreview']) {
  let selected = selection
  const selectMicrophone = vi.fn()
  const createDevicePreview = typeof preview === 'function' ? preview : preview.createDevicePreview
  const base: MicrophonePickerProps = {
    t,
    useMicrophoneDevice: selector => selector(selected),
    selectMicrophone,
    createDevicePreview,
  }
  const view = render(<MicrophonePicker {...base} />)
  return {
    view,
    selectMicrophone,
    createDevicePreview,
    select: () => view.container.querySelector('select') as HTMLSelectElement,
    options: () => Array.from(view.container.querySelectorAll('option')).map(option => ({
      value: option.value,
      text: option.textContent ?? '',
      disabled: option.disabled,
    })),
    meter: () => view.container.querySelector('[role="img"]'),
    error: () => view.container.querySelector('[role="alert"]'),
    selectDevice: (next: MicrophoneDevice) => { selected = next; view.rerender(<MicrophonePicker {...base} />) },
  }
}

afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
})

describe('MicrophonePicker', () => {
  it('lists the system default and named inputs, naming unnamed ones positionally', async () => {
    stubMediaDevices([
      info('default', 'Default', { groupId: 'gA' }),
      info('mic-1', 'Blue Yeti', { groupId: 'gA' }),
      info('mic-2', '', { groupId: 'gB' }),
      info('cam-0', 'Camera', { groupId: 'gC', kind: 'videoinput' }),
    ])
    const picker = mount({ id: '', label: '' }, previewStub())
    await act(async () => {})
    expect(picker.options()).toEqual([
      { value: '', text: 'System default (Blue Yeti)', disabled: false },
      { value: 'mic-1', text: 'Blue Yeti', disabled: false },
      { value: 'mic-2', text: 'Microphone 2', disabled: false },
    ])
    expect(picker.select().value).toBe('')
  })

  it('falls back to the plain system row when no physical default resolves', async () => {
    stubMediaDevices([info('mic-1', 'Headset')])
    const picker = mount({ id: '', label: '' }, previewStub())
    await act(async () => {})
    expect(picker.options()[0]).toMatchObject({ value: '', text: 'System default microphone' })
  })

  it('writes the chosen device through selectMicrophone', async () => {
    stubMediaDevices([info('mic-1', 'Blue Yeti')])
    const picker = mount({ id: '', label: '' }, previewStub())
    await act(async () => {})
    await act(async () => { fireEvent.change(picker.select(), { target: { value: 'mic-1' } }) })
    expect(picker.selectMicrophone).toHaveBeenCalledWith({ id: 'mic-1', label: 'Blue Yeti' })
    await act(async () => { fireEvent.change(picker.select(), { target: { value: '' } }) })
    expect(picker.selectMicrophone).toHaveBeenCalledWith({ id: '', label: '' })
  })

  it('re-enumerates when devices change', async () => {
    const media = stubMediaDevices([info('mic-1', 'One')])
    const picker = mount({ id: '', label: '' }, previewStub())
    await act(async () => {})
    media.setInputs([info('mic-1', 'One'), info('mic-2', 'Two')])
    await act(async () => { media.fire() })
    expect(picker.options().map(option => option.text)).toEqual(['System default microphone', 'One', 'Two'])
  })

  it('keeps a disconnected selection listed but disabled, without opening it', async () => {
    stubMediaDevices([info('mic-1', 'One')])
    const picker = mount({ id: 'mic-9', label: 'Gone' }, previewStub())
    await act(async () => {})
    expect(picker.options()).toEqual([
      { value: '', text: 'System default microphone', disabled: false },
      { value: 'mic-9', text: 'Gone — disconnected', disabled: true },
      { value: 'mic-1', text: 'One', disabled: false },
    ])
    expect(picker.createDevicePreview).not.toHaveBeenCalled()
    expect(picker.meter()).toBeNull()
  })

  it('previews the selected device live and releases the preview on unmount', async () => {
    stubMediaDevices([info('mic-1', 'One')])
    const preview = previewStub(0.5)
    const picker = mount({ id: '', label: '' }, preview)
    await act(async () => {})
    expect(picker.createDevicePreview).toHaveBeenCalledWith('', expect.any(Function))
    const bars = Array.from((picker.meter() as HTMLElement).children)
    expect(bars).toHaveLength(8)
    expect(bars.map(bar => bar.getAttribute('data-active'))).toEqual([
      'true', 'true', 'true', 'true', 'false', 'false', 'false', 'false',
    ])
    picker.view.unmount()
    expect(preview.events).toEqual(['dispose'])
  })

  it('re-opens the preview after the opened device ends', async () => {
    stubMediaDevices([info('mic-1', 'One')])
    const preview = previewStub()
    const picker = mount({ id: 'mic-1', label: 'One' }, preview)
    await act(async () => {})
    expect(picker.createDevicePreview).toHaveBeenCalledTimes(1)
    await act(async () => { preview.triggerEnded() })
    expect(preview.events).toEqual(['dispose'])
    expect(picker.createDevicePreview).toHaveBeenCalledTimes(2)
  })

  it('releases the preview while the tab is hidden and resumes on return', async () => {
    stubMediaDevices([info('mic-1', 'One')])
    const preview = previewStub()
    const picker = mount({ id: '', label: '' }, preview)
    await act(async () => {})
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(preview.events).toEqual(['dispose'])
    expect(picker.meter()).toBeNull()
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(picker.createDevicePreview).toHaveBeenCalledTimes(2)
  })

  it('follows a device change to a new selection', async () => {
    stubMediaDevices([info('mic-1', 'One'), info('mic-2', 'Two')])
    const preview = previewStub()
    const picker = mount({ id: 'mic-1', label: 'One' }, preview)
    await act(async () => {})
    expect(picker.createDevicePreview).toHaveBeenNthCalledWith(1, 'mic-1', expect.any(Function))
    await act(async () => { picker.selectDevice({ id: 'mic-2', label: 'Two' }) })
    expect(preview.events).toEqual(['dispose'])
    expect(picker.createDevicePreview).toHaveBeenNthCalledWith(2, 'mic-2', expect.any(Function))
    expect(picker.select().value).toBe('mic-2')
  })

  it('reports enumeration failure when the browser offers no media devices', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    const picker = mount({ id: '', label: '' }, previewStub())
    await act(async () => {})
    expect(picker.error()?.textContent).toBe(en['settings.device.unsupported'])
    expect(picker.options()).toEqual([{ value: '', text: 'System default microphone', disabled: false }])
  })

  it('reports a denied preview as permission guidance', async () => {
    stubMediaDevices([info('mic-1', 'One')])
    const denied = (): never => { throw new RecordingError('denied') }
    const picker = mount({ id: '', label: '' }, previewStub(0, denied))
    await act(async () => {})
    expect(picker.error()?.textContent).toBe(en['mic.denied'])
  })

  it('names an unlabeled selected device from the remembered selection', async () => {
    stubMediaDevices([info('mic-1', '', { groupId: 'gB' })])
    const picker = mount({ id: 'mic-1', label: 'One' }, previewStub())
    await act(async () => {})
    expect(picker.options().map(option => option.text)).toEqual(['System default microphone', 'One'])
  })


  it('reports enumeration failures with the underlying message', async () => {
    stubEnumerate(async () => { throw new Error('boom') })
    const picker = mount({ id: '', label: '' }, previewStub())
    await act(async () => {})
    expect(picker.error()?.textContent).toBe(`${en['mic.failed']}boom`)
  })

  it('stringifies non-error enumeration failures', async () => {
    stubEnumerate(async () => { throw 'boom' })
    const picker = mount({ id: '', label: '' }, previewStub())
    await act(async () => {})
    expect(picker.error()?.textContent).toBe(`${en['mic.failed']}boom`)
  })

  it('reports preview failures without device-specific guidance as transcription failures', async () => {
    stubMediaDevices([info('mic-1', 'One')])
    const unexpected = (): never => { throw new RecordingError('no-data') }
    const picker = mount({ id: '', label: '' }, previewStub(0, unexpected))
    await act(async () => {})
    expect(picker.error()?.textContent).toBe(en['mic.failed'])
  })

  it('disposes a preview that resolves after teardown', async () => {
    const enumerate = deferred<MediaDeviceInfo[]>()
    stubEnumerate(() => enumerate.promise)
    const create = deferred<DevicePreview>()
    const events: string[] = []
    const picker = mount({ id: '', label: '' }, vi.fn(() => create.promise))
    await act(async () => { enumerate.resolve([info('mic-1', 'One')]) })
    picker.view.unmount()
    await act(async () => {
      create.resolve({ level: () => 0, dispose: () => { events.push('dispose') } })
    })
    expect(events).toEqual(['dispose'])
  })

  it('swallows a preview failure that lands after teardown', async () => {
    const enumerate = deferred<MediaDeviceInfo[]>()
    stubEnumerate(() => enumerate.promise)
    const create = deferred<DevicePreview>()
    const picker = mount({ id: '', label: '' }, vi.fn(() => create.promise))
    await act(async () => { enumerate.resolve([info('mic-1', 'One')]) })
    picker.view.unmount()
    await act(async () => { create.reject(new Error('late')) })
    expect(picker.meter()).toBeNull()
  })

  it('swallows an enumeration that settles after teardown', async () => {
    const enumerate = deferred<MediaDeviceInfo[]>()
    stubEnumerate(() => enumerate.promise)
    const preview = previewStub()
    const picker = mount({ id: '', label: '' }, preview)
    picker.view.unmount()
    await act(async () => { enumerate.resolve([info('mic-1', 'One')]) })
    expect(preview.createDevicePreview).not.toHaveBeenCalled()
  })

  it('writes no state for a failure landing after teardown', async () => {
    const enumerate = deferred<MediaDeviceInfo[]>()
    stubEnumerate(() => enumerate.promise)
    const preview = previewStub()
    const picker = mount({ id: '', label: '' }, preview)
    picker.view.unmount()
    await act(async () => { enumerate.reject(new Error('late')) })
    expect(preview.createDevicePreview).not.toHaveBeenCalled()
  })

  it('ignores a superseded enumeration result', async () => {
    const first = deferred<MediaDeviceInfo[]>()
    const second = deferred<MediaDeviceInfo[]>()
    const listeners: (() => void)[] = []
    let calls = 0
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: async () => { calls += 1; return calls === 1 ? first.promise : second.promise },
        addEventListener: (_name: string, listener: () => void) => { listeners.push(listener) },
      },
    })
    const fire = (): void => { for (const listener of listeners) listener() }
    const picker = mount({ id: '', label: '' }, previewStub())
    await act(async () => { fire() })
    await act(async () => { second.resolve([info('mic-2', 'Two')]) })
    await act(async () => { first.resolve([info('mic-1', 'One')]) })
    expect(picker.options().map(option => option.text)).toEqual(['System default microphone', 'Two'])
  })

  it('ignores a superseded enumeration failure', async () => {
    const first = deferred<MediaDeviceInfo[]>()
    const second = deferred<MediaDeviceInfo[]>()
    const listeners: (() => void)[] = []
    let calls = 0
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: async () => { calls += 1; return calls === 1 ? first.promise : second.promise },
        addEventListener: (_name: string, listener: () => void) => { listeners.push(listener) },
      },
    })
    const fire = (): void => { for (const listener of listeners) listener() }
    const picker = mount({ id: '', label: '' }, previewStub())
    await act(async () => { fire() })
    await act(async () => { second.resolve([info('mic-2', 'Two')]) })
    await act(async () => { first.reject(new Error('stale')) })
    expect(picker.error()).toBeNull()
  })

  it('ignores a device-end event that lands after teardown', async () => {
    stubMediaDevices([info('mic-1', 'One')])
    const preview = previewStub()
    const picker = mount({ id: '', label: '' }, preview)
    await act(async () => {})
    picker.view.unmount()
    await act(async () => { preview.triggerEnded() })
    expect(preview.createDevicePreview).toHaveBeenCalledTimes(1)
  })
})
