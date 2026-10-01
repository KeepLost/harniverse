// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import { defineStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '../src/client/slots.ts'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { WorkspaceRuntime } from '../src/client/workspaces/service.ts'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

afterEach(() => { localStorage.clear() })

describe('machine-owned runtime persistence', () => {
  it('restores only that machine selection, even when both machines have the same session id', async () => {
    const ctx = new Context()
    const local = new FakeApiClient()
    const remote = new FakeApiClient()
    for (const api of [local, remote]) api.onList = async () => ok({ items: [
      { sessionId: 'same' as never, blank: true, running: false, updatedAt: 1 },
    ] }) as never
    const sessions = new SessionRuntime(ctx, local, fakeRemote())
    await ctx.plugin({ apply: () => {} }).await()
    const source = sessions.list
    try {
      await sessions.refresh()
      sessions.open('same' as never)
      await sessions.resetTarget(remote, 'remote:one')
      await sessions.refresh()
      expect(source.getSnapshot().current).toBeUndefined()
      sessions.open('same' as never)
      await sessions.resetTarget(local, 'host')
      await sessions.refresh()
      expect(source.getSnapshot().current).toBe('same')
      sessions.clear()
      await sessions.resetTarget(remote, 'remote:one')
      await sessions.refresh()
      expect(source.getSnapshot().current).toBe('same')
    } finally { await ctx.fiber.dispose() }
  })

  it('isolates persisted session drafts by machine while preserving root preferences', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote())
    new WorkspaceRuntime(ctx, api, sessions)
    let host!: SlotRendererHost
    ctx.slots.install({ renderRoot: (value) => { host = value; return null } })
    const store = defineStore({ init: () => ({ draft: '' }), persist: 'target-test', actions: {
      write: (draft, text: string) => { draft.draft = text },
    } })
    const root = defineStore({ init: () => ({ language: 'zh' }), actions: {} })
    ctx.slots.register({ name: 'root', store: root, children: { 'machine.test': { kind: 'single', scope: 'session' } } } as never, () => null)
    ctx.slots.register({ name: 'machine.test', store } as never, () => null)
    ctx.slots.renderSlot('root', {})
    const entry = ctx.slots.entries('machine.test' as never)[0]!
    const rootEntry = ctx.slots.entries('root')[0]!
    const local = host.storeOf(entry, 'same') as ReturnType<typeof store.create>
    const preferences = host.storeOf(rootEntry, undefined)
    local.actions.write('local draft')
    ctx.slots.resetTarget('remote:one')
    const remote = host.storeOf(entry, 'same') as ReturnType<typeof store.create>
    expect(remote.getSnapshot().draft).toBe('')
    remote.actions.write('remote draft')
    expect(host.storeOf(rootEntry, undefined)).toBe(preferences)
    ctx.slots.resetTarget('host')
    expect((host.storeOf(entry, 'same') as ReturnType<typeof store.create>).getSnapshot().draft).toBe('local draft')
    ctx.slots.resetTarget('remote:one')
    expect((host.storeOf(entry, 'same') as ReturnType<typeof store.create>).getSnapshot().draft).toBe('remote draft')
    await ctx.fiber.dispose()
  })
})
