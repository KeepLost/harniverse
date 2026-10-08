// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPolling } from '../src/client/poll.ts'

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function becomeVisible(): void {
  visibility = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('startPolling', () => {
  it('reads once at start and then on every interval', () => {
    const run = vi.fn()
    const stop = startPolling(run, 3000)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    expect(run).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(6000)
    expect(run).toHaveBeenCalledTimes(4)
    stop()
  })

  it('stops reading once stopped', () => {
    const run = vi.fn()
    const stop = startPolling(run, 3000)
    stop()
    vi.advanceTimersByTime(30_000)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('skips ticks while the page is hidden and reads again when it returns', () => {
    const run = vi.fn()
    const stop = startPolling(run, 3000)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(9000)
    expect(run).toHaveBeenCalledTimes(1)
    becomeVisible()
    expect(run).toHaveBeenCalledTimes(2)
    stop()
  })

  it('does not read at start when the page is already hidden', () => {
    visibility = 'hidden'
    const run = vi.fn()
    const stop = startPolling(run, 3000)
    expect(run).not.toHaveBeenCalled()
    becomeVisible()
    expect(run).toHaveBeenCalledTimes(1)
    stop()
  })
})
