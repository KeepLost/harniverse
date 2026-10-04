// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
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

/** Same-provider catalog above/below the search threshold (four entries). */
function modelGroups(count: number): ModelDirectoryState['groups'] {
  const group = state().groups[0]!
  return [{ ...group, models: [
    ...group.models,
    ...Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
      id: `model-${index + 2}`, name: `Model ${index + 2}`,
    })),
  ].slice(0, count) }]
}

const scrollIntoView = vi.fn()
beforeEach(() => {
  scrollIntoView.mockClear()
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
})

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect keyboard walk', () => {
  it('↑↓ walk the rows of the shown pane, wrapping, and stay open', () => {
    render(<ModelSelect locked={false} available
      directory={createSnapshotStore(state({ groups: modelGroups(4) }))}
      load={vi.fn()} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    const cells = screen.getAllByRole('menuitem')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cells[1])
    fireEvent.keyDown(cells[1]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(cells[0])
    fireEvent.keyDown(cells[0]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(cells.at(-1))
    expect(screen.getByRole('menu', { name: '模型与推理等级' })).toBeTruthy()
  })

  it('Escape backs out of a drilled pane first, then closes', () => {
    render(<ModelSelect locked={false} available
      directory={createSnapshotStore(state({ groups: modelGroups(4) }))}
      load={vi.fn()} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.length).toBeGreaterThan(0)
    fireEvent.keyDown(rows[0]!, { key: 'Escape' })
    expect(screen.getByRole('menu', { name: '模型与推理等级' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /模型/ }), { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: '模型与推理等级' })).toBeNull()
  })

  it('omits search for a small catalog', () => {
    render(<ModelSelect locked={false} available
      directory={createSnapshotStore(state({ groups: modelGroups(4) }))}
      load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4)
  })
})

describe('ModelSelect search', () => {
  it('clears search when reopening the model list', () => {
    render(<ModelSelect locked={false} available
      directory={createSnapshotStore(state({ groups: modelGroups(5) }))}
      load={vi.fn()} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const search = screen.getByRole('searchbox')
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'zzzz' } })
    fireEvent.click(trigger)
    expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const reopened = screen.getByRole('searchbox')
    expect(reopened.getAttribute('value')).toBe('')
    expect(document.activeElement).toBe(reopened)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
  })

  it('hides empty provider headings and announces empty states', () => {
    const directory = createSnapshotStore(state({ groups: [
      ...modelGroups(4),
      { id: 'other', name: 'Other', models: [{ id: 'gemini', name: 'Gemini Flash' }] },
      { id: 'empty', name: 'Empty Provider', models: [] },
    ] }))
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    expect(screen.queryByRole('group', { name: 'Empty Provider' })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzz' } })
    expect(screen.getByRole('status').textContent).toBe('没有匹配的模型。')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'GMFL  ' } })
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Gemini Flash'])
    act(() => { directory.set(state({ groups: [] })) })
    expect(screen.getByRole('status').textContent).toBe(zh['empty.models'])
  })

  it.each(['Enter', 'Tab'])('keeps typing focus while arrows wrap across groups and %s accepts the highlight', async (key) => {
    const select = vi.fn().mockResolvedValue(true)
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'beta' },
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }] },
        { id: 'other', name: 'Other', models: [
          { id: 'delta', name: 'Delta' }, { id: 'epsilon', name: 'Epsilon' }, { id: 'gamma', name: 'Gamma' },
        ] },
      ],
    }))
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const search = screen.getByRole('searchbox')
    expect(search).toBeInstanceOf(HTMLInputElement)
    expect(search.closest('[role="menu"]')).toBeNull()
    const [alpha, beta, delta, epsilon, gamma] = screen.getAllByRole('menuitemradio')
    expect(search.getAttribute('aria-activedescendant')).toBe(beta!.id)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toBe(delta!.id)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toBe(epsilon!.id)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toBe(gamma!.id)
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toBe(alpha!.id)
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(search.getAttribute('aria-activedescendant')).toBe(gamma!.id)
    expect(gamma!.hasAttribute('data-highlighted')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.instances.at(-1)).toBe(gamma)
    expect(fireEvent.keyDown(search, { key: 'ArrowLeft' })).toBe(true)
    expect(fireEvent.keyDown(search, { key: 'ArrowRight' })).toBe(true)
    fireEvent.keyDown(search, { key: 'ArrowDown', isComposing: true })
    expect(search.getAttribute('aria-activedescendant')).toBe(gamma!.id)
    fireEvent.change(search, { target: { value: 'alp' } })
    expect(search.getAttribute('aria-activedescendant')).toBe(screen.getByRole('menuitemradio', { name: 'Alpha' }).id)
    fireEvent.change(search, { target: { value: 'zzzz' } })
    expect(search.hasAttribute('aria-activedescendant')).toBe(false)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(select).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    const restored = screen.getAllByRole('menuitemradio')
    expect(search.getAttribute('aria-activedescendant')).toBe(restored[0]!.id)
    fireEvent.mouseMove(restored[4]!)
    expect(search.getAttribute('aria-activedescendant')).toBe(restored[4]!.id)
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key })
    expect(select).toHaveBeenCalledWith({ provider: 'other', model: 'gamma' })
    await waitFor(() => { expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull() })
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('filters model names fuzzily, hides empty groups, clears on reopening, and selects a result', async () => {
    const directory = createSnapshotStore(state({ groups: [
      ...modelGroups(4),
      { id: 'other', name: 'Other', models: [{ id: 'gemini', name: 'Gemini Flash' }] },
    ] }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const search = screen.getByRole('searchbox')
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: '  GMFL  ' } })
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Gemini Flash'])
    expect(screen.getByRole('searchbox')).toBe(search)
    expect(document.activeElement).toBe(search)
    expect(screen.queryByRole('group', { name: 'DeepSeek' })).toBeNull()
    expect(trigger.textContent).toContain('DeepSeek-V4-Flash')
    fireEvent.change(search, { target: { value: 'zzzz' } })
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('没有匹配的模型。')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(fireEvent.keyDown(search, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(search)
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(search.getAttribute('value')).toBe('')
    expect(document.activeElement).toBe(search)
    expect(screen.queryByRole('button', { name: '清除搜索' })).toBeNull()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
    fireEvent.change(search, { target: { value: 'gmfl' } })
    fireEvent.keyDown(search, { key: 'Escape' })
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    expect(screen.getByRole('searchbox').getAttribute('value')).toBe('')
    const reopened = screen.getByRole('searchbox')
    fireEvent.change(reopened, { target: { value: 'gmfl' } })
    const row = screen.getByRole('menuitemradio', { name: 'Gemini Flash' })
    expect(screen.getByRole('menu', { name: '模型' }).contains(row)).toBe(true)
    fireEvent.keyDown(reopened, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(reopened)
    expect(reopened.getAttribute('aria-activedescendant')).toBe(row.id)
    fireEvent.keyDown(reopened, { key: 'Tab' })
    await waitFor(() => { expect(screen.queryByRole('group', { name: '模型与推理等级' })).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'other', model: 'gemini' })
  })
})
