// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { EffortButton } from '../src/client/EffortButton.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

const t: ComponentProps<typeof EffortButton>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

function mount(overrides: {
  state?: Partial<ModelDirectoryState>
  available?: boolean
  locked?: boolean
  select?: (selection: ModelSelection) => Promise<boolean>
} = {}) {
  const directory = createSnapshotStore<ModelDirectoryState>(state(overrides.state))
  const select = overrides.select ?? vi.fn(async (selection: ModelSelection) => {
    directory.set(state({ ...overrides.state, current: selection }))
    return true
  })
  const view = render(<EffortButton
    locked={overrides.locked ?? false}
    available={overrides.available ?? true}
    directory={directory}
    load={vi.fn()}
    select={select}
    t={t}
  />)
  return { directory, select, ...view }
}

describe('EffortButton', () => {
  it('renders nothing while the current model declares no effort levels', () => {
    const { container } = mount({
      state: {
        groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
        current: { provider: 'p', model: 'm' },
      },
    })

    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for an unavailable session', () => {
    const { container } = mount({ available: false })

    expect(container.innerHTML).toBe('')
  })

  it('announces the current level and submits a pick through the shared selection', async () => {
    const { select } = mount()

    const trigger = screen.getByRole('button', { name: '选择推理等级，当前 High' })
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择推理等级，当前 Max' })).toBeTruthy()
    })
  })

  it('offers the provider default only without a model default, and picking it drops the effort field', async () => {
    const select = vi.fn().mockResolvedValue(true)
    mount({
      state: {
        groups: [{
          id: 'p',
          name: 'P',
          models: [{ id: 'm', name: 'M', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }],
        }],
        current: { provider: 'p', model: 'm', reasoningEffort: 'high' },
      },
      select,
    })

    fireEvent.click(screen.getByRole('button', { name: '选择推理等级，当前 High' }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['Default', 'High'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Default' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'p', model: 'm' })
    })
  })

  it('re-picking the current level closes the menu without submitting', () => {
    const { select } = mount()

    fireEvent.click(screen.getByRole('button', { name: '选择推理等级，当前 High' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'High' }))
    expect(select).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('announces a rejected selection through the toast', async () => {
    const { directory } = mount({
      select: vi.fn(async () => {
        directory.set(state({ error: 'route refused' }))
        return false
      }),
    })

    fireEvent.click(screen.getByRole('button', { name: '选择推理等级，当前 High' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(screen.getByText('模型操作失败：route refused')).toBeTruthy()
    })
  })

  it('locks the trigger with the session lock', () => {
    mount({ locked: true })

    expect(screen.getByRole('button', { name: '选择推理等级，当前 High' })).toHaveProperty('disabled', true)
  })

  it('disables rows while a selection is in flight', () => {
    mount({ state: { status: 'selecting' } })

    fireEvent.click(screen.getByRole('button', { name: '选择推理等级，当前 High' }))
    for (const row of screen.getAllByRole('menuitemradio')) {
      expect(row).toHaveProperty('disabled', true)
    }
  })

  it('closes on Escape and on an outside press', () => {
    mount()

    const trigger = screen.getByRole('button', { name: '选择推理等级，当前 High' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('ignores keys that are not Escape and presses inside the menu', () => {
    mount()

    const trigger = screen.getByRole('button', { name: '选择推理等级，当前 High' })
    // Escape while closed is a no-op, as is any other key while open.
    fireEvent.keyDown(trigger, { key: 'Escape' })
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'a' })
    expect(screen.getByRole('menu')).toBeTruthy()

    // A press inside the root keeps the menu open; only outside closes it.
    fireEvent.mouseDown(screen.getAllByRole('menuitemradio').at(0) as HTMLElement)
    expect(screen.getByRole('menu')).toBeTruthy()

    // Clicking the trigger while open toggles back closed.
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('spells an effort id the directory does not name as itself', () => {
    mount({ state: { current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'ghost' } } })

    expect(screen.getByRole('button', { name: '选择推理等级，当前 ghost' })).toBeTruthy()
  })

  it('renders nothing before the host reports a current selection', () => {
    const { container } = mount({ state: { current: null } })

    expect(container.innerHTML).toBe('')
  })

  it('stays quiet when a rejected selection carries no error text', async () => {
    mount({ select: vi.fn(async () => false) })

    fireEvent.click(screen.getByRole('button', { name: '选择推理等级，当前 High' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  it('dismisses the toast once its hold elapses', async () => {
    vi.useFakeTimers()
    try {
      const { directory } = mount({
        select: vi.fn(async () => {
          directory.set(state({ error: 'route refused' }))
          return false
        }),
      })

      fireEvent.click(screen.getByRole('button', { name: '选择推理等级，当前 High' }))
      fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
      await act(async () => {})
      expect(screen.getByRole('alert')).toBeTruthy()

      await act(async () => { vi.advanceTimersByTime(4000) })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
