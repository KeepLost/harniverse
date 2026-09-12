// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GovernorOverview } from '@deepseek-ai/dsh-governor/client'
import { createGovernorViewStore } from '../src/client/stores.ts'
import { GovernorCenterView, type GovernorCenterViewProps } from '../src/client/GovernorCenterView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: GovernorCenterViewProps['t'] = makeTranslate(zh)

const OVERVIEW: GovernorOverview = {
  tier: 'rlimit',
  globalLimitBytes: 8_000_000_000,
  liveRssBytes: 2_000_000_000,
  sessions: [
    {
      sessionId: 'session-alpha',
      rssBytes: 1_500_000_000,
      cpuTicks: 42,
      commands: 2,
      quota: { sessionId: 'session-alpha', quotaBytes: 4_000_000_000, effectiveLimitBytes: 4_000_000_000, shared: false },
      breaches: [],
    },
    {
      sessionId: 'session-beta',
      rssBytes: 500_000_000,
      cpuTicks: 0,
      commands: 1,
      quota: { sessionId: 'session-beta', effectiveLimitBytes: 8_000_000_000, shared: true },
      breaches: [{ kind: 'memory-limit', sessionId: 'session-beta', commandId: 'c1', peakBytes: 8_100_000_000, limitBytes: 8_000_000_000, at: 1 }],
    },
  ],
  hostFreeBytes: 100_000_000_000,
  hostNetRxBytes: 1_024,
  hostNetTxBytes: 2_048,
  t: 1,
}

/** Mount the board with a stubbed Remote face over a real store instance. */
function mount(overview: GovernorOverview | { ok: false; error: string }, pollMs = 60_000) {
  const instance = createGovernorViewStore().create()
  const calls: { adjust: [string, number | null][] } = { adjust: [] }
  const fetchOverview = vi.fn(async () => 'ok' in overview
    ? { ok: false as const, error: 'error' }
    : { ok: true as const, value: overview })
  const closeView = vi.fn()
  const adjustQuota = vi.fn(async (sessionId: string, memoryBytes: number | null) => {
    calls.adjust.push([sessionId, memoryBytes])
    return { ok: true as const, value: undefined }
  })
  render(
    <GovernorCenterView
      {...{
        useStore: (selector: (state: { open: boolean }) => boolean) => selector({ open: false }),
        actions: instance.actions,
        overview: fetchOverview,
        adjustQuota,
        closeView,
        pollMs,
        t,
      } as unknown as GovernorCenterViewProps}
    />,
  )
  return { calls, fetchOverview, closeView }
}

describe('GovernorCenterView', () => {
  it('renders the tier, the global budget usage, and host sentinels', async () => {
    mount(OVERVIEW)
    await waitFor(() => { expect(screen.getByText('session-alpha')).toBeDefined() })
    expect(screen.getByText(zh['tier.rlimit'])).toBeDefined()
    expect(screen.getByText((content, element) => element?.tagName === 'SPAN' && content.includes('7.5 GiB') && content.includes('1.9 GiB'))).toBeDefined()
    expect(screen.getByText((content, element) => element?.tagName === 'SPAN' && content.includes('93.1 GiB'))).toBeDefined()
    expect(screen.getByText((content, element) => element?.tagName === 'SPAN' && content.includes('2.0 KiB'))).toBeDefined()
  })

  it('renders one row per session with quota state and breach badges', async () => {
    mount(OVERVIEW)
    await waitFor(() => { expect(screen.getByText('session-alpha')).toBeDefined() })
    expect(screen.getByText('42')).toBeDefined()
    expect(screen.getByText(zh['breach.memory-limit'])).toBeDefined()
    // The explicit-quota session shows its isolation leaf; the pool session shows the badge.
    expect(screen.getAllByText('3.7 GiB').length).toBeGreaterThan(0)
    expect(screen.getByText(zh['quota.shared'])).toBeDefined()
  })

  it('applies a drafted quota in MiB and clears back to the shared pool', async () => {
    const { calls } = mount(OVERVIEW)
    await waitFor(() => { expect(screen.getByText('session-alpha')).toBeDefined() })
    const input = screen.getAllByPlaceholderText(zh['quota.set'])[0] as HTMLInputElement
    fireEvent.change(input, { target: { value: '512' } })
    fireEvent.click(screen.getAllByText(zh['quota.apply'])[0]!)
    await waitFor(() => { expect(calls.adjust).toContainEqual(['session-alpha', 512 * 1024 * 1024]) })
    fireEvent.click(screen.getAllByText(zh['quota.clear'])[0]!)
    await waitFor(() => { expect(calls.adjust).toContainEqual(['session-alpha', null]) })
  })

  it('shows the error note with a retry verb when the Remote fails', async () => {
    mount({ ok: false, error: 'error' })
    await waitFor(() => { expect(screen.getByText(zh['view.error'])).toBeDefined() })
    expect(screen.getByText(zh['view.retry'])).toBeDefined()
  })

  it('shows the empty note when no metered session exists', async () => {
    mount({ ...OVERVIEW, sessions: [] })
    await waitFor(() => { expect(screen.getByText(zh['view.empty'])).toBeDefined() })
  })

  it('retries after a failed load', async () => {
    const harness = mount({ ok: false, error: 'error' })
    await waitFor(() => { expect(screen.getByText(zh['view.error'])).toBeDefined() })
    fireEvent.click(screen.getByText(zh['view.retry']))
    await waitFor(() => { expect(harness.fetchOverview.mock.calls.length).toBeGreaterThanOrEqual(2) })
  })

  it('renders the cgroup tier and omits absent host sentinels', async () => {
    const { hostFreeBytes: _free, hostNetRxBytes: _rx, hostNetTxBytes: _tx, ...bare } = OVERVIEW
    mount({ ...bare, tier: 'cgroup' })
    await waitFor(() => { expect(screen.getByText(zh['tier.cgroup'])).toBeDefined() })
    expect(screen.queryByText((content, element) => element?.tagName === 'SPAN' && content.includes('KiB'))).toBeNull()
  })

  it('treats an empty or invalid draft as a clear back to the pool', async () => {
    const { calls } = mount(OVERVIEW)
    await waitFor(() => { expect(screen.getByText('session-alpha')).toBeDefined() })
    const input = screen.getAllByPlaceholderText(zh['quota.set'])[0] as HTMLInputElement
    fireEvent.change(input, { target: { value: 'not-a-number' } })
    fireEvent.click(screen.getAllByText(zh['quota.apply'])[0]!)
    await waitFor(() => { expect(calls.adjust).toContainEqual(['session-alpha', null]) })
  })

  it('drives the real poll timer and renders a zero-limit row', async () => {
    const harness = mount({
      ...OVERVIEW,
      sessions: [{
        sessionId: 'zero',
        rssBytes: 500,
        cpuTicks: 0,
        commands: 1,
        quota: { sessionId: 'zero', effectiveLimitBytes: 0, shared: true },
        breaches: [],
      }],
    }, 50)
    // Real timers: mount, wait for the first load, then let one poll fire.
    await waitFor(() => { expect(screen.getByText('zero')).toBeDefined() })
    await new Promise((resolve) => { setTimeout(resolve, 120) })
    expect(harness.fetchOverview.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('covers unmount cleanup, refresh verb, tiny units, and hot bars', async () => {
    const harness = mount({
      ...OVERVIEW,
      sessions: [{
        sessionId: 'tiny',
        rssBytes: 900,
        cpuTicks: 0,
        commands: 1,
        quota: { sessionId: 'tiny', effectiveLimitBytes: 950, shared: true },
        breaches: [],
      }, {
        sessionId: 'hot',
        rssBytes: 950,
        cpuTicks: 0,
        commands: 1,
        quota: { sessionId: 'hot', quotaBytes: 1_000, effectiveLimitBytes: 1_000, shared: false },
        breaches: [],
      }],
    })
    await waitFor(() => { expect(screen.getByText('tiny')).toBeDefined() })
    // 900 B renders in the base unit; a >=90% row takes the hot bar fill.
    expect(screen.getAllByText((content, element) => element?.tagName === 'SPAN' && content.includes('900 B') && content.includes('950 B')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText(zh['view.refresh']))
    await waitFor(() => { expect(harness.fetchOverview.mock.calls.length).toBeGreaterThanOrEqual(2) })
  })

  it('closes back to the conversation through the layout exit', async () => {
    const { closeView } = mount(OVERVIEW)
    await waitFor(() => { expect(screen.getByText('session-alpha')).toBeDefined() })
    fireEvent.click(screen.getByText(zh['view.close']))
    expect(closeView).toHaveBeenCalledTimes(1)
  })
})
