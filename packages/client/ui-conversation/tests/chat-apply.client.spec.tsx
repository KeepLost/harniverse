// @vitest-environment jsdom
// apply wiring: the conversation service provided, the chat view registered
// as the first 'conversation.view' ring entry declaring the whole-Tool seat,
// the slot registrations land against a root entry's children declarations
// (the AppFrame role), and the shared store handle rides all strict session
// entries. Tool composition belongs to ui-tool and its machinery spec.

import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime, usePinnedBrowserLanguages, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatViewInjected } from '../src/client/contract/slots.ts'
import type { SessionInput } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const ROOT = 'root-1' as SessionId
const CHILD = 'child-1' as SessionId

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
  // The plugin injects both; these specs exercise no settings path.
  runtime.provide('remote', { $on: () => () => {} })
  runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await runtime.sessions.add({ id: ROOT, summary: { title: 'R', displayTitle: 'R' } }, { current: false })
  await runtime.sessions.add(
    { id: CHILD, summary: { title: 'C', displayTitle: 'C', parentId: ROOT } }, { current: false })
  runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)

  // Declared by ui-layout's root entry in production; the test root declares
  // them here so the contributions land.
  await runtime.root.declare({
    'conversation': { kind: 'single', scope: 'session-maybe' },
    'details': { kind: 'single', scope: 'session' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, (_p: { renderSlot?: unknown }) => null)

  const feature = await runtime.mount({ inject: [...inject], apply })
  return { runtime, feature, slots: runtime.slots }
}

/** First stored entry for a key (inject/store live directly on StoredEntry). */
function renderEntryOf(slots: Awaited<ReturnType<typeof bench>>['slots'], key: 'conversation' | 'conversation.session' | 'conversation.session.header' | 'conversation.view' | 'details') {
  return slots.entries(key)[0] as undefined | { inject?: unknown; store?: unknown }
}

describe('apply wiring', () => {
  it('provides the conversation service', async () => {
    const b = await bench()
    expect(b.runtime.ctx.get('conversation')).toBeDefined()
    await b.runtime.dispose()
  })

  it('registers the chat view and its keyed business-node seat', async () => {
    const b = await bench()
    const entries = b.slots.entries('conversation.view')
    expect(entries.map(e => e.options.id)).toEqual(['chat'])
    // Label is a locale thunk resolving through the zh dictionary.
    expect(resolveSlotLabel(entries[0]?.options.label)).toBe('对话')
    expect(entries[0]?.options.order).toBe(0)
    // Declaring is claiming: the chat entry's registration put the hole on
    // the ledger with the contract's kind/scope.
    const nodeSlot = b.slots.spec('conversation.chat.node')
    expect(nodeSlot).toMatchObject({ kind: 'keyed', scope: 'session' })
    expect(nodeSlot?.inject?.hooks?.turnData).toBeTypeOf('function')
    await b.runtime.dispose()
  })

  it('occupies the slots + the ring; session entries share one store handle', async () => {
    const b = await bench()
    const conversation = renderEntryOf(b.slots, 'conversation')
    const conversationSession = renderEntryOf(b.slots, 'conversation.session')
    const conversationHeader = renderEntryOf(b.slots, 'conversation.session.header')
    const chatView = renderEntryOf(b.slots, 'conversation.view')
    const details = renderEntryOf(b.slots, 'details')
    expect(conversation?.inject).toBeTypeOf('function')
    expect(chatView?.inject).toBeTypeOf('function')
    expect(details?.inject).toBeTypeOf('function')
    // The shared handle: one apply-built store value on ALL session entries
    // (the session-maybe 'conversation' shell carries no store by design).
    expect(conversationSession?.store).toBeDefined()
    expect(conversationHeader?.store).toBe(conversationSession?.store)
    expect(details?.store).toBe(conversationSession?.store)
    expect(chatView?.store).toBe(conversationSession?.store)
    // The hero holes ride the conversation entry's children declaration (the
    // empty-state occupant is gone). Both are root-scoped: the new-session
    // screen precedes the session either would belong to.
    expect(b.slots.spec('conversation.hero.workspace')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.spec('conversation.hero.agentPreset')).toEqual({ kind: 'single', scope: 'root' })
    expect(b.slots.entries('settings.general.item').map(entry => entry.options.id)).toEqual(['composer-enter', 'conversation-links'])
    await b.runtime.dispose()
  })

  it('leaves per-Tool rows to the ui-tool plugin', async () => {
    const b = await bench()
    // The actual toolview declaration activates every registrant. The
    // file-mutation registrant claims both write and edit for the diff card; the
    // one search row registers under both grep and glob; the web rows register
    // one component under both web tool names.
    expect(b.slots.entries('conversation.chat.node').map(entry => entry.options.key)).not.toContain('tool-call')
    // Stats stick with the composer (not inside ChatView).
    expect(b.slots.entries('conversation.composer.dock').map(e => e.options.id)).toEqual(['stats'])
    await b.runtime.dispose()
  })

  it('plugin fiber disposal collects every registration (unload cascade, ring and hole included)', async () => {
    const b = await bench()
    await b.feature.dispose()
    expect(b.slots.entries('conversation')).toHaveLength(0)
    // The declared ring collapses with its declaring entry, and the chat
    // entry's keyed hole (with the sample's registration) collapses with it.
    expect(b.slots.entries('conversation.view')).toHaveLength(0)
    expect(b.slots.entries('conversation.chat.node')).toHaveLength(0)
    expect(b.slots.spec('conversation.chat.node')).toBeUndefined()
    expect(b.slots.entries('details')).toHaveLength(0)
    expect(b.slots.entries('settings.general.item')).toHaveLength(0)
    expect(b.runtime.ctx.get('conversation')).toBeUndefined()
    await b.runtime.dispose()
  })
})

describe('chat view recall composition', () => {
  async function recallBench(updateQueue: (itemId: never, action: never) => Promise<unknown>) {
    const runtime = await SlotTestRuntime.create()
    runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
    runtime.provide('remote', { $on: () => () => {} })
    runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    await runtime.sessions.add({
      id: ROOT,
      summary: { title: 'R', displayTitle: 'R' },
      session: {
        updateQueue: updateQueue as never,
        prompt: () => Promise.resolve({ ok: true, value: { accepted: true } }),
      },
    }, { current: false })
    runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)

    await runtime.root.declare({
      'conversation': { kind: 'single', scope: 'session-maybe' },
      'details': { kind: 'single', scope: 'session' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    }, (_p: { renderSlot?: unknown }) => null)

    await runtime.mount({ inject: [...inject], apply })
    const entry = runtime.slots.entries('conversation.view')[0] as
      | { inject?: (sessionId: SessionId, actions: never) => ChatViewInjected }
      | undefined
    if (entry?.inject === undefined) throw new Error('chat view entry resolved no inject')
    const face = entry.inject(ROOT, undefined as never)
    const conversation = runtime.ctx.get('conversation') as { input: { for: (actx: unknown) => SessionInput } }
    const actx = runtime.sessions.scope(ROOT)
    if (actx === undefined) throw new Error('recall bench resolved no session scope')
    const input = conversation.input.for(actx)
    return { runtime, face, input, shell: input as SessionInputShell }
  }

  const okRemove = (itemId: string) => ({
    ok: true as const,
    value: { accepted: true as const, messageId: itemId, status: { state: 'discarded' as const, delivery: 'steer' as const } },
  })

  it('refills the composer with the recalled plain text on success', async () => {
    const updateQueue = vi.fn(() => Promise.resolve(okRemove('steer-1')))
    const b = await recallBench(updateQueue)
    try {
      await b.face.recallSteering('steer-1' as never, [{ type: 'text', text: 'take it back' }])
      expect(updateQueue).toHaveBeenCalledWith('steer-1', { kind: 'remove' })
      expect(b.shell.state.getSnapshot().draft).toBe('take it back')
      expect(b.shell.notices.getSnapshot()).toBeNull()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('defers the refill past a still-settling submission so it cannot be consumed', async () => {
    const updateQueue = vi.fn(() => Promise.resolve(okRemove('steer-5')))
    const b = await recallBench(updateQueue)
    try {
      // A recall racing its own steer's submit transaction: the machine is
      // busy, and the refill must land only after settlement returns plain.
      b.shell.setDraft('the steer text')
      b.shell.submit('steer')
      await vi.waitFor(() => { expect(b.shell.state.getSnapshot().phase).toBe('submitting') })
      await b.face.recallSteering('steer-5' as never, [{ type: 'text', text: 'take it back' }])
      expect(b.shell.state.getSnapshot().draft).not.toBe('take it back')
      await vi.waitFor(() => { expect(b.shell.state.getSnapshot().phase).toBe('plain') })
      await vi.waitFor(() => {
        expect(b.shell.state.getSnapshot().draft).toBe('take it back')
      })
      expect(b.shell.notices.getSnapshot()).toBeNull()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('strips file-handle blocks and warns that attachments were not restored', async () => {
    const updateQueue = vi.fn(() => Promise.resolve(okRemove('steer-2')))
    const b = await recallBench(updateQueue)
    try {
      const handle = '[文件] notes.txt · 1.2 KB · sha256:abcdef01\n只读路径: /tmp/notes.txt\n用 read 工具读取该路径获得内容；不要凭名字猜测内容。'
      await b.face.recallSteering('steer-2' as never, [
        { type: 'image', attachment: {} },
        { type: 'text', text: handle },
        { type: 'text', text: 'see the picture' },
      ])
      expect(b.shell.state.getSnapshot().draft).toBe('see the picture')
      expect(b.shell.notices.getSnapshot()).toMatchObject({
        level: 'info',
        text: '撤回的消息带有附件，附件不会恢复，请重新添加。',
      })
    } finally {
      await b.runtime.dispose()
    }
  })

  it('keeps a non-empty draft, copying the recalled text to the clipboard instead', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const updateQueue = vi.fn(() => Promise.resolve(okRemove('steer-3')))
    const b = await recallBench(updateQueue)
    try {
      b.shell.setDraft('already typing')
      await b.face.recallSteering('steer-3' as never, [{ type: 'text', text: 'take it back' }])
      expect(b.shell.state.getSnapshot().draft).toBe('already typing')
      expect(writeText).toHaveBeenCalledWith('take it back')
      expect(b.shell.notices.getSnapshot()).toMatchObject({
        level: 'info',
        text: '输入框非空，撤回的文本已复制到剪贴板。',
      })
    } finally {
      await b.runtime.dispose()
    }
  })

  it('never refills on failure and differentiates the notice by the reported lifecycle', async () => {
    const claimed = {
      ok: false as const,
      error: {
        code: 'queue-item-not-found' as const,
        message: 'queued item is no longer pending',
        details: { itemId: 'steer-4', status: { state: 'claimed' as const, turn: 2, delivery: 'steer' as const } },
      },
    }
    const updateQueue = vi.fn(() => Promise.resolve(claimed))
    const b = await recallBench(updateQueue)
    try {
      await b.face.recallSteering('steer-4' as never, [{ type: 'text', text: 'too late' }])
      expect(b.shell.state.getSnapshot().draft).toBe('')
      expect(b.shell.notices.getSnapshot()).toMatchObject({
        level: 'error',
        text: '撤回失败：模型已读取这条消息，无法撤回。如需中断，请使用「停止」。',
      })
    } finally {
      await b.runtime.dispose()
    }
  })
})
