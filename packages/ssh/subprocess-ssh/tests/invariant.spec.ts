/** Invariant companion registers the package's empty installer and removes it on fiber disposal. */
import { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

describe('subprocess-ssh invariant companion', () => {
  it('registers and unregisters the empty installer', async () => {
    const ctx = new Context()
    const registered: { id: string; installer: InvariantInstaller; removed: boolean }[] = []
    ctx.provide('invariants', {
      register: (id: string, installer: InvariantInstaller) => {
        registered.push({ id, installer, removed: false })
        return () => { registered.forEach((entry) => { if (entry.id === id) entry.removed = true }) }
      },
    } as never)
    const fiber = ctx.plugin({ name, inject, apply })
    await fiber
    expect(registered).toHaveLength(1)
    expect(registered[0]!.id).toBe('@deepseek-ai/dsh-subprocess-ssh')
    expect(registered[0]!.installer).toBeTypeOf('function')
    const installed = (registered[0]!.installer as () => unknown)()
    expect(installed).toBeUndefined()
    await fiber.dispose()
    expect(registered[0]!.removed).toBe(true)
  })
})
