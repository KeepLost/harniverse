import { describe, expect, it, vi } from 'vitest'
import * as invariant from '@deepseek-ai/dsh-compaction-lossless/invariant'

describe('compaction-lossless invariant companion', () => {
  it('registers package ownership and returns its disposer', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)

    await expect(invariant.apply({ invariants: { register } } as never)).resolves.toBe(dispose)
    expect(invariant.name).toBe('compaction-lossless-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-compaction-lossless', expect.any(Function))
  })
})
