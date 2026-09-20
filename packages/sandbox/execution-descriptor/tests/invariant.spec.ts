import { describe, expect, it, vi } from 'vitest'
import * as invariant from '@deepseek-ai/dsh-execution-descriptor/invariant'

describe('execution-descriptor invariant companion', () => {
  it('registers the package-owned explained-empty installer', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never
    const dispose = await invariant.apply(ctx)
    expect(invariant.name).toBe('execution-descriptor-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-execution-descriptor', expect.any(Function))
    expect(() => {
      const install = register.mock.calls[0]![1] as () => void
      install()
    }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
