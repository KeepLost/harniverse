// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleCreateRemoteInput, ScheduleRecord } from '@deepseek-ai/dsh-scheduler/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import {
  ScheduleEditorDrawer,
  type ScheduleEditorDrawerProps,
} from '../src/client/ScheduleEditorDrawer.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: ScheduleEditorDrawerProps['t'] = makeTranslate(zh)

const sessionLabel = (id: SessionId): string => `session:${id}`

function record(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
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

type RemoteOk<T> = { ok: true; value: T }
type RemoteErr = { ok: false; error: { code: string; message: string; details: object } }

function verbs() {
  return {
    create: vi.fn(async (): Promise<RemoteOk<ScheduleRecord> | RemoteErr> => ({ ok: true, value: record() })),
    update: vi.fn(async (): Promise<RemoteOk<ScheduleRecord | undefined> | RemoteErr> => ({ ok: true, value: record() })),
    remove: vi.fn(async (): Promise<RemoteOk<boolean> | RemoteErr> => ({ ok: true, value: true })),
  }
}

function mount(props: Partial<ScheduleEditorDrawerProps> & { record?: ScheduleRecord } = {}) {
  const face = verbs()
  const onClose = vi.fn()
  const onSaved = vi.fn(async () => {})
  const sessionIds = props.sessionIds ?? ['session-a', 'session-b'] as SessionId[]
  render(
    <ScheduleEditorDrawer
      record={props.record}
      ownerSessionId={'ownerSessionId' in props ? props.ownerSessionId : ('session-a' as SessionId)}
      sessionIds={sessionIds}
      sessionLabel={sessionLabel}
      runs={props.runs ?? []}
      verbs={face}
      onClose={onClose}
      onSaved={onSaved}
      t={t}
    />,
  )
  return { face, onClose, onSaved }
}

describe('ScheduleEditorDrawer', () => {
  it('creates with a named-session target selected from the session list', async () => {
    const { face, onClose } = mount()
    fireEvent.change(screen.getByLabelText(zh['editor.prompt']), { target: { value: '周报' } })
    fireEvent.change(screen.getByLabelText(zh['editor.target']), { target: { value: 'session' } })
    fireEvent.change(screen.getByLabelText(zh['editor.targetSession']), { target: { value: 'session-b' } })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.save'] }))
    await waitFor(() => {
      expect(face.create).toHaveBeenCalledWith('session-a', {
        prompt: '周报',
        rule: { kind: 'after', delayMs: 5 * 60_000 },
        target: { kind: 'session', sessionId: 'session-b' },
        contextMode: 'continue',
      })
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('creates a fresh job schedule at an explicit time', async () => {
    const { face } = mount()
    fireEvent.change(screen.getByLabelText(zh['editor.prompt']), { target: { value: '新鲜任务' } })
    fireEvent.change(screen.getByLabelText(zh['editor.target']), { target: { value: 'job' } })
    fireEvent.change(screen.getByLabelText(zh['editor.rule']), { target: { value: 'at' } })
    fireEvent.change(screen.getByLabelText(zh['editor.at']), { target: { value: '2099-01-02T03:04' } })
    fireEvent.change(screen.getByLabelText(zh['editor.context']), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.save'] }))
    await waitFor(() => { expect(face.create).toHaveBeenCalledTimes(1) })
    const input = (face.create.mock.calls[0] as unknown as [SessionId, ScheduleCreateRemoteInput])[1]
    expect(input?.target).toEqual({ kind: 'job' })
    expect(input?.contextMode).toBe('fresh')
    expect(input?.rule.kind).toBe('at')
  })

  it('falls back to an empty target session when creation has no owner or sessions', () => {
    mount({ ownerSessionId: undefined, sessionIds: [] })
    fireEvent.change(screen.getByLabelText(zh['editor.target']), { target: { value: 'session' } })
    const targetSession = screen.getByLabelText(zh['editor.targetSession']) as unknown as { value: string }
    expect(targetSession.value).toBe('')
  })

  it('keeps save disabled until the prompt is non-empty', () => {
    mount()
    const save = screen.getByRole('button', { name: zh['editor.save'] })
    expect(save.getAttribute('disabled')).not.toBeNull()
    fireEvent.change(screen.getByLabelText(zh['editor.prompt']), { target: { value: 'x' } })
    expect(save.getAttribute('disabled')).toBeNull()
  })

  it('ignores a submit while the draft is invalid', () => {
    mount()
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes without verbs when nothing changed in edit mode', async () => {
    const { face, onClose } = mount({ record: record() })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.save'] }))
    expect(face.update).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed save as an alert and stays open', async () => {
    const { face } = mount({ record: record() })
    face.update.mockResolvedValue({ ok: false, error: { code: 'denied', message: 'capability missing', details: {} } })
    fireEvent.change(screen.getByLabelText(zh['editor.prompt']), { target: { value: 'next' } })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.save'] }))
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(screen.getByText(zh['editor.failure'].replace('{error}', 'capability missing'))).toBeTruthy()
  })

  it('surfaces a non-Error create rejection as text', async () => {
    const { face } = mount()
    face.create.mockRejectedValue('create failed')
    fireEvent.change(screen.getByLabelText(zh['editor.prompt']), { target: { value: 'next' } })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.save'] }))
    await waitFor(() => { expect(screen.getByText(zh['editor.failure'].replace('{error}', 'create failed'))).toBeTruthy() })
  })

  it('surfaces a failed create result as an alert', async () => {
    const { face } = mount()
    face.create.mockResolvedValue({ ok: false, error: { code: 'denied', message: 'create denied', details: {} } })
    fireEvent.change(screen.getByLabelText(zh['editor.prompt']), { target: { value: 'next' } })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.save'] }))
    await waitFor(() => { expect(screen.getByText(zh['editor.failure'].replace('{error}', 'create denied'))).toBeTruthy() })
  })

  it('surfaces a failed delete as an alert and stays open', async () => {
    const { face, onClose } = mount({ record: record() })
    face.remove.mockResolvedValue({ ok: false, error: { code: 'denied', message: 'cannot delete', details: {} } })
    fireEvent.click(screen.getByRole('button', { name: zh['action.delete'] }))
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(screen.getByText(zh['editor.failure'].replace('{error}', 'cannot delete'))).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('surfaces a non-Error delete rejection as text', async () => {
    const { face } = mount({ record: record() })
    face.remove.mockRejectedValue('delete failed')
    fireEvent.click(screen.getByRole('button', { name: zh['action.delete'] }))
    await waitFor(() => { expect(screen.getByText(zh['editor.failure'].replace('{error}', 'delete failed'))).toBeTruthy() })
  })

  it('locks rule editing for finished schedules', () => {
    mount({ record: record({ status: 'done' }) })
    expect(screen.getByText(zh['editor.ruleLocked'])).toBeTruthy()
    expect(screen.queryByLabelText(zh['editor.every'])).toBeNull()
  })

  it('renders at and fresh fields in edit mode and saves a status-only change', async () => {
    const edited = record({
      rule: { kind: 'at', at: '2099-01-02T03:04:00.000Z' },
      contextMode: 'fresh',
      target: { kind: 'job' },
      jobSessionId: 'session-b' as SessionId,
    })
    const { face } = mount({ record: edited })
    expect(screen.getByText(zh['target.job'] + ' · session:session-b')).toBeTruthy()
    expect(screen.getByDisplayValue('2099-01-02T03:04')).toBeTruthy()
    expect(screen.getByText(zh['editor.context.fresh'])).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh['editor.status']), { target: { value: 'paused' } })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.save'] }))
    await waitFor(() => {
      const [id, patch] = face.update.mock.calls[0] as unknown as [string, { status: string; rule: object }]
      expect(id).toBe('sched-1')
      expect(patch.status).toBe('paused')
      expect(patch.rule).toBeTypeOf('object')
    })
  })

  it('builds an after rule patch and handles non-Escape keys', async () => {
    const edited = record({ rule: { kind: 'after', delayMs: 5 * 60_000 }, target: { kind: 'job' } })
    const { face, onClose } = mount({ record: edited })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(zh['target.job'])).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh['editor.after']), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.save'] }))
    await waitFor(() => { expect(face.update).toHaveBeenCalledWith('sched-1', expect.objectContaining({ rule: { kind: 'after', delayMs: 10 * 60_000 } })) })
  })

  it('deletes the edited record through the drawer and closes', async () => {
    const { face, onClose, onSaved } = mount({ record: record() })
    fireEvent.click(screen.getByRole('button', { name: zh['action.delete'] }))
    await waitFor(() => { expect(face.remove).toHaveBeenCalledWith('sched-1') })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('closes on cancel and on Escape without saving', () => {
    const { face, onClose } = mount({ record: record() })
    fireEvent.click(screen.getByRole('button', { name: zh['editor.cancel'] }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(face.update).not.toHaveBeenCalled()
    expect(face.remove).not.toHaveBeenCalled()
  })

  it('shows the no-session note and keeps save disabled without an owner', () => {
    mount({ ownerSessionId: undefined })
    expect(screen.getByText(zh['editor.noSession'])).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh['editor.prompt']), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: zh['editor.save'] }).getAttribute('disabled')).not.toBeNull()
  })

  it('shows an empty named-session choice when no sessions are available', () => {
    mount({ sessionIds: [] })
    fireEvent.change(screen.getByLabelText(zh['editor.target']), { target: { value: 'session' } })
    expect(screen.getByText(zh['editor.noSession'])).toBeTruthy()
    expect(screen.getByLabelText(zh['editor.targetSession']).getAttribute('disabled')).not.toBeNull()
  })
})
