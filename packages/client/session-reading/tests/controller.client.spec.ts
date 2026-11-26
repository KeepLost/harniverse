/**
 * SessionReadingController: the Host ledger mirror, the attention-gated
 * acknowledgement, and the manual-mark hold, over a fake Host ledger, fake
 * sessions, and a fake page-attention face.
 */
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionReadingAction, SessionReadingRecord } from '../src/types.ts'
import { SessionReadingController } from '../src/client/controller.ts'
import type { ReadingPage, ReadingSessions, SessionReadingRemote } from '../src/client/controller.ts'

const sid = (id: string): SessionId => id as SessionId

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** Minimal observable cell the fakes publish through. */
function cell<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: (): T => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: T): void {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: (): number => listeners.size,
  }
}

type Ledger = { current: SessionId | undefined }
type Transcript = Pick<ConversationSnapshot, 'turnEnds' | 'openState'>

const record = (sessionId: string, over: Partial<SessionReadingRecord> = {}): SessionReadingRecord => ({
  sessionId: sid(sessionId),
  completedTurn: 1,
  failed: false,
  readTurn: 0,
  manualUnread: false,
  ...over,
})

const carried = <T>(value: T) => Promise.resolve({ ok: true as const, value })

interface Bench {
  controller: SessionReadingController
  /** The fake Host ledger; tests edit it in place to simulate Host changes. */
  ledger: SessionReadingRecord[]
  list: Mock<SessionReadingRemote['list']>
  mark: Mock<SessionReadingRemote['mark']>
  listState: ReturnType<typeof cell<Ledger>>
  transcript: ReturnType<typeof cell<Transcript>>
  page: { focused: boolean; focusListeners: Set<() => void> }
}

/** One controller over a fake Host ledger whose marks apply like the real service. */
function bench(records: readonly SessionReadingRecord[], options: { selected?: SessionId; attended?: boolean } = {}): Bench {
  const ledger = [...records]
  const remote = {
    list: vi.fn<SessionReadingRemote['list']>(() => carried({ records: [...ledger] })),
    mark: vi.fn<SessionReadingRemote['mark']>((sessionId: SessionId, action: SessionReadingAction) => {
      const row = ledger.find(candidate => candidate.sessionId === sessionId)
      const stored = action === 'unread'
        ? { ...(row ?? record(sessionId, { completedTurn: 0 })), manualUnread: true }
        : row === undefined ? undefined : { ...row, manualUnread: false, readTurn: row.completedTurn }
      if (stored !== undefined && row === undefined) ledger.push(stored)
      else if (stored !== undefined && row !== undefined) ledger[ledger.indexOf(row)] = stored
      return carried({ record: stored ?? null })
    }),
  }
  const listState = cell<Ledger>({ current: options.selected })
  const transcript = cell<Transcript>(shows(1))
  const page = { focused: true, focusListeners: new Set<() => void>() }
  const sessions: ReadingSessions = { list: listState, binding: () => ({ session: transcript }) }
  const attention: ReadingPage = {
    focused: () => page.focused,
    onFocusedChange: (listener) => {
      page.focusListeners.add(listener)
      return () => { page.focusListeners.delete(listener) }
    },
  }
  const controller = new SessionReadingController(remote, sessions, attention)
  controller.start()
  if (options.selected !== undefined && options.attended !== false) controller.getSnapshot().report(options.selected, true)
  return { controller, ledger, list: remote.list, mark: remote.mark, listState, transcript, page }
}

/** The marks the controller sent so far, in order. */
const sent = (b: Bench): Array<{ sessionId: SessionId; action: SessionReadingAction }> =>
  b.mark.mock.calls.map(([sessionId, action]) => ({ sessionId, action }))

/** A transcript window that finished loading and holds the given completed turns. */
const shows = (...turns: number[]): Transcript => ({
  turnEnds: new Map(turns.map(turn => [turn, turn])),
  openState: 'open',
})

/** Let every pending promise chain settle before the next assertion. */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round++) await Promise.resolve()
}

/** A started controller whose page never has focus and whose sessions are inert. */
function unfocused(remote: SessionReadingRemote): { controller: SessionReadingController } {
  const controller = new SessionReadingController(remote, {
    list: cell<Ledger>({ current: undefined }),
    binding: () => undefined,
  }, { focused: () => false, onFocusedChange: () => () => {} })
  controller.start()
  return { controller }
}

describe('SessionReadingController ledger mirror', () => {
  it('publishes only the unread rows once the first list lands and keeps the snapshot stable across equal refreshes', async () => {
    const b = bench([
      record('done'),
      record('read', { readTurn: 1 }),
      record('broken', { failed: true }),
      record('flagged', { completedTurn: 0, manualUnread: true }),
    ], { attended: false })
    const listener = vi.fn()
    b.controller.subscribe(listener)
    const initial = b.controller.getSnapshot()
    expect(initial.unread).toEqual({})
    await settle()
    expect(b.controller.getSnapshot().unread).toEqual({
      done: { failed: false },
      broken: { failed: true },
      flagged: { failed: false },
    })
    expect(listener).toHaveBeenCalledTimes(1)
    const published = b.controller.getSnapshot()
    await b.controller.refresh()
    expect(b.controller.getSnapshot()).toBe(published)
    expect(listener).toHaveBeenCalledTimes(1)
    b.controller.dispose()
  })

  it('republishes when a row keeps its session but its failure bit flips', async () => {
    const b = bench([record('flaky')], { attended: false })
    await settle()
    expect(b.controller.getSnapshot().unread).toEqual({ flaky: { failed: false } })
    b.ledger[0] = record('flaky', { failed: true })
    await b.controller.invalidate()
    expect(b.controller.getSnapshot().unread).toEqual({ flaky: { failed: true } })
    b.controller.dispose()
  })

  it('collapses a change signal that lands during a fetch into one trailing refetch', async () => {
    const first = deferred<Awaited<ReturnType<SessionReadingRemote['list']>>>()
    let blocked = true
    const remote = {
      list: vi.fn<SessionReadingRemote['list']>(() => blocked
        ? first.promise
        : carried({ records: [record('late')] })),
      mark: vi.fn<SessionReadingRemote['mark']>(),
    }
    const { controller } = unfocused(remote)
    const joined = controller.invalidate()
    expect(remote.list).toHaveBeenCalledTimes(1)
    void controller.invalidate()
    expect(remote.list).toHaveBeenCalledTimes(1)
    blocked = false
    first.resolve({ ok: true, value: { records: [] } })
    await joined
    await settle()
    expect(remote.list).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().unread).toEqual({ late: { failed: false } })
    controller.dispose()
  })

  it('keeps the last ledger when a fetch is refused or throws, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const outcomes: Array<() => ReturnType<SessionReadingRemote['list']>> = [
        () => carried({ records: [record('kept')] }),
        () => Promise.resolve({ ok: false as const, error: { code: 'forbidden', message: 'denied', details: {} } }),
        () => Promise.reject(new Error('unmounted method')),
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises the non-Error arm of describeFailure.
        () => Promise.reject('link down'),
      ]
      const { controller } = unfocused({ list: () => (outcomes.shift() as () => ReturnType<SessionReadingRemote['list']>)(), mark: vi.fn() })
      await settle()
      expect(controller.getSnapshot().unread).toEqual({ kept: { failed: false } })
      await controller.refresh()
      await controller.refresh()
      await controller.refresh()
      expect(controller.getSnapshot().unread).toEqual({ kept: { failed: false } })
      expect(warn.mock.calls.map(args => String(args[1]))).toEqual(['denied', 'unmounted method', 'link down'])
      controller.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  it('hands start its own disposer, tolerates repeated disposal, and lets a subscriber leave', async () => {
    let ledger: readonly SessionReadingRecord[] = [record('done')]
    const remote = {
      list: vi.fn<SessionReadingRemote['list']>(() => carried({ records: ledger })),
      mark: vi.fn<SessionReadingRemote['mark']>(),
    }
    const list = cell<Ledger>({ current: undefined })
    const controller = new SessionReadingController(remote, { list, binding: () => undefined }, {
      focused: () => false,
      onFocusedChange: () => () => {},
    })
    const stop = controller.start()
    const listener = vi.fn()
    const leave = controller.subscribe(listener)
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    leave()
    ledger = [record('other')]
    await controller.invalidate()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(list.listenerCount()).toBe(1)
    stop()
    controller.dispose()
    expect(list.listenerCount()).toBe(0)
  })

  it('contains a throwing subscriber so the rest still observe the ledger', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const b = bench([record('done')], { attended: false })
    const seen: number[] = []
    b.controller.subscribe(() => { throw new Error('broken subscriber') })
    b.controller.subscribe(() => { seen.push(seen.length + 1) })
    await settle()
    expect(seen).toEqual([1])
    b.controller.dispose()
  })

  it('ignores a late ledger answer after disposal', async () => {
    const first = deferred<Awaited<ReturnType<SessionReadingRemote['list']>>>()
    const { controller } = unfocused({ list: () => first.promise, mark: vi.fn() })
    controller.dispose()
    first.resolve({ ok: true, value: { records: [record('late')] } })
    await settle()
    expect(controller.getSnapshot().unread).toEqual({})
    await expect(controller.refresh()).resolves.toBeUndefined()
  })
})

describe('SessionReadingController acknowledgement', () => {
  it('acknowledges once the selected, visible, focused reader holds the completed turn in the transcript', async () => {
    const b = bench([record('s1')], { selected: sid('s1') })
    await settle()
    expect(sent(b)).toEqual([{ sessionId: sid('s1'), action: 'read' }])
    expect(b.list).toHaveBeenCalledTimes(2)
    expect(b.controller.getSnapshot().unread).toEqual({})
    b.controller.dispose()
  })

  it('waits for each missing condition instead of acknowledging', async () => {
    const b = bench([record('s1'), record('s2')], { selected: sid('s1'), attended: false })
    await settle()
    // Row not reported visible.
    expect(sent(b)).toEqual([])
    b.controller.getSnapshot().report(sid('s2'), true)
    // The report names another session.
    expect(sent(b)).toEqual([])
    b.page.focused = false
    b.controller.getSnapshot().report(sid('s1'), true)
    // Page unfocused.
    expect(sent(b)).toEqual([])
    b.transcript.set(shows())
    b.page.focused = true
    for (const listener of b.page.focusListeners) listener()
    // Focus returned, but the transcript no longer holds the completed turn.
    expect(sent(b)).toEqual([])
    b.transcript.set(shows(1))
    expect(sent(b)).toEqual([{ sessionId: sid('s1'), action: 'read' }])
    b.controller.dispose()
  })

  it('leaves an already-read row and a hidden row alone', async () => {
    const b = bench([record('s1', { readTurn: 1 })], { selected: sid('s1') })
    await settle()
    expect(sent(b)).toEqual([])
    b.controller.getSnapshot().report(sid('s1'), false)
    b.listState.set({ current: sid('s2') })
    b.listState.set({ current: sid('s1') })
    expect(sent(b)).toEqual([])
    b.controller.dispose()
  })

  it('acknowledges a completion that arrives while the reader is already looking', async () => {
    const b = bench([record('s1', { readTurn: 1 })], { selected: sid('s1') })
    await settle()
    expect(sent(b)).toEqual([])
    b.ledger[0] = record('s1', { completedTurn: 2 })
    await b.controller.invalidate()
    // The transcript still shows turn 1 only.
    expect(sent(b)).toEqual([])
    b.transcript.set(shows(1, 2))
    expect(sent(b)).toEqual([{ sessionId: sid('s1'), action: 'read' }])
    b.controller.dispose()
  })

  it('waits for the window to finish loading when the ledger credits no completed turn', async () => {
    const b = bench([record('s1', { completedTurn: 0, manualUnread: true })], { selected: sid('s1'), attended: false })
    await settle()
    b.controller.getSnapshot().report(sid('s1'), true)
    // A manual unread observed while its session is selected is held.
    expect(sent(b)).toEqual([])
    b.listState.set({ current: sid('s2') })
    b.transcript.set({ ...shows(), openState: 'loading' })
    b.listState.set({ current: sid('s1') })
    expect(sent(b)).toEqual([])
    b.transcript.set(shows())
    expect(sent(b)).toEqual([{ sessionId: sid('s1'), action: 'read' }])
    b.controller.dispose()
  })

  it('follows the selection: subscribes to the selected transcript only', async () => {
    const b = bench([], { selected: sid('s1') })
    await settle()
    expect(b.transcript.listenerCount()).toBe(1)
    b.listState.set({ current: sid('s2') })
    expect(b.transcript.listenerCount()).toBe(1)
    b.listState.set({ current: undefined })
    expect(b.transcript.listenerCount()).toBe(0)
    b.controller.dispose()
    expect(b.page.focusListeners.size).toBe(0)
    expect(b.listState.listenerCount()).toBe(0)
  })

  it('acknowledges again after the reader leaves and a new turn completes', async () => {
    const b = bench([record('s1')], { selected: sid('s1') })
    await settle()
    expect(sent(b)).toHaveLength(1)
    b.listState.set({ current: sid('s2') })
    b.ledger[0] = record('s1', { completedTurn: 2 })
    await b.controller.invalidate()
    // Not selected: the completion stays unread.
    expect(sent(b)).toHaveLength(1)
    expect(b.controller.getSnapshot().unread).toEqual({ s1: { failed: false } })
    b.transcript.set(shows(1, 2))
    b.listState.set({ current: sid('s1') })
    await settle()
    expect(sent(b).map(mark => [mark.sessionId, mark.action])).toEqual([[sid('s1'), 'read'], [sid('s1'), 'read']])
    b.controller.dispose()
  })

  it('sends one acknowledgement while the earlier one is in flight and retries when the refetch still shows the turn unread', async () => {
    const b = bench([record('s1')], { selected: sid('s1') })
    const first = deferred<Awaited<ReturnType<SessionReadingRemote['mark']>>>()
    let attempts = 0
    b.mark.mockImplementation((_sessionId, _action) => {
      attempts += 1
      if (attempts === 1) return first.promise
      const stored = record('s1', { readTurn: 1 })
      b.ledger[0] = stored
      return carried({ record: stored })
    })
    await settle()
    expect(sent(b)).toHaveLength(1)
    b.transcript.set(shows(1))
    b.controller.getSnapshot().report(sid('s1'), true)
    await settle()
    expect(sent(b)).toHaveLength(1)
    // The fake Host never applied the first mark: its ledger still says unread.
    first.resolve({ ok: true, value: { record: record('s1', { readTurn: 1 }) } })
    await settle()
    expect(sent(b).map(mark => mark.action)).toEqual(['read', 'read'])
    b.transcript.set(shows(1))
    await settle()
    expect(sent(b)).toHaveLength(2)
    b.controller.dispose()
  })

  it('subscribes once the selected session gains its transcript binding', async () => {
    let available = false
    const list = cell<Ledger>({ current: sid('s1') })
    const transcript = cell<Transcript>(shows(1))
    const mark = vi.fn<SessionReadingRemote['mark']>(() => carried({ record: record('s1', { readTurn: 1 }) }))
    let read = false
    const controller = new SessionReadingController({
      list: () => carried({ records: [record('s1', read ? { readTurn: 1 } : {})] }),
      mark: (...args) => {
        read = true
        return mark(...args)
      },
    }, { list, binding: () => available ? { session: transcript } : undefined }, {
      focused: () => true,
      onFocusedChange: () => () => {},
    })
    controller.start()
    controller.getSnapshot().report(sid('s1'), true)
    await settle()
    // Without a binding there is no transcript to show the turn.
    expect(transcript.listenerCount()).toBe(0)
    expect(mark).not.toHaveBeenCalled()
    available = true
    list.set({ current: sid('s1') })
    await settle()
    expect(transcript.listenerCount()).toBe(1)
    expect(mark.mock.calls.map(([sessionId]) => sessionId)).toEqual([sid('s1')])
    controller.dispose()
  })

  it('retries a refused acknowledgement on the next attention change', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const b = bench([record('s1')], { selected: sid('s1') })
      b.mark.mockImplementationOnce(() => Promise.resolve({
        ok: false as const,
        error: { code: 'forbidden', message: 'denied', details: {} },
      }))
      await settle()
      expect(sent(b)).toEqual([{ sessionId: sid('s1'), action: 'read' }])
      expect(warn).toHaveBeenCalledTimes(1)
      b.transcript.set(shows(1))
      await settle()
      expect(sent(b).map(mark => mark.action)).toEqual(['read', 'read'])
      b.controller.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  it('reports a broken mark and retries it on the next attention change', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const b = bench([record('s1')], { selected: sid('s1') })
      b.mark.mockImplementationOnce(() => Promise.reject(new Error('carrier gone')))
      await settle()
      expect(sent(b)).toHaveLength(1)
      b.transcript.set(shows(1))
      await settle()
      expect(sent(b)).toHaveLength(2)
      expect(warn.mock.calls.map(args => [String(args[0]), String(args[1])])).toEqual([
        ['[session-reading] mark failed:', 'carrier gone'],
      ])
      b.controller.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps a manual unread while the session stays selected and acknowledges it after leaving and returning', async () => {
    const b = bench([record('s1', { readTurn: 1 })], { selected: sid('s1') })
    await settle()
    expect(sent(b)).toEqual([])
    b.controller.getSnapshot().mark(sid('s1'), 'unread')
    await settle()
    expect(sent(b)).toEqual([{ sessionId: sid('s1'), action: 'unread' }])
    expect(b.controller.getSnapshot().unread).toEqual({ s1: { failed: false } })
    // Looking again at the session the reader just flagged must not clear it.
    b.page.focused = false
    for (const listener of b.page.focusListeners) listener()
    b.page.focused = true
    for (const listener of b.page.focusListeners) listener()
    b.controller.getSnapshot().report(sid('s1'), false)
    b.controller.getSnapshot().report(sid('s1'), true)
    expect(sent(b)).toHaveLength(1)
    b.listState.set({ current: sid('s2') })
    b.listState.set({ current: sid('s1') })
    await settle()
    expect(sent(b).map(mark => mark.action)).toEqual(['unread', 'read'])
    expect(b.controller.getSnapshot().unread).toEqual({})
    b.controller.dispose()
  })

  it('holds a manual unread that arrived from another reader while the session is selected', async () => {
    const b = bench([], { selected: sid('s1') })
    await settle()
    b.ledger.push(record('s1', { completedTurn: 0, manualUnread: true }))
    await b.controller.invalidate()
    expect(sent(b)).toEqual([])
    expect(b.controller.getSnapshot().unread).toEqual({ s1: { failed: false } })
    b.listState.set({ current: undefined })
    b.listState.set({ current: sid('s1') })
    await settle()
    expect(sent(b).map(mark => mark.action)).toEqual(['read'])
    b.controller.dispose()
  })

  it('refetches after a manual mark of another session and reports its refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const b = bench([record('s1', { readTurn: 1 })], { selected: sid('s1') })
      b.mark.mockImplementationOnce(() => Promise.resolve({
        ok: false as const,
        error: { code: 'forbidden', message: 'denied', details: {} },
      }))
      const before = b.list.mock.calls.length
      b.controller.getSnapshot().mark(sid('s2'), 'unread')
      await settle()
      expect(sent(b)).toEqual([{ sessionId: sid('s2'), action: 'unread' }])
      expect(b.list).toHaveBeenCalledTimes(before)
      expect(warn).toHaveBeenCalledTimes(1)
      b.controller.getSnapshot().mark(sid('s2'), 'unread')
      await settle()
      expect(b.list).toHaveBeenCalledTimes(before + 1)
      expect(b.controller.getSnapshot().unread).toEqual({ s2: { failed: false } })
      b.controller.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  it('stops acknowledging after disposal', async () => {
    const b = bench([record('s1')], { selected: sid('s1') })
    await settle()
    expect(sent(b)).toHaveLength(1)
    b.controller.dispose()
    b.ledger[0] = record('s1', { completedTurn: 2 })
    b.transcript.set(shows(1, 2))
    for (const listener of b.page.focusListeners) listener()
    b.controller.getSnapshot().mark(sid('s1'), 'unread')
    await settle()
    expect(sent(b)).toHaveLength(1)
    expect(b.page.focusListeners.size).toBe(0)
  })
})
