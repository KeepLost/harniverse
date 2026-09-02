import { describe, expect, it, vi } from 'vitest'
import * as invariant from '../src/invariant.ts'

describe('attachment-local invariant companion', () => {
  it('registers the package invariant and returns its disposer', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    await expect(invariant.apply({ invariants: { register } } as never)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-attachment-local', expect.any(Function))
  })
})
