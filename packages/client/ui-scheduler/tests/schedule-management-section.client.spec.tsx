// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleRecord } from '@deepseek-ai/dsh-scheduler/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { ScheduleManagementSection } from '../src/client/ScheduleManagementSection.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = makeTranslate(zh)

function record(id: string, status: ScheduleRecord['status'] = 'active'): ScheduleRecord {
  return {
    id,
    prompt: `prompt-${id}`,
    rule: { kind: 'after', delayMs: 300_000 },
    target: { kind: 'current' },
    contextMode: 'continue',
    createdBy: { kind: 'user', sessionId: 's1' as SessionId },
    status,
    createdAt: 1,
    nextDue: 2,
    lastRunAt: 3,
    promptRevision: 1,
  }
}

function props(overrides: Record<string, unknown> = {}) {
  const list = vi.fn(async (sessionId: string) => ({
    ok: true as const,
    value: sessionId === 's1' ? [record('one')] : [record('two', 'paused')],
  }))
  return {
    useSessions: (selector: (state: { current: string }) => unknown) => selector({ current: 's1' }),
    useWorkspaces: (selector: (state: { items: unknown[]; recentWorkspaceId: string }) => unknown) => selector({
      items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }],
      recentWorkspaceId: 'w1',
    }),
    list,
    create: vi.fn(async () => ({ ok: true as const, value: record('created') })),
    update: vi.fn(async (_sessionId: string, id: string, patch: { prompt?: string; status?: ScheduleRecord['status'] }) => ({
      ok: true as const,
      value: { ...record(id), ...patch },
    })),
    runs: vi.fn(async () => ({
      ok: true as const,
      value: [{ id: 'run-1', scheduleId: 'one', ownerSessionId: 's1', targetSessionId: 's1', dueAt: 2, attemptedAt: 4, promptRevision: 1, status: 'succeeded' as const }],
    })),
    remove: vi.fn(async () => ({ ok: true as const, value: true })),
    locale: 'schedule',
    t,
    ...overrides,
  } as unknown as Parameters<typeof ScheduleManagementSection>[0]
}

describe('ScheduleManagementSection', () => {
  it('aggregates the current workspace and exposes schedule state', async () => {
    render(<ScheduleManagementSection {...props()} />)
    expect(await screen.findByText(zh['management.title'])).toBeDefined()
    expect(screen.getByText('prompt-one')).toBeDefined()
    expect(screen.getByText('prompt-two')).toBeDefined()
    expect(screen.getAllByText(/上次执行/)).toHaveLength(2)
    expect(screen.getAllByText(/成功/)).toHaveLength(2)
  })

  it('uses the current session without a workspace and renders completed failures', async () => {
    const done = record('done', 'done')
    Object.defineProperty(done, 'nextDue', { value: undefined, configurable: true, enumerable: true })
    Object.defineProperty(done, 'lastRunAt', { value: undefined, configurable: true, enumerable: true })
    Object.defineProperty(done, 'lastError', { value: 'connection lost', configurable: true, enumerable: true })
    const face = props({
      list: vi.fn(async () => ({ ok: true as const, value: [done, { ...done, id: 'done-2' }, record('later')] })),
      useWorkspaces: (
        selector: (state: { items: unknown[]; recentWorkspaceId: undefined }) => unknown,
      ) => selector({ items: [], recentWorkspaceId: undefined }),
    })
    render(<ScheduleManagementSection {...face} />)
    expect(await screen.findAllByText('prompt-done')).toHaveLength(2)
    expect(screen.getAllByText(/上次失败/)).toHaveLength(2)
    expect(screen.getAllByText('下次执行: —')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: zh['action.pause'] })).toHaveLength(1)
  })

  it('falls back to the most recently used workspace when the current session is ungrouped', async () => {
    const face = props({
      useSessions: (selector: (state: { current: string }) => unknown) => selector({ current: 'outside' }),
    })
    render(<ScheduleManagementSection {...face} />)
    await screen.findByText(zh['management.title'])
    expect(face.list).toHaveBeenCalledWith('s1')
    expect(face.list).toHaveBeenCalledWith('s2')
  })

  it('creates each supported rule shape and refreshes', async () => {
    const face = props()
    render(<ScheduleManagementSection {...face} />)
    await screen.findByText(zh['management.title'])
    const openCreate = (): HTMLElement => {
      const button = screen.getByRole('button', { name: zh['management.create'] })
      fireEvent.click(button)
      return screen.getByRole('button', { name: zh['management.save'] }).closest('form')!
    }
    let form = openCreate()
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'new prompt' } })
    fireEvent.click(within(form).getByRole('button', { name: zh['management.save'] }))
    await waitFor(() => { expect(face.create).toHaveBeenCalledWith('s1', expect.objectContaining({ prompt: 'new prompt' })) })
    form = openCreate()
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'at prompt' } })
    fireEvent.change(within(form).getByRole('combobox'), { target: { value: 'at' } })
    fireEvent.change(form.querySelector('input')!, { target: { value: '2030-01-01T12:00' } })
    fireEvent.click(within(form).getByRole('button', { name: zh['management.save'] }))
    await waitFor(() => { expect(face.create).toHaveBeenCalledTimes(2) })
    form = openCreate()
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'every prompt' } })
    fireEvent.change(within(form).getByRole('combobox'), { target: { value: 'every' } })
    fireEvent.click(within(form).getByRole('button', { name: zh['management.save'] }))
    await waitFor(() => { expect(face.create).toHaveBeenCalledTimes(3) })
  })

  it('edits, pauses, resumes, and deletes through the owning session', async () => {
    const face = props()
    render(<ScheduleManagementSection {...face} />)
    await screen.findByText('prompt-one')
    fireEvent.click(screen.getAllByRole('button', { name: zh['management.prompt'] })[0]!)
    fireEvent.change(screen.getByDisplayValue('prompt-one'), { target: { value: 'edited' } })
    fireEvent.click(screen.getAllByRole('button', { name: zh['management.save'] })[0]!)
    await waitFor(() => { expect(face.update).toHaveBeenCalledWith('s1', 'one', { prompt: 'edited' }) })
    fireEvent.click(screen.getAllByRole('button', { name: zh['action.pause'] })[0]!)
    await waitFor(() => { expect(face.update).toHaveBeenCalledWith('s1', 'one', { status: 'paused' }) })
    fireEvent.click(screen.getAllByRole('button', { name: zh['action.resume'] })[0]!)
    await waitFor(() => { expect(face.update).toHaveBeenCalledWith('s2', 'two', { status: 'active' }) })
    fireEvent.click(screen.getAllByRole('button', { name: zh['action.delete'] })[0]!)
    await waitFor(() => { expect(face.remove).toHaveBeenCalledWith('s1', 'one') })
    await waitFor(() => { expect(face.list).toHaveBeenCalledTimes(10) })
  })

  it('renders retry and disables creation when no session is selected', async () => {
    const list = vi.fn(async () => ({ ok: false as const, error: { message: 'offline' } }))
    const face = props({ list })
    render(<ScheduleManagementSection {...face} />)
    expect(await screen.findByText(zh['management.error'])).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh['management.retry'] }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(4) })
    cleanup()
    render(<ScheduleManagementSection {...props({
      useSessions: (
        selector: (state: { current: undefined }) => unknown,
      ) => selector({ current: undefined }),
      useWorkspaces: (
        selector: (state: { items: unknown[]; recentWorkspaceId: undefined }) => unknown,
      ) => selector({ items: [], recentWorkspaceId: undefined }),
    })} />)
    await screen.findByText(zh['management.empty'])
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['management.create'] }).disabled).toBe(true)
  })

  it('keeps an empty form inert and surfaces a create failure', async () => {
    const create = vi.fn(async () => ({ ok: false as const, error: { message: 'rejected' } }))
    const face = props({ create })
    render(<ScheduleManagementSection {...face} />)
    await screen.findByText(zh['management.title'])
    fireEvent.click(screen.getByRole('button', { name: zh['management.create'] }))
    const form = screen.getByRole('button', { name: zh['management.save'] }).closest('form')!
    fireEvent.submit(form)
    expect(create).not.toHaveBeenCalled()
    fireEvent.click(within(form).getByRole('button', { name: zh['management.cancel'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['management.create'] }))
    const secondForm = screen.getByRole('button', { name: zh['management.save'] }).closest('form')!
    fireEvent.change(within(secondForm).getByRole('textbox'), { target: { value: 'will fail' } })
    fireEvent.submit(secondForm)
    await waitFor(() => { expect(create).toHaveBeenCalled() })
  })

  it('renders failed history and survives a mutation failure', async () => {
    const face = props({
      runs: vi.fn(async () => ({
        ok: true as const,
        value: [{ id: 'run-failed', scheduleId: 'one', ownerSessionId: 's1', targetSessionId: 's1', dueAt: 2, attemptedAt: 4, promptRevision: 1, status: 'failed' as const, error: 'offline' }],
      })),
      update: vi.fn(async () => { throw new Error('offline') }),
    })
    render(<ScheduleManagementSection {...face} />)
    await screen.findAllByText(new RegExp(zh['management.failed']))
    fireEvent.click(screen.getAllByRole('button', { name: zh['action.pause'] })[0]!)
    await screen.findByText(zh['management.error'])
  })

  it('keeps a schedule visible when its history read is unavailable', async () => {
    const face = props({
      runs: vi.fn(async () => ({ ok: false as const, error: { message: 'not available' } })),
    })
    render(<ScheduleManagementSection {...face} />)
    await screen.findByText('prompt-one')
    expect(screen.getAllByText(/执行次数: 0/)).toHaveLength(2)
  })
})
