/** Adapter run loops, event-stream resume, cursor persistence, catch-up, and host restarts. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatAdapterError } from '@deepseek-ai/dsh-chat-adapter'
import { FakeChatAdapter } from '@deepseek-ai/dsh-chat-adapter-fake'
import { TurnRenderer } from '../src/turns.ts'
import { boot, cleanup, member, readState, REMOTE, seedState } from './helpers.ts'
import { begin, delta, finish } from './turn.ts'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

const FAKE_TIMERS: NonNullable<Parameters<typeof vi.useFakeTimers>[0]> = { toFake: ['setTimeout', 'clearTimeout', 'Date'] }

/** An adapter whose `run` consults a script before falling back to the fake's wait-for-abort loop. */
class ScriptedAdapter extends FakeChatAdapter {
  runs = 0
  script: Array<(signal: AbortSignal) => Promise<void>> = []
  stopFails = false

  override run(sink: Parameters<FakeChatAdapter['run']>[0], signal: AbortSignal): Promise<void> {
    this.runs += 1
    const step = this.script.shift()
    return step === undefined ? super.run(sink, signal) : step(signal)
  }

  override stop(): Promise<void> {
    return this.stopFails ? Promise.reject(new Error('stop failed')) : super.stop()
  }
}

describe('adapter run loops', () => {
  it('retries a dropped connection with exponential backoff and reports it in /status', async () => {
    vi.useFakeTimers(FAKE_TIMERS)
    const flaky = new ScriptedAdapter({ botId: 'flaky' })
    flaky.script = [
      () => Promise.reject(new ChatAdapterError('network', 'fake', 'reset')),
      () => Promise.reject(new Error('socket closed')),
    ]
    const h = await boot({ config: { members: [member()] } })
    h.ctx.chatAdapters.register(flaky)
    await vi.advanceTimersByTimeAsync(0)
    await h.say('100', '/status')
    expect(h.sent().at(-1)).toContain('Platform fake:flaky: platform connection interrupted, reconnecting')
    expect(flaky.runs).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(flaky.runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(flaky.runs).toBe(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(flaky.runs).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(flaky.runs).toBe(3)
    await h.say('100', '/status')
    expect(h.sent().at(-1)).toContain('Platform fake:flaky: running')
  })

  it('resets the backoff after a healthy run and honors a platform retry hint', async () => {
    vi.useFakeTimers(FAKE_TIMERS)
    const adapter = new ScriptedAdapter({ botId: 'flaky' })
    adapter.script = [
      () => Promise.reject(new ChatAdapterError('network', 'fake', 'reset')),
      () => Promise.reject(new ChatAdapterError('network', 'fake', 'reset')),
      async () => { await new Promise(resolve => setTimeout(resolve, 31_000)); throw new ChatAdapterError('network', 'fake', 'reset') },
      () => Promise.reject(new ChatAdapterError('rate-limited', 'fake', 'slow', { retryAfterMs: 7_000 })),
      () => Promise.reject(new ChatAdapterError('rate-limited', 'fake', 'slow')),
    ]
    const h = await boot({ config: { members: [member()] } })
    h.ctx.chatAdapters.register(adapter)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(adapter.runs).toBe(3)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(adapter.runs).toBe(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(adapter.runs).toBe(4)
    await vi.advanceTimersByTimeAsync(6_999)
    expect(adapter.runs).toBe(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.runs).toBe(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.runs).toBe(6)
  })

  it('stops an adapter whose credential was rejected and says so', async () => {
    const bad = new ScriptedAdapter({ botId: 'bad' })
    bad.script = [() => Promise.reject(new ChatAdapterError('auth-failed', 'fake', '401'))]
    const h = await boot({ config: { members: [member()] } })
    h.ctx.chatAdapters.register(bad)
    await vi.waitFor(() => { expect(bad.runs).toBe(1) })
    await h.say('100', '/status')
    expect(h.sent().at(-1)).toContain('Platform fake:bad: the platform credential is invalid, contact the owner')
    expect(bad.runs).toBe(1)
  })

  it('requests exit when a second instance polls the same bot', async () => {
    const dup = new ScriptedAdapter({ botId: 'dup' })
    dup.script = [() => Promise.reject(new ChatAdapterError('poll-conflict', 'fake', '409'))]
    const h = await boot({ config: { members: [member()] } })
    h.ctx.chatAdapters.register(dup)
    await vi.waitFor(() => { expect(h.exits).toEqual([1]) })
    await h.say('100', '/status')
    expect(h.sent().at(-1)).toContain('another instance is polling this bot; stopped')
  })

  it('does not require the launcher exit hook', async () => {
    const dup = new ScriptedAdapter({ botId: 'dup' })
    dup.script = [() => Promise.reject(new ChatAdapterError('poll-conflict', 'fake', '409'))]
    const h = await boot({ config: { members: [member()] } })
    h.ctx.chatAdapters.register(dup)
    await vi.waitFor(() => { expect(dup.runs).toBe(1) })
  })

  it('stays quiet when an adapter fails while it is being stopped', async () => {
    const stubborn = new ScriptedAdapter({ botId: 'stubborn' })
    stubborn.stopFails = true
    stubborn.script = [async (signal) => {
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      throw new ChatAdapterError('network', 'fake', 'closed during stop')
    }]
    const h = await boot({ config: { members: [member()] } })
    const dispose = h.ctx.chatAdapters.register(stubborn)
    await vi.waitFor(() => { expect(stubborn.runs).toBe(1) })
    dispose()
    await vi.waitFor(() => { expect(stubborn.runs).toBe(1) })
    const other = new ScriptedAdapter({ botId: 'other' })
    other.stopFails = true
    h.ctx.chatAdapters.register(other)
    await vi.waitFor(() => { expect(other.runs).toBe(1) })
    await h.stopBridge()
  })

  it('starts late-registered adapters and stops unregistered ones', async () => {
    const h = await boot({ config: { members: [member()] } })
    const late = new FakeChatAdapter({ botId: 'late' })
    const dispose = h.ctx.chatAdapters.register(late)
    await vi.waitFor(() => { expect(late.running).toBe(true) })
    await late.enqueue({
      type: 'message', messageId: 'l1', route: { kind: 'direct', chatId: '100' }, sender: { userId: '100', isBot: false },
      addressed: true, text: '/whoami', controlText: '/whoami', attachments: [], platformTime: 1,
    })
    expect(late.transcript).toHaveLength(1)
    dispose()
    await vi.waitFor(() => { expect(late.running).toBe(false) })
    dispose()
  })

  it('ignores detaching an adapter it never ran', async () => {
    const h = await boot()
    const stranger = new FakeChatAdapter({ botId: 'stranger' })
    h.ctx.chatAdapters.register(stranger)()
    await vi.waitFor(() => { expect(stranger.running).toBe(false) })
  })

  it('stops every adapter and stream when its scope is disposed', async () => {
    const h = await boot({ config: { members: [member({ dshRemoteHost: REMOTE })] } })
    await h.ctx.fiber.dispose()
    expect(h.adapter.running).toBe(false)
    expect(h.client.muxes.every(mux => mux.closed)).toBe(true)
  })

  it('does not start adapters registered while stopping', async () => {
    const h = await boot()
    const unregister = h.ctx.chatAdapters.register(new FakeChatAdapter({ botId: 'z' }))
    unregister()
    await h.ctx.fiber.dispose()
  })
})

describe('event streams', () => {
  it('persists cursors after a debounce and on shutdown', async () => {
    vi.useFakeTimers(FAKE_TIMERS)
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    expect(h.state().table('cursors').size).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => { expect(h.state().table('cursors').get('local')).toEqual({ [turn.sessionId]: 1 }) })
    await turn.next('assistant/chunk', delta('x'))
    await h.stopBridge()
    expect(await readState(h.root, state => state.table('cursors').get('local'))).toEqual({ [turn.sessionId]: 2 })
  })

  it('stays quiet when shutdown closed the state before the last cursor write', async () => {
    const h = await boot({ config: { members: [member()] } })
    await begin(h)
    await h.ctx.fiber.dispose()
  })

  it('warns and continues when cursors cannot be written', async () => {
    vi.useFakeTimers(FAKE_TIMERS)
    const h = await boot({ config: { members: [member()] } })
    const put = vi.spyOn(h.state().table('cursors'), 'put').mockRejectedValue(new Error('disk full'))
    await begin(h)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => { expect(put).toHaveBeenCalled() })
    expect(h.state().table('cursors').size).toBe(0)
  })

  it('resumes from stored cursors: replays by history, skips applied events, and reads remote streams', async () => {
    const root = await seedState(async (state) => {
      const base = { ownerKey: 'fake:200', botId: 'fake-bot', platform: 'fake', route: { kind: 'direct' as const, chatId: '200' }, cwd: '/x', createdAt: 1 }
      await state.table('sessions').put('chat-local', { ...base, sessionId: 'chat-local' })
      await state.table('sessions').put('chat-remote', { ...base, sessionId: 'chat-remote', remoteHost: REMOTE })
      await state.table('sessions').put('chat-fresh', { ...base, sessionId: 'chat-fresh' })
      await state.table('cursors').put('local', { 'chat-local': 4, 'chat-gone': 9 })
      await state.table('cursors').put(REMOTE, { 'chat-remote': 2 })
    })
    const h = await boot({ root, config: { members: [member({ dshRemoteHost: REMOTE })] } })
    expect(h.client.muxes.map(mux => [mux.options.remoteHost, mux.options.cursors])).toEqual([
      [undefined, { 'chat-local': 4, 'chat-gone': 9 }], [REMOTE, { 'chat-remote': 2 }],
    ])
    let page = 0
    h.client.on('session.history', (payload) => {
      page += 1
      return payload.sessionId === 'chat-local' && page === 1
        ? { events: [{ event: { type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } } }], hasMore: true }
        : { events: [], hasMore: true }
    })
    for (const mux of h.client.muxes) mux.markOpen()
    await vi.waitFor(() => { expect(h.client.of('session.history').length).toBeGreaterThanOrEqual(3) })
    const calls = h.client.of('session.history')
    expect(calls.map(call => call.payload)).toEqual(expect.arrayContaining([
      { sessionId: 'chat-local', afterSeq: 4, maxEvents: 200 }, { sessionId: 'chat-local', afterSeq: 5, maxEvents: 200 },
      { sessionId: 'chat-remote', afterSeq: 2, maxEvents: 200 },
    ]))
    expect(calls.find(call => call.payload.sessionId === 'chat-remote')?.options).toEqual({ remoteHost: REMOTE })
    expect(calls.some(call => call.payload.sessionId === 'chat-fresh')).toBe(false)
    await h.client.mux().event('chat-local', 3, 'turn/start', { turn: 1 })
    await h.client.mux().event('chat-local', 5, 'turn/start', { turn: 1 })
  })

  it('tolerates a stream that closes before it opens', async () => {
    const h = await boot({ config: { members: [member()] } })
    h.client.mux().markClosed()
    await h.say('100', '/whoami')
    expect(h.sent()).toHaveLength(1)
  })

  it('logs a failed catch-up and keeps serving', async () => {
    const root = await seedState(async (state) => {
      await state.table('sessions').put('chat-local', {
        sessionId: 'chat-local', ownerKey: 'fake:200', botId: 'fake-bot', platform: 'fake',
        route: { kind: 'direct', chatId: '200' }, cwd: '/x', createdAt: 1,
      })
      await state.table('cursors').put('local', { 'chat-local': 1 })
    })
    const h = await boot({ root, config: { members: [member()] } })
    h.client.on('session.history', () => { throw new Error('history down') })
    h.client.mux().markOpen()
    await vi.waitFor(() => { expect(h.client.of('session.history')).toHaveLength(1) })
    await h.say('200', '/whoami')
    expect(h.sent()[0]).toContain('fake:200')
  })

  it('reconciles after a host restart: expires pending cards and replays history', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    h.client.on('session.history', () => ({ events: [{ event: { type: 'assistant/chunk', seq: 2, time: 1, data: delta('late') } }, { event: { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } }], hasMore: false }))
    turn.mux.options.onHostRestart?.('boot-1', 'boot-2')
    await vi.waitFor(() => { expect(h.sent().at(-1)).toBe('late') })
  })

  it('reports and survives a rendering failure', async () => {
    const h = await boot({ config: { members: [member()] } })
    const turn = await begin(h)
    vi.spyOn(TurnRenderer.prototype, 'apply').mockRejectedValueOnce(new Error('renderer broke'))
    await turn.next('assistant/chunk', delta('lost'))
    await turn.next('assistant/chunk', delta('found'))
    await finish(turn)
    expect(h.sent().at(-1)).toBe('found')
  })

  it('keeps its own state apart per platform message', async () => {
    const h = await boot({ config: { members: [member()] } })
    expect(h.client.muxes).toHaveLength(1)
    expect(h.client.mux().options.remoteHost).toBeUndefined()
  })
})
