// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ChannelList, type ChannelListProps } from '../src/client/ChannelList.tsx'
import { ChannelPanel, type ChannelPanelProps } from '../src/client/ChannelPanel.tsx'
import type { ChatBotView, ChatOwnerView, ChatPlatformView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ImInjected } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'
import { createImStore, type ImState } from '../src/client/stores.ts'

afterEach(cleanup)

const t = makeTranslate(zh) as ChannelPanelProps['t']

const TELEGRAM: ChatPlatformView = {
  platform: 'telegram',
  label: 'Telegram',
  fields: [{ key: 'token', label: '机器人 Token', secret: true, required: true }],
}
const FEISHU: ChatPlatformView = { platform: 'feishu', label: '飞书', fields: [] }
const SLACK: ChatPlatformView = { platform: 'slack', label: 'Slack', fields: [] }

function bot(id: string, patch: Partial<ChatBotView> = {}): ChatBotView {
  return {
    id, platform: 'telegram', alias: `Bot ${id}`, identity: { botId: `${id}00`, displayName: '' },
    values: {}, secrets: {}, enabled: true, state: 'online', settings: {}, createdAt: 0, ...patch,
  }
}

const OWNER: ChatOwnerView = { key: 'telegram:42', platform: 'telegram', userId: '42', displayName: 'Alice', pairedAt: 0 }

function faceDouble(): ImInjected {
  const verb = () => vi.fn(async () => {})
  return {
    pollMs: 3000,
    refresh: verb(), loadCatalog: verb(), connect: verb(), rename: verb(), setEnabled: verb(), check: verb(), retry: verb(),
    remove: verb(), setWorkspace: verb(), setModel: verb(), setPreset: verb(), issueCode: verb(), unpair: verb(),
  }
}

/** A real store instance preloaded through its own actions. */
function storeWith(setup: (actions: ReturnType<ReturnType<typeof createImStore>['create']>['actions']) => void = () => {}) {
  const instance = createImStore().create()
  setup(instance.actions)
  return instance
}

function mount(options: {
  platform?: ChatPlatformView
  bots?: ChatBotView[]
  owners?: ChatOwnerView[]
  setup?: Parameters<typeof storeWith>[0]
} = {}) {
  const instance = storeWith(options.setup)
  const face = faceDouble()
  const state: ImState = instance.getSnapshot()
  const props: ChannelPanelProps = {
    platform: options.platform ?? TELEGRAM,
    bots: options.bots ?? [],
    owners: options.owners ?? [],
    state,
    workspaces: [],
    face,
    actions: instance.actions,
    t,
  }
  const view = render(<ChannelPanel {...props} />)
  const rerender = () => { view.rerender(<ChannelPanel {...props} state={instance.getSnapshot()} />) }
  return { instance, face, view, rerender }
}

describe('ChannelList', () => {
  const props = (patch: Partial<ChannelListProps> = {}): ChannelListProps => ({
    platforms: [TELEGRAM, FEISHU],
    bots: [bot('a'), bot('b', { platform: 'feishu' }), bot('c')],
    selected: 'telegram',
    onSelect: vi.fn(),
    t,
    ...patch,
  })

  it('lists every platform of the descriptors with its bot count', () => {
    render(<ChannelList {...props()} />)
    const nav = screen.getByRole('navigation', { name: zh['channels.aria'] })
    expect(within(nav).getAllByRole('button')).toHaveLength(2)
    expect(within(nav).getByRole('button', { name: 'Telegram（2 个机器人）' }).getAttribute('aria-current')).toBe('true')
    expect(within(nav).getByRole('button', { name: '飞书（1 个机器人）' }).getAttribute('aria-current')).toBeNull()
  })

  it('selects a channel', () => {
    const onSelect = vi.fn()
    render(<ChannelList {...props({ onSelect })} />)
    fireEvent.click(screen.getByRole('button', { name: /飞书/ }))
    expect(onSelect).toHaveBeenCalledWith('feishu')
  })

  it('needs no client change for a platform it has never seen', () => {
    render(<ChannelList {...props({ platforms: [TELEGRAM, SLACK], selected: 'slack' })} />)
    expect(screen.getByRole('button', { name: /Slack/ }).getAttribute('aria-current')).toBe('true')
  })
})

describe('ChannelPanel header', () => {
  it('names the channel and tallies online bots', () => {
    mount({ bots: [bot('a'), bot('b', { state: 'error' }), bot('c', { state: 'disabled', enabled: false })] })
    expect(screen.getByRole('heading', { name: 'Telegram' })).toBeTruthy()
    expect(screen.getByText('1 / 3 在线')).toBeTruthy()
    expect(screen.getByRole('heading', { name: zh['list.heading'] })).toBeTruthy()
  })

  it('opens the connect form for the channel', () => {
    const { instance } = mount()
    expect(screen.queryByRole('form')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['connect.open'] }))
    expect(instance.getSnapshot().form).toMatchObject({ platform: 'telegram' })
  })

  it('renders the connect form from the descriptor while it is open for this channel', () => {
    const { rerender, instance } = mount({ setup: (actions) => { actions.openForm('telegram') } })
    expect(screen.getByRole('form', { name: '接入 Telegram 机器人' })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['connect.open'] }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('机器人 Token'), { target: { value: '123:abc' } })
    fireEvent.change(screen.getByLabelText(zh['form.alias']), { target: { value: 'Work' } })
    rerender()
    expect(instance.getSnapshot().form).toMatchObject({ values: { token: '123:abc' }, alias: 'Work' })
  })

  it('connects with the typed values through the face and cancels through the store', () => {
    const { face, instance } = mount({ setup: (actions) => {
      actions.openForm('telegram')
      actions.setFormValue('token', ' 123:abc ')
      actions.setFormAlias('Work')
    } })
    fireEvent.click(screen.getByRole('button', { name: zh['form.submit'] }))
    expect(face.connect).toHaveBeenCalledWith('telegram', 'Work', { token: '123:abc' })
    fireEvent.click(screen.getByRole('button', { name: zh['form.cancel'] }))
    expect(instance.getSnapshot().form).toBeNull()
  })

  it('hides a form that was opened for another channel', () => {
    mount({ setup: (actions) => { actions.openForm('feishu') } })
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['connect.open'] }).disabled).toBe(false)
  })
})

describe('ChannelPanel empty state', () => {
  it.each([
    [TELEGRAM, zh['empty.telegram']],
    [FEISHU, zh['empty.feishu']],
    [SLACK, zh['empty.generic']],
  ])('explains how to create a bot on %j', (platform, text) => {
    mount({ platform })
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('ChannelPanel cards', () => {
  it('renders one card per bot, collapsed by default', () => {
    mount({ bots: [bot('a'), bot('b')] })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText(zh['empty.telegram'])).toBeNull()
    expect(screen.getByRole('button', { name: '展开 Bot a' })).toBeTruthy()
  })

  it('expands and collapses a card through the store', () => {
    const { instance, rerender } = mount({ bots: [bot('a')] })
    fireEvent.click(screen.getByRole('button', { name: '展开 Bot a' }))
    expect(instance.getSnapshot().expanded).toEqual(['a'])
    rerender()
    fireEvent.click(screen.getByRole('button', { name: '收起 Bot a' }))
    expect(instance.getSnapshot().expanded).toEqual([])
  })

  it('threads pending operations, notes, and the removal confirmation to the right card only', () => {
    mount({
      bots: [bot('a'), bot('b')],
      setup: (actions) => {
        actions.setExpanded('a', true)
        actions.setExpanded('b', true)
        actions.setBusy('a:check', true)
        actions.setNote('b', { kind: 'error', error: { code: 'not-found', message: 'gone' } })
        actions.askRemove('b')
      },
    })
    const [first, second] = screen.getAllByRole('listitem')
    expect(within(first!).getByRole('button', { name: zh['action.checking'] })).toBeTruthy()
    expect(within(second!).getAllByRole('alert').map(node => node.textContent)).toContain('机器人不存在，可能已被移除')
    expect(within(first!).queryByRole('button', { name: zh['action.removeYes'] })).toBeNull()
    expect(within(second!).getByRole('button', { name: zh['action.removeYes'] })).toBeTruthy()
  })

  it('opens and withdraws the removal confirmation through the store', () => {
    const { instance, rerender } = mount({ bots: [bot('a')], setup: (actions) => { actions.setExpanded('a', true) } })
    fireEvent.click(screen.getByRole('button', { name: zh['action.remove'] }))
    expect(instance.getSnapshot().confirmRemove).toBe('a')
    rerender()
    fireEvent.click(screen.getByRole('button', { name: zh['action.removeNo'] }))
    expect(instance.getSnapshot().confirmRemove).toBeNull()
  })

  it('routes card verbs through the face', () => {
    const { face } = mount({ bots: [bot('a')], setup: (actions) => { actions.setExpanded('a', true) } })
    fireEvent.click(screen.getByRole('button', { name: zh['action.check'] }))
    expect(face.check).toHaveBeenCalledWith('a')
  })
})

describe('ChannelPanel owners', () => {
  it('shows the channel owners and the pairing code controls', () => {
    const { face } = mount({ owners: [OWNER] })
    expect(screen.getByRole('heading', { name: zh['owners.heading'] })).toBeTruthy()
    expect(screen.getByText('Alice')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['pair.generate'] }))
    expect(face.issueCode).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '解除 Alice 的绑定' }))
    expect(face.unpair).toHaveBeenCalledWith('telegram:42')
  })

  it('shows the issued code and an owner failure from the store', () => {
    mount({ setup: (actions) => {
      actions.codeIssued({ value: 'K7Q2', expiresAt: Date.now() + 60_000 })
      actions.ownerFailed({ code: 'bridge-unavailable', message: 'down' })
    } })
    expect(screen.getByText('/pair K7Q2')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('聊天桥暂不可用，请稍后重试')
  })
})
