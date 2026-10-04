// @vitest-environment jsdom
// Fixed double-Escape stop routing through the real sessions double: every
// eligibility verdict is read off live ConversationSnapshot state (running,
// pending, subagent, chat timeline), driven by window keydown capture the
// way the browser delivers it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConversationSnapshot, ISessions, SessionBinding, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { installStopShortcut } from '../src/client/stop-shortcut.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

const SID = 's1' as SessionId

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  document.body.replaceChildren()
})

/** Conversation-snapshot overrides for one running session with the given turn window. */
function runningChat(
  turnTimings: Map<number, { startTime: number; endTime?: number }>,
  turnEnds = new Map<number, number>(),
): Partial<ConversationSnapshot> {
  return {
    running: true,
    chat: chatSnapshotFixture({ turnTimings, turnEnds }),
  }
}

/**
 * Memoizing binding face: the sessions double mints a fresh binding object
 * per call, while the production SessionRuntime caches one per scope record —
 * the wrapper restores that identity contract for the generation check.
 */
function stableBindings(sessions: Pick<ISessions, 'binding'>): ISessions {
  const memo = new Map<string, SessionBinding>()
  return {
    binding: (id: SessionId) => {
      const live = sessions.binding(id)
      if (live === undefined) {
        memo.delete(id)
        return undefined
      }
      const cached = memo.get(id)
      if (cached !== undefined && cached.session === live.session) return cached
      memo.set(id, live)
      return live
    },
  } as unknown as ISessions
}

const sessionFace = { cancel: () => Promise.resolve({ ok: true as const, value: { accepted: true as const } }) }

async function bench(
  snapshot: Partial<ConversationSnapshot> = runningChat(new Map([[1, { startTime: 1 }]])),
  beforeInstall?: () => (() => void) | undefined,
) {
  const runtime = await SlotTestRuntime.create()
  disposers.push(() => runtime.dispose())
  const cancel = vi.fn()
  await runtime.sessions.add({ id: SID, snapshot, session: sessionFace })
  const offCapture = beforeInstall?.()
  if (offCapture !== undefined) disposers.push(offCapture)
  const dispose = installStopShortcut(stableBindings(runtime.sessions), cancel)
  disposers.push(dispose)
  const root = document.createElement('div')
  root.dataset.conversationSession = SID
  root.dataset.conversationRegion = 'chat'
  document.body.append(root)
  const input = document.createElement('textarea')
  input.dataset.conversationRegion = 'composer'
  root.append(input)
  input.focus()
  /** Dispatch one keydown; the return value mirrors the fixed input's consumption. */
  const press = (overrides: Record<string, unknown> = {}, target: Element | Window = input): boolean => {
    const event = new KeyboardEvent('keydown', { code: 'Escape', bubbles: true, cancelable: true, ...overrides })
    if ('keyCode' in overrides) Object.defineProperty(event, 'keyCode', { value: overrides.keyCode })
    if (overrides.preventDefault === true) event.preventDefault()
    target.dispatchEvent(event)
    return event.defaultPrevented
  }
  const update = (mutate: (draft: ConversationSnapshot) => void) => runtime.sessions.updateSnapshot(SID, mutate)
  return { runtime, cancel, input, root, press, update, dispose }
}

describe('fixed stop routing', () => {
  it('cancels the session only after two eligible Escapes', async () => {
    const b = await bench()
    expect(b.press()).toBe(true) // consumed by the fixed input, not yet a stop
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
    expect(b.cancel).toHaveBeenCalledWith(SID)
  })

  it.each([
    ['ctrl', { ctrlKey: true }],
    ['alt', { altKey: true }],
    ['shift', { shiftKey: true }],
    ['meta', { metaKey: true }],
    ['repeat', { repeat: true }],
    ['IME composition', { isComposing: true }],
    ['legacy keyCode 229', { keyCode: 229 }],
  ])('clears the sequence when %s owns a key', async (_name, overrides) => {
    const b = await bench()
    b.press()
    expect(b.press(overrides)).toBe(false)
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('clears the sequence when an earlier capture handler already consumes every key', async () => {
    let offConsume: (() => void) | undefined
    const b = await bench(runningChat(new Map([[1, { startTime: 1 }]])), () => {
      const consume = (event: KeyboardEvent): void => {
        if (event.code === 'Escape') event.preventDefault()
      }
      window.addEventListener('keydown', consume, true)
      offConsume = () => { window.removeEventListener('keydown', consume, true) }
      return offConsume
    })
    // Every Escape arrives already consumed, so none may arm the sequence.
    b.press()
    b.press()
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    offConsume?.()
    b.press()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('clears on other keys, events addressed outside an Element, and leaving Conversation', async () => {
    const b = await bench()
    for (const invalidate of [
      () => { expect(b.press({ code: 'KeyA' })).toBe(false) },
      () => { expect(b.press({}, window)).toBe(false) },
      () => { expect(b.press({}, document.body)).toBe(false) },
    ]) {
      b.press({ code: 'KeyA' }) // clear any press the previous iteration left
      b.press()
      invalidate()
      b.press()
      expect(b.cancel).not.toHaveBeenCalled()
    }
    // The cleared sequence still arms and completes afterwards.
    b.press()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('clears while any dialog or menu owns the foreground keyboard', async () => {
    const b = await bench()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    try {
      b.press()
      expect(b.press()).toBe(false)
      b.press()
      expect(b.cancel).not.toHaveBeenCalled()
    } finally {
      dialog.remove()
    }
    b.press()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('does not combine presses across input regions of one occurrence', async () => {
    const b = await bench()
    b.press() // composer region
    b.press({}, b.root) // chat region
    expect(b.cancel).not.toHaveBeenCalled()
    b.press({}, b.root)
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('never combines a press with the next turn even while running remains true', async () => {
    const b = await bench()
    b.press()
    await b.update((draft) => {
      draft.chat = chatSnapshotFixture({
        turnTimings: new Map([[1, { startTime: 1, endTime: 2 }], [2, { startTime: 2 }]]),
        turnEnds: new Map([[1, 2]]),
      })
    })
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('clears when an approval appears and disappears between presses', async () => {
    const b = await bench()
    const wait = (): PendingWait<'approval'> => new PendingWait(
      'approval', RpcId(`r${crypto.randomUUID()}`), SID,
      { approvalId: 'ap', toolName: 'bash' } as PendingWait<'approval'>['payload'], vi.fn(),
    )
    b.press()
    await b.update((draft) => { draft.pending = [wait()] })
    expect(b.press()).toBe(false)
    await b.update((draft) => { draft.pending = [] })
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    await b.update((draft) => { draft.pending = [wait()] })
    await b.update((draft) => { draft.pending = [] })
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('excludes terminal, iframe, approval and inert descendants even inside Conversation', async () => {
    const b = await bench()
    for (const [tag, attribute, value] of [
      ['div', 'class', 'xterm'],
      ['iframe', '', ''],
      ['div', 'data-approval-key', ''],
      ['div', 'inert', ''],
    ] as const) {
      const element = document.createElement(tag)
      if (attribute !== '') element.setAttribute(attribute, value)
      b.root.append(element)
      b.press({ code: 'KeyA' }) // clear any press the previous iteration left
      b.press()
      expect(b.press({}, element)).toBe(false)
      b.press()
      expect(b.cancel).not.toHaveBeenCalled()
      element.remove()
    }
  })

  it('clears on running and removed lifecycle changes', async () => {
    const b = await bench()
    b.press()
    await b.update((draft) => { draft.running = false })
    expect(b.press()).toBe(false)
    await b.update((draft) => { draft.running = true })
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    await b.update((draft) => { draft.removed = true })
    expect(b.press()).toBe(false)
  })

  it('requires a live binding and an observed open turn before arming', async () => {
    const b = await bench()
    b.root.dataset.conversationSession = 'missing'
    expect(b.press()).toBe(false)
    b.root.dataset.conversationSession = SID
    await b.update((draft) => { draft.chat = chatSnapshotFixture({}) })
    expect(b.press()).toBe(false)
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('retains the first press across updates inside the same running turn', async () => {
    const b = await bench()
    b.press()
    await b.update((draft) => {
      draft.chat = chatSnapshotFixture({ turnTimings: new Map([[1, { startTime: 1 }]]) })
    })
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('uses the existing stop path for continuable children and excludes one-shot children', async () => {
    const b = await bench()
    await b.update((draft) => {
      draft.subagent = {
        address: { parentSessionId: 'parent' as SessionId, childSessionId: SID, mode: 'one-shot' },
        parentAvailable: false,
      }
    })
    expect(b.press()).toBe(false)
    await b.update((draft) => {
      draft.subagent = {
        address: { parentSessionId: 'parent' as SessionId, childSessionId: SID, mode: 'continuable' },
        parentAvailable: true,
      }
    })
    b.press()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('does not arm without a cancellable live turn or after disposal', async () => {
    const b = await bench()
    await b.update((draft) => {
      draft.chat = chatSnapshotFixture({
        turnTimings: new Map([[1, { startTime: 1, endTime: 2 }]]),
        turnEnds: new Map([[1, 2]]),
      })
    })
    expect(b.press()).toBe(false)
    b.press()
    b.dispose()
    expect(b.press()).toBe(false)
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('does not combine presses across a Session binding replacement', async () => {
    const b = await bench()
    b.press()
    await b.runtime.sessions.remove(SID)
    await b.runtime.sessions.add({ id: SID, snapshot: runningChat(new Map([[1, { startTime: 1 }]])), session: sessionFace })
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })
})
