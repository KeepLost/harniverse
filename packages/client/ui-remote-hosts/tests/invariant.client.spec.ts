// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as RemoteHostsInvariant from '../src/invariant.ts'
import { apply as applyHost } from '../src/index.ts'
import { apply as applyClient } from '../src/client/index.ts'
import { RemoteHostsSidebarAction } from '../src/client/RemoteHostsSidebarAction.tsx'
import { createRemoteHostsViewStore } from '../src/client/stores.ts'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createElement } from 'react'
import { zh } from '../src/client/locales.ts'

describe('host companion', () => {
  it('keeps the host half as an intentional no-op', () => {
    applyHost()
  })
})

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(RemoteHostsInvariant).await()).resolves.toBeDefined()
  })
})

describe('client composition', () => {
  it('registers the sidebar and center faces with live remote actions', async () => {
    const factories: Array<() => unknown> = []
    const registrations: Array<{ config: { inject?: () => unknown } }> = []
    const remoteHosts = {
      list: vi.fn(async () => ({ ok: true, value: [] })),
      upsert: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      probe: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      connect: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      disconnect: vi.fn(async () => ({ ok: true, value: undefined })),
      remove: vi.fn(async () => ({ ok: true, value: undefined })),
    }
    const layout = { setCenterView: vi.fn(), clearCenterView: vi.fn() }
    const ctx = {
      effect: (run: () => unknown) => { run(); return () => {} },
      locale: { register: vi.fn() },
      layout,
      remote: { remoteHosts },
      slots: {
        inject: (_name: string, factory: () => unknown) => { factories.push(factory) },
        register: (config: { inject?: () => unknown }) => { registrations.push({ config }); return () => {} },
      },
    } as never
    applyClient(ctx)
    for (const factory of factories) factory()
    expect(registrations).toHaveLength(2)
    const sidebar = registrations[0]!.config.inject!() as { openView: () => void }
    sidebar.openView()
    expect(layout.setCenterView).toHaveBeenCalledWith('remote-hosts')
    const center = registrations[1]!.config.inject!() as Record<string, (...args: unknown[]) => unknown>
    await center.list!()
    await center.upsert!({ name: 'host' })
    await center.probe!({ host: 'host', username: 'runner' })
    await center.connect!('host-id')
    await center.connect!('host-id', { kind: 'password', password: 'secret' })
    await center.disconnect!('host-id')
    await center.remove!('host-id')
    vi.stubGlobal('location', { href: 'http://localhost:3000/' })
    const open = vi.fn()
    vi.stubGlobal('open', open)
    center.openRemote!('host-id')
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ href: 'http://localhost:3000/?dshRemoteHost=host-id' }), '_blank', 'noopener,noreferrer')
    vi.stubGlobal('location', undefined)
    center.openRemote!('host-id')
    vi.stubGlobal('open', undefined)
    vi.stubGlobal('location', { href: 'http://localhost:3000/' })
    center.openRemote!('host-id')
    vi.stubGlobal('location', undefined)
    center.openRemote!('host-id')
    center.closeView!()
    expect(layout.clearCenterView).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('renders wide and rail sidebar actions from the shared store', () => {
    const store = createRemoteHostsViewStore().create()
    const openView = vi.fn()
    const props = {
      wide: true, useStore: (selector: (value: ReturnType<typeof store.getSnapshot>) => unknown) => selector(store.getSnapshot()),
      openView, t: makeTranslate(zh),
    } as Parameters<typeof RemoteHostsSidebarAction>[0]
    render(createElement(RemoteHostsSidebarAction, props))
    fireEvent.click(screen.getByRole('button', { name: zh.open }))
    expect(openView).toHaveBeenCalled()
    cleanup()
    render(createElement(RemoteHostsSidebarAction, { ...props, wide: false }))
    expect(screen.getByRole('button', { name: zh.open }).textContent).toBe('')
    cleanup()
  })
})
