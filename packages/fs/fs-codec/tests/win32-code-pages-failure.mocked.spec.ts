/**
 * Win32 code-page resolution when koffi cannot load: unavailable priors are
 * cached as a miss, and the sync form reports the same absence.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('koffi', () => {
  throw new Error('no dll on this host')
})

const { hostPriors, hostPriorsSync } = await import('@deepseek-ai/dsh-fs-codec')

describe('hostPriors — mocked koffi failure', () => {
  it('treats the load failure as unavailable priors, cached per process', async () => {
    expect(await hostPriors({ platform: 'win32' })).toEqual({})
    expect(await hostPriors({ platform: 'win32' })).toEqual({})
    expect(hostPriorsSync({ platform: 'win32' })).toEqual({})
  })
})
