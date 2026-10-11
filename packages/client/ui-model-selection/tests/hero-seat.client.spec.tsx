// @vitest-environment jsdom
/** Model-profile hero chip: controller staging plus the chip's rendering contract. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient, RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelProfileSeat } from '../src/client/ModelProfileSeat.tsx'
import type { ModelProfileSeatProps } from '../src/client/ModelProfileSeat.tsx'
import { ModelProfileSeatController } from '../src/client/hero-store.ts'
import type { SeatSessionSummary } from '../src/client/hero-store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ComponentProps<typeof ModelProfileSeat>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `s-${nextRpc++}` as never, result: { ok: true, value } }
}
function refused<T>(message: string): RpcResponse<T> {
  return {
    rpcId: `s-${nextRpc++}` as never,
    result: { ok: false, error: { code: 'model-unavailable', message, details: { provider: 'deepseek-official', model: 'deepseek-chat' } } },
  }
}

const ROSTER = {
  defaultProfileId: 'unrestricted',
  profiles: [
    { id: 'unrestricted', name: 'Unrestricted', unrestricted: true },
    { id: 'focused', name: '专注', unrestricted: false },
  ],
}

function face(overrides: Partial<Record<'modelProfiles' | 'models' | 'selectModelProfile', ReturnType<typeof vi.fn>>> = {}) {
  return {
    llm: { modelProfiles: overrides.modelProfiles ?? vi.fn(() => Promise.resolve(ok(ROSTER))) },
    sessions: {
      models: overrides.models ?? vi.fn(() => Promise.resolve(ok({
        current: { provider: 'deepseek-official', model: 'deepseek-chat' },
        profile: { id: 'unrestricted', name: 'Unrestricted', unrestricted: true },
        routable: true,
        groups: [],
        failures: [],
      }))),
      selectModelProfile: overrides.selectModelProfile ?? vi.fn(() => Promise.resolve(ok({
        profile: ROSTER.profiles[1]!,
      }))),
    },
  } as unknown as Pick<IApiClient, 'llm' | 'sessions'>
}

describe('ModelProfileSeatController', () => {
  function boot(
    api: Pick<IApiClient, 'llm' | 'sessions'>,
    session: () => SeatSessionSummary | undefined,
    startSession = vi.fn(),
  ) {
    return { seat: new ModelProfileSeatController(api, session, startSession), startSession }
  }

  it('loads the roster and defaults the display to the session profile', async () => {
    const { seat } = boot(face(), () => ({ id: 's1' as never, blank: true }))
    await seat.load()
    await seat.refreshSession()
    expect(seat.store.getSnapshot().options).toHaveLength(2)
    expect(seat.store.getSnapshot().current).toBe('unrestricted')
    expect(seat.store.getSnapshot().error).toBeNull()
    seat.reset()
    expect(seat.store.getSnapshot()).toEqual({ options: [], current: '', error: null, busy: false })
  })

  it('shows the deployment default once the session read refuses', async () => {
    const api = face({ models: vi.fn(() => Promise.resolve(refused('no agent'))) })
    const { seat } = boot(api, () => ({ id: 's1' as never, blank: true }))
    await seat.load()
    await seat.refreshSession()
    expect(seat.store.getSnapshot().current).toBe('unrestricted')
    expect(seat.store.getSnapshot().error).toBeNull()
  })

  it('surfaces roster failures without losing the previous options', async () => {
    const modelProfiles = vi.fn()
      .mockResolvedValueOnce(ok(ROSTER))
      .mockResolvedValueOnce(refused('policy offline'))
    const { seat } = boot(face({ modelProfiles }), () => undefined)
    await seat.load()
    await seat.load()
    expect(seat.store.getSnapshot().options).toHaveLength(2)
    expect(seat.store.getSnapshot().error).toBe('policy offline')
  })

  it('renders a rejected roster read as text', async () => {
    const modelProfiles = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce('disconnected')
    const { seat } = boot(face({ modelProfiles }), () => undefined)
    await seat.load()
    expect(seat.store.getSnapshot().error).toBe('offline')
    await seat.load()
    // Non-Error rejections still render as text.
    expect(seat.store.getSnapshot().error).toBe('disconnected')
  })

  it('ignores roster and session answers that outlive a newer operation', async () => {
    const rosterGate = Promise.withResolvers<RpcResponse<typeof ROSTER>>()
    const modelProfiles = vi.fn()
      .mockReturnValueOnce(rosterGate.promise)
      .mockResolvedValue(ok({ ...ROSTER, defaultProfileId: 'focused' }))
    const { seat } = boot(face({ modelProfiles }), () => undefined)
    const staleLoad = seat.load()
    await seat.load()
    expect(seat.store.getSnapshot().current).toBe('focused')
    // The stale read resolves last with a different default and must not win.
    rosterGate.resolve(ok(ROSTER))
    await staleLoad
    expect(seat.store.getSnapshot().current).toBe('focused')

    const modelsGate = Promise.withResolvers<RpcResponse<never>>()
    const models = vi.fn()
      .mockReturnValueOnce(modelsGate.promise)
      .mockResolvedValue(ok({
        current: { provider: 'deepseek-official', model: 'deepseek-chat' },
        profile: { id: 'focused', name: '专注', unrestricted: false },
        routable: true, groups: [], failures: [],
      }))
    let session: SeatSessionSummary | undefined = { id: 's1' as never, blank: true }
    const seat2 = new ModelProfileSeatController(face({ models }), () => session, vi.fn())
    await seat2.load()
    const staleRefresh = seat2.refreshSession()
    // A session move answers with its own read while the stale one pends.
    session = { id: 's2' as never, blank: true }
    await seat2.refreshSession()
    expect(seat2.store.getSnapshot().current).toBe('focused')
    // The stale read rejects after a reset cleared the seat; nothing publishes.
    seat2.reset()
    modelsGate.reject(new Error('offline'))
    await staleRefresh
    expect(seat2.store.getSnapshot()).toEqual({ options: [], current: '', error: null, busy: false })
  })

  it('skips the session re-read while the current session is unchanged', async () => {
    const models = vi.fn(() => Promise.resolve(ok({
      current: { provider: 'deepseek-official', model: 'deepseek-chat' },
      profile: { id: 'focused', name: '专注', unrestricted: false },
      routable: true, groups: [], failures: [],
    })))
    let session: SeatSessionSummary | undefined = { id: 's1' as never, blank: true }
    const { seat } = boot(face({ models }), () => session)
    await seat.load()
    await seat.refreshSession()
    expect(seat.store.getSnapshot().current).toBe('focused')

    // The same session again re-reads nothing.
    await seat.refreshSession()
    expect(models).toHaveBeenCalledOnce()

    session = undefined
    await seat.refreshSession()
    expect(seat.store.getSnapshot().current).toBe('unrestricted')
    expect(models).toHaveBeenCalledOnce()
  })

  it('keeps a pick staged when the current session already started', async () => {
    const selectModelProfile = vi.fn()
    const { seat } = boot(face({ selectModelProfile }), () => ({ id: 's1' as never, blank: false }))
    await seat.load()
    seat.select('focused')
    expect(selectModelProfile).not.toHaveBeenCalled()
    expect(seat.store.getSnapshot().current).toBe('focused')
    // With no stage or no session, reconciliation is a no-op.
    await seat.apply()
    expect(seat.store.getSnapshot().busy).toBe(false)
  })

  it('ignores reconciliation with nothing staged or no session to serve it', async () => {
    const { seat } = boot(face(), () => undefined)
    await seat.load()
    await seat.apply()
    expect(seat.store.getSnapshot().busy).toBe(false)
  })

  it('falls back to text when the session profile read rejects', async () => {
    const models = vi.fn().mockRejectedValue('disconnected')
    const { seat } = boot(face({ models }), () => ({ id: 's1' as never, blank: true }))
    await seat.load()
    await seat.refreshSession()
    expect(seat.store.getSnapshot().current).toBe('unrestricted')
    expect(seat.store.getSnapshot().error).toBeNull()
  })

  it('drops stale settlements and stages without a session to serve them', async () => {
    // A roster rejection that settles after a newer load publishes nothing.
    const rosterGate = Promise.withResolvers<never>()
    const modelProfiles = vi.fn()
      .mockReturnValueOnce(rosterGate.promise)
      .mockResolvedValue(ok(ROSTER))
    const { seat } = boot(face({ modelProfiles }), () => undefined)
    const staleLoad = seat.load()
    await seat.load()
    rosterGate.reject(new Error('offline'))
    await staleLoad
    expect(seat.store.getSnapshot().error).toBeNull()

    // A session read that settles after a newer one publishes nothing.
    const modelsGate = Promise.withResolvers<never>()
    const models = vi.fn()
      .mockReturnValueOnce(modelsGate.promise)
      .mockResolvedValue(ok({
        current: { provider: 'deepseek-official', model: 'deepseek-chat' },
        profile: { id: 'focused', name: '专注', unrestricted: false },
        routable: true, groups: [], failures: [],
      }))
    let session: SeatSessionSummary | undefined = { id: 's1' as never, blank: true }
    const seat2 = new ModelProfileSeatController(face({ models }), () => session, vi.fn())
    await seat2.load()
    const staleRefresh = seat2.refreshSession()
    session = { id: 's2' as never, blank: true }
    await seat2.refreshSession()
    expect(seat2.store.getSnapshot().current).toBe('focused')
    // The stale read settles last with the unrestricted profile and must not win.
    modelsGate.resolve(ok({
      current: { provider: 'deepseek-official', model: 'deepseek-chat' },
      profile: { id: 'unrestricted', name: 'Unrestricted', unrestricted: true },
      routable: true, groups: [], failures: [],
    }) as never)
    await staleRefresh
    expect(seat2.store.getSnapshot().current).toBe('focused')

    // A staged pick with no session to serve stays staged through reconciliation.
    seat2.reset()
    await seat2.load()
    seat2.select('focused')
    session = undefined
    await seat2.apply()
    expect(seat2.store.getSnapshot().busy).toBe(false)
    expect(seat2.store.getSnapshot().current).toBe('focused')
  })

  it('applies a pick live on the current blank session', async () => {
    const selectModelProfile = vi.fn(() => Promise.resolve(ok({ profile: ROSTER.profiles[1]! })))
    const { seat } = boot(face({ selectModelProfile }), () => ({ id: 's1' as never, blank: true }))
    await seat.load()
    await seat.refreshSession()

    seat.select('focused')
    await waitFor(() => { expect(seat.store.getSnapshot().busy).toBe(false) })
    expect(selectModelProfile).toHaveBeenCalledWith({ sessionId: 's1', profileId: 'focused' })
    expect(seat.store.getSnapshot().current).toBe('focused')
    expect(seat.store.getSnapshot().error).toBeNull()
  })

  it('starts a distinct session when none is current', async () => {
    const startSession = vi.fn()
    const { seat } = boot(face(), () => undefined, startSession)
    await seat.load()
    seat.select('focused')
    expect(startSession).toHaveBeenCalledWith('focused')
    expect(seat.store.getSnapshot().current).toBe('focused')
  })

  it('reconciles a staged pick onto a reused session born under another profile', async () => {
    const selectModelProfile = vi.fn(() => Promise.resolve(ok({ profile: ROSTER.profiles[1]! })))
    const world = { session: undefined as SeatSessionSummary | undefined }
    const { seat } = boot(face({ selectModelProfile }), () => world.session)
    await seat.load()
    seat.select('focused')
    world.session = { id: 's2' as never, blank: true }
    await seat.refreshSession()
    await seat.apply()
    expect(selectModelProfile).toHaveBeenCalledWith({ sessionId: 's2', profileId: 'focused' })
    expect(seat.store.getSnapshot().current).toBe('focused')
  })

  it('consumes a stage that the created session already carries', async () => {
    const selectModelProfile = vi.fn()
    const models = vi.fn(() => Promise.resolve(ok({
      current: { provider: 'deepseek-official', model: 'deepseek-chat' },
      profile: { id: 'focused', name: '专注', unrestricted: false },
      routable: true, groups: [], failures: [],
    })))
    const world = { session: undefined as SeatSessionSummary | undefined }
    const startSession = vi.fn(() => {
      // The started flow lands on a session born carrying the staged profile.
      world.session = { id: 's2' as never, blank: true }
    })
    const seat = new ModelProfileSeatController(face({ models, selectModelProfile }), () => world.session, startSession)
    await seat.load()
    seat.select('focused')
    expect(startSession).toHaveBeenCalledWith('focused')
    await seat.refreshSession()
    await seat.apply()
    expect(selectModelProfile).not.toHaveBeenCalled()
    expect(seat.store.getSnapshot().current).toBe('focused')
  })

  it('drops a stage whose session started running before it could serve', async () => {
    const world = { session: undefined as SeatSessionSummary | undefined }
    const { seat } = boot(face(), () => world.session)
    await seat.load()
    seat.select('focused')
    // The flow landed on a session that already started running.
    world.session = { id: 's2' as never, blank: false }
    await seat.apply()
    expect(seat.store.getSnapshot().busy).toBe(false)
    expect(seat.store.getSnapshot().current).toBe('unrestricted')
  })

  it('reports a refused live apply and clears the stage', async () => {
    const selectModelProfile = vi.fn(() => Promise.resolve(refused('unknown model profile "focused"')))
    const { seat } = boot(face({ selectModelProfile }), () => ({ id: 's1' as never, blank: true }))
    await seat.load()
    seat.select('focused')
    await waitFor(() => { expect(seat.store.getSnapshot().busy).toBe(false) })
    expect(seat.store.getSnapshot().error).toContain('unknown model profile')
    expect(seat.store.getSnapshot().current).toBe('unrestricted')
  })

  it('reports an unavailable selectModelProfile RPC as text', async () => {
    const api = face()
    delete (api.sessions as { selectModelProfile?: unknown }).selectModelProfile
    const { seat } = boot(api, () => ({ id: 's1' as never, blank: true }))
    await seat.load()
    seat.select('focused')
    await waitFor(() => { expect(seat.store.getSnapshot().busy).toBe(false) })
    expect(seat.store.getSnapshot().error).toBe('session.selectModelProfile is unavailable')
    expect(seat.store.getSnapshot().current).toBe('unrestricted')
  })

  it('reports a transport failure during a live apply as text', async () => {
    const selectModelProfile = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce('disconnected')
    const { seat } = boot(face({ selectModelProfile }), () => ({ id: 's1' as never, blank: true }))
    await seat.load()
    seat.select('focused')
    await waitFor(() => { expect(seat.store.getSnapshot().error).toBe('offline') })
    seat.select('focused')
    await waitFor(() => { expect(seat.store.getSnapshot().error).toBe('disconnected') })
  })

  it('ignores a pick while an apply is in flight', async () => {
    let settle: (() => void) | undefined
    const selectModelProfile = vi.fn(() => new Promise<never>((resolve) => {
      settle = (): void => { resolve(ok({ profile: ROSTER.profiles[1]! }) as never) }
    }))
    const { seat } = boot(face({ selectModelProfile }), () => ({ id: 's1' as never, blank: true }))
    await seat.load()
    seat.select('focused')
    seat.select('unrestricted')
    expect(selectModelProfile).toHaveBeenCalledOnce()
    settle!()
    await waitFor(() => { expect(seat.store.getSnapshot().busy).toBe(false) })
  })
})

describe('ModelProfileSeat', () => {
  function mount(options: readonly { id: string; name: string; unrestricted: boolean }[], current: string) {
    const store = createSnapshotStore({
      options, current, error: null, busy: false,
    })
    const actions = {
      load: vi.fn(() => Promise.resolve()),
      refreshSession: vi.fn(() => Promise.resolve()),
      apply: vi.fn(() => Promise.resolve()),
      select: vi.fn(),
    }
    render(<ModelProfileSeat {...({
      ...actions,
      useModelProfileSeat: bindSnapshotSelector(store),
      t,
    } as unknown as ModelProfileSeatProps)} />)
    return actions
  }

  it('renders nothing while only the built-in profile exists', () => {
    mount([{ id: 'unrestricted', name: 'Unrestricted', unrestricted: true }], 'unrestricted')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders the chip and submits a pick through the menu', async () => {
    const actions = mount(ROSTER.profiles, 'unrestricted')
    const chip = screen.getByRole('button', { name: t('seat.aria', { profile: '不限制' }) })
    fireEvent.click(chip)
    fireEvent.click(await screen.findByRole('menuitem', { name: '专注' }))
    expect(actions.select).toHaveBeenCalledWith('focused')

    // The menu's own dismissal closes it without a pick.
    fireEvent.click(chip)
    await screen.findByRole('menuitem', { name: '专注' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('menuitem', { name: '专注' })).toBeNull() })
  })

  it('falls back to the unselected label while the display choice is unknown', () => {
    mount(ROSTER.profiles, '')
    expect(screen.getByRole('button', { name: t('seat.aria', { profile: t('seat.selectAria') }) })).toBeTruthy()
  })

  it('exposes a rejected apply through the trigger title', () => {
    const store = createSnapshotStore({
      options: ROSTER.profiles, current: 'unrestricted', error: 'boom', busy: false,
    })
    render(<ModelProfileSeat {...({
      load: () => Promise.resolve(),
      refreshSession: () => Promise.resolve(),
      apply: () => Promise.resolve(),
      select: vi.fn(),
      useModelProfileSeat: bindSnapshotSelector(store),
      t,
    } as unknown as ModelProfileSeatProps)} />)
    expect(screen.getByTitle('boom')).toBeTruthy()
  })
})
