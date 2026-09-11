import { describe, expect, it, vi } from 'vitest'
import * as invariant from '@deepseek-ai/dsh-tool-scheduler/invariant'

describe('tool-scheduler invariant companion', () => {
  it('registers the package-owned empty installer', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const result = await invariant.apply({ invariants: { register } } as never)

    expect(invariant.name).toBe('tool-scheduler-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-tool-scheduler', expect.any(Function))
    expect(result).toBe(dispose)
  })
})
