// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatOwnerView } from '@deepseek-ai/dsh-api-remotes/client'
import { formatStamp } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'
import { OwnersBlock, type OwnersBlockProps } from '../src/client/OwnersBlock.tsx'

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
})

const t = makeTranslate(zh) as OwnersBlockProps['t']

const OWNER: ChatOwnerView = { key: 'telegram:42', platform: 'telegram', userId: '42', displayName: 'Alice', pairedAt: NOW - 3_600_000 }

function mount(patch: Partial<OwnersBlockProps> = {}) {
  const issueCode = vi.fn(async () => {})
  const unpair = vi.fn(async () => {})
  const props: OwnersBlockProps = { owners: [], code: null, error: null, busy: [], issueCode, unpair, t, ...patch }
  const view = render(<OwnersBlock {...props} />)
  return { issueCode, unpair, view, rerender: (next: Partial<OwnersBlockProps>) => { view.rerender(<OwnersBlock {...props} {...next} />) } }
}

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

describe('OwnersBlock', () => {
  it('explains the empty state', () => {
    mount()
    expect(screen.getByRole('heading', { name: zh['owners.heading'] })).toBeTruthy()
    expect(screen.getByText(zh['owners.empty'])).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('lists paired accounts with name, user id, and paired time', () => {
    mount({ owners: [OWNER, { key: 'telegram:7', platform: 'telegram', userId: '7', pairedAt: NOW }] })
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('Alice')
    expect(items[0]!.textContent).toContain('用户 ID 42')
    expect(items[0]!.textContent).toContain(`绑定于 ${formatStamp(OWNER.pairedAt)}`)
    // An account without a display name is named by its user id.
    expect(screen.getByRole('button', { name: '解除 7 的绑定' })).toBeTruthy()
    expect(screen.queryByText(zh['owners.empty'])).toBeNull()
  })

  it('unpairs one account', () => {
    const { unpair } = mount({ owners: [OWNER] })
    fireEvent.click(screen.getByRole('button', { name: '解除 Alice 的绑定' }))
    expect(unpair).toHaveBeenCalledWith('telegram:42')
  })

  it('disables the unpair action of the account being unpaired', () => {
    mount({ owners: [OWNER], busy: ['owner:telegram:42'] })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '解除 Alice 的绑定' }).disabled).toBe(true)
  })

  it('requests a pairing code and shows progress while it is issued', () => {
    const { issueCode, rerender } = mount()
    fireEvent.click(screen.getByRole('button', { name: zh['pair.generate'] }))
    expect(issueCode).toHaveBeenCalledTimes(1)
    rerender({ busy: ['code'] })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['pair.generating'] }).disabled).toBe(true)
  })

  it('shows the code, the pairing instruction, and the expiry countdown', () => {
    mount({ code: { value: 'K7Q2-M9', expiresAt: NOW + 272_000 } })
    expect(screen.getByLabelText(zh['pair.codeLabel']).textContent).toBe('K7Q2-M9')
    expect(screen.getByText(zh['pair.instruction'])).toBeTruthy()
    expect(screen.getByText('/pair K7Q2-M9')).toBeTruthy()
    expect(screen.getByText('04:32 后失效')).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['pair.regenerate'] })).toBeTruthy()
    expect(screen.getByText(zh['pair.announce'])).toBeTruthy()
  })

  it('counts down every second and reports expiry', () => {
    mount({ code: { value: 'K7Q2', expiresAt: NOW + 3_000 } })
    expect(screen.getByText('00:03 后失效')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByText('00:02 后失效')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByText(zh['pair.expired'])).toBeTruthy()
    expect(screen.queryByLabelText(zh['pair.codeLabel'])).toBeNull()
    expect(screen.queryByRole('button', { name: zh['pair.copyAria'] })).toBeNull()
    // The clock stops once the code has expired.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats a code that arrives already expired as expired', () => {
    mount({ code: { value: 'K7Q2', expiresAt: NOW - 1 } })
    expect(screen.getByText(zh['pair.expired'])).toBeTruthy()
  })

  it('starts a fresh countdown for a newly issued code', () => {
    const { rerender } = mount({ code: { value: 'AAAA', expiresAt: NOW + 5_000 } })
    act(() => { vi.advanceTimersByTime(2000) })
    rerender({ code: { value: 'BBBB', expiresAt: NOW + 2_000 + 60_000 } })
    expect(screen.getByLabelText(zh['pair.codeLabel']).textContent).toBe('BBBB')
    expect(screen.getByText('01:00 后失效')).toBeTruthy()
  })

  it('copies the code and confirms briefly', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    mount({ code: { value: 'K7Q2', expiresAt: NOW + 60_000 } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['pair.copyAria'] })) })
    expect(writeText).toHaveBeenCalledWith('K7Q2')
    expect(screen.getByRole('button', { name: zh['pair.copyAria'] }).textContent).toBe(zh['pair.copied'])
    act(() => { vi.advanceTimersByTime(1600) })
    expect(screen.getByRole('button', { name: zh['pair.copyAria'] }).textContent).toBe(zh['pair.copy'])
  })

  it('does not claim a copy the host refused', async () => {
    stubClipboard(async () => { throw new Error('denied') })
    mount({ code: { value: 'K7Q2', expiresAt: NOW + 60_000 } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['pair.copyAria'] })) })
    expect(screen.getByRole('button', { name: zh['pair.copyAria'] }).textContent).toBe(zh['pair.copy'])
  })

  it('shows an owner-block failure as an alert', () => {
    mount({ error: { code: 'bridge-unavailable', message: 'down' } })
    expect(screen.getByRole('alert').textContent).toBe('聊天桥暂不可用，请稍后重试')
  })
})
