import { describe, expect, it, vi } from 'vitest'
import * as invariant from '@deepseek-ai/dsh-scheduler/invariant'

describe('scheduler invariant companion', () => {
  it('registers the package-owned installer and verifies dispatch targets', async () => {
    const listeners: ((session: unknown, event: unknown) => void)[] = []
    const fail = vi.fn(() => { throw new Error('invariant failure') })
    const register = vi.fn().mockImplementation((_name: string, installer: (ctx: unknown, fail: () => never) => void) => {
      installer({
        on: (event: string, listener: (session: unknown, event: unknown) => void) => {
          if (event === 'session/event') listeners.push(listener)
        },
      }, fail)
      return () => {}
    })
    const dispose = await invariant.apply({ invariants: { register } } as never)
    expect(invariant.name).toBe('scheduler-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-scheduler', expect.any(Function))
    expect(dispose).toBeTypeOf('function')

    const listener = listeners[0]!
    const session = { id: 'session-a' }
    listener(session, { type: 'schedule/dispatch', seq: 3, data: { scheduleId: 's1', dueAt: 1, targetSessionId: 'session-a', turn: null } })
    expect(fail).not.toHaveBeenCalled()
    expect(() => {
      listener(session, { type: 'schedule/dispatch', seq: 4, data: { scheduleId: 's2', dueAt: 1, targetSessionId: 'session-b', turn: null } })
    }).toThrow('invariant failure')
    expect(fail).toHaveBeenCalledTimes(1)
    listener(session, { type: 'turn/start', seq: 5, data: { turn: 1 } })
    expect(fail).toHaveBeenCalledTimes(1)
  })
})
