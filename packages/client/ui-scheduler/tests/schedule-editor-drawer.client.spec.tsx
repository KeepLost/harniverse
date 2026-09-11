// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleRecord } from '@deepseek-ai/dsh-scheduler/client'
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
  const sessionIds = ['session-a', 'session-b'] as SessionId[]
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

  it('keeps save disabled until the prompt is non-empty', () => {
    mount()
    const save = screen.getByRole('button', { name: zh['editor.save'] })
    expect(save.getAttribute('disabled')).not.toBeNull()
    fireEvent.change(screen.getByLabelText(zh['editor.prompt']), { target: { value: 'x' } })
    expect(save.getAttribute('disabled')).toBeNull()
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

  it('locks rule editing for finished schedules', () => {
    mount({ record: record({ status: 'done' }) })
    expect(screen.getByText(zh['editor.ruleLocked'])).toBeTruthy()
    expect(screen.queryByLabelText(zh['editor.every'])).toBeNull()
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
})
