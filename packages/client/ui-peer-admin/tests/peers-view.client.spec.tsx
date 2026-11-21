// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerAdminView, PeerSessionSummary, PeerSurface } from '@deepseek-ai/dsh-peer-host/types'
import { PeersView, type PeersViewProps } from '../src/client/PeersView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh)
const peerId = '3f2a8f9e-1111-4222-8333-444455556666'

function peer(overrides: Partial<PeerAdminView> = {}): PeerAdminView {
  return {
    instanceId: peerId,
    displayName: 'Build workstation',
    platform: 'darwin', arch: 'arm64', version: '1.0.0-rc.3',
    status: 'active',
    surface: { delegate: true, message: true, list: true },
    firstSeenAt: '2026-11-01T00:00:00.000Z',
    lastSeenAt: '2026-11-20T08:00:00.000Z',
    monthlyTurnsUsed: 0,
    monthlyTurnPeriod: '2026-11',
    sessionCount: 0,
    ...overrides,
  }
}

const session: PeerSessionSummary = {
  sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef',
  createdAt: '2026-11-19T09:00:00.000Z',
  lastActivityAt: '2026-11-19T09:05:00.000Z',
  state: 'ended',
  label: 'audit me',
}

function face(initial: PeerAdminView[], overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(async (): Promise<RemoteResult<{ peers: PeerAdminView[] }>> => ({ ok: true, value: { peers: initial } })),
    remove: vi.fn(async (): Promise<RemoteResult<void>> => ({ ok: true, value: undefined })),
    setSurface: vi.fn(async (input: { instanceId: string; surface: PeerSurface }) => {
      return { ok: true as const, value: peer({ surface: input.surface }) } as const
    }),
    approveSurface: vi.fn(async () => {
      return { ok: true as const, value: peer({ surface: { delegate: true, message: true, list: true } }) } as const
    }),
    rejectSurface: vi.fn(async () => ({ ok: true as const, value: peer() } as const)),
    setBudget: vi.fn(async (input: { instanceId: string; monthlyTurns?: number }) => {
      const override = input.monthlyTurns === undefined ? {} : { monthlyTurns: input.monthlyTurns }
      return { ok: true as const, value: peer(override) } as const
    }),
    audit: vi.fn(async (): Promise<RemoteResult<{ sessions: PeerSessionSummary[] }>> => ({ ok: true, value: { sessions: [session] } })),
    ...overrides,
  }
}

/** One tick source stub; `bump` moves the snapshot the view subscribes to. */
function tickSource(): { source: { getSnapshot(): number; subscribe(listener: () => void): () => void }; bump(): void } {
  const listeners = new Set<() => void>()
  let value = 0
  return {
    source: {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    bump: () => { value += 1; for (const listener of listeners) listener() },
  }
}

function mount(actions: ReturnType<typeof face>, tick = tickSource()) {
  // A minimal stand-in for the renderer-bound selector hook: it subscribes to
  // the bare source and re-renders on every published change.
  const usePeersTick = (selector: (snapshot: number) => number): number => {
    const [snapshot, setSnapshot] = useState(tick.source.getSnapshot())
    useEffect(() => tick.source.subscribe(() => { setSnapshot(tick.source.getSnapshot()) }), [tick.source])
    return selector(snapshot)
  }
  const props = {
    ...actions,
    usePeersTick,
    t,
  } as unknown as PeersViewProps
  return { view: render(<PeersView {...props} />), actions, tick }
}

describe('paired-peer governance view', () => {
  it('renders the roster with surface badges and budget state, or the empty state', async () => {
    const actions = face([peer({ monthlyTurns: 5, monthlyTurnsUsed: 2 })])
    mount(actions)
    expect(await screen.findByText('Build workstation')).toBeDefined()
    expect(screen.getByText(/已用 2 \/ 5 回合/)).toBeDefined()
    expect(screen.getByText('委派')).toBeDefined()
    const bare = face([])
    mount(bare)
    expect(await screen.findByText(zh.empty)).toBeDefined()
  })

  it('edits the granted surface through the inline toggles', async () => {
    const actions = face([peer()])
    mount(actions)
    fireEvent.click(await screen.findByText(zh.editSurface))
    const messageToggle = screen.getAllByRole('checkbox')[1]!
    fireEvent.click(messageToggle)
    fireEvent.click(screen.getByText(zh.saveSurface))
    await waitFor(() => {
      expect(actions.setSurface).toHaveBeenCalledWith({ instanceId: peerId, surface: { delegate: true, message: false, list: true } })
    })
  })

  it('approves and rejects parked widening requests', async () => {
    const actions = face([peer({ pendingSurface: { delegate: true, message: false, list: true } })])
    mount(actions)
    expect(await screen.findByText(/等待你的审批/)).toBeDefined()
    fireEvent.click(screen.getByText(zh.approve))
    await waitFor(() => { expect(actions.approveSurface).toHaveBeenCalledWith({ instanceId: peerId }) })
    fireEvent.click(screen.getByText(zh.reject))
    await waitFor(() => { expect(actions.rejectSurface).toHaveBeenCalledWith({ instanceId: peerId }) })
  })

  it('saves and lifts turn budgets with strict input bounds', async () => {
    const actions = face([peer({ monthlyTurns: 5, monthlyTurnsUsed: 5 })])
    mount(actions)
    const input = await screen.findByPlaceholderText(zh.budgetPlaceholder)
    fireEvent.change(input, { target: { value: 'soon' } })
    fireEvent.click(screen.getByText(zh.saveBudget))
    expect(await screen.findByText(zh.budgetInvalid)).toBeDefined()
    expect(actions.setBudget).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '40' } })
    fireEvent.click(screen.getByText(zh.saveBudget))
    await waitFor(() => { expect(actions.setBudget).toHaveBeenCalledWith({ instanceId: peerId, monthlyTurns: 40 }) })
    fireEvent.click(screen.getByText(zh.clearBudget))
    await waitFor(() => { expect(actions.setBudget).toHaveBeenCalledWith({ instanceId: peerId }) })
  })

  it('audits one peer\u2019s delegated sessions and collapses again', async () => {
    const actions = face([peer({ sessionCount: 1 })])
    mount(actions)
    fireEvent.click(await screen.findByText(zh.expand))
    expect(await screen.findByText('audit me')).toBeDefined()
    expect(screen.getByText(zh.sessionEnded)).toBeDefined()
    fireEvent.click(screen.getByText(zh.collapse))
    expect(screen.queryByText('audit me')).toBeNull()
  })

  it('removes one peer through the confirm step', async () => {
    const actions = face([peer()])
    mount(actions)
    fireEvent.click(await screen.findByText(zh.remove))
    fireEvent.click(screen.getByText(zh.confirmRemove))
    await waitFor(() => { expect(actions.remove).toHaveBeenCalledWith({ instanceId: peerId }) })
  })

  it('surfaces remote failures as localized copy', async () => {
    const actions = face([peer()], {
      setBudget: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'peer-failed', message: 'peer: STORE_FAILED (rename failed)', details: { reason: 'STORE_FAILED' } },
      })),
    })
    mount(actions)
    const input = await screen.findByPlaceholderText(zh.budgetPlaceholder)
    fireEvent.change(input, { target: { value: '9' } })
    fireEvent.click(screen.getByText(zh.saveBudget))
    expect(await screen.findByText(zh.errorStoreFailed)).toBeDefined()
  })

  it('surfaces list failures and render errors as operator copy', async () => {
    const failing = face([peer()], {
      list: vi.fn(async (): Promise<RemoteResult<{ peers: PeerAdminView[] }>> => {
        throw new Error('socket send failed')
      }),
    })
    mount(failing)
    expect(await screen.findByText('socket send failed')).toBeDefined()
    const refused = face([peer()], {
      list: vi.fn(async (): Promise<RemoteResult<{ peers: PeerAdminView[] }>> => ({
        ok: false,
        error: { code: 'peer-failed', message: 'peer: RECORD_NOT_FOUND', details: { reason: 'RECORD_NOT_FOUND' } },
      })),
    })
    mount(refused)
    expect(await screen.findByText(zh.errorRecordNotFound)).toBeDefined()
  })

  it('walks the surface editor open-cancel path and renders all-off badges', async () => {
    const actions = face([peer({ surface: { delegate: false, message: false, list: false } })])
    mount(actions)
    expect(await screen.findByText(/委派 \(关闭\)/)).toBeDefined()
    fireEvent.click(screen.getByText(zh.editSurface))
    fireEvent.click(screen.getByText(zh.collapse))
    expect(actions.setSurface).not.toHaveBeenCalled()
  })

  it('cancels a started removal and refreshes on demand', async () => {
    const actions = face([peer()])
    mount(actions)
    fireEvent.click(await screen.findByText(zh.remove))
    fireEvent.click(screen.getByText(zh.reject))
    expect(actions.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(zh.refresh))
    await waitFor(() => { expect(actions.list).toHaveBeenCalled() })
  })

  it('audits with running rows and reports audit failures', async () => {
    const actions = face([peer({ sessionCount: 2 })], {
      audit: vi.fn(async (): Promise<RemoteResult<{ sessions: PeerSessionSummary[] }>> => ({
        ok: true,
        value: { sessions: [{ ...session, state: 'running' }] },
      })),
    })
    mount(actions)
    fireEvent.click(await screen.findByText(zh.expand))
    expect(await screen.findByText(zh.sessionRunning)).toBeDefined()
    const failing = face([peer({ sessionCount: 1 })], {
      audit: vi.fn(async (): Promise<RemoteResult<{ sessions: PeerSessionSummary[] }>> => ({
        ok: false,
        error: { code: 'peer-failed', message: 'peer: STORE_FAILED', details: { reason: 'STORE_FAILED' } },
      })),
    })
    mount(failing)
    fireEvent.click(await screen.findByText(zh.expand))
    expect(await screen.findByText(zh.errorStoreFailed)).toBeDefined()
  })

  it('drops a stale listing when a newer refresh already answered', async () => {
    let releaseFirst: ((value: RemoteResult<{ peers: PeerAdminView[] }>) => void) | undefined
    let failFirst: ((cause: unknown) => void) | undefined
    const first = new Promise<RemoteResult<{ peers: PeerAdminView[] }>>((resolve, reject) => {
      releaseFirst = resolve
      failFirst = reject
    })
    const calls: Array<Promise<RemoteResult<{ peers: PeerAdminView[] }>>> = []
    const actions = face([peer()], {
      list: vi.fn(async (): Promise<RemoteResult<{ peers: PeerAdminView[] }>> => {
        const result = calls.shift()
        if (result !== undefined) return await result
        return { ok: true, value: { peers: [peer({ displayName: 'Fresh answer' })] } }
      }),
    })
    calls.push(first)
    const { tick } = mount(actions)
    tick.bump()
    await screen.findByText('Fresh answer')
    failFirst?.('stale refusal')
    // The stale rejection arrived after a newer refresh answered, so its error is dropped too.
    await waitFor(() => { expect(screen.queryByText('stale refusal')).toBeNull() })
    const second = new Promise<RemoteResult<{ peers: PeerAdminView[] }>>((resolve) => { releaseFirst = resolve })
    calls.push(second)
    tick.bump()
    // Flush between bumps so React delivers each tick as its own effect run.
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    tick.bump()
    await waitFor(() => { expect(screen.queryByText('Fresh answer')).not.toBeNull() })
    releaseFirst?.({ ok: true, value: { peers: [peer({ displayName: 'Stale answer' })] } })
    // Let the stale resolution run its continuation before asserting it never landed.
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(screen.queryByText('Stale answer')).toBeNull()
  })

  it('reports action throws through the view error line', async () => {
    const actions = face([peer()], {
      setSurface: vi.fn(async (): Promise<RemoteResult<PeerAdminView>> => { throw new Error('agent refused') }),
    })
    mount(actions)
    fireEvent.click(await screen.findByText(zh.editSurface))
    fireEvent.click(screen.getByText(zh.saveSurface))
    expect(await screen.findByText('agent refused')).toBeDefined()
  })

  it('stringifies non-Error listing throws while the generation is current', async () => {
    const actions = face([peer()], {
      list: vi.fn(async (): Promise<RemoteResult<{ peers: PeerAdminView[] }>> => { throw 'listing refused' }),
    })
    mount(actions)
    expect(await screen.findByText('listing refused')).toBeDefined()
  })

  it('stringifies non-Error action throws', async () => {
    const actions = face([peer()], {
      setSurface: vi.fn(async (): Promise<RemoteResult<PeerAdminView>> => { throw 'raw refusal' }),
    })
    mount(actions)
    fireEvent.click(await screen.findByText(zh.editSurface))
    fireEvent.click(screen.getByText(zh.saveSurface))
    expect(await screen.findByText('raw refusal')).toBeDefined()
  })

  it('labels idle audit rows and full pending banners', async () => {
    const actions = face([peer({ sessionCount: 1, pendingSurface: { delegate: true, message: true, list: true } })], {
      audit: vi.fn(async (): Promise<RemoteResult<{ sessions: PeerSessionSummary[] }>> => ({
        ok: true,
        value: { sessions: [{ ...session, state: 'idle' }] },
      })),
    })
    mount(actions)
    await screen.findByText('Build workstation')
    fireEvent.click(screen.getByText(zh.expand))
    expect(await screen.findByText(zh.sessionIdle)).toBeDefined()
    expect(screen.getByText(/委派 \+ 消息 \+ 列表/)).toBeDefined()
  })

  it('re-lists when the pairing-event tick moves', async () => {
    const actions = face([peer()])
    const { tick } = mount(actions)
    await screen.findByText('Build workstation')
    tick.bump()
    await waitFor(() => { expect(actions.list).toHaveBeenCalledTimes(2) })
  })
})


describe('issue localization', () => {
  it('maps every closed reason and foreign failures to operator copy', async () => {
    const { peerIssue, resultError } = await import('../src/client/issues.ts')
    const failure = (reason: unknown, message?: unknown, code?: string) => ({ code: code ?? 'peer-failed', message, details: { reason }  }) as RemoteFailure
    expect(peerIssue(t, failure('INVALID_PAYLOAD', 'raw'))).toBe(zh.errorInvalidPayload)
    expect(peerIssue(t, failure('CORRUPT_INSTANCE', 'raw'))).toBe(zh.errorCorruptInstance)
    expect(peerIssue(t, failure(undefined, 'wire message'))).toBe('wire message')
    expect(peerIssue(t, failure(undefined, '', 'other-code'))).toBe(zh.actionFailed)
    expect(peerIssue(t, failure(42, 'wire message'))).toBe('wire message')
    expect(resultError(t, { ok: true as const, value: 1 })).toBeUndefined()
    expect(resultError(t, { ok: false, error: failure('STORE_FAILED') })).toEqual(new Error(zh.errorStoreFailed))
  })
})
