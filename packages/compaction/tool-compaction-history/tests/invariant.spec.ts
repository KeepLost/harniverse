import { describe, expect, it, vi } from 'vitest'
import * as invariant from '@deepseek-ai/dsh-tool-compaction-history/invariant'

describe('tool-compaction-history invariant companion', () => {
  it('registers package ownership and returns its disposer', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)

    await expect(invariant.apply({ invariants: { register } } as never)).resolves.toBe(dispose)
    expect(invariant.name).toBe('tool-compaction-history-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-tool-compaction-history', expect.any(Function))
  })
})
