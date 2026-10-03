// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId, SessionListState, JobView } from '@deepseek-ai/dsh-client-runtime/client'
import { JobListAction, type JobListActionProps } from '../src/client/JobListAction.tsx'
import { zh } from '../src/client/locales.ts'

// Live rows render `now - startedAt`, so every assertion needs a pinned clock.
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const SESSION = 'session' as SessionId
const START = 1_700_000_000_000
const t: JobListActionProps['t'] = makeTranslate(zh)

function job(over: Partial<JobView> = {}): JobView {
  return {
    id: 'bash-1' as JobView['id'],
    kind: 'bash',
    label: 'pnpm run build',
    status: 'running',
    startedAt: START,
    ...over,
  }
}

function props(jobs: readonly JobView[] | undefined, api?: JobListActionProps['api']): JobListActionProps {
  const state = {
    ids: [SESSION],
    byId: {},
    current: SESSION,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: jobs === undefined ? {} : { [SESSION]: jobs },
    currentAddress: undefined, selectionSeq: 0,
  } satisfies SessionListState
  function useSessions<T>(select: (snapshot: SessionListState) => T): T {
    return select(state)
  }
  return { sessionId: SESSION, useSessions, t, ...api === undefined ? {} : { api } } as unknown as JobListActionProps
}

/** Scripted follow windows served in call order; later calls answer empty. */
interface JobsFaceCall {
  follow: { jobId: string; offsetBytes?: number }[]
  kill: { jobId: string }[]
}

function fakeJobs(
  windows: readonly string[] = [],
  outcome:
    | { ok: true; value: { result: 'requested' | 'already-finished' } }
    | { ok: false; error: { code: string; message: string; details: {} } } = { ok: true, value: { result: 'requested' } },
): { api: JobListActionProps['api']; calls: JobsFaceCall } {
  const calls: JobsFaceCall = { follow: [], kill: [] }
  let served = 0
  let offset = 0
  const api = {
    jobs: {
      follow: (payload: { sessionId: string; jobId: string; offsetBytes?: number }): Promise<unknown> => {
        calls.follow.push({ jobId: payload.jobId, ...payload.offsetBytes === undefined ? {} : { offsetBytes: payload.offsetBytes } })
        const text = served < windows.length ? windows[served] ?? '' : ''
        served += 1
        offset += text.length
        return Promise.resolve({
          rpcId: 'r',
          result: { ok: true, value: { text, nextOffsetBytes: offset, truncated: false, totalBytes: offset, status: 'running' as const } },
        })
      },
      kill: (payload: { sessionId: string; jobId: string }): Promise<unknown> => {
        calls.kill.push({ jobId: payload.jobId })
        return Promise.resolve({ rpcId: 'r', result: outcome })
      },
    },
  } as unknown as JobListActionProps['api']
  return { api, calls }
}

/** A follow face whose every call rejects, for the transport-failure view. */
function brokenJobs(): JobListActionProps['api'] {
  return {
    jobs: {
      follow: () => Promise.reject(new Error('wire down')),
      kill: () => Promise.reject(new Error('wire down')),
    },
  }
}

/**
 * Rows in render order as `[kind, label, status, duration]`: the span cells
 * of each row, with the action buttons and the expanded pane (not spans)
 * filtered out.
 */
function rowCells(): string[][] {
  return within(screen.getByRole('list', { name: zh['list.aria'] }))
    .getAllByRole('listitem')
    .map(row => [...row.children]
      .filter((cell): cell is HTMLSpanElement => cell instanceof HTMLSpanElement)
      .map(cell => cell.textContent ?? '')
      .filter(text => text !== ''))
}

/** The first row's listitem locator. */
function firstRow(): HTMLElement {
  return within(screen.getByRole('list', { name: zh['list.aria'] })).getAllByRole('listitem')[0]!
}

describe('JobListAction visibility', () => {
  it('renders nothing while the session has no jobs', () => {
    const { container } = render(<JobListAction {...props(undefined)} />)
    expect(container.innerHTML).toBe('')
  })

  it('counts only live jobs, and falls back to the total when none are live', () => {
    const { rerender } = render(<JobListAction {...props([job(), job({ id: 'bash-2' as JobView['id'] })])} />)
    expect(screen.getByRole('button', { name: '2 个后台任务运行中' })).toBeDefined()

    rerender(<JobListAction {...props([job({ status: 'completed', finishedAt: START + 3_000 })])} />)
    expect(screen.getByRole('button', { name: '1 个后台任务' })).toBeDefined()
  })

  it('closes and unmounts when the last job disappears while the list is open', () => {
    const { container, rerender } = render(<JobListAction {...props([job()])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('list', { name: zh['list.aria'] })).toBeDefined()

    rerender(<JobListAction {...props([])} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('JobListAction rows', () => {
  it('orders live jobs by start, then settled jobs newest-first', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-3' as JobView['id'], label: 'old done', status: 'completed', startedAt: START, finishedAt: START + 1_000 }),
      job({ id: 'bash-4' as JobView['id'], label: 'new done', status: 'failed', startedAt: START, finishedAt: START + 9_000 }),
      job({ id: 'bash-2' as JobView['id'], label: 'later live', startedAt: START + 5_000 }),
      job({ id: 'bash-1' as JobView['id'], label: 'earlier live', startedAt: START }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells()).toEqual([
      ['bash', 'earlier live', '运行中', '0秒'],
      ['bash', 'later live', '运行中', '0秒'],
      ['bash', 'new done', '已失败', '9秒'],
      ['bash', 'old done', '已完成', '1秒'],
    ])
  })

  it('breaks a settled tie on start order so map iteration never decides it', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-2' as JobView['id'], label: 'second', status: 'completed', startedAt: START + 10, finishedAt: START + 100 }),
      job({ id: 'bash-1' as JobView['id'], label: 'first', status: 'completed', startedAt: START, finishedAt: START + 100 }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells().map(cells => cells[1])).toEqual(['first', 'second'])
  })

  it('prefers the producer detail over the generic status word', () => {
    render(<JobListAction {...props([
      job({ status: 'killed', detail: 'signal: SIGTERM', finishedAt: START + 2_000 }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells()[0]).toContain('signal: SIGTERM')
  })

  it('renders every status word, including the stopping transition', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'a', status: 'running' }),
      job({ id: 'bash-2' as JobView['id'], label: 'b', status: 'stopping' }),
      job({ id: 'bash-3' as JobView['id'], label: 'c', status: 'completed', finishedAt: START }),
      job({ id: 'bash-4' as JobView['id'], label: 'd', status: 'killed', finishedAt: START }),
      job({ id: 'bash-5' as JobView['id'], label: 'e', status: 'failed', finishedAt: START }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    const words = rowCells().map(cells => cells[2])
    expect(new Set(words)).toEqual(new Set(['运行中', '正在停止', '已完成', '已取消', '已失败']))
  })
})

describe('JobListAction duration', () => {
  it('advances a live row once per second and freezes a settled one', () => {
    vi.setSystemTime(START + 1_000)
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'live' }),
      job({ id: 'bash-2' as JobView['id'], label: 'done', status: 'completed', finishedAt: START + 4_000 }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells()[0]).toContain('1秒')
    expect(rowCells()[1]).toContain('4秒')

    act(() => { vi.advanceTimersByTime(2_000) })
    expect(rowCells()[0]).toContain('3秒')
    expect(rowCells()[1]).toContain('4秒')
  })

  it('widens to minutes and then hours, and never shows a negative figure', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'm', status: 'completed', finishedAt: START + 125_000 }),
      job({ id: 'bash-2' as JobView['id'], label: 'h', status: 'completed', finishedAt: START + 7_380_000 }),
      // A clock that moved backwards must not render a negative duration.
      job({ id: 'bash-3' as JobView['id'], label: 'skew', status: 'completed', startedAt: START + 5_000, finishedAt: START }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells().map(cells => cells[3])).toEqual(['2小时3分', '2分5秒', '0秒'])
  })

  it('runs no clock while the list is closed', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    render(<JobListAction {...props([job()])} />)
    expect(interval).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button'))
    expect(interval).toHaveBeenCalledTimes(1)
  })

  it('runs no clock for an open list holding only settled jobs', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    render(<JobListAction {...props([job({ status: 'completed', finishedAt: START })])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(interval).not.toHaveBeenCalled()
  })
})

describe('JobListAction dismissal', () => {
  it('closes on Escape and returns focus to the trigger', () => {
    render(<JobListAction {...props([job()])} />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('ignores other keys and a closed-list Escape', () => {
    render(<JobListAction {...props([job()])} />)
    const trigger = screen.getByRole('button')
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('closes on an outside pointer press but not on one inside', () => {
    render(<JobListAction {...props([job()])} />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)

    fireEvent.pointerDown(screen.getByRole('list', { name: zh['list.aria'] }))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.pointerDown(document.body)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('JobListAction wire tolerance', () => {
  it('treats a settled job with no finishedAt as zero-duration and sorts it by start', () => {
    // `finishedAt` is optional on the wire; the Host always sets it, so this
    // covers a producer or carrier that ever stops doing so.
    render(<JobListAction {...props([
      job({ id: 'bash-1' as JobView['id'], label: 'no finish', status: 'completed' }),
      job({ id: 'bash-2' as JobView['id'], label: 'finished', status: 'completed', startedAt: START - 1_000, finishedAt: START + 2_000 }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells().map(cells => [cells[1], cells[3]])).toEqual([
      ['finished', '3秒'],
      ['no finish', '0秒'],
    ])
  })

  it('falls back to start order when neither settled job carries a finish time', () => {
    render(<JobListAction {...props([
      job({ id: 'bash-2' as JobView['id'], label: 'later', status: 'failed', startedAt: START + 1_000 }),
      job({ id: 'bash-1' as JobView['id'], label: 'earlier', status: 'failed', startedAt: START }),
    ])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(rowCells().map(cells => cells[1])).toEqual(['later', 'earlier'])
  })
})

describe('JobListAction expandable output', () => {
  it('follows the ring from offset 0 and appends polled windows', async () => {
    const { api, calls } = fakeJobs(['tick 1\n', 'tick 2\n'])
    render(<JobListAction {...props([job()], api)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.expand'] }))

    const pane = screen.getByRole('log', { name: zh['output.aria'] })
    await act(async () => {})
    expect(pane.textContent).toContain('tick 1\n')
    expect(calls.follow).toEqual([{ jobId: 'bash-1', offsetBytes: 0 }])

    await act(async () => { vi.advanceTimersByTime(500) })
    expect(pane.textContent).toContain('tick 2\n')
    expect(calls.follow).toEqual([{ jobId: 'bash-1', offsetBytes: 0 }, { jobId: 'bash-1', offsetBytes: 7 }])
  })

  it('stops polling once the row settles and keeps the pane readable', async () => {
    const { api, calls } = fakeJobs(['tick 1\n'])
    const view = render(<JobListAction {...props([job()], api)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.expand'] }))
    await act(async () => {})

    view.rerender(<JobListAction {...props([
      job({ status: 'killed', detail: 'signal: SIGTERM', finishedAt: START + 1_000 }),
    ], api)} />)
    const settledCalls = calls.follow.length
    await act(async () => { vi.advanceTimersByTime(2_000) })
    expect(calls.follow.length).toBe(settledCalls)
    // The pane survives settlement; only the stop control disappears.
    expect(screen.getByRole('log', { name: zh['output.aria'] }).textContent).toContain('tick 1\n')
    expect(within(firstRow()).queryByRole('button', { name: zh['row.stop'] })).toBeNull()
    expect(within(firstRow()).queryByRole('button', { name: zh['row.collapse'] })).not.toBeNull()
  })

  it('clears the poll when the row collapses', async () => {
    const { api, calls } = fakeJobs(['tick 1\n'])
    render(<JobListAction {...props([job()], api)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.expand'] }))
    await act(async () => {})

    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.collapse'] }))
    expect(screen.queryByRole('log', { name: zh['output.aria'] })).toBeNull()
    const collapsedCalls = calls.follow.length
    await act(async () => { vi.advanceTimersByTime(1_500) })
    expect(calls.follow.length).toBe(collapsedCalls)
  })

  it('renders a refused follow inline without dropping the pane', async () => {
    const api = {
      jobs: {
        follow: () => Promise.resolve({
          rpcId: 'r',
          result: { ok: false, error: { code: 'job-unavailable', message: 'job bash-1 is gone', details: {} } },
        }),
      },
    } as unknown as JobListActionProps['api']
    render(<JobListAction {...props([job()], api)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.expand'] }))

    await act(async () => {})
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('输出读取失败：job bash-1 is gone')
    expect(screen.getByRole('log', { name: zh['output.aria'] })).toBeDefined()
  })

  it('renders a transport failure inline', async () => {
    render(<JobListAction {...props([job()], brokenJobs())} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.expand'] }))

    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toBe('输出读取失败：wire down')
  })
})

describe('JobListAction two-step stop', () => {
  it('arms on the first press and kills on the second', async () => {
    const { api, calls } = fakeJobs()
    render(<JobListAction {...props([job()], api)} />)
    fireEvent.click(screen.getByRole('button'))
    const stop = within(firstRow()).getByRole('button', { name: zh['row.stop'] })
    fireEvent.click(stop)
    expect(calls.kill).toEqual([])
    expect(within(firstRow()).getByRole('button', { name: zh['row.stopConfirm'] })).toBeDefined()

    await act(async () => { fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.stopConfirm'] })) })
    expect(calls.kill).toEqual([{ jobId: 'bash-1' }])
    expect(within(firstRow()).getByRole('button', { name: zh['row.stop'] })).toBeDefined()
  })

  it('reverts the confirm posture on its own timeout without killing', async () => {
    const { api, calls } = fakeJobs()
    render(<JobListAction {...props([job()], api)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.stop'] }))

    await act(async () => { vi.advanceTimersByTime(2_500) })
    expect(within(firstRow()).getByRole('button', { name: zh['row.stop'] })).toBeDefined()
    expect(calls.kill).toEqual([])
  })

  it('shows a refused kill as an inline alert', async () => {
    const api = fakeJobs([], {
      ok: false,
      error: { code: 'job-unavailable', message: 'registry is absent', details: {} },
    }).api
    render(<JobListAction {...props([job()], api)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.stop'] }))

    await act(async () => { fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.stopConfirm'] })) })
    expect(screen.getByRole('alert').textContent).toBe('停止失败：registry is absent')
  })

  it('shows a transport failure of the kill as an inline alert', async () => {
    render(<JobListAction {...props([job()], brokenJobs())} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.stop'] }))

    await act(async () => { fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.stopConfirm'] })) })
    expect(screen.getByRole('alert').textContent).toBe('停止失败：wire down')
  })

  it('renders a non-Error kill rejection through its string form', async () => {
    const api = {
      jobs: {
        follow: () => Promise.resolve({ rpcId: 'r', result: { ok: true, value: { text: '', nextOffsetBytes: 0, truncated: false, totalBytes: 0, status: 'running' as const } } }),
        // oxlint-disable-next-line prefer-promise-reject-errors -- the alert renders non-Error rejections via their string form
        kill: () => Promise.reject('carrier gone'),
      },
    } as never
    render(<JobListAction {...props([job()], api)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.stop'] }))

    await act(async () => { fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.stopConfirm'] })) })
    expect(screen.getByRole('alert').textContent).toBe('停止失败：carrier gone')
  })

  it('keeps appending after the user scrolls the output pane', async () => {
    const { api } = fakeJobs(['tick 1\n', 'tick 2\n'])
    render(<JobListAction {...props([job()], api)} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(within(firstRow()).getByRole('button', { name: zh['row.expand'] }))

    const pane = screen.getByRole('log', { name: zh['output.aria'] })
    await act(async () => {})
    fireEvent.scroll(pane)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(pane.textContent).toContain('tick 2\n')
  })
})
