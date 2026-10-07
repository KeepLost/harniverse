// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { BotCard, type BotCardProps } from '../src/client/BotCard.tsx'
import type { ChatBotView } from '@deepseek-ai/dsh-api-remotes/client'
import { formatClock } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh) as BotCardProps['t']
const CHECKED = new Date(2026, 9, 7, 9, 41, 7).getTime()

const BOT: ChatBotView = {
  id: 'bot-1',
  platform: 'feishu',
  alias: '飞书助手',
  identity: { botId: 'cli_aaf4a1b2c3dcdd', displayName: 'DSH 助手' },
  values: { appId: 'cli_aaf4a1b2c3dcdd' },
  secrets: { appSecret: { configured: true, tail: 'x9z1' } },
  enabled: true,
  state: 'online',
  checkedAt: CHECKED,
  settings: {},
  createdAt: 1,
}

function faceDouble(withPicker = false) {
  return {
    ...withPicker ? { pickWorkspace: vi.fn(async () => {}) } : {},
    rename: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    setWorkspace: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setPreset: vi.fn(async () => {}),
  }
}

function mount(patch: Partial<Omit<BotCardProps, 'bot' | 'face'>> & { bot?: Partial<ChatBotView>; whole?: ChatBotView; picker?: boolean } = {}) {
  const { picker, bot, whole, ...rest } = patch
  const face = faceDouble(picker)
  const onToggle = vi.fn()
  const onAskRemove = vi.fn()
  const props: BotCardProps = {
    bot: whole ?? { ...BOT, ...bot },
    platformLabel: '飞书',
    expanded: false,
    busy: [],
    note: undefined,
    confirming: false,
    workspaces: [{ path: '/work/a', title: 'Alpha' }],
    models: { status: 'ready', groups: [] },
    presets: { status: 'ready', options: [{ id: 'code' }] },
    face,
    onToggle,
    onAskRemove,
    t,
    ...rest,
  }
  const view = render(<ul><BotCard {...props} /></ul>)
  const rerender = (next: Partial<BotCardProps>): void => { view.rerender(<ul><BotCard {...props} {...next} /></ul>) }
  return { face, onToggle, onAskRemove, view, rerender }
}

describe('card header', () => {
  it('shows alias, masked identity with the bot name, status, and last check time', () => {
    mount()
    expect(screen.getByText('飞书助手')).toBeTruthy()
    expect(screen.getByText('cli_aaf4••••dcdd').tagName).toBe('CODE')
    expect(screen.getByText(/DSH 助手/)).toBeTruthy()
    expect(screen.getByText(zh['status.online'])).toBeTruthy()
    expect(screen.getByText(`最近检查 ${formatClock(CHECKED)}`)).toBeTruthy()
  })

  it('omits the bot name when it repeats the id', () => {
    mount({ bot: { identity: { botId: '123456', displayName: '123456' } } })
    expect(screen.getByLabelText(zh['card.identity']).textContent).toBe('123456')
  })

  it('omits the bot name when the platform reported none', () => {
    mount({ bot: { identity: { botId: '123456', displayName: '' } } })
    expect(screen.getByLabelText(zh['card.identity']).textContent).toBe('123456')
  })

  it('says when the bot has never been checked', () => {
    const { checkedAt: _checked, ...unchecked } = BOT
    mount({ whole: unchecked })
    expect(screen.getByText(zh['status.unchecked'])).toBeTruthy()
  })

  it.each([
    ['starting', undefined, '连接中'],
    ['reconnecting', undefined, '重连中'],
    ['error', 'token revoked', '异常：token revoked'],
    ['disabled', undefined, '已停用'],
  ] as const)('names the %s state in words', (state, message, text) => {
    mount({ bot: { state, ...message === undefined ? {} : { message } } })
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(text)
  })

  it('toggles from the chevron, which names the card and what it controls', () => {
    const { onToggle, rerender } = mount()
    const chevron = screen.getByRole('button', { name: '展开 飞书助手' })
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    expect(chevron.getAttribute('aria-controls')).toBeNull()
    fireEvent.click(chevron)
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender({ expanded: true })
    const open = screen.getByRole('button', { name: '收起 飞书助手' })
    expect(open.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(open.getAttribute('aria-controls')!)).toBeTruthy()
  })
})

describe('alias editing', () => {
  it('renames on Enter with the trimmed alias', () => {
    const { face } = mount()
    fireEvent.click(screen.getByRole('button', { name: '重命名 飞书助手' }))
    const input = screen.getByLabelText<HTMLInputElement>(zh['card.aliasLabel'])
    expect(input.value).toBe('飞书助手')
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '  值班机器人 ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(face.rename).toHaveBeenCalledWith('bot-1', '值班机器人')
    expect(screen.queryByLabelText(zh['card.aliasLabel'])).toBeNull()
    expect(screen.getByRole('button', { name: '重命名 飞书助手' })).toBeTruthy()
  })

  it('renames from the save button', () => {
    const { face } = mount()
    fireEvent.click(screen.getByRole('button', { name: '重命名 飞书助手' }))
    fireEvent.change(screen.getByLabelText(zh['card.aliasLabel']), { target: { value: 'Ops' } })
    fireEvent.click(screen.getByRole('button', { name: zh['card.aliasSave'] }))
    expect(face.rename).toHaveBeenCalledWith('bot-1', 'Ops')
  })

  it('cancels on Escape without letting the key reach the settings panel', () => {
    const { face } = mount()
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    fireEvent.click(screen.getByRole('button', { name: '重命名 飞书助手' }))
    const input = screen.getByLabelText(zh['card.aliasLabel'])
    fireEvent.change(input, { target: { value: 'Ops' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    document.removeEventListener('keydown', outer)
    expect(outer).not.toHaveBeenCalled()
    expect(face.rename).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(zh['card.aliasLabel'])).toBeNull()
  })

  it('cancels from the cancel button', () => {
    const { face } = mount()
    fireEvent.click(screen.getByRole('button', { name: '重命名 飞书助手' }))
    fireEvent.click(screen.getByRole('button', { name: zh['card.aliasCancel'] }))
    expect(face.rename).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(zh['card.aliasLabel'])).toBeNull()
  })

  it('ignores other keys, and a blank or unchanged alias', () => {
    const { face } = mount()
    fireEvent.click(screen.getByRole('button', { name: '重命名 飞书助手' }))
    const input = screen.getByLabelText(zh['card.aliasLabel'])
    fireEvent.keyDown(input, { key: 'a' })
    expect(screen.getByLabelText(zh['card.aliasLabel'])).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(face.rename).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重命名 飞书助手' }))
    fireEvent.change(screen.getByLabelText(zh['card.aliasLabel']), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByLabelText(zh['card.aliasLabel']), { key: 'Enter' })
    expect(face.rename).not.toHaveBeenCalled()
  })
})

describe('expanded body', () => {
  it('stays out of the document while collapsed', () => {
    mount()
    expect(screen.queryByRole('group', { name: zh['workspace.title'] })).toBeNull()
    expect(screen.queryByRole('button', { name: zh['action.check'] })).toBeNull()
  })

  it('threads the bot id through every setting change', () => {
    const { face } = mount({ expanded: true })
    fireEvent.change(screen.getByLabelText(zh['preset.title']), { target: { value: 'code' } })
    expect(face.setPreset).toHaveBeenCalledWith('bot-1', 'code')
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.choose'] }))
    fireEvent.change(screen.getByLabelText(zh['workspace.registered']), { target: { value: '/work/a' } })
    expect(face.setWorkspace).toHaveBeenCalledWith('bot-1', '/work/a')
    fireEvent.change(screen.getByLabelText(zh['model.model']), { target: { value: '' } })
    expect(face.setModel).toHaveBeenCalledWith('bot-1', null)
  })

  it('routes the model choice through the bot id', () => {
    const { face } = mount({
      expanded: true,
      models: { status: 'ready', groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }] },
    })
    const select = screen.getByLabelText<HTMLSelectElement>(zh['model.model'])
    fireEvent.change(select, { target: { value: select.options[1]!.value } })
    expect(face.setModel).toHaveBeenCalledWith('bot-1', { provider: 'deepseek', model: 'chat' })
  })

  it('offers the native directory picker only when the face has one', () => {
    const first = mount({ expanded: true })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.choose'] }))
    expect(screen.queryByRole('button', { name: zh['workspace.browse'] })).toBeNull()
    first.view.unmount()
    const second = mount({ expanded: true, picker: true })
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.choose'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.browse'] }))
    expect(second.face.pickWorkspace).toHaveBeenCalledWith('bot-1')
  })

  it('disables the settings while an update of this bot is in flight', () => {
    mount({ expanded: true, busy: ['update'] })
    expect(screen.getByLabelText<HTMLSelectElement>(zh['preset.title']).disabled).toBe(true)
  })
})

describe('actions', () => {
  it('checks the connection', () => {
    const { face } = mount({ expanded: true })
    fireEvent.click(screen.getByRole('button', { name: zh['action.check'] }))
    expect(face.check).toHaveBeenCalledWith('bot-1')
  })

  it('shows check progress and holds every action while an operation runs', () => {
    mount({ expanded: true, busy: ['check'], bot: { state: 'error' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['action.checking'] }).disabled).toBe(true)
    for (const name of [zh['action.retry'], zh['action.disable'], zh['action.remove']]) {
      expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true)
    }
  })

  it('offers a retry when the bot is not online, and shows its progress', () => {
    const { face, rerender } = mount({ expanded: true, bot: { state: 'error' } })
    fireEvent.click(screen.getByRole('button', { name: zh['action.retry'] }))
    expect(face.retry).toHaveBeenCalledWith('bot-1')
    rerender({ expanded: true, bot: { ...BOT, state: 'reconnecting' }, busy: ['retry'] })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['action.retrying'] }).disabled).toBe(true)
  })

  it.each(['online', 'disabled'] as const)('hides the retry while the bot is %s', (state) => {
    mount({ expanded: true, bot: { state, enabled: state === 'online' } })
    expect(screen.queryByRole('button', { name: zh['action.retry'] })).toBeNull()
  })

  it('disables a running bot and enables a stopped one', () => {
    const first = mount({ expanded: true })
    fireEvent.click(screen.getByRole('button', { name: zh['action.disable'] }))
    expect(first.face.setEnabled).toHaveBeenCalledWith('bot-1', false)
    first.view.unmount()
    const second = mount({ expanded: true, bot: { state: 'disabled', enabled: false } })
    fireEvent.click(screen.getByRole('button', { name: zh['action.enable'] }))
    expect(second.face.setEnabled).toHaveBeenCalledWith('bot-1', true)
  })

  it('asks before removing, then removes on confirmation', () => {
    const { face, onAskRemove, rerender } = mount({ expanded: true })
    fireEvent.click(screen.getByRole('button', { name: zh['action.remove'] }))
    expect(onAskRemove).toHaveBeenCalledWith(true)
    expect(face.remove).not.toHaveBeenCalled()
    rerender({ expanded: true, confirming: true })
    expect(screen.getByRole('alert').textContent).toBe('确定移除“飞书助手”？机器人会断开连接，已保存的凭据一并删除。')
    fireEvent.click(screen.getByRole('button', { name: zh['action.removeYes'] }))
    expect(face.remove).toHaveBeenCalledWith('bot-1')
  })

  it('withdraws the confirmation and starts on the safe choice', () => {
    const { onAskRemove } = mount({ expanded: true, confirming: true })
    const cancel = screen.getByRole('button', { name: zh['action.removeNo'] })
    expect(document.activeElement).toBe(cancel)
    fireEvent.click(cancel)
    expect(onAskRemove).toHaveBeenCalledWith(false)
  })

  it('shows removal progress and holds the confirmation buttons', () => {
    mount({ expanded: true, confirming: true, busy: ['remove'] })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['action.removing'] }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['action.removeNo'] }).disabled).toBe(true)
  })
})

describe('operation notes', () => {
  const card = () => screen.getByRole('listitem')

  it('reports a healthy check with its time', () => {
    mount({ note: { kind: 'check', ok: true, checkedAt: CHECKED } })
    expect(within(card()).getByText(`连接正常（${formatClock(CHECKED)}）`).getAttribute('role')).toBe('status')
  })

  it('reports a failed check as an alert with the platform message', () => {
    mount({ note: { kind: 'check', ok: false, message: 'timeout', checkedAt: CHECKED } })
    expect(screen.getByRole('alert').textContent).toBe('连接失败：timeout')
  })

  it('reports a failed check without a message', () => {
    mount({ note: { kind: 'check', ok: false, checkedAt: CHECKED } })
    expect(screen.getByRole('alert').textContent).toBe(zh['check.failBare'])
  })

  it('reports an operation failure as an alert', () => {
    mount({ note: { kind: 'error', error: { code: 'invalid-input', message: 'workspace must be absolute' } } })
    expect(screen.getByRole('alert').textContent).toBe('输入无效：workspace must be absolute')
  })

  it('shows notes while the card is collapsed', () => {
    mount({ expanded: false, note: { kind: 'error', error: { code: 'not-found', message: 'gone' } } })
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
