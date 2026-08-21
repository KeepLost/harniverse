import { describe, expect, it, vi } from 'vitest'
import * as invariant from '@deepseek-ai/dsh-tool-compaction/invariant'

describe('tool-compaction invariant companion', () => {
  it('registers the package-owned empty installer', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const result = await invariant.apply({ invariants: { register } } as never)

    expect(invariant.name).toBe('tool-compaction-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-tool-compaction', expect.any(Function))
    expect(result).toBe(dispose)
  })
})
