// @vitest-environment jsdom
/**
 * The section's presentation behavior: header switches, the channel tab bar,
 * per-event sound selection with preview, the volume slider, the local-file
 * flow with name resolution, disabled and unavailable states, and write
 * failures — everything through plain props and stubbed actions.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { SoundSection } from '../src/client/SoundSection.tsx'
import type { SoundSectionProps } from '../src/client/SoundSection.tsx'
import { EventRow } from '../src/client/EventRow.tsx'
import { NavIcon } from '../src/client/NavIcon.tsx'
import css from '../src/client/SoundSection.module.css'
import { en, zh } from '../src/client/locales.ts'
import { defaultSoundSettings, soundFieldFor, volumeFieldFor } from '../src/sound-settings.ts'
import type { SoundSettings } from '../src/sound-settings.ts'

afterEach(cleanup)

type Translate = SoundSectionProps['t']

/** Click the checkbox inside the switch row labelled by one text node. */
function checkboxOf(text: string): HTMLInputElement {
  const label = screen.getByText(text).closest('label')
  expect(label).not.toBeNull()
  return (label as HTMLLabelElement).querySelector('input') as HTMLInputElement
}

/** Build a translator over one dictionary. */
function translatorOf(dictionary: typeof zh | typeof en): Translate {
  return ((key: keyof typeof zh, params?: Record<string, unknown>) => {
    let text: string = dictionary[key]
    for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
    return text
  }) as Translate
}

/** One mutable scope snapshot the tests shape per case. */
interface ScopeHarness {
  readonly getSnapshot: () => { status: 'ready' | 'loading' | 'unavailable'; value: SoundSettings | undefined; writable: boolean }
  readonly subscribe: (listener: () => void) => () => void
  notify: () => void
  state: { status: 'ready' | 'loading' | 'unavailable'; value: SoundSettings | undefined; writable: boolean }
}

function scopeHarness(overrides: Partial<SoundSettings> = {}, writable = true): ScopeHarness {
  const listeners: Array<() => void> = []
  const harness: ScopeHarness = {
    state: { status: 'ready', value: { ...defaultSoundSettings(), ...overrides }, writable },
    getSnapshot: () => harness.state,
    subscribe: (listener: () => void) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    notify: () => { for (const listener of [...listeners]) listener() },
  }
  return harness
}

/** Render the section with stubbed actions; returns the stubs for assertions. */
function renderSection(options: { scope?: ScopeHarness; t?: Translate } = {}) {
  const scope = options.scope ?? scopeHarness()
  const t = options.t ?? translatorOf(zh)
  const actions = {
    setField: vi.fn(() => Promise.resolve()),
    chooseFile: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)),
    audioName: vi.fn(async (value: string) => value.startsWith('audio:') ? 'bell.wav' : ''),
    preview: vi.fn(),
  }
  const props = {
    useSettings: bindSnapshotSelector(scope),
    t,
    ...actions,
  } as unknown as SoundSectionProps
  render(<SoundSection {...props} />)
  return { scope, actions, t }
}

describe('SoundSection header and tabs', () => {
  it('renders the title, intro, both switches, and the six main event rows', () => {
    const t = translatorOf(zh)
    renderSection({ t })
    expect(screen.getByText(zh.title)).toBeDefined()
    expect(screen.getByText(zh.intro)).toBeDefined()
    expect(checkboxOf(zh.master)).toBeDefined()
    expect(checkboxOf(zh.quietCurrent)).toBeDefined()
    for (const kind of ['completion', 'approval', 'question', 'plan-review', 'goal-blocked', 'failure'] as const) {
      expect(screen.getByText(zh[`event.${kind}` as keyof typeof zh])).toBeDefined()
    }
    expect(screen.queryByText(zh.ignoreSubagent)).toBeNull()
  })

  it('switches to the subagent tab with the ignore switch and its own rows', () => {
    const t = translatorOf(zh)
    renderSection({ t })
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.subagent'] }))
    expect(checkboxOf(zh.ignoreSubagent)).toBeDefined()
    expect(screen.getByText(zh.subagentHint)).toBeDefined()
    expect(screen.getAllByText(zh['event.completion'])).toHaveLength(1)
  })

  it('writes the master and quiet switches through the scope', () => {
    const { actions } = renderSection()
    fireEvent.click(checkboxOf(zh.master))
    fireEvent.click(checkboxOf(zh.quietCurrent))
    expect(actions.setField).toHaveBeenCalledWith('enabled', false)
    expect(actions.setField).toHaveBeenCalledWith('quietCurrent', true)
  })

  it('surfaces the unavailable notice while the scope is not ready', () => {
    const harness = scopeHarness()
    harness.state = { status: 'unavailable', value: undefined, writable: false }
    renderSection({ scope: harness })
    expect(screen.getByText(zh.unavailable)).toBeDefined()
    expect(screen.getByText(zh.readonly)).toBeDefined()
  })

  it('surfaces a failed write carrying a non-error reason', async () => {
    const harness = scopeHarness()
    const reason: unknown = 'denied'
    const actions = {
      /* oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error covers String(error). */
      setField: vi.fn((): Promise<void> => Promise.reject(reason)),
      chooseFile: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)),
      audioName: vi.fn(async () => ''),
      preview: vi.fn(),
    }
    const props = { useSettings: bindSnapshotSelector(harness), t: translatorOf(zh), ...actions } as unknown as SoundSectionProps
    render(<SoundSection {...props} />)
    await act(async () => { fireEvent.click(checkboxOf(zh.master)) })
    await waitFor(() => { expect(screen.getByText(zh.writeFailed.replace('{message}', 'denied'))).toBeDefined() })
  })

  it('surfaces a failed write carrying an Error object', async () => {
    const harness = scopeHarness()
    const actions = {
      setField: vi.fn((_field: string, value: unknown) => value === true ? Promise.reject(new Error('busy')) : Promise.resolve()),
      chooseFile: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)),
      audioName: vi.fn(async () => ''),
      preview: vi.fn(),
    }
    const props = { useSettings: bindSnapshotSelector(harness), t: translatorOf(zh), ...actions } as unknown as SoundSectionProps
    render(<SoundSection {...props} />)
    await act(async () => { fireEvent.click(checkboxOf(zh.quietCurrent)) })
    await waitFor(() => { expect(screen.getByText(zh.writeFailed.replace('{message}', 'busy'))).toBeDefined() })
  })

  it('drives one event row through the section: select, preview, and volume', async () => {
    const { actions } = renderSection()
    const pill = screen.getAllByRole('button', { name: zh['sound.chime'] })[0] as HTMLButtonElement
    await act(async () => { fireEvent.click(pill) })
    const option = await screen.findByRole('menuitem', { name: zh['sound.bell'] })
    await act(async () => { fireEvent.click(option) })
    expect(actions.setField).toHaveBeenCalledWith('completionSound', 'bell')
    expect(actions.preview).toHaveBeenCalledWith('bell', 1)
    const slider = screen.getAllByRole('slider')[0] as HTMLInputElement
    fireEvent.change(slider, { target: { value: '40' } })
    expect(actions.setField).toHaveBeenCalledWith('completionVolume', 0.4)
  })

  it('toggles ignore-subagent and returns to the main tab', async () => {
    renderSection()
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.subagent'] }))
    fireEvent.click(checkboxOf(zh.ignoreSubagent))
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.main'] }))
    expect(screen.queryByText(zh.subagentHint)).toBeNull()
  })

  it('dims the event rows while the master switch is off', () => {
    renderSection({ scope: scopeHarness({ enabled: false }) })
    expect(document.querySelector(`.${css.eventsDisabled}`)).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: zh['tab.subagent'] }))
  })
})

describe('NavIcon', () => {
  it('renders one glyph', () => {
    const { container } = render(<NavIcon />)
    expect(container.querySelector('svg')).not.toBeNull()
  })
})

describe('EventRow', () => {
  /** One row's plain props over the English dictionary. */
  function rowProps(overrides: Partial<Parameters<typeof EventRow>[0]['row']> = {}) {
    const t = translatorOf(en)
    return {
      row: {
        kind: 'completion' as const,
        channel: 'main' as const,
        title: t('event.completion'),
        description: t('event.completion.desc'),
        sound: 'chime',
        volume: 1,
        ...overrides,
      },
      disabled: false,
      t,
      actions: {
        setSound: vi.fn(),
        setVolume: vi.fn(),
        preview: vi.fn(),
        chooseFile: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)),
        audioName: vi.fn(async () => 'bell.wav'),
      },
    }
  }

  it('shows the selected built-in on the pill and previews on selection', async () => {
    const props = rowProps()
    render(<EventRow {...props} />)
    const pill = screen.getByRole('button', { name: en['sound.chime'] })
    await act(async () => { fireEvent.click(pill) })
    const option = await screen.findByRole('menuitem', { name: en['sound.ding'] })
    await act(async () => { fireEvent.click(option) })
    expect(props.actions.setSound).toHaveBeenCalledWith(soundFieldFor('completion', 'main'), 'ding')
    expect(props.actions.preview).toHaveBeenCalledWith('ding', 1)
  })

  it('selecting mute writes without previewing', async () => {
    const props = rowProps()
    render(<EventRow {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    const option = await screen.findByRole('menuitem', { name: en['sound.none'] })
    await act(async () => { fireEvent.click(option) })
    expect(props.actions.setSound).toHaveBeenCalledWith(soundFieldFor('completion', 'main'), 'none')
    expect(props.actions.preview).not.toHaveBeenCalled()
  })

  it('writes the volume slider as a 0–1 value', () => {
    const props = rowProps({ volume: 0.5 })
    render(<EventRow {...props} />)
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(slider.value).toBe('50')
    fireEvent.change(slider, { target: { value: '25' } })
    expect(props.actions.setVolume).toHaveBeenCalledWith(volumeFieldFor('completion', 'main'), 0.25)
    expect(screen.getByText(en['volume.percent'].replace('{value}', '50'))).toBeDefined()
  })

  it('opens the picker through the local option and keeps the value on cancel', async () => {
    const props = rowProps()
    render(<EventRow {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    const option = await screen.findByRole('menuitem', { name: en['sound.local'] })
    await act(async () => { fireEvent.click(option) })
    await waitFor(() => { expect(props.actions.chooseFile).toHaveBeenCalledTimes(1) })
    expect(props.actions.setSound).not.toHaveBeenCalled()
    props.actions.chooseFile = vi.fn(() => Promise.resolve('audio:a9'))
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    const again = await screen.findByRole('menuitem', { name: en['sound.local'] })
    await act(async () => { fireEvent.click(again) })
    await waitFor(() => { expect(props.actions.setSound).toHaveBeenCalledWith(soundFieldFor('completion', 'main'), 'audio:a9') })
    expect(props.actions.preview).toHaveBeenCalledWith('audio:a9', 1)
  })

  it('closes the menu without selecting when dismissed', async () => {
    const props = rowProps()
    render(<EventRow {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    await screen.findByRole('menuitem', { name: en['sound.ding'] })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('menuitem')).toBeNull() })
    expect(props.actions.setSound).not.toHaveBeenCalled()
  })

  it('resolves and labels a stored audio reference with replace and preview', async () => {
    const props = rowProps({ sound: 'audio:a1' })
    render(<EventRow {...props} />)
    await waitFor(() => { expect(screen.getAllByText('bell.wav').length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByRole('button', { name: en['file.play'] }))
    expect(props.actions.preview).toHaveBeenCalledWith('audio:a1', 1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['file.replace'] })) })
    await waitFor(() => { expect(props.actions.chooseFile).toHaveBeenCalledTimes(1) })
  })

  it('labels an unresolvable reference as not stored in this browser', async () => {
    const props = rowProps({ sound: 'audio:gone' })
    props.actions.audioName = vi.fn(async () => '')
    render(<EventRow {...props} />)
    await waitFor(() => { expect(screen.getAllByText(en['sound.unresolved']).length).toBeGreaterThan(0) })
  })

  it('offers the picker from a pending local value', async () => {
    const props = rowProps({ sound: 'local' })
    render(<EventRow {...props} />)
    const buttons = screen.getAllByRole('button', { name: en['file.choose'] })
    expect(buttons.length).toBeGreaterThan(0)
    props.actions.chooseFile = vi.fn(() => Promise.resolve('audio:a2'))
    await act(async () => { fireEvent.click(buttons[buttons.length - 1] as HTMLButtonElement) })
    await waitFor(() => { expect(props.actions.setSound).toHaveBeenCalledWith(soundFieldFor('completion', 'main'), 'audio:a2') })
  })

  it('drops a late filename resolution after unmount', async () => {
    const props = rowProps({ sound: 'audio:a1' })
    let release: (name: string) => void = () => { /* parked until the test releases */ }
    props.actions.audioName = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
    const { unmount } = render(<EventRow {...props} />)
    unmount()
    release('bell.wav')
    await act(async () => { await Promise.resolve() })
  })

  it('disables every control while the row is disabled', () => {
    const props = rowProps({ sound: 'audio:a1' })
    props.disabled = true
    render(<EventRow {...props} />)
    const disabledButtons = screen.getAllByRole('button').map(button => (button as HTMLButtonElement).disabled)
    expect(disabledButtons.every(Boolean)).toBe(true)
    const slider = screen.getByRole('slider')
    expect(slider.hasAttribute('disabled')).toBe(true)
  })
})
