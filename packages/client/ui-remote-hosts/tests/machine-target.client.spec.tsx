// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MachineTarget, type MachineTargetProps } from '../src/client/MachineTarget.tsx'
import { zh } from '../src/client/target-locales.ts'

afterEach(cleanup)

describe('current machine navigation', () => {
  it('names the local machine and has no return action', () => {
    render(<MachineTarget {...props({ kind: 'host' })} />)
    expect(screen.getByText(zh.host)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.returnHost })).toBeNull()
  })

  it('returns immediately while remote machine naming is unavailable, in wide and rail modes', async () => {
    const naming = Promise.withResolvers<string | undefined>()
    const returned = vi.fn()
    const remote = props({ kind: 'remote', id: 'remote-id' })
    const view = render(<MachineTarget {...remote} nameOf={() => naming.promise} returnToHost={returned} />)
    expect(screen.getByText('remote-id')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.returnHost }))
    expect(returned).toHaveBeenCalledOnce()
    await act(async () => { naming.reject(new Error('offline')) })
    view.rerender(<MachineTarget {...remote} wide={false} returnToHost={returned} />)
    fireEvent.click(screen.getByRole('button', { name: zh.returnHost }))
    expect(returned).toHaveBeenCalledTimes(2)
  })

  it('ignores a late name from the previous remote selection', async () => {
    const first = Promise.withResolvers<string | undefined>()
    const second = Promise.withResolvers<string | undefined>()
    const nameOf = (id: string) => id === 'first' ? first.promise : second.promise
    const view = render(<MachineTarget {...props({ kind: 'remote', id: 'first' })} nameOf={nameOf} />)
    view.rerender(<MachineTarget {...props({ kind: 'remote', id: 'second' })} nameOf={nameOf} />)
    await act(async () => { second.resolve('Build machine') })
    await act(async () => { first.resolve('Old machine') })
    expect(screen.getByText('Build machine')).toBeTruthy()
    expect(screen.queryByText('Old machine')).toBeNull()
  })

  it('ignores a late failed name and reports a failed return without hiding the return action', async () => {
    const pending = Promise.withResolvers<string | undefined>()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const view = render(<MachineTarget {...props({ kind: 'remote', id: 'first' })} nameOf={() => pending.promise}
        returnToHost={() => Promise.reject(new Error('offline'))} />)
      view.rerender(<MachineTarget {...props({ kind: 'remote', id: 'second' })} />)
      await act(async () => { pending.reject(new Error('old host unavailable')) })
      expect(screen.getByText('second')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: zh.returnHost }))
      await act(async () => { await Promise.resolve() })
      // The second target supplies its own return action, not the retired one.
      expect(log).not.toHaveBeenCalled()
      view.rerender(<MachineTarget {...props({ kind: 'remote', id: 'second' })}
        returnToHost={() => Promise.reject(new Error('offline'))} />)
      fireEvent.click(screen.getByRole('button', { name: zh.returnHost }))
      await act(async () => { await Promise.resolve() })
      expect(log).toHaveBeenCalledWith('machine return failed:', expect.any(Error))
    } finally { log.mockRestore() }
  })
})

function props(target: import('@deepseek-ai/dsh-api-remotes/client').MachineTarget): MachineTargetProps {
  return { wide: true, useMachine: selector => selector(target), nameOf: async () => undefined,
    returnToHost: () => {}, t: makeTranslate(zh), useSessions: (() => undefined) as never, useWorkspaces: (() => undefined) as never }
}
