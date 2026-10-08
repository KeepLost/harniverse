/**
 * Win32 code-page resolution against a hoisted koffi mock: the lazy binding,
 * its caching, and the sync accessor's cached view.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('koffi', () => ({
  default: {
    load: () => ({
      func: (prototype: string) => (prototype.includes('GetACP') ? () => 1252 : () => 850),
    }),
  },
}))

const { hostPriors, hostPriorsSync } = await import('@deepseek-ai/dsh-fs-codec')

describe('hostPriors — mocked koffi success', () => {
  it('lazily binds GetACP/GetOEMCP once and shares the cache with the sync form', async () => {
    expect(await hostPriors({ platform: 'win32' })).toEqual({ acp: 1252, oemcp: 850 })
    expect(await hostPriors({ platform: 'win32' })).toEqual({ acp: 1252, oemcp: 850 })
    expect(hostPriorsSync({ platform: 'win32' })).toEqual({ acp: 1252, oemcp: 850 })
  })
})
