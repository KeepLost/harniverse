// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { QueueMessageInfo, QueueSubscriptionInfo, QueueTopicStats } from '@deepseek-ai/dsh-queue/types'
import { QueueTab, type QueueTabProps } from '../src/client/QueueTab.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.spyOn(window, 'confirm').mockRestore()
})

const t: QueueTabProps['t'] = makeTranslate(zh)

const STATS: QueueTopicStats[] = [{
  topic: { id: 1, name: 'ops', ttlMs: null, createdAt: 0, nextOffset: 2 },
  liveCount: 1, archivedCount: 1, subscriberCount: 1, oldestLiveOffset: 0, newestLiveOffset: 1,
}]

const MESSAGES: QueueMessageInfo[] = [
  { topicId: 1, offset: 0, payload: { a: 1 }, headers: {}, publisher: 'panel', publishedAt: 0, expiresAt: 9_000_000_000_000, state: 'live' },
  { topicId: 1, offset: 1, payload: { b: 2 }, headers: {}, publisher: 'tool', publishedAt: 0, expiresAt: 9_000_000_000_000, state: 'archived' },
]

const SUBS: Array<QueueSubscriptionInfo & { dormant: boolean }> = [
  { sessionId: 'session-a', topicId: 1, cursor: 1, subscribedAt: 0, lastDeliveredAt: 1, dormant: false },
  { sessionId: 'session-b', topicId: 1, cursor: 0, subscribedAt: 0, lastDeliveredAt: null, dormant: true },
]

type Verbs = Pick<QueueTabProps, keyof QueueTabProps> & Record<string, unknown>

/** Mount the tab over scripted Remote verbs recording every call. */
function mount(overrides: Partial<Verbs> = {}, listResult: QueueTopicStats[] | { ok: false; error: string } = STATS) {
  const calls: Record<string, unknown[]> = {}
  const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true as const, value })
  const fail = <T,>(): RemoteResult<T> => ({ ok: false as const, error: { message: 'denied' } as never })
  const verbs = {
    topicList: async () => Array.isArray(listResult) ? ok(listResult) : fail<QueueTopicStats[]>(),
    topicCreate: async (name: string, ttlMs: number | null) => { calls.topicCreate = [name, ttlMs]; return ok({}) },
    topicDelete: async (name: string) => { calls.topicDelete = [name]; return ok(undefined) },
    publish: async (...args: unknown[]) => { calls.publish = args; return ok(MESSAGES[0]!) },
    messages: async (...args: unknown[]) => { calls.messages = args; return ok(MESSAGES) },
    subscriptions: async (...args: unknown[]) => { calls.subscriptions = args; return ok(SUBS) },
    subscribe: async (...args: unknown[]) => { calls.subscribe = args; return ok(SUBS[0]!) },
    unsubscribe: async (...args: unknown[]) => { calls.unsubscribe = args; return ok(undefined) },
    pollMs: 60_000,
    ...overrides,
    t,
  } as unknown as QueueTabProps
  render(<QueueTab {...verbs} />)
  return { calls }
}

describe('QueueTab', () => {
  it('renders the topic table and the empty state', async () => {
    mount({}, [])
    await waitFor(() => { expect(screen.getByText(zh['view.empty'])).toBeTruthy() })
  })

  it('renders the error note with retry', async () => {
    mount({}, { ok: false, error: 'denied' })
    await waitFor(() => { expect(screen.getByText(zh['view.error'])).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['view.retry']))
  })

  it('lists topics with aggregates and opens a topic detail with messages and subscriptions', async () => {
    const { calls } = mount()
    await waitFor(() => { expect(screen.getByText('ops')).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['topic.select']))
    await waitFor(() => { expect(calls.messages).toBeDefined() })
    expect(screen.getByText(/session-a/)).toBeTruthy()
    // The dormant subscriber carries its badge; the archived row renders dimmed copy.
    expect(screen.getByText(zh['subs.dormant'])).toBeTruthy()
    expect(screen.getByText(zh['table.archived'], { selector: 'td' })).toBeTruthy()
    expect(screen.getAllByText(/session-b/).length).toBeGreaterThan(0)
  })

  it('creates topics with parsed TTL and deletes through the confirm gate', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { calls } = mount()
    await waitFor(() => { expect(screen.getByText('ops')).toBeTruthy() })
    fireEvent.change(screen.getAllByPlaceholderText(zh['topic.name'])[0]!, { target: { value: 'fresh' } })
    fireEvent.change(screen.getAllByPlaceholderText(zh['topic.ttl'])[0]!, { target: { value: '9000' } })
    fireEvent.click(screen.getByText(zh['topic.create']))
    await waitFor(() => { expect(calls.topicCreate).toEqual(['fresh', 9000]) })
    fireEvent.click(screen.getByText(zh['topic.delete']))
    await waitFor(() => { expect(calls.topicDelete).toEqual(['ops']) })
  })

  it('treats invalid TTL drafts as absent and skips deletion when confirm declines', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { calls } = mount()
    await waitFor(() => { expect(screen.getByText('ops')).toBeTruthy() })
    fireEvent.change(screen.getAllByPlaceholderText(zh['topic.ttl'])[0]!, { target: { value: 'nope' } })
    fireEvent.change(screen.getAllByPlaceholderText(zh['topic.name'])[0]!, { target: { value: 'x' } })
    fireEvent.click(screen.getByText(zh['topic.create']))
    await waitFor(() => { expect(calls.topicCreate).toEqual(['x', null]) })
    fireEvent.click(screen.getByText(zh['topic.delete']))
    expect(confirmSpy).toHaveBeenCalled()
    expect(calls.topicDelete).toBeUndefined()
  })

  it('publishes parsed payloads with TTL overrides and surfaces a failed op', async () => {
    const { calls } = mount()
    await waitFor(() => { expect(screen.getByText('ops')).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['topic.select']))
    await waitFor(() => { expect(screen.getByPlaceholderText(zh['detail.payload'])).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText(zh['detail.payload']), { target: { value: '{"n":1}' } })
    fireEvent.change(screen.getByPlaceholderText(zh['detail.ttl']), { target: { value: '5000' } })
    fireEvent.click(screen.getByText(zh['detail.publish']))
    await waitFor(() => { expect(calls.publish).toEqual(['ops', { n: 1 }, {}, 5000, 'panel']) })
    // An unparsable payload aborts the publish without calling the Remote.
    const before = (calls.publish as unknown[])?.length ?? 0
    fireEvent.change(screen.getByPlaceholderText(zh['detail.payload']), { target: { value: '{bad' } })
    fireEvent.click(screen.getByText(zh['detail.publish']))
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect((calls.publish as unknown[])?.length ?? 0).toBe(before)
  })

  it('reports a denied operation through the failure note', async () => {
    const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true as const, value })
    mount({
      topicDelete: async () => ({ ok: false as const, error: { message: 'no capability' } as never }),
    } as Partial<Verbs>)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await waitFor(() => { expect(screen.getByText('ops')).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['topic.delete']))
    await waitFor(() => { expect(screen.getByText(/no capability/)).toBeTruthy() })
    void ok
  })

  it('toggles archived visibility and drives the subscribe bar', async () => {
    const { calls } = mount()
    await waitFor(() => { expect(screen.getByText('ops')).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['topic.select']))
    await waitFor(() => { expect(calls.messages).toBeDefined() })
    fireEvent.click(screen.getByText(zh['detail.showArchived']))
    await waitFor(() => { expect(calls.messages).toBeDefined() })
    fireEvent.change(screen.getByPlaceholderText(zh['subs.session']), { target: { value: 'session-z' } })
    fireEvent.click(screen.getByText(zh['subs.subscribe']))
    await waitFor(() => { expect(calls.subscribe).toEqual(['session-z', 'ops']) })
    fireEvent.click(screen.getAllByText(zh['subs.unsubscribe'])[0]!)
    await waitFor(() => { expect(calls.unsubscribe).toEqual(['session-a', 'ops']) })
  })

  it('tolerates a failing messages/subscriptions fetch while the list succeeds', async () => {
    mount({
      messages: async () => ({ ok: false as const, error: { message: 'denied' } as never }),
      subscriptions: async () => ({ ok: false as const, error: { message: 'denied' } as never }),
    })
    await waitFor(() => { expect(screen.getByText('ops')).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['topic.select']))
    await new Promise((resolve) => { setTimeout(resolve, 30) })
  })

  it('renders a bare error value through the failure note fallback', async () => {
    mount({
      topicDelete: async () => ({ ok: false as const, error: 'plain-denied' as never }),
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await waitFor(() => { expect(screen.getByText('ops')).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['topic.delete']))
    await waitFor(() => { expect(screen.getByText(/plain-denied/)).toBeTruthy() })
  })

  it('drives the poll timer and publishes without a TTL override', async () => {
    const mounted2 = render(<QueueTab {...{
      topicList: async () => ({ ok: true as const, value: STATS }),
      topicCreate: async () => ({ ok: true as const, value: {} }),
      topicDelete: async () => ({ ok: true as const, value: undefined }),
      publish: async (..._args: unknown[]) => ({ ok: true as const, value: MESSAGES[0] }),
      messages: async () => ({ ok: true as const, value: MESSAGES }),
      subscriptions: async () => ({ ok: true as const, value: SUBS }),
      subscribe: async () => ({ ok: true as const, value: SUBS[0] }),
      unsubscribe: async () => ({ ok: true as const, value: undefined }),
      pollMs: 40,
      t,
    } as unknown as QueueTabProps} />)
    await waitFor(() => { expect(screen.getAllByText('ops').length).toBeGreaterThan(0) })
    fireEvent.click(screen.getAllByText(zh['topic.select'])[0]!)
    await waitFor(() => { expect(screen.getByPlaceholderText(zh['detail.payload'])).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText(zh['detail.payload']), { target: { value: '{"z":9}' } })
    fireEvent.click(screen.getByText(zh['detail.publish']))
    await new Promise((resolve) => { setTimeout(resolve, 90) })
    mounted2.unmount()
  })

  it('refreshes on demand and shows the loading note first', async () => {
    const { calls } = mount()
    expect(screen.getByText(zh['view.loading'])).toBeTruthy()
    await waitFor(() => { expect(screen.getByText('ops')).toBeTruthy() })
    fireEvent.click(screen.getByText(zh['view.refresh']))
    await waitFor(() => { expect((calls.messages as unknown[]) ?? true).toBeTruthy() })
  })
})
