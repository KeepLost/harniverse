// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatBotView, ChatBotsSnapshot, ChatPlatformView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ImInjected } from '../src/client/controller.ts'
import { ImSection, type ImSectionProps } from '../src/client/ImSection.tsx'
import { zh } from '../src/client/locales.ts'
import { createImStore } from '../src/client/stores.ts'

beforeEach(() => { vi.useFakeTimers() })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const t = makeTranslate(zh) as ImSectionProps['t']

const TELEGRAM: ChatPlatformView = { platform: 'telegram', label: 'Telegram', fields: [] }
const FEISHU: ChatPlatformView = { platform: 'feishu', label: '飞书', fields: [] }

function bot(id: string, platform: string, patch: Partial<ChatBotView> = {}): ChatBotView {
  return {
    id, platform, alias: `Bot ${id}`, identity: { botId: id, displayName: '' }, values: {}, secrets: {},
    enabled: true, state: 'online', settings: {}, createdAt: 0, ...patch,
  }
}

function snapshot(patch: Partial<ChatBotsSnapshot> = {}): ChatBotsSnapshot {
  return { platforms: [TELEGRAM, FEISHU], bots: [], owners: [], bridge: 'running', ...patch }
}

function hookOf<T>(instance: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(selector: (state: T) => S): S {
    return selector(useSyncExternalStore(instance.subscribe, instance.getSnapshot))
  }
}

interface MountOptions {
  loaded?: ChatBotsSnapshot
  workspaces?: Array<{ workspaceId: string; path: string; title: string }>
  pick?: boolean
}

function mount(options: MountOptions = {}) {
  const instance = createImStore().create()
  if (options.loaded !== undefined) instance.actions.snapshotLoaded(options.loaded)
  const verb = () => vi.fn(async () => {})
  const face: ImInjected = {
    pollMs: 3000,
    refresh: verb(), loadCatalog: verb(), connect: verb(), rename: verb(), setEnabled: verb(), check: verb(), retry: verb(),
    remove: verb(), setWorkspace: verb(), setModel: verb(), setPreset: verb(), issueCode: verb(), unpair: verb(),
    ...options.pick ? { pickWorkspace: verb() } : {},
  }
  const workspaces = { items: options.workspaces ?? [] }
  const props = {
    ...face,
    t,
    useStore: hookOf(instance),
    actions: instance.actions,
    useWorkspaces: (selector: (state: typeof workspaces) => unknown) => selector(workspaces),
    close: vi.fn(),
  } as unknown as ImSectionProps
  const view = render(<ImSection {...props} />)
  return { instance, face, view }
}

describe('ImSection', () => {
  it('titles the section and introduces it', () => {
    mount({ loaded: snapshot() })
    expect(screen.getByRole('region', { name: zh.title })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: zh.title })).toBeTruthy()
    expect(screen.getByText(zh.intro)).toBeTruthy()
  })

  it('announces loading before the first snapshot lands', () => {
    mount()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('shows a failed first read with a retry', () => {
    const { instance, face } = mount()
    act(() => { instance.actions.snapshotFailed({ code: 'unavailable', message: 'offline' }) })
    expect(screen.getByRole('alert').textContent).toBe('无法读取机器人状态：offline')
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(face.refresh).toHaveBeenCalledTimes(2)
  })

  it('keeps the channels and flags a later failed read', () => {
    const { instance } = mount({ loaded: snapshot() })
    act(() => { instance.actions.snapshotFailed({ code: 'unavailable', message: 'offline' }) })
    expect(screen.getByRole('navigation')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('无法读取机器人状态：offline')
  })

  it('explains a host with no chat platform', () => {
    mount({ loaded: snapshot({ platforms: [] }) })
    expect(screen.getByText(zh.noPlatforms)).toBeTruthy()
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('lists the descriptor platforms and shows the first one by default', () => {
    mount({ loaded: snapshot({ bots: [bot('a', 'telegram'), bot('b', 'feishu', { state: 'error' }), bot('c', 'telegram')] }) })
    const nav = screen.getByRole('navigation', { name: zh['channels.aria'] })
    expect(within(nav).getByRole('button', { name: 'Telegram（2 个机器人）' })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: '飞书（1 个机器人）' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Telegram' })).toBeTruthy()
    expect(screen.getAllByRole('listitem').map(item => item.textContent).join()).toContain('Bot a')
    expect(screen.getByText('2 / 2 在线')).toBeTruthy()
  })

  it('switches channels through the store', () => {
    const { instance } = mount({ loaded: snapshot({ bots: [bot('a', 'telegram'), bot('b', 'feishu', { state: 'error' })] }) })
    fireEvent.click(screen.getByRole('button', { name: /飞书/ }))
    expect(instance.getSnapshot().selected).toBe('feishu')
    expect(screen.getByRole('heading', { name: '飞书' })).toBeTruthy()
    expect(screen.getByText('0 / 1 在线')).toBeTruthy()
    expect(screen.getByText('Bot b')).toBeTruthy()
    expect(screen.queryByText('Bot a')).toBeNull()
  })

  it('falls back to the first channel when the selected one disappears', () => {
    const { instance } = mount({ loaded: snapshot() })
    act(() => { instance.actions.select('slack') })
    expect(screen.getByRole('heading', { name: 'Telegram' })).toBeTruthy()
  })

  it('filters owners to the selected channel', () => {
    mount({ loaded: snapshot({ owners: [
      { key: 'telegram:1', platform: 'telegram', userId: '1', displayName: 'Alice', pairedAt: 0 },
      { key: 'feishu:2', platform: 'feishu', userId: '2', displayName: 'Bob', pairedAt: 0 },
    ] }) })
    expect(screen.getByText('Alice')).toBeTruthy()
    expect(screen.queryByText('Bob')).toBeNull()
  })

  it.each<[Partial<ChatBotsSnapshot>, string]>([
    [{ bridge: 'starting' }, zh['bridge.starting']],
    [{ bridge: 'stopped', bots: [bot('a', 'telegram')] }, zh['bridge.stopped']],
    [{ bridge: 'error', bridgeMessage: 'port in use' }, '聊天桥异常：port in use'],
    [{ bridge: 'error' }, zh['bridge.errorBare']],
  ])('warns about the chat bridge: %j', (patch, text) => {
    mount({ loaded: snapshot(patch) })
    expect(screen.getByText(text)).toBeTruthy()
  })

  it('says nothing about a running bridge', () => {
    mount({ loaded: snapshot() })
    expect(screen.queryByText(zh['bridge.stopped'])).toBeNull()
  })

  it('treats a stopped bridge with no bots as idle, since the host starts it with the first bot', () => {
    mount({ loaded: snapshot({ bridge: 'stopped' }) })
    expect(screen.queryByText(zh['bridge.stopped'])).toBeNull()
  })

  it('offers the registered workspaces to an expanded card', () => {
    mount({
      loaded: snapshot({ bots: [bot('a', 'telegram')] }),
      workspaces: [{ workspaceId: 'w1', path: '/work/a', title: 'Alpha' }],
    })
    fireEvent.click(screen.getByRole('button', { name: '展开 Bot a' }))
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.choose'] }))
    expect([...screen.getByLabelText<HTMLSelectElement>(zh['workspace.registered']).options].map(option => option.text))
      .toContain('Alpha — /work/a')
  })

  describe('polling', () => {
    it('reads now and then every 3 seconds, and loads the catalogs once', () => {
      const { face } = mount({ loaded: snapshot() })
      expect(face.refresh).toHaveBeenCalledTimes(1)
      expect(face.loadCatalog).toHaveBeenCalledTimes(1)
      act(() => { vi.advanceTimersByTime(3000) })
      expect(face.refresh).toHaveBeenCalledTimes(2)
      act(() => { vi.advanceTimersByTime(6000) })
      expect(face.refresh).toHaveBeenCalledTimes(4)
      expect(face.loadCatalog).toHaveBeenCalledTimes(1)
    })

    it('stops when the section unmounts', () => {
      const { face, view } = mount({ loaded: snapshot() })
      view.unmount()
      act(() => { vi.advanceTimersByTime(30_000) })
      expect(face.refresh).toHaveBeenCalledTimes(1)
    })
  })
})
