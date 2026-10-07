// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatBotSettingsView, ChatBotView } from '@deepseek-ai/dsh-api-remotes/client'
import { zh } from '../src/client/locales.ts'
import { BotSettings, type BotSettingsProps } from '../src/client/BotSettings.tsx'

afterEach(cleanup)

const t = makeTranslate(zh) as BotSettingsProps['t']

const GROUPS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'max', name: '最大' }], defaultEffort: 'high' },
      },
    ],
  },
  { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }] },
]

function botWith(settings: ChatBotSettingsView): ChatBotView {
  return {
    id: 'bot-1', platform: 'telegram', alias: 'Helper', identity: { botId: '1', displayName: 'H' },
    values: {}, secrets: {}, enabled: true, state: 'online', settings, createdAt: 0,
  }
}

function mount(settings: ChatBotSettingsView = {}, patch: Partial<BotSettingsProps> = {}) {
  const calls = {
    setWorkspace: vi.fn(),
    pickWorkspace: vi.fn(),
    setModel: vi.fn(),
    setPreset: vi.fn(),
  }
  const props: BotSettingsProps = {
    bot: botWith(settings),
    workspaces: [{ path: '/work/a', title: 'Alpha' }, { path: '/work/b', title: 'Beta' }],
    models: { status: 'ready', groups: GROUPS },
    presets: { status: 'ready', options: [{ id: 'standard', name: 'Standard' }, { id: 'code' }] },
    busy: false,
    setWorkspace: calls.setWorkspace,
    setModel: calls.setModel,
    setPreset: calls.setPreset,
    t,
    ...patch,
  }
  const view = render(<BotSettings {...props} />)
  return { ...calls, view, rerender: (next: Partial<BotSettingsProps>) => { view.rerender(<BotSettings {...props} {...next} />) } }
}

const choose = (name: string): void => { fireEvent.click(screen.getByRole('button', { name })) }

describe('workspace row', () => {
  it('reads "follow default" when the bot has no workspace', () => {
    mount()
    const group = screen.getByRole('group', { name: zh['workspace.title'] })
    expect(within(group).getByText(zh['workspace.follow'])).toBeTruthy()
  })

  it('shows the configured workspace path', () => {
    mount({ workspace: '/work/a' })
    expect(screen.getByText('/work/a').tagName).toBe('CODE')
  })

  it('opens and closes the directory chooser', () => {
    mount()
    const toggle = screen.getByRole('button', { name: zh['workspace.choose'] })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText(zh['workspace.registered'])).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText(zh['workspace.registered'])).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByLabelText(zh['workspace.registered'])).toBeNull()
  })

  it('applies a registered workspace picked from the list', () => {
    const { setWorkspace } = mount()
    choose(zh['workspace.choose'])
    const select = screen.getByLabelText<HTMLSelectElement>(zh['workspace.registered'])
    expect([...select.options].map(option => option.text)).toEqual([zh['workspace.follow'], 'Alpha — /work/a', 'Beta — /work/b'])
    fireEvent.change(select, { target: { value: '/work/b' } })
    expect(setWorkspace).toHaveBeenCalledWith('/work/b')
  })

  it('returns to the host default from the list', () => {
    const { setWorkspace } = mount({ workspace: '/work/a' })
    choose(zh['workspace.choose'])
    const select = screen.getByLabelText<HTMLSelectElement>(zh['workspace.registered'])
    expect(select.value).toBe('/work/a')
    fireEvent.change(select, { target: { value: '' } })
    expect(setWorkspace).toHaveBeenCalledWith(null)
  })

  it('lists a configured path that is not a registered workspace', () => {
    mount({ workspace: '/elsewhere/project' })
    choose(zh['workspace.choose'])
    const select = screen.getByLabelText<HTMLSelectElement>(zh['workspace.registered'])
    expect(select.value).toBe('/elsewhere/project')
    expect([...select.options].map(option => option.text)).toContain('/elsewhere/project')
  })

  it('applies a typed absolute path, trimmed', () => {
    const { setWorkspace } = mount()
    choose(zh['workspace.choose'])
    const apply = screen.getByRole<HTMLButtonElement>('button', { name: zh['workspace.apply'] })
    expect(apply.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(zh['workspace.pathLabel']), { target: { value: '  /srv/app  ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['workspace.apply'] }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.apply'] }))
    expect(setWorkspace).toHaveBeenCalledWith('/srv/app')
  })

  it('offers the native picker only when the runtime has one', () => {
    const first = mount()
    choose(zh['workspace.choose'])
    expect(screen.queryByRole('button', { name: zh['workspace.browse'] })).toBeNull()
    first.view.unmount()
    const pickWorkspace = vi.fn()
    mount({}, { pickWorkspace })
    choose(zh['workspace.choose'])
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.browse'] }))
    expect(pickWorkspace).toHaveBeenCalledTimes(1)
  })
})

describe('model and thinking-effort rows', () => {
  const modelSelect = () => screen.getByLabelText<HTMLSelectElement>(zh['model.model'])
  const effortSelect = () => screen.getByLabelText<HTMLSelectElement>(zh['model.effort'])

  it('groups models by provider and defaults to following the host', () => {
    mount()
    expect(modelSelect().value).toBe('')
    const groups = [...modelSelect().querySelectorAll('optgroup')]
    expect(groups.map(group => group.label)).toEqual(['DeepSeek', 'OpenAI'])
    expect([...groups[0]!.querySelectorAll('option')].map(option => option.text)).toEqual(['DeepSeek Chat', 'DeepSeek Reasoner'])
    expect(modelSelect().options[0]!.text).toBe(zh['model.follow'])
  })

  it('holds the thinking effort until a model is chosen', () => {
    mount()
    expect(effortSelect().disabled).toBe(true)
    expect(screen.getByText(zh['model.effortNeedsModel'])).toBeTruthy()
  })

  it('ignores a change on the held effort select while no model is chosen', () => {
    const { setModel } = mount()
    fireEvent.change(effortSelect(), { target: { value: '' } })
    expect(setModel).not.toHaveBeenCalled()
  })

  it('chooses a model without carrying an old effort over', () => {
    const { setModel } = mount({ model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' } })
    const chat = [...modelSelect().options].find(option => option.text === 'DeepSeek Chat')!
    fireEvent.change(modelSelect(), { target: { value: chat.value } })
    expect(setModel).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('returns the model to the host default', () => {
    const { setModel } = mount({ model: { provider: 'deepseek', model: 'deepseek-chat' } })
    fireEvent.change(modelSelect(), { target: { value: '' } })
    expect(setModel).toHaveBeenCalledWith(null)
  })

  it('offers the efforts of the chosen model and applies one', () => {
    const { setModel } = mount({ model: { provider: 'deepseek', model: 'deepseek-reasoner' } })
    expect(effortSelect().disabled).toBe(false)
    expect([...effortSelect().options].map(option => option.text)).toEqual([zh['model.follow'], '高', '最大'])
    expect(effortSelect().value).toBe('')
    fireEvent.change(effortSelect(), { target: { value: 'max' } })
    expect(setModel).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' })
  })

  it('clears the effort back to the default while keeping the model', () => {
    const { setModel } = mount({ model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' } })
    expect(effortSelect().value).toBe('max')
    fireEvent.change(effortSelect(), { target: { value: '' } })
    expect(setModel).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })

  it('explains a model without selectable efforts', () => {
    mount({ model: { provider: 'openai', model: 'gpt' } })
    expect(effortSelect().disabled).toBe(true)
    expect(screen.getByText(zh['model.effortUnsupported'])).toBeTruthy()
  })

  it('keeps a configured model that the catalog no longer lists', () => {
    mount({ model: { provider: 'acme', model: 'x1', reasoningEffort: 'turbo' } })
    expect(modelSelect().selectedOptions[0]!.text).toBe('acme / x1（不在当前列表）')
    expect(effortSelect().disabled).toBe(true)
    expect([...effortSelect().options].map(option => option.text)).toEqual([zh['model.follow'], 'turbo'])
    expect(effortSelect().value).toBe('turbo')
  })

  it('keeps a configured effort the model no longer declares', () => {
    mount({ model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'ultra' } })
    expect([...effortSelect().options].map(option => option.text)).toEqual([zh['model.follow'], '高', '最大', 'ultra'])
    expect(effortSelect().value).toBe('ultra')
  })

  it('ignores a change event that names no known model', () => {
    const { setModel } = mount({ model: { provider: 'acme', model: 'x1' } })
    const unlisted = modelSelect().value
    fireEvent.change(modelSelect(), { target: { value: unlisted } })
    expect(setModel).not.toHaveBeenCalled()
  })

  it('says so when the model catalog could not be read', () => {
    mount({}, { models: { status: 'error', groups: [] } })
    expect(screen.getByText(zh['model.catalogError'])).toBeTruthy()
  })
})

describe('agent preset row', () => {
  const presetSelect = () => screen.getByLabelText<HTMLSelectElement>(zh['preset.title'])

  it('lists the presets by display name and falls back to the id', () => {
    mount()
    expect([...presetSelect().options].map(option => option.text)).toEqual([zh['preset.follow'], 'Standard', 'code'])
    expect(presetSelect().value).toBe('')
  })

  it('applies a preset and returns to the host default', () => {
    const { setPreset } = mount({ agentProfile: 'standard' })
    expect(presetSelect().value).toBe('standard')
    fireEvent.change(presetSelect(), { target: { value: 'code' } })
    expect(setPreset).toHaveBeenLastCalledWith('code')
    fireEvent.change(presetSelect(), { target: { value: '' } })
    expect(setPreset).toHaveBeenLastCalledWith(null)
  })

  it('keeps a configured preset that the roster no longer lists', () => {
    mount({ agentProfile: 'retired' })
    expect(presetSelect().selectedOptions[0]!.text).toBe('retired（不在当前列表）')
  })

  it('says so when the preset roster could not be read', () => {
    mount({}, { presets: { status: 'error', options: [] } })
    expect(screen.getByText(zh['preset.catalogError'])).toBeTruthy()
  })
})

describe('while an update is in flight', () => {
  it('disables every control', () => {
    mount({ workspace: '/work/a', model: { provider: 'deepseek', model: 'deepseek-reasoner' } }, { busy: true, pickWorkspace: vi.fn() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['workspace.choose'] }).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>(zh['model.model']).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>(zh['model.effort']).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>(zh['preset.title']).disabled).toBe(true)
  })

  it('disables the chooser controls too', () => {
    const { rerender } = mount({}, { pickWorkspace: vi.fn() })
    choose(zh['workspace.choose'])
    rerender({ busy: true, pickWorkspace: vi.fn() })
    expect(screen.getByLabelText<HTMLSelectElement>(zh['workspace.registered']).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(zh['workspace.pathLabel']).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['workspace.browse'] }).disabled).toBe(true)
  })
})
