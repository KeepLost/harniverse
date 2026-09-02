// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { CompactionProgressItem } from '../src/client/chat/CompactionProgressItem.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh)

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function progress(
  phase: 'preparing' | 'reasoning' | 'summary' | 'failed',
  overrides: Partial<{
    reasoningText: string
    summaryText: string
    error: string
  }> = {},
) {
  return {
    compactionId: 'compact-1',
    phase,
    reasoningText: '',
    summaryText: '',
    startedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as const
}

describe('CompactionProgressItem', () => {
  it('shows each lifecycle phase and follows the latest streamed line', () => {
    const view = render(<CompactionProgressItem progress={progress('preparing')} t={t} />)
    expect(view.getByText('正在压缩上下文')).toBeTruthy()
    expect(view.getByText('准备中')).toBeTruthy()

    view.rerender(<CompactionProgressItem progress={progress('reasoning', { reasoningText: 'old\nnew reasoning' })} t={t} />)
    expect(view.getByText('思考摘要')).toBeTruthy()
    expect(view.getByText('new reasoning')).toBeTruthy()

    view.rerender(<CompactionProgressItem progress={progress('summary', { summaryText: 'new summary' })} t={t} />)
    expect(view.getByText('生成摘要')).toBeTruthy()
    expect(view.getByText('new summary')).toBeTruthy()
  })

  it('reveals reasoning, summary, and failure details from the disclosure button', () => {
    const view = render(<CompactionProgressItem progress={progress('failed', {
      reasoningText: 'reasoning detail',
      summaryText: 'partial summary',
      error: 'provider unavailable',
    })} t={t} />)
    const button = view.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('压缩失败')).toBeTruthy()

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('reasoning detail')).toBeTruthy()
    expect(view.getAllByText('partial summary')).toHaveLength(2)
    expect(view.getByText('provider unavailable')).toBeTruthy()
    expect(view.container.querySelector('[data-state="failed"]')).not.toBeNull()
  })

  it('updates elapsed time while the operation is visible', () => {
    vi.useFakeTimers()
    vi.setSystemTime(6_000)
    const view = render(<CompactionProgressItem progress={progress('summary')} t={t} />)
    expect(view.getByText('5秒')).toBeTruthy()

    act(() => { vi.advanceTimersByTime(2_000) })
    expect(view.getByText('7秒')).toBeTruthy()
  })
})
