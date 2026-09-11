import { describe, expect, it, vi } from 'vitest'
import * as invariant from '@deepseek-ai/dsh-command-reset/invariant'

describe('command-reset invariant companion', () => {
  it('registers the package-owned no-op installer', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never
    const dispose = await invariant.apply(ctx)
    expect(invariant.name).toBe('command-reset-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-command-reset', expect.any(Function))
    expect(() => {
      const install = register.mock.calls[0]![1] as () => void
      install()
    }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
