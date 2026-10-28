/**
 * The threadpool floor module: import order runs it before any filesystem
 * call, an operator-provided larger value wins, a smaller explicit value is
 * raised to the floor, and the unset default installs the floor.
 */

import { describe, expect, it, vi } from 'vitest'

async function importFloor(): Promise<string | undefined> {
  vi.resetModules()
  const floor = await import('../src/threadpool-floor.ts')
  expect(floor.THREADPOOL_FLOOR).toBe(16)
  return process.env.UV_THREADPOOL_SIZE
}

describe('threadpool floor', () => {
  it('installs the floor when the variable is unset', async () => {
    delete process.env.UV_THREADPOOL_SIZE
    await expect(importFloor()).resolves.toBe('16')
  })

  it('raises a below-floor explicit setting', async () => {
    process.env.UV_THREADPOOL_SIZE = '8'
    await expect(importFloor()).resolves.toBe('16')
  })

  it('keeps an operator-provided larger value', async () => {
    process.env.UV_THREADPOOL_SIZE = '64'
    await expect(importFloor()).resolves.toBe('64')
  })
})
