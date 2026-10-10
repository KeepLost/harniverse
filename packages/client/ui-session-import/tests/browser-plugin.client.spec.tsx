// @vitest-environment jsdom
/**
 * Composition specs: the real slot registry, renderer, store seats, inject
 * faces, and locale seat around the plugin's `apply`, with only the
 * `officialSessionImport` Remote, the connection wire, the sessions face,
 * and the composer-block registry stubbed. Registrations leave with the
 * plugin fiber.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { MachineTarget, OfficialSessionScan } from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import type { ArchiveDockInjected } from '../src/client/controller.ts'
import { en, zh } from '../src/client/locales.ts'
import { SessionImportNavIcon } from '../src/client/NavIcon.tsx'

usePinnedBrowserLanguages('zh')

const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true, value })

const SCAN: OfficialSessionScan = {
  roots: ['/home/u/.dsh/sessions'],
  items: [{
    sourceId: '0/p/s/session.v4.jsonl.zstd', path: '/home/u/.dsh/sessions/p/s/session.v4.jsonl.zstd', format: 'official-v4',
    sourceSessionId: 's', title: '整理仓库', turns: 2, createdAt: 1, updatedAt: 2, sizeBytes: 10, status: 'new',
  }],
  unreadable: [],
  maxArtifactBytes: 1024,
}

function machineSource() {
  let value: MachineTarget = { kind: 'host' }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: MachineTarget) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  cleanup()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

describe('ui-session-import apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.officialSessionImport', 'sessions'])
  })

  it('registers the section at order 22 and drives a scan through the Remote per machine', async () => {
    const runtime = await SlotTestRuntime.create()
    disposers.push(() => runtime.dispose())
    const remote = {
      scan: vi.fn(async () => ok(SCAN)),
      importSources: vi.fn(async () => ok([])),
      importUpload: vi.fn(),
    }
    const machine = machineSource()
    runtime.provide('remote', {})
    runtime.provide('remote.officialSessionImport', remote)
    runtime.provide('connection', { api: {}, target: machine } as never)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const plugin = await runtime.mount({ apply, inject })
    await runtime.declare({
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.nav.icon': { kind: 'keyed', scope: 'root' },
    })

    const [entry] = runtime.slots.entries('settings.section')
    expect(entry?.options).toMatchObject({ id: 'session-import', order: 22 })
    // The same id keys the section's nav glyph (the download tray, owned here).
    expect(runtime.slots.entries('settings.nav.icon').map(e => [e.options.key, e.component]))
      .toEqual([['session-import', SessionImportNavIcon]])
    const label = entry!.options.label as () => string
    expect(label()).toBe(zh.nav)
    await act(async () => { locale.setLocale('en') })
    expect(label()).toBe(en.nav)
    await act(async () => { locale.setLocale('zh') })

    const view = runtime.renderSlot('settings.section', { close: vi.fn() })
    await waitFor(() => { expect(view.view.getByText('整理仓库')).toBeTruthy() })
    expect(remote.scan).toHaveBeenCalledOnce()
    await act(async () => { machine.set({ kind: 'remote', id: 'host-2' }) })
    await waitFor(() => { expect(remote.scan).toHaveBeenCalledTimes(2) })

    // Refusals raised before the Host answers use this plugin's own copy.
    const upload = view.view.getByLabelText(zh['upload.label'])
    fireEvent.change(upload, { target: { files: [new File([new Uint8Array(2048)], 'big.jsonl')] } })
    await waitFor(() => { expect(view.view.getByRole('alert').textContent).toBe('文件有 2 KiB，超过了 1 KiB 的上限。') })
    const unreadable = { name: 'x.jsonl', size: 1, arrayBuffer: () => Promise.reject(new Error('gone')) }
    fireEvent.change(upload, { target: { files: [unreadable] } })
    await waitFor(() => { expect(view.view.getByRole('alert').textContent).toBe('读取文件失败：gone') })
    expect(remote.importUpload).not.toHaveBeenCalled()

    await plugin.dispose()
    expect(runtime.slots.entries('settings.section')).toEqual([])
    expect(runtime.slots.entries('settings.nav.icon')).toEqual([])
  })
})

/** Boot the plugin on a bare Context with the conversation and sessions faces the dock reads. */
async function dockBench(initial: unknown) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('remote', {})
  ctx.provide('remote.officialSessionImport', {})
  const list = vi.fn(async () => ({ result: { ok: true, value: { presets: [] } } }))
  ctx.provide('connection', { api: { agentPresets: { list } }, target: machineSource() })
  let value = initial
  const listeners = new Set<() => void>()
  const face = {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  let scopeCtx: Context | undefined
  const scopeFiber = ctx.plugin({ apply: (inner: Context) => { scopeCtx = inner } })
  await scopeFiber.await()
  const continueArchive = vi.fn(async () => 'child' as SessionId)
  const open = vi.fn()
  ctx.provide('sessions', {
    binding: (id: SessionId) => ({ sessionId: id, session: { projections: { faceOf: () => face } } }),
    scope: () => scopeCtx,
    continueArchive,
    open,
  })
  const blocks = { set: vi.fn() }
  ctx.provide('conversation', { blocks })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = () => ctx.slots.entries('conversation.input.dock')[0]
  return {
    ctx, fiber, scopeFiber, blocks, list, continueArchive, open, listeners, entry,
    publish(next: unknown) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    face(sessionId: string): ArchiveDockInjected {
      const store = {
        presetsLoading: vi.fn(), presetsLoaded: vi.fn(), presetsFailed: vi.fn(),
        continueStarted: vi.fn(), continueFailed: vi.fn(), continueSettled: vi.fn(),
      }
      const factory = entry()?.inject as unknown as (id: SessionId, actions: typeof store) => ArchiveDockInjected
      return factory(sessionId as SessionId, store)
    },
  }
}

describe('ui-session-import archive dock', () => {
  it('registers the dock first in the input dock', async () => {
    const b = await dockBench(null)
    expect(b.entry()?.options).toMatchObject({ id: 'session-import-archive', order: -100 })
    expect(b.entry()?.locale).toBe('sessionImport')
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    await b.ctx.fiber.dispose()
  })

  it('blocks an archive composer for as long as its projection says so and its scope lives', async () => {
    const b = await dockBench({ format: 'official-v4' })
    const face = b.face('archive')
    expect(b.blocks.set).toHaveBeenLastCalledWith('archive', { reason: zh['composer.blocked'] })
    b.face('archive')
    expect(b.listeners.size).toBe(1)
    b.publish(null)
    expect(b.blocks.set).toHaveBeenLastCalledWith('archive', undefined)
    b.publish({ format: 'official-v4' })
    expect(b.blocks.set).toHaveBeenLastCalledWith('archive', { reason: zh['composer.blocked'] })
    await face.continueArchive('')
    expect(b.continueArchive).toHaveBeenCalledWith({ sessionId: 'archive' })
    expect(b.open).toHaveBeenCalledWith('child')
    await face.loadPresets()
    expect(b.list).toHaveBeenCalledWith({})
    await b.scopeFiber.dispose()
    expect(b.listeners.size).toBe(0)
    expect(b.blocks.set).toHaveBeenLastCalledWith('archive', undefined)
    await b.ctx.fiber.dispose()
  })

  it('leaves ordinary sessions unblocked', async () => {
    const b = await dockBench(undefined)
    b.face('native')
    expect(b.blocks.set).toHaveBeenCalledExactlyOnceWith('native', undefined)
    await b.ctx.fiber.dispose()
  })
})
