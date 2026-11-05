/** Execution-world selection resolution: preference, availability, degrade. */
import { describe, expect, it } from 'vitest'
import { resolveExecWorld, type ExecWorldAvailability } from '../src/exec-world.ts'

const healthy: ExecWorldAvailability = { providerVersion: 'QEMU 8.1.3', assetsReady: true }
const noBinary: ExecWorldAvailability = { providerVersion: undefined, assetsReady: true }
const noAssets: ExecWorldAvailability = { providerVersion: 'QEMU 8.1.3', assetsReady: false }

describe('resolveExecWorld', () => {
  it('composes the vm family only for a vm preference with a healthy provider', () => {
    expect(resolveExecWorld('vm', healthy)).toBe('vm')
  })

  it('degrades a vm preference to local when the provider binary is missing', () => {
    expect(resolveExecWorld('vm', noBinary)).toBe('local')
  })

  it('degrades a vm preference to local when provider assets are absent', () => {
    expect(resolveExecWorld('vm', noAssets)).toBe('local')
  })

  it('composes local regardless of provider health', () => {
    expect(resolveExecWorld('local', healthy)).toBe('local')
    expect(resolveExecWorld('local', noBinary)).toBe('local')
  })
})
