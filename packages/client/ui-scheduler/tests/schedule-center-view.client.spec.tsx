// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleCreateRemoteInput, ScheduleRecord, ScheduleRun, ScheduleUpdate } from '@deepseek-ai/dsh-scheduler/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { createScheduleViewStore } from '../src/client/stores.ts'
import {
  ScheduleCenterView,
  type ScheduleCenterActions,
  type ScheduleCenterViewProps,
} from '../src/client/ScheduleCenterView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: ScheduleCenterViewProps['t'] = makeTranslate(zh)

type RecordOverrides = Partial<Omit<ScheduleRecord, 'nextDue'>> & { nextDue?: number | undefined }

function record(over: RecordOverrides = {}): ScheduleRecord {
  return {
    id: 'sched-1',
    prompt: 'nightly digest',
    rule: { kind: 'every', intervalMs: 30 * 60_000, anchor: '2026-09-11T00:00:00.000Z' },
    target: { kind: 'current' },
    contextMode: 'continue',
    status: 'active',
    createdBy: { kind: 'user', sessionId: 'session-a' },
    createdAt: 1,
    nextDue: 2,
    ...over,
  } as ScheduleRecord
}

function run(over: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    ownerSessionId: 'session-a',
    targetSessionId: 'session-b',
    dueAt: 1,
    attemptedAt: 2,
    status: 'succeeded',
    ...over,
  } as ScheduleRun
}

/** Verbs over an in-memory table: the fixture the assertions read back. */
function verbs(rows: readonly ScheduleRecord[], runs: readonly ScheduleRun[] = []) {
  const table = new Map(rows.map(row => [row.id, { ...row }]))
  return {
    listAll: vi.fn(async () => ({ ok: true as const, value: [...table.values()] })),
    runsOf: vi.fn(async (id: string) => ({ ok: true as const, value: runs.filter(item => item.scheduleId === id) })),
    create: vi.fn(async (owner: SessionId, input: Parameters<ScheduleCenterActions['create']>[1]) => {
      const created = record({ ...input, id: 'sched-new', createdBy: { kind: 'user', sessionId: owner } })
      table.set(created.id, created)
      return { ok: true as const, value: created }
    }),
    update: vi.fn(async (id: string, patch: Parameters<ScheduleCenterActions['update']>[1]) => {
      const current = table.get(id)
      if (current === undefined) return { ok: true as const, value: undefined }
      const next = { ...current, ...patch }
      table.set(id, next)
      return { ok: true as const, value: next }
    }),
    remove: vi.fn(async (id: string) => { table.delete(id); return { ok: true as const, value: true } }),
    closeView: vi.fn(),
  }
}

const sid = (value: string): SessionId => value as SessionId
const sessionsState = (): SessionListState => ({
  ids: [sid('session-a'), sid('session-b')],
  byId: {
    [sid('session-a')]: { id: sid('session-a'), displayTitle: '主会话', cwd: '/a', running: false, blank: false, updatedAt: 1 },
    [sid('session-b')]: { id: sid('session-b'), displayTitle: '任务会话', cwd: '/b', running: false, blank: false, updatedAt: 1 },
  },
  current: sid('session-a'),
  phase: 'ready',
} as SessionListState)

/** Mirror the framework's useSessions seat over a fixed snapshot value. */
function sessionsSeat(state: SessionListState) {
  return ((selector: (snapshot: SessionListState) => unknown) => selector(state)) as never
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

function mount(face: ReturnType<typeof verbs>, sessions = sessionsState()) {
  const instance = createScheduleViewStore().create()
  const props = {
    active: true,
    useSessions: sessionsSeat(sessions),
    useWorkspaces: ((selector: (snapshot: unknown) => unknown) => selector({})) as never,
    useStore: hookOf(instance),
    actions: instance.actions,
    ...face,
    t,
  } as unknown as ScheduleCenterViewProps
  const utils = render(<ScheduleCenterView {...props} />)
  return { instance, ...utils }
}

describe('ScheduleCenterView', () => {
  it('claims occupancy while mounted and releases it on unmount', () => {
    const { instance, unmount } = mount(verbs([]))
    expect(instance.getSnapshot().open).toBe(true)
    unmount()
    expect(instance.getSnapshot().open).toBe(false)
  })

  it('renders the global table with id, target, rule, and the latest run destination', async () => {
    const rows = [record(), record({
      id: 'sched-2',
      prompt: 'bind check',
      target: { kind: 'session', sessionId: sid('session-b') },
      status: 'paused',
    })]
    mount(verbs(rows, [run({ scheduleId: 'sched-1' }), run({ id: 'run-0', scheduleId: 'sched-2', status: 'failed', error: 'boom' })]))
    await waitFor(() => { expect(screen.getByText('nightly digest')).toBeTruthy() })
    expect(screen.getByText('sched-1'.slice(0, 8))).toBeTruthy()
    // current-target row shows the creator's session; the named row the bound one.
    expect(screen.getByTitle(`本会话 · 主会话 (#${'session-a'.slice(0, 8)})`)).toBeTruthy()
    expect(screen.getByTitle(`指定会话 · 任务会话 (#${'session-b'.slice(0, 8)})`)).toBeTruthy()
    // Rule summary in minutes and the status vocabulary.
    expect(screen.getAllByText(zh['rule.every'].replace('{minutes}', '30')).length).toBe(2)
    expect(screen.getAllByText(zh['status.active']).length).toBeGreaterThan(0)
    expect(screen.getAllByText(zh['status.paused']).length).toBeGreaterThan(0)
  })

  it('renders job and at rules, missing moments, completed status, and unknown sessions', async () => {
    const rows = [record({
      id: 'sched-at',
      rule: { kind: 'at', at: '2026-09-11T01:00:00.000Z' },
      target: { kind: 'job' },
      jobSessionId: sid('unknown-session'),
      nextDue: 3,
    }), record({
      id: 'sched-job',
      rule: { kind: 'after', delayMs: 60_000 },
      target: { kind: 'job' },
      nextDue: undefined,
      status: 'done',
    }), record({
      id: 'sched-undef-2',
      target: { kind: 'job' },
      nextDue: undefined,
    })]
    mount(verbs(rows))
    await waitFor(() => { expect(screen.getByTitle('sched-job')).toBeTruthy() })
    expect(screen.getByTitle('任务会话 · #unknown-')).toBeTruthy()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByText(zh['status.done'])).toBeTruthy()
    const completedRow = screen.getByTitle('sched-job').closest('tr')
    expect(completedRow).not.toBeNull()
    expect(within(completedRow as HTMLElement).queryByRole('button', { name: zh['action.pause'] })).toBeNull()
    expect(screen.getByText(zh['rule.after'].replace('{minutes}', '1'))).toBeTruthy()
  })

  it('shows no latest run when the history Remote fails and resumes paused rows', async () => {
    const face = verbs([record({ status: 'paused' })])
    face.runsOf.mockResolvedValue({ ok: false, error: { code: 'denied', message: 'no history', details: {} } } as never)
    mount(face)
    await waitFor(() => { expect(screen.getByText('nightly digest')).toBeTruthy() })
    expect(screen.getByText(zh['run.none'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['action.resume'] }))
    await waitFor(() => { expect(face.update).toHaveBeenCalledWith('sched-1', { status: 'active' }) })
  })

  it('pauses, resumes, and deletes through the global verbs, refreshing after each', async () => {
    const face = verbs([record()])
    mount(face)
    await waitFor(() => { expect(screen.getByText('nightly digest')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['action.pause'] }))
    await waitFor(() => { expect(face.update).toHaveBeenCalledWith('sched-1', { status: 'paused' }) })
    fireEvent.click(screen.getByRole('button', { name: zh['action.delete'] }))
    await waitFor(() => { expect(face.remove).toHaveBeenCalledWith('sched-1') })
    await waitFor(() => { expect(screen.getByText(zh['view.empty'])).toBeTruthy() })
  })

  it('shows the loading note first, then the error state with retry', async () => {
    const base = verbs([])
    type ListOutcome = { ok: true; value: ScheduleRecord[] } | { ok: false; error: { code: string; message: string; details: object } }
    const listAll = vi.fn(async (): Promise<ListOutcome> =>
      ({ ok: false, error: { code: 'denied', message: 'no capability', details: {} } }))
    const face = { ...base, listAll }
    mount(face as unknown as ReturnType<typeof verbs>)
    expect(screen.getByText(zh['view.loading'])).toBeTruthy()
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(screen.getByText(zh['view.error'])).toBeTruthy()
    listAll.mockResolvedValue({ ok: true, value: [] })
    fireEvent.click(screen.getByRole('button', { name: zh['view.retry'] }))
    await waitFor(() => { expect(screen.getByText(zh['view.empty'])).toBeTruthy() })
  })

  it('closes through the injected layout exit', async () => {
    const face = verbs([])
    mount(face)
    await waitFor(() => { expect(screen.getByText(zh['view.empty'])).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['view.close'] }))
    expect(face.closeView).toHaveBeenCalledTimes(1)
  })

  it('refreshes from the header action', async () => {
    const face = verbs([])
    mount(face)
    await waitFor(() => { expect(screen.getByText(zh['view.empty'])).toBeTruthy() })
    const calls = face.listAll.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: zh['view.refresh'] }))
    await waitFor(() => { expect(face.listAll.mock.calls.length).toBe(calls + 1) })
  })

  it('creates a schedule through the drawer bound to the current session', async () => {
    const face = verbs([])
    mount(face)
    await waitFor(() => { expect(screen.getByText(zh['view.empty'])).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['view.create'] }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(zh['editor.prompt']), { target: { value: '每天早报' } })
    fireEvent.change(within(dialog).getByLabelText(zh['editor.rule']), { target: { value: 'every' } })
    fireEvent.change(within(dialog).getByLabelText(zh['editor.every']), { target: { value: '15' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh['editor.save'] }))
    await waitFor(() => { expect(face.create).toHaveBeenCalledTimes(1) })
    const [owner, input] = face.create.mock.calls[0] as [SessionId, ScheduleCreateRemoteInput]
    expect(owner).toBe('session-a')
    expect(input.prompt).toBe('每天早报')
    expect(input.rule.kind).toBe('every')
    expect(input.rule.kind === 'every' && input.rule.intervalMs).toBe(15 * 60_000)
    expect(input.target).toEqual({ kind: 'current' })
    await waitFor(() => { expect(screen.getByText('每天早报')).toBeTruthy() })
  })

  it('edits prompt and rule through the drawer, surfacing run history with its destinations', async () => {
    const edited = record({
      prompt: '旧指令',
      target: { kind: 'session', sessionId: sid('session-b') },
    })
    const face = verbs([edited], [run({ attemptedAt: 5 }), run({ id: 'run-2', attemptedAt: 3, status: 'failed', error: '模型超时' })])
    mount(face)
    await waitFor(() => { expect(screen.getByText('旧指令')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['table.edit'] }))
    const dialog = await screen.findByRole('dialog')
    // Edit mode shows the read-only target summary and the run history with
    // each destination session.
    expect(within(dialog).getByText(`指定会话 · 任务会话 (#${'session-b'.slice(0, 8)})`)).toBeTruthy()
    expect(within(dialog).getAllByText(`任务会话 (#${'session-b'.slice(0, 8)})`).length).toBeGreaterThan(0)
    expect(within(dialog).getByText('模型超时')).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText(zh['editor.prompt']), { target: { value: '新指令' } })
    fireEvent.change(within(dialog).getByLabelText(zh['editor.rule']), { target: { value: 'after' } })
    fireEvent.change(within(dialog).getByLabelText(zh['editor.after']), { target: { value: '10' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh['editor.save'] }))
    await waitFor(() => { expect(face.update).toHaveBeenCalledTimes(1) })
    const [id, patch] = face.update.mock.calls[0] as unknown as [string, ScheduleUpdate]
    expect(id).toBe('sched-1')
    expect(patch.prompt).toBe('新指令')
    expect(patch.rule?.kind).toBe('after')
    expect(patch.rule?.kind === 'after' && patch.rule.delayMs).toBe(10 * 60_000)
    await waitFor(() => { expect(screen.getByText('新指令')).toBeTruthy() })
  })

  it('opens an editor with empty history when run history is unavailable', async () => {
    const face = verbs([record({ prompt: 'without history' })])
    face.runsOf.mockResolvedValue({ ok: false, error: { code: 'denied', message: 'history unavailable', details: {} } } as never)
    mount(face)
    await waitFor(() => { expect(screen.getByText('without history')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['table.edit'] }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(zh['run.none'])).toBeTruthy()
  })

  it('uses the first session as create owner when no session is current', async () => {
    const face = verbs([])
    const sessions = { ...sessionsState(), current: undefined } as SessionListState
    mount(face, sessions)
    await waitFor(() => { expect(screen.getByText(zh['view.empty'])).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['view.create'] }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(zh['editor.prompt']), { target: { value: 'fallback owner' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh['editor.save'] }))
    await waitFor(() => { expect(face.create).toHaveBeenCalledWith('session-a', expect.anything()) })
  })
})
