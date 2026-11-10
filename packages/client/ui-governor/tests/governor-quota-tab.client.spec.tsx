// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GovernorOverview } from '@deepseek-ai/dsh-governor/client'
import { GovernorQuotaTab, type GovernorQuotaTabProps } from '../src/client/GovernorQuotaTab.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: GovernorQuotaTabProps['t'] = makeTranslate(zh)

const OVERVIEW: GovernorOverview = {
  tier: 'rlimit',
  globalLimitBytes: null,
  liveRssBytes: 2_000_000_000,
  sessions: [
    {
      sessionId: 'session-alpha',
      rssBytes: 1_000_000_000,
      cpuTicks: 42,
      commands: 2,
      quota: { sessionId: 'session-alpha', quotaBytes: 2_000_000_000, effectiveLimitBytes: 2_000_000_000, shared: false },
      breaches: [],
    },
    {
      sessionId: 'session-beta',
      rssBytes: 1_000_000_000,
      cpuTicks: 0,
      commands: 1,
      quota: { sessionId: 'session-beta', effectiveLimitBytes: null, shared: true },
      breaches: [],
    },
  ],
  t: 1,
}

/** One sessions-feed row stand-in shaped like SessionSummary. */
function summary(id: string, overrides: Record<string, unknown> = {}) {
  return { id, displayTitle: `标题-${id}`, running: false, ...overrides }
}

/** Mount the tab with a stubbed Remote face and sessions feed. */
function mount(
  overview: GovernorOverview | { ok: false; error: string },
  byId: Record<string, ReturnType<typeof summary>> = {},
  pollMs = 60_000,
) {
  const calls: { adjust: [string, number | null][] } = { adjust: [] }
  const fetchOverview = vi.fn(async () => 'ok' in overview
    ? { ok: false as const, error: 'error' }
    : { ok: true as const, value: overview })
  const adjustQuota = vi.fn(async (sessionId: string, memoryBytes: number | null) => {
    calls.adjust.push([sessionId, memoryBytes])
    return { ok: true as const, value: undefined }
  })
  render(
    <GovernorQuotaTab
      {...{
        useSessions: (selector: (list: unknown) => unknown) => selector({ byId }),
        overview: fetchOverview,
        adjustQuota,
        pollMs,
        t,
      } as unknown as GovernorQuotaTabProps}
    />,
  )
  return { calls, fetchOverview, adjustQuota }
}

describe('GovernorQuotaTab', () => {
  it('lists only quota-limited sessions with title, value, and usage', async () => {
    mount(OVERVIEW, {
      'session-alpha': summary('session-alpha', { running: true }),
      'session-beta': summary('session-beta'),
    })
    await waitFor(() => { expect(screen.getByText('标题-session-alpha')).toBeDefined() })
    // The unlimited session stays off the row list (only the picker offers it).
    expect(screen.queryByTitle('session-beta')).toBeNull()
    expect(screen.getByText('1.9 GiB')).toBeDefined()
    expect(screen.getByText(content => content.includes('953.7 MiB') && content.includes('50%'))).toBeDefined()
  })

  it('falls back to the session id while the feed lacks the session', async () => {
    mount(OVERVIEW, {})
    await waitFor(() => { expect(screen.getByText('session-alpha')).toBeDefined() })
  })

  it('shows the empty note while no session carries a limit', async () => {
    mount({ ...OVERVIEW, sessions: [OVERVIEW.sessions[1]!] }, { 'session-beta': summary('session-beta') })
    await waitFor(() => { expect(screen.getByText(zh['quotaList.empty'])).toBeDefined() })
  })

  it('adjusts a drafted quota in MiB and removes the limit', async () => {
    const { calls } = mount(OVERVIEW, { 'session-alpha': summary('session-alpha') })
    await waitFor(() => { expect(screen.getByText('标题-session-alpha')).toBeDefined() })
    const input = screen.getByPlaceholderText(zh['quotaList.adjust']) as HTMLInputElement
    fireEvent.change(input, { target: { value: '512' } })
    fireEvent.click(screen.getByText(zh['quota.apply']))
    await waitFor(() => { expect(calls.adjust).toContainEqual(['session-alpha', 512 * 1024 * 1024]) })
    fireEvent.click(screen.getByText(zh['quotaList.clear']))
    await waitFor(() => { expect(calls.adjust).toContainEqual(['session-alpha', null]) })
  })

  it('treats an empty draft as a clear', async () => {
    const { calls } = mount(OVERVIEW, { 'session-alpha': summary('session-alpha') })
    await waitFor(() => { expect(screen.getByText('标题-session-alpha')).toBeDefined() })
    fireEvent.click(screen.getByText(zh['quota.apply']))
    await waitFor(() => { expect(calls.adjust).toContainEqual(['session-alpha', null]) })
  })

  it('adds a first limit through the picker and resets it', async () => {
    const { calls } = mount(OVERVIEW, {
      'session-alpha': summary('session-alpha'),
      'session-beta': summary('session-beta'),
    })
    await waitFor(() => { expect(screen.getByText('标题-session-alpha')).toBeDefined() })
    // The picker offers only sessions without a limit.
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: zh['quotaList.add.pick'] })
    expect(screen.getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['', 'session-beta'])
    const apply = screen.getByRole<HTMLButtonElement>('button', { name: zh['quotaList.add.apply'] })
    expect(apply.disabled).toBe(true)
    fireEvent.change(select, { target: { value: 'session-beta' } })
    fireEvent.change(screen.getByPlaceholderText(zh['quota.set']), { target: { value: '256' } })
    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)
    await waitFor(() => { expect(calls.adjust).toContainEqual(['session-beta', 256 * 1024 * 1024]) })
    await waitFor(() => { expect(screen.getByRole<HTMLSelectElement>('combobox', { name: zh['quotaList.add.pick'] }).value).toBe('') })
  })

  it('keeps the picker apply disabled for an invalid draft', async () => {
    mount(OVERVIEW, {
      'session-alpha': summary('session-alpha'),
      'session-beta': summary('session-beta'),
    })
    await waitFor(() => { expect(screen.getByText('标题-session-alpha')).toBeDefined() })
    fireEvent.change(screen.getByRole<HTMLSelectElement>('combobox', { name: zh['quotaList.add.pick'] }), { target: { value: 'session-beta' } })
    fireEvent.change(screen.getByPlaceholderText(zh['quota.set']), { target: { value: 'nope' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['quotaList.add.apply'] }).disabled).toBe(true)
  })

  it('renders the status-dot states of limited sessions', async () => {
    mount(OVERVIEW, {
      'session-alpha': summary('session-alpha', { running: true, pendingInteraction: { kind: 'ask' } }),
    })
    await waitFor(() => { expect(screen.getByText('标题-session-alpha')).toBeDefined() })
    // The warning dot branch renders without error; the done branch covers completed rows.
    cleanup()
    mount({ ...OVERVIEW, sessions: [OVERVIEW.sessions[0]!] }, {
      'session-alpha': summary('session-alpha', { completed: true }),
    })
    await waitFor(() => { expect(screen.getByText('标题-session-alpha')).toBeDefined() })
  })

  it('shows the error note with a retry verb when the Remote fails', async () => {
    const harness = mount({ ok: false, error: 'error' })
    await waitFor(() => { expect(screen.getByText(zh['view.error'])).toBeDefined() })
    fireEvent.click(screen.getByText(zh['view.retry']))
    await waitFor(() => { expect(harness.fetchOverview.mock.calls.length).toBeGreaterThanOrEqual(2) })
  })

  it('refreshes on demand and tolerates a zero quota row', async () => {
    const harness = mount({
      ...OVERVIEW,
      sessions: [{
        sessionId: 'zero',
        rssBytes: 10,
        cpuTicks: 0,
        commands: 1,
        quota: { sessionId: 'zero', quotaBytes: 0, effectiveLimitBytes: 0, shared: false },
        breaches: [],
      }],
    }, { zero: summary('zero') })
    await waitFor(() => { expect(screen.getByText('标题-zero')).toBeDefined() })
    fireEvent.click(screen.getByRole('button', { name: zh['view.refresh'] }))
    await waitFor(() => { expect(harness.fetchOverview.mock.calls.length).toBeGreaterThanOrEqual(2) })
  })

  it('drives the real poll timer and renders a hot usage bar', async () => {
    const harness = mount({
      ...OVERVIEW,
      sessions: [{
        sessionId: 'hot',
        rssBytes: 950,
        cpuTicks: 0,
        commands: 1,
        quota: { sessionId: 'hot', quotaBytes: 1_000, effectiveLimitBytes: 1_000, shared: false },
        breaches: [],
      }],
    }, { hot: summary('hot') }, 50)
    // Real timers: mount, wait for the first load, then let one poll fire.
    await waitFor(() => { expect(screen.getByText('标题-hot')).toBeDefined() })
    await new Promise((resolve) => { setTimeout(resolve, 120) })
    expect(harness.fetchOverview.mock.calls.length).toBeGreaterThanOrEqual(2)
    // 950 of 1000 bytes pins the hot bar arm.
    expect(screen.getByText(content => content.includes('95%'))).toBeDefined()
  })
})
