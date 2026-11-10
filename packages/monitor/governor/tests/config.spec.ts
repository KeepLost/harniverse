import { describe, expect, it } from 'vitest'
import { AUTO_BUDGET_FRACTION, DEFAULT_CONFIG, resolveGlobalLimitBytes } from '../src/config.ts'

const GiB = 1024 * 1024 * 1024

describe('resolveGlobalLimitBytes', () => {
  it('none (the default) carries no shared-pool budget', async () => {
    expect(DEFAULT_CONFIG.memory.limit).toBe('none')
    expect(await resolveGlobalLimitBytes(DEFAULT_CONFIG)).toBe(Number.POSITIVE_INFINITY)
  })

  it('auto takes 80% of min(MemTotal, own cgroup ceiling)', async () => {
    const read = async (path: string) => {
      if (path === '/proc/meminfo') return 'MemTotal: 16777216 kB\n'
      if (path === '/sys/fs/cgroup/memory.max') return String(4 * GiB)
      throw new Error('ENOENT')
    }
    expect(await resolveGlobalLimitBytes({ ...DEFAULT_CONFIG, memory: { limit: 'auto' } }, read))
      .toBe(Math.floor(4 * GiB * AUTO_BUDGET_FRACTION))
    const readBare = async (path: string) => {
      if (path === '/proc/meminfo') return 'MemTotal: 8388608 kB\n'
      throw new Error('ENOENT')
    }
    expect(await resolveGlobalLimitBytes({ ...DEFAULT_CONFIG, memory: { limit: 'auto' } }, readBare))
      .toBe(Math.floor(8 * GiB * AUTO_BUDGET_FRACTION))
  })

  it('honors an explicit positive budget and falls back otherwise', async () => {
    expect(await resolveGlobalLimitBytes({ ...DEFAULT_CONFIG, memory: { limit: 123 } })).toBe(123)
    expect(await resolveGlobalLimitBytes({ ...DEFAULT_CONFIG, memory: { limit: -5 } }))
      .toBe(Math.floor(2 * GiB * AUTO_BUDGET_FRACTION))
    expect(await resolveGlobalLimitBytes({ ...DEFAULT_CONFIG, memory: { limit: Number.NaN } }))
      .toBe(Math.floor(2 * GiB * AUTO_BUDGET_FRACTION))
    expect(await resolveGlobalLimitBytes({ ...DEFAULT_CONFIG, memory: { limit: 'auto' } }, async () => {
      throw new Error('ENOENT')
    })).toBe(Math.floor(2 * GiB * AUTO_BUDGET_FRACTION))
  })
})
