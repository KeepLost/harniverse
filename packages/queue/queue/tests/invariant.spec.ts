import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/invariant.ts'

type Installer = (ctx: unknown, fail: (message: string) => void) => void

/** Mount the companion and capture the registered installer wiring. */
async function mounted(): Promise<{ installers: Installer[]; dispatch: (event: unknown) => void; failures: string[] }> {
  const installers: Installer[] = []
  const failures: string[] = []
  const listeners: ((...args: unknown[]) => void)[] = []
  const ctx = new Context()
  const ctxLike = {
    on: (name: string, fn: (...args: unknown[]) => void) => {
      if (name === 'internal/dispatch') listeners.push(fn)
    },
  }
  ;(ctx as unknown as { invariants: unknown }).invariants = {
    register: (_name: string, installer: Installer) => {
      installers.push(installer)
      return () => {}
    },
  }
  await apply(ctx)
  await Promise.resolve()
  for (const installer of installers) installer(ctxLike, (message) => { failures.push(message) })
  const dispatch = (event: unknown): void => {
    for (const listener of listeners) listener('emit', 'session/event', [{ id: 's1' }, event])
  }
  return { installers, dispatch, failures }
}

describe('queue invariant companion', () => {
  it('passes well-formed queue deliveries and non-queue events', async () => {
    const { installers, dispatch, failures } = await mounted()
    expect(installers).toHaveLength(1)
    // Non user/message and non-queue events pass untouched.
    dispatch({ type: 'assistant/message', data: {} })
    dispatch({ type: 'user/message', data: { source: { kind: 'user' } } })
    dispatch({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'schedule' } } })
    dispatch({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'queue', topic: 'ops', offset: 3 } } })
    expect(failures).toHaveLength(0)
  })

  it('fails a queue delivery whose source lacks topic or offset', async () => {
    const { dispatch, failures } = await mounted()
    dispatch({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'queue' } } })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('lacks its topic/offset source')
  })
})
