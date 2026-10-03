// @vitest-environment jsdom
/**
 * The Voice input settings section over a scripted settings scope and speech
 * face: field writes route through `set`/`unset` (empty clears), the API key
 * input stays write-only, and the prepare control reports the settled status.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { VoiceSettingsSection } from '../src/client/VoiceSettingsSection.tsx'
import type { VoiceSettingsInjected, VoiceSettingsSectionProps, VoiceSection } from '../src/client/VoiceSettingsSection.tsx'
import { en } from '../src/client/locales.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

const t: VoiceSettingsSectionProps['t'] = makeTranslate(en)

/** Concrete scope snapshot for the scripted mirror. */
interface ScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: VoiceSection | undefined
  user: unknown
  writable: boolean
}

/** Prepare answer the scripted speech face holds until called. */
type PrepareAnswer = Awaited<ReturnType<VoiceSettingsInjected['api']['speech']['prepare']>>

function scopeFixture(section: VoiceSection = {}, options: { user?: Record<string, unknown> } = {}) {
  const writes: { field: string; value: unknown }[] = []
  const clears: string[] = []
  const snapshot: ScopeSnapshot = {
    status: 'ready',
    value: section,
    user: options.user,
    writable: true,
  }
  const scope: VoiceSettingsInjected['scope'] & {
    writes: { field: string; value: unknown }[]
    clears: string[]
  } = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => { writes.push({ field, value }) },
    unset: async (field) => { clears.push(field) },
    writes,
    clears,
  }
  return scope
}

function speechFixture() {
  const calls: number[] = []
  let answer: PrepareAnswer = { rpcId: 'r', result: { ok: true, value: { status: 'ready' } } }
  const api: VoiceSettingsInjected['api'] & { calls: number[] } = {
    speech: {
      prepare: async () => {
        calls.push(calls.length)
        return answer
      },
    },
    calls,
  }
  return { api, setAnswer: (value: PrepareAnswer): void => { answer = value } }
}

function mount(injected: VoiceSettingsInjected) {
  return render(<VoiceSettingsSection close={() => {}} t={t} scope={injected.scope} api={injected.api} />)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('VoiceSettingsSection fields', () => {
  it('renders the current selection and writes recognizer changes', () => {
    const scope = scopeFixture({ recognizer: 'sensevoice', language: 'zh' })
    const view = mount({ scope, api: speechFixture().api })
    const select = view.getByLabelText(t('settings.recognizer')) as HTMLSelectElement
    expect(select.value).toBe('sensevoice')
    fireEvent.change(select, { target: { value: 'openai-compatible' } })
    expect(scope.writes).toEqual([{ field: 'recognizer', value: 'openai-compatible' }])
  })

  it('clears a field when its input empties', () => {
    const scope = scopeFixture({ language: 'zh' })
    const view = mount({ scope, api: speechFixture().api })
    fireEvent.change(view.getByLabelText(t('settings.language')), { target: { value: '' } })
    expect(scope.clears).toEqual(['language'])
  })

  it('normalizes the push-to-talk key to lowercase', () => {
    const scope = scopeFixture()
    const view = mount({ scope, api: speechFixture().api })
    fireEvent.change(view.getByLabelText(t('settings.pushToTalkKey')), { target: { value: ' Shift ' } })
    expect(scope.writes).toEqual([{ field: 'pushToTalkKey', value: 'shift' }])
  })

  it('keeps the API key write-only and marks the configured state', () => {
    const scope = scopeFixture({}, { user: { apiKey: 'sk-live' } })
    const view = mount({ scope, api: speechFixture().api })
    const key = view.getByLabelText(t('settings.apiKey')) as HTMLInputElement
    expect(key.value).toBe('')
    expect(key.placeholder).toBe(t('settings.apiKey.set'))
    fireEvent.change(key, { target: { value: 'sk-new' } })
    expect(scope.writes).toEqual([{ field: 'apiKey', value: 'sk-new' }])
  })
})

describe('VoiceSettingsSection preparation', () => {
  it('reports the ready observation after a successful prepare', async () => {
    const speech = speechFixture()
    speech.setAnswer({ rpcId: 'r', result: { ok: true, value: { status: 'ready' } } })
    const view = mount({ scope: scopeFixture(), api: speech.api })
    fireEvent.click(view.getByRole('button', { name: t('settings.prepare') }))
    await vi.waitFor(() => { expect(view.getByText(t('settings.prepare.ready'))).toBeTruthy() })
    expect(speech.api.calls).toHaveLength(1)
  })

  it('reports failure detail and stays writable', async () => {
    const speech = speechFixture()
    speech.setAnswer({ rpcId: 'r', result: { ok: true, value: { status: 'failed', detail: 'sha mismatch' } } })
    const view = mount({ scope: scopeFixture(), api: speech.api })
    fireEvent.click(view.getByRole('button', { name: t('settings.prepare') }))
    await vi.waitFor(() => { expect(view.getByText(`${t('settings.prepare.failed')}sha mismatch`)).toBeTruthy() })
  })

  it('surfaces a refused prepare through its wire message', async () => {
    const speech = speechFixture()
    speech.setAnswer({ rpcId: 'r', result: { ok: false, error: { code: 'speech-unavailable', message: 'voice input is disabled' } } })
    const view = mount({ scope: scopeFixture(), api: speech.api })
    fireEvent.click(view.getByRole('button', { name: t('settings.prepare') }))
    await vi.waitFor(() => { expect(view.getByText(`${t('settings.prepare.failed')}voice input is disabled`)).toBeTruthy() })
  })

  it('reports a transport rejection of prepare as its detail', async () => {
    const api: VoiceSettingsInjected['api'] = {
      speech: {
        prepare: () => Promise.reject(new Error('carrier dropped')),
      },
    }
    const view = mount({ scope: scopeFixture(), api })
    fireEvent.click(view.getByRole('button', { name: t('settings.prepare') }))
    await vi.waitFor(() => { expect(view.getByText(`${t('settings.prepare.failed')}carrier dropped`)).toBeTruthy() })
  })

  it('writes the local model variant selection', () => {
    const scope = scopeFixture({ modelVariant: 'int8' })
    const view = mount({ scope, api: speechFixture().api })
    const select = view.getByLabelText(t('settings.modelVariant')) as HTMLSelectElement
    expect(select.value).toBe('int8')
    fireEvent.change(select, { target: { value: 'fp32' } })
    expect(scope.writes).toEqual([{ field: 'modelVariant', value: 'fp32' }])
  })
})

describe('VoiceSettingsSection reactivity', () => {
  it('re-renders through the scope subscription when the section changes', async () => {
    const listeners: (() => void)[] = []
    const scope = scopeFixture({ recognizer: 'off' })
    const snapshot: ScopeSnapshot = { status: 'ready', value: { recognizer: 'off' }, user: undefined, writable: true }
    scope.getSnapshot = () => snapshot
    scope.subscribe = (listener: () => void) => {
      listeners.push(listener)
      return () => {}
    }
    const view = mount({ scope, api: speechFixture().api })
    expect((view.getByLabelText(t('settings.recognizer')) as HTMLSelectElement).value).toBe('off')
    snapshot.value = { recognizer: 'sensevoice', language: 'zh' }
    act(() => { for (const listener of listeners) listener() })
    expect((view.getByLabelText(t('settings.recognizer')) as HTMLSelectElement).value).toBe('sensevoice')
  })

  it('renders the empty section while no value resolved yet', () => {
    const scope = scopeFixture()
    scope.getSnapshot = () => ({ status: 'ready', value: undefined, user: undefined, writable: true })
    const view = mount({ scope, api: speechFixture().api })
    expect((view.getByLabelText(t('settings.recognizer')) as HTMLSelectElement).value).toBe('off')
  })

  it('ignores a second prepare click while one is in flight', async () => {
    const speech = speechFixture()
    let release: (() => void) | undefined
    speech.api.speech.prepare = () => new Promise((resolve) => { release = () => { resolve({ rpcId: 'r', result: { ok: true, value: { status: 'ready' } } }) } })
    const view = mount({ scope: scopeFixture(), api: speech.api })
    const button = view.getByRole('button', { name: t('settings.prepare') })
    fireEvent.click(button)
    await vi.waitFor(() => { expect(view.getAllByText(t('settings.preparing')).length).toBeGreaterThan(0) })
    fireEvent.click(button)
    release?.()
    await vi.waitFor(() => { expect(view.getByText(t('settings.prepare.ready'))).toBeTruthy() })
  })

  it('stringifies a non-Error prepare rejection into the detail', async () => {
    const api: VoiceSettingsInjected['api'] = {
      speech: {
        // oxlint-disable-next-line prefer-promise-reject-errors -- the string rejection is the case under test
        prepare: () => Promise.reject('carrier dropped'),
      },
    }
    const view = mount({ scope: scopeFixture(), api })
    fireEvent.click(view.getByRole('button', { name: t('settings.prepare') }))
    await vi.waitFor(() => { expect(view.getByText(`${t('settings.prepare.failed')}carrier dropped`)).toBeTruthy() })
  })

  it('clears the push-to-talk key when only whitespace was entered', () => {
    const scope = scopeFixture({ pushToTalkKey: 'shift' })
    const view = mount({ scope, api: speechFixture().api })
    fireEvent.change(view.getByLabelText(t('settings.pushToTalkKey')), { target: { value: '   ' } })
    expect(scope.clears).toEqual(['pushToTalkKey'])
  })

  it('renders the unprepared observation and a detail-less failure', async () => {
    const unprepared = speechFixture()
    unprepared.setAnswer({ rpcId: 'r', result: { ok: true, value: { status: 'unprepared' } } })
    const view = mount({ scope: scopeFixture(), api: unprepared.api })
    fireEvent.click(view.getByRole('button', { name: t('settings.prepare') }))
    await vi.waitFor(() => { expect(view.getByText(t('settings.prepare.unprepared'))).toBeTruthy() })
    cleanup()

    const bare = speechFixture()
    bare.setAnswer({ rpcId: 'r', result: { ok: true, value: { status: 'failed' } } })
    const second = mount({ scope: scopeFixture(), api: bare.api })
    fireEvent.click(second.getByRole('button', { name: t('settings.prepare') }))
    await vi.waitFor(() => { expect(second.container.textContent).toContain(t('settings.prepare.failed').trim()) })
  })
})
