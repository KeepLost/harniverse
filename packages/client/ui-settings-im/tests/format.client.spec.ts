import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatBotView, ChatPlatformField } from '@deepseek-ai/dsh-api-remotes/client'
import {
  botsOf, canConnect, connectValues, errorText, formatClock, formatRemaining, formatStamp, maskIdentity, statusText, statusTone, tally,
} from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as Parameters<typeof errorText>[0]

function bot(patch: Partial<ChatBotView> & Pick<ChatBotView, 'id'>): ChatBotView {
  return {
    platform: 'telegram',
    alias: patch.id,
    identity: { botId: '1', displayName: 'Bot' },
    values: {},
    secrets: {},
    enabled: true,
    state: 'online',
    settings: {},
    createdAt: 0,
    ...patch,
  }
}

describe('maskIdentity', () => {
  it('keeps the head and tail of a long platform id', () => {
    expect(maskIdentity('cli_aaf4a1b2c3dcdd')).toBe('cli_aaf4••••dcdd')
  })

  it('leaves an id that is short enough to read whole', () => {
    expect(maskIdentity('123456789')).toBe('123456789')
    expect(maskIdentity('cli_aaf4dcdd')).toBe('cli_aaf4dcdd')
  })
})

describe('time formatting', () => {
  const at = new Date(2026, 9, 7, 8, 5, 3).getTime()

  it('renders a local clock reading as HH:MM:SS', () => {
    expect(formatClock(at)).toBe('08:05:03')
  })

  it('renders a local stamp as YYYY-MM-DD HH:mm', () => {
    expect(formatStamp(at)).toBe('2026-10-07 08:05')
  })

  it('renders a remaining duration as mm:ss and floors at zero', () => {
    expect(formatRemaining(272_400)).toBe('04:33')
    expect(formatRemaining(61_000)).toBe('01:01')
    expect(formatRemaining(0)).toBe('00:00')
    expect(formatRemaining(-5_000)).toBe('00:00')
    expect(formatRemaining(125 * 60_000)).toBe('125:00')
  })
})

describe('channel tally', () => {
  const bots = [
    bot({ id: 'a', state: 'online' }),
    bot({ id: 'b', state: 'error' }),
    bot({ id: 'c', platform: 'feishu', state: 'online' }),
    bot({ id: 'd', state: 'disabled', enabled: false }),
  ]

  it('selects the bots of one platform', () => {
    expect(botsOf(bots, 'telegram').map(entry => entry.id)).toEqual(['a', 'b', 'd'])
    expect(botsOf(bots, 'slack')).toEqual([])
  })

  it('counts online bots against all bots of the platform', () => {
    expect(tally(bots, 'telegram')).toEqual({ online: 1, total: 3 })
    expect(tally(bots, 'feishu')).toEqual({ online: 1, total: 1 })
    expect(tally(bots, 'slack')).toEqual({ online: 0, total: 0 })
  })
})

describe('status presentation', () => {
  it.each([
    ['online', '运行正常', 'ok'],
    ['starting', '连接中', 'pending'],
    ['reconnecting', '重连中', 'warn'],
    ['disabled', '已停用', 'off'],
  ] as const)('names %s in words and a tone', (state, text, tone) => {
    const entry = bot({ id: 'x', state })
    expect(statusText(t, entry)).toBe(text)
    expect(statusTone(entry.state)).toBe(tone)
  })

  it('appends the host message to an error state', () => {
    expect(statusText(t, bot({ id: 'x', state: 'error', message: 'token revoked' }))).toBe('异常：token revoked')
    expect(statusText(t, bot({ id: 'x', state: 'error' }))).toBe('异常')
    expect(statusTone('error')).toBe('error')
  })
})

describe('errorText', () => {
  it.each([
    ['invalid-credentials', '凭据无效，请检查后重试'],
    ['unreachable', '无法连接到平台，请检查网络或代理'],
    ['duplicate-bot', '该机器人已接入'],
    ['not-found', '机器人不存在，可能已被移除'],
    ['bridge-unavailable', '聊天桥暂不可用，请稍后重试'],
  ])('maps %s to its own sentence', (code, text) => {
    expect(errorText(t, { code, message: 'ignored host wording' })).toBe(text)
  })

  it('carries the host message for invalid input and unknown failures', () => {
    expect(errorText(t, { code: 'invalid-input', message: 'workspace must be absolute' }))
      .toBe('输入无效：workspace must be absolute')
    expect(errorText(t, { code: 'forbidden', message: 'operate capability required' }))
      .toBe('操作失败：operate capability required')
  })

  it('names a failed directory picker', () => {
    expect(errorText(t, { code: 'pick-failed', message: 'native capability off' }))
      .toBe('无法打开目录选择器：native capability off')
  })
})

describe('connect form values', () => {
  const fields: ChatPlatformField[] = [
    { key: 'token', label: 'Token', secret: true, required: true },
    { key: 'baseUrl', label: 'Address', secret: false, required: false },
    {
      key: 'site', label: 'Site', secret: false, required: false,
      options: [{ value: 'https://open.feishu.cn', label: 'Feishu' }, { value: 'https://open.larksuite.com', label: 'Lark' }],
    },
  ]

  it('trims typed values, drops blank optional ones, and defaults a choice to its first option', () => {
    expect(connectValues(fields, { token: '  123:abc \n', baseUrl: '   ' }))
      .toEqual({ token: '123:abc', site: 'https://open.feishu.cn' })
    expect(connectValues(fields, { token: 't', baseUrl: ' http://proxy ', site: 'https://open.larksuite.com' }))
      .toEqual({ token: 't', baseUrl: 'http://proxy', site: 'https://open.larksuite.com' })
  })

  it('allows connecting only when every required field has a value', () => {
    expect(canConnect(fields, {})).toBe(false)
    expect(canConnect(fields, { token: '   ' })).toBe(false)
    expect(canConnect(fields, { token: 'x' })).toBe(true)
    expect(canConnect([], {})).toBe(true)
  })
})
