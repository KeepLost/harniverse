import { describe, expect, it, vi } from 'vitest'
import * as invariant from '@deepseek-ai/dsh-peer-outbox/invariant'

describe('peer-outbox invariant companion', () => {
  it('registers the package-owned empty installer', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const result = await invariant.apply({ invariants: { register } } as never)

    expect(invariant.name).toBe('peer-outbox-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-peer-outbox', expect.any(Function))
    expect(result).toBe(dispose)
  })
})
