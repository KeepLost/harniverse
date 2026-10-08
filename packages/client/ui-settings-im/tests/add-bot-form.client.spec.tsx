// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AddBotForm, type AddBotFormProps } from '../src/client/AddBotForm.tsx'
import type { ChatPlatformView } from '@deepseek-ai/dsh-api-remotes/client'
import { zh } from '../src/client/locales.ts'
import type { ConnectForm } from '../src/client/stores.ts'

afterEach(cleanup)

const t = makeTranslate(zh) as AddBotFormProps['t']

const TELEGRAM: ChatPlatformView = {
  platform: 'telegram',
  label: 'Telegram',
  fields: [
    { key: 'token', label: '机器人 Token', secret: true, required: true, placeholder: '123456789:AA…', hint: '在 @BotFather 创建机器人后获得' },
    { key: 'baseUrl', label: 'Bot API 地址', secret: false, required: false, hint: '留空使用官方地址' },
  ],
}

const FEISHU: ChatPlatformView = {
  platform: 'feishu',
  label: '飞书',
  fields: [
    { key: 'appId', label: 'App ID', secret: false, required: true },
    { key: 'appSecret', label: 'App Secret', secret: true, required: true },
    {
      key: 'domain', label: '站点', secret: false, required: false,
      options: [{ value: 'https://open.feishu.cn', label: '飞书（中国）' }, { value: 'https://open.larksuite.com', label: 'Lark（国际）' }],
    },
  ],
}

/** A stateful host for the controlled form, mirroring the store's edit actions. */
function mount(platform: ChatPlatformView, patch: Partial<ConnectForm> = {}) {
  const submit = vi.fn()
  const cancel = vi.fn()
  const edits: Array<[string, string]> = []
  function Host() {
    const [form, setForm] = useState<ConnectForm>({ platform: platform.platform, alias: '', values: {}, pending: false, error: null, ...patch })
    return (
      <AddBotForm
        platform={platform}
        form={form}
        setValue={(key, value) => { edits.push([key, value]); setForm(f => ({ ...f, values: { ...f.values, [key]: value } })) }}
        setAlias={(alias) => { setForm(f => ({ ...f, alias })) }}
        onSubmit={submit}
        onCancel={cancel}
        t={t}
      />
    )
  }
  render(<Host />)
  return { submit, cancel, edits }
}

describe('AddBotForm', () => {
  it('renders the descriptor fields with labels, placeholders, and hints under the inputs', () => {
    mount(TELEGRAM)
    expect(screen.getByRole('form', { name: '接入 Telegram 机器人' })).toBeTruthy()
    const token = screen.getByLabelText<HTMLInputElement>('机器人 Token')
    expect(token.type).toBe('password')
    expect(token.placeholder).toBe('123456789:AA…')
    expect(token.required).toBe(true)
    expect(token.getAttribute('aria-describedby')).toBe(screen.getByText('在 @BotFather 创建机器人后获得').id)
    const address = screen.getByLabelText<HTMLInputElement>('Bot API 地址')
    expect(address.type).toBe('text')
    expect(address.required).toBe(false)
    expect(screen.getByText('留空使用官方地址')).toBeTruthy()
    expect(screen.getByLabelText(zh['form.alias'])).toBeTruthy()
    expect(screen.getByText(zh['form.aliasHint'])).toBeTruthy()
  })

  it('renders a field without a hint with no description link', () => {
    mount(FEISHU)
    expect(screen.getByLabelText('App ID').getAttribute('aria-describedby')).toBeNull()
  })

  it('renders an options field as a select defaulting to its first option', () => {
    const { edits } = mount(FEISHU)
    const site = screen.getByLabelText<HTMLSelectElement>('站点')
    expect(site.tagName).toBe('SELECT')
    expect(site.value).toBe('https://open.feishu.cn')
    expect([...site.options].map(option => option.text)).toEqual(['飞书（中国）', 'Lark（国际）'])
    fireEvent.change(site, { target: { value: 'https://open.larksuite.com' } })
    expect(edits).toEqual([['domain', 'https://open.larksuite.com']])
    expect(screen.getByLabelText<HTMLSelectElement>('站点').value).toBe('https://open.larksuite.com')
  })

  it('shows and hides a secret value with a labeled toggle', () => {
    mount(TELEGRAM)
    const token = screen.getByLabelText<HTMLInputElement>('机器人 Token')
    fireEvent.change(token, { target: { value: '123:abc' } })
    fireEvent.click(screen.getByRole('button', { name: '显示 机器人 Token' }))
    expect(screen.getByLabelText<HTMLInputElement>('机器人 Token').type).toBe('text')
    expect(screen.getByLabelText<HTMLInputElement>('机器人 Token').value).toBe('123:abc')
    fireEvent.click(screen.getByRole('button', { name: '隐藏 机器人 Token' }))
    expect(screen.getByLabelText<HTMLInputElement>('机器人 Token').type).toBe('password')
  })

  it('gives a non-secret field no show toggle', () => {
    mount(FEISHU)
    expect(screen.queryByRole('button', { name: '显示 App ID' })).toBeNull()
    expect(screen.getByRole('button', { name: '显示 App Secret' })).toBeTruthy()
  })

  it('keeps Connect disabled until every required field has a value', () => {
    mount(FEISHU)
    const connect = screen.getByRole<HTMLButtonElement>('button', { name: zh['form.submit'] })
    expect(connect.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_a1' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['form.submit'] }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'secret' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['form.submit'] }).disabled).toBe(false)
  })

  it('submits through the form, including Enter inside an input', () => {
    const { submit } = mount(TELEGRAM, { values: { token: '123:abc' } })
    fireEvent.click(screen.getByRole('button', { name: zh['form.submit'] }))
    fireEvent.submit(screen.getByLabelText('Bot API 地址'))
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('does not submit an incomplete form', () => {
    const { submit } = mount(TELEGRAM)
    fireEvent.submit(screen.getByRole('form'))
    expect(submit).not.toHaveBeenCalled()
  })

  it('carries the optional alias', () => {
    mount(TELEGRAM)
    fireEvent.change(screen.getByLabelText(zh['form.alias']), { target: { value: '我的助手' } })
    expect(screen.getByLabelText<HTMLInputElement>(zh['form.alias']).value).toBe('我的助手')
  })

  it('shows connect progress and blocks edits while pending', () => {
    const { submit } = mount(TELEGRAM, { values: { token: 'x' }, pending: true })
    const connect = screen.getByRole<HTMLButtonElement>('button', { name: zh['form.submitting'] })
    expect(connect.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['form.cancel'] }).disabled).toBe(true)
    expect(screen.getByRole('form').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe(zh['form.submitting'])
    fireEvent.submit(screen.getByRole('form'))
    expect(submit).not.toHaveBeenCalled()
  })

  it('is not busy and announces nothing while idle', () => {
    mount(TELEGRAM)
    expect(screen.getByRole('form').getAttribute('aria-busy')).toBe('false')
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it.each([
    ['invalid-credentials', '凭据无效，请检查后重试'],
    ['unreachable', '无法连接到平台，请检查网络或代理'],
    ['duplicate-bot', '该机器人已接入'],
  ])('surfaces a %s refusal inline', (code, text) => {
    mount(TELEGRAM, { values: { token: 'x' }, error: { code, message: 'host wording' } })
    expect(screen.getByRole('alert').textContent).toBe(text)
  })

  it('cancels', () => {
    const { cancel } = mount(TELEGRAM)
    fireEvent.click(screen.getByRole('button', { name: zh['form.cancel'] }))
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
