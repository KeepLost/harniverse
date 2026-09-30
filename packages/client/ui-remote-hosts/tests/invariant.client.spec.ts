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
    type Roster =
      | { ok: true; value: Array<{ id: string; name: string }> }
      | { ok: false; error: { code: string; message: string; details: Record<string, never> } }
    const remoteHosts = {
      list: vi.fn(async (): Promise<Roster> => ({ ok: true, value: [] })),
      upsert: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      verify: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      keyFilePicker: vi.fn(async () => ({ ok: true, value: { kind: 'native' } })),
      pickKeyFile: vi.fn(async () => ({ ok: true, value: { path: '/home/me/.ssh/id_ed25519' } })),
      listKeyFiles: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      connect: vi.fn(async (input: unknown) => ({ ok: true, value: input })),
      disconnect: vi.fn(async () => ({ ok: true, value: undefined })),
      removeHost: vi.fn(async () => ({ ok: true, value: undefined })),
    }
    const layout = { setCenterView: vi.fn(), clearCenterView: vi.fn() }
    const connection = { switchTarget: vi.fn(), target: { getSnapshot: () => ({ kind: 'host' }), subscribe: () => () => {} } }
    const ctx = {
      effect: (run: () => unknown) => { run(); return () => {} },
      locale: { register: vi.fn() },
      layout,
      connection,
      get: () => connection,
      remote: { remoteHosts },
      slots: {
        inject: (_name: string, factory: () => unknown) => { factories.push(factory) },
        register: (config: { inject?: () => unknown }) => { registrations.push({ config }); return () => {} },
      },
    } as never
    applyClient(ctx)
    for (const factory of factories) factory()
    expect(registrations).toHaveLength(3)
    const sidebar = registrations[0]!.config.inject!() as { openView: () => void }
    sidebar.openView()
    expect(layout.setCenterView).toHaveBeenCalledWith('remote-hosts')
    const center = registrations[1]!.config.inject!() as Record<string, (...args: unknown[]) => unknown>
    await center.list!()
    await center.upsert!({ name: 'host' })
    await center.verify!({ host: 'host', username: 'runner', secrets: { kind: 'password', password: 'secret' } })
    await center.keyFilePicker!()
    await center.pickKeyFile!()
    await center.listKeyFiles!({ path: '/home/me/.ssh' })
    expect(remoteHosts.listKeyFiles).toHaveBeenCalledWith({ path: '/home/me/.ssh' })
    await center.listKeyFiles!({})
    expect(remoteHosts.listKeyFiles).toHaveBeenLastCalledWith({})
    await center.connect!('host-id')
    await center.connect!('host-id', { kind: 'password', password: 'secret' })
    await center.disconnect!('host-id')
    await center.remove!('host-id')
    // The view-facing callback keeps the short name; the Remote method carries
    // the exported name because the namespace service owns `remove`.
    expect(remoteHosts.removeHost).toHaveBeenCalledWith('host-id')
    vi.stubGlobal('location', { href: 'http://localhost:3000/' })
    const open = vi.fn()
    vi.stubGlobal('open', open)
    center.openRemote!('host-id')
    expect(connection.switchTarget).toHaveBeenCalledWith({ kind: 'remote', id: 'host-id' })
    expect(open).not.toHaveBeenCalled()
    expect(location.href).toBe('http://localhost:3000/')
    const machine = registrations[2]!.config.inject!() as {
      nameOf(id: string): Promise<string | undefined>
      returnToHost(): void
    }
    remoteHosts.list
      .mockResolvedValueOnce({ ok: true, value: [{ id: 'host-id', name: 'lab' }] })
      .mockResolvedValueOnce({ ok: true, value: [{ id: 'host-id', name: 'lab' }] })
      .mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'roster unavailable', details: {} } })
    await expect(machine.nameOf('host-id')).resolves.toBe('lab')
    await expect(machine.nameOf('missing')).resolves.toBeUndefined()
    await expect(machine.nameOf('host-id')).resolves.toBeUndefined()
    machine.returnToHost()
    expect(connection.switchTarget).toHaveBeenLastCalledWith({ kind: 'host' })
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
