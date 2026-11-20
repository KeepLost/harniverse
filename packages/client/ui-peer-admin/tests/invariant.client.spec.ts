// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as PeerAdminInvariant from '../src/invariant.ts'
import { apply as applyHost } from '../src/index.ts'
import { apply as applyClient } from '../src/client/index.ts'

afterEach(cleanup)

describe('host companion', () => {
  it('keeps the host half as an intentional no-op', () => {
    applyHost()
  })
})

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(PeerAdminInvariant).await()).resolves.toBeDefined()
  })
})

describe('client composition', () => {
  it('registers the dashboard tab with live remote actions and pairing-event refresh', () => {
    const factories: Array<() => unknown> = []
    const registrations: Array<{ config: { id?: string; order?: number }; label?: () => string }> = []
    type Roster =
      | { ok: true; value: { peers: unknown[] } }
      | { ok: false; error: { code: string; message: string; details: Record<string, never> } }
    const peerHost = {
      list: vi.fn(async (): Promise<Roster> => ({ ok: true, value: { peers: [] } })),
      remove: vi.fn(async () => ({ ok: true, value: undefined })),
      setSurface: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      approveSurface: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      rejectSurface: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      setBudget: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      audit: vi.fn(async () => ({ ok: true, value: { sessions: [] } })),
    }
    const subscriptions: Array<string> = []
    const ctx = {
      effect: (run: () => unknown) => { run(); return () => {} },
      locale: { register: vi.fn(), bind: vi.fn((ns: string) => (key: string) => `${ns}:${key}`) },
      remote: {
        peer: peerHost,
        $on: vi.fn((name: string, _listener: () => void) => { subscriptions.push(name); return () => {} }),
      },
      slots: {
        inject: (_name: string, factory: () => unknown) => { factories.push(factory) },
        register: (config: { id?: string; order?: number; inject?: () => unknown; label?: () => string }) => {
          registrations.push(config.label === undefined ? { config } : { config, label: config.label })
          return () => {}
        },
      },
    } as never
    applyClient(ctx)
    expect(subscriptions).toEqual(['peer/paired', 'peer/removed'])
    for (const factory of factories) factory()
    expect(registrations).toHaveLength(1)
    expect(registrations[0]!.config.id).toBe('peer-admin')
    expect(registrations[0]!.config.order).toBe(30)
    expect(registrations[0]!.label).toBeDefined()
    type InjectedFace = { hooks: { peersTick: { getSnapshot(): number } } } & { list: () => unknown }
    const injected = (registrations[0] as unknown as { config: { inject: () => InjectedFace } }).config.inject()
    expect(injected.hooks.peersTick.getSnapshot()).toBe(0)
    // The injected actions reach the mounted peer namespace verbatim.
    void injected.list?.()
    expect(peerHost.list).toHaveBeenCalled()
  })
})
