// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleRecord } from '@deepseek-ai/dsh-scheduler/client'
import { ScheduleListAction, type ScheduleListActionProps } from '../src/client/ScheduleListAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: ScheduleListActionProps['t'] = makeTranslate(zh)

function record(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'sched-1',
    prompt: 'nightly digest',
    rule: { kind: 'after', delayMs: 60_000 },
    target: { kind: 'current' },
    contextMode: 'continue',
    status: 'active',
    createdBy: { kind: 'user', sessionId: 'session' },
    createdAt: 1,
    nextDue: 2,
    ...over,
  } as ScheduleRecord
}

interface Face {
  rows: ScheduleRecord[]
  update?: (id: string, patch: { status?: 'active' | 'paused' }) => Promise<{ ok: true; value: ScheduleRecord | undefined }>
  remove?: (id: string) => Promise<{ ok: true; value: boolean }>
}

function props(face: Face): ScheduleListActionProps {
  const update = face.update ?? vi.fn(async (id: string, patch: { status?: 'active' | 'paused' }) => ({
    ok: true as const,
    value: face.rows.find(row => row.id === id) !== undefined
      ? { ...face.rows.find(row => row.id === id)!, ...patch }
      : undefined,
  }))
  const remove = face.remove ?? vi.fn(async () => ({ ok: true as const, value: true }))
  return {
    onRefresh: vi.fn(async () => ({ ok: true as const, value: face.rows })),
    onUpdate: update,
    onRemove: remove,
    sessionId: 'session',
    t,
  } as unknown as ScheduleListActionProps
}

describe('ScheduleListAction', () => {
  it('renders nothing while the first refresh is pending and when the session owns none', async () => {
    const face: Face = { rows: [] }
    const { container } = render(<ScheduleListAction {...props(face)} />)
    expect(container.firstChild).toBeNull()
    await waitFor(() => { expect(screen.queryByRole('button')).toBeNull() })
  })

  it('shows the trigger after rows arrive and lists them with due moments', async () => {
    const face: Face = { rows: [record()] }
    render(<ScheduleListAction {...props(face)} />)
    const trigger = await screen.findByRole('button', { name: zh['count.active.one'].replace('{count}', '1') })
    fireEvent.click(trigger)
    const list = await screen.findByRole('list', { name: zh['list.aria'] })
    const row = within(list).getByRole('listitem')
    expect(row.textContent).toContain('nightly digest')
    expect(within(list).getAllByRole('button', { name: zh['action.pause'] })).toHaveLength(1)
    expect(within(list).getAllByRole('button', { name: zh['action.delete'] })).toHaveLength(1)
  })

  it('counts paused rows under the paused label', async () => {
    const face: Face = { rows: [record({ status: 'paused' })] }
    render(<ScheduleListAction {...props(face)} />)
    await screen.findByRole('button', { name: zh['count.paused.one'].replace('{count}', '1') })
  })

  it('pause and delete go through the verbs and refresh afterwards', async () => {
    const face: Face = { rows: [record(), record({ id: 'sched-2', status: 'paused' })] }
    const rendered = props(face)
    render(<ScheduleListAction {...rendered} />)
    const trigger = await screen.findByRole('button', { name: zh['count.active.one'].replace('{count}', '1') })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: zh['action.pause'] }))
    await waitFor(() => { expect(rendered.onUpdate).toHaveBeenCalledWith('sched-1', { status: 'paused' }) })
    const deletes = await screen.findAllByRole('button', { name: zh['action.delete'] })
    fireEvent.click(deletes[1]!)
    await waitFor(() => { expect(rendered.onRemove).toHaveBeenCalledWith('sched-2') })
  })

  it('settled rows render without action buttons', async () => {
    const face: Face = { rows: [(() => { const row = record({ id: 'done-1', status: 'done' }); delete (row as { nextDue?: number }).nextDue; return row })()] }
    render(<ScheduleListAction {...props(face)} />)
    const trigger = await screen.findByRole('button')
    fireEvent.click(trigger)
    const list = await screen.findByRole('list', { name: zh['list.aria'] })
    expect(within(list).queryByRole('button', { name: zh['action.pause'] })).toBeNull()
    expect(within(list).queryByRole('button', { name: zh['action.delete'] })).toBeNull()
    expect(within(list).getByText(zh['due.none'])).toBeDefined()
  })
})
