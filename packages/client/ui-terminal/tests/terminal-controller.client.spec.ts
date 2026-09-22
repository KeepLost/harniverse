/**
 * The terminal panel controller as a state machine over scripted wire deps:
 * the terminal/hold streams are hub-fed frame queues and the `/api` RPC
 * caller records every call, so each spec drives one behavior — list loads,
 * the exclusive-input follow stream (snapshot, ordered deltas, demotion),
 * window holds, the bounded slow-follower ladder, and the verb wire shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RpcId,
  type HoldStreamFrame,
  type RpcError,
  type RpcRequest,
  type RpcResult,
  type SessionId,
  type TerminalStreamFrame,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  TerminalAttachmentId, TerminalEnvironment, TerminalShell, WebTerminalId, WebTerminalInfo,
} from '@deepseek-ai/dsh-api-terminal-controller/types'
import { TerminalPanelController, type TerminalPanelDeps, type TerminalSurface } from '../src/client/controller.ts'

/** Terminal follow-stream binding as the client events face takes it. */
type TerminalBinding = Parameters<TerminalPanelDeps['events']['terminal']>[0]

/** Window-hold binding as the client events face takes it. */
type HoldBinding = Parameters<TerminalPanelDeps['events']['hold']>[0]

/** Wire error shape carried by stream/error frames and RPC failures. */
interface WireError { code: string; message: string; details?: unknown }

/** One programmable stream open: frames queue up until the pump consumes. */
interface StreamOpen<P, F> {
  /** Binding the controller passed when opening the stream. */
  readonly payload: P
  /** Abort signal the controller bound the stream lifetime to. */
  readonly signal: AbortSignal
  /** Deliver one frame to the consumer. */
  feed: (frame: F) => void
  /** Complete the stream as the carrier would on a clean detach. */
  end: () => void
  /** Fail the stream as the carrier would on a transport error. */
  fail: (error: unknown) => void
}

/**
 * A hub of scripted streams: each open becomes an entry whose frames the
 * spec feeds explicitly; consumers pull RpcRequest-wrapped frames.
 */
class FrameHub<P, F> {
  /** Every open in arrival order. */
  readonly opens: StreamOpen<P, F>[] = []
  private counter = 0

  /** The stream face handed to the controller. */
  readonly stream = (payload: P, signal: AbortSignal): AsyncIterable<RpcRequest<F>> => {
    let notify: (() => void) | undefined
    let failure: { error: unknown } | undefined
    let finished = false
    const queue: RpcRequest<F>[] = []
    const wake = (): void => {
      const listener = notify
      notify = undefined
      listener?.()
    }
    this.opens.push({
      payload,
      signal,
      feed: (frame) => {
        queue.push({ rpcId: RpcId(`hub-${++this.counter}`), payload: frame })
        wake()
      },
      end: () => { finished = true; wake() },
      fail: (error) => { failure = { error }; wake() },
    })
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<RpcRequest<F>>> => {
          for (;;) {
            const next = queue.shift()
            if (next !== undefined) return { value: next, done: false }
            if (failure !== undefined) throw failure.error
            if (finished) return { value: undefined, done: true }
            await new Promise<void>((resolve) => { notify = resolve })
          }
        },
        return: async (): Promise<IteratorResult<RpcRequest<F>>> => ({ value: undefined, done: true }),
      }),
    }
  }
}

/** Recorded `/api` call with its decoded verb arguments. */
interface RecordedCall { channel: string; endpoint: string; args: Record<string, unknown> }

/** Scripted `/api` RPC caller: routes `terminal/<verb>` to spec handlers. */
class FakeRpc {
  /** Every call in arrival order. */
  readonly calls: RecordedCall[] = []
  private readonly handlers = new Map<string, (args: Record<string, unknown>) => RpcResult<unknown>>()

  /** Script a successful verb result. */
  on(method: string, value: (args: Record<string, unknown>) => unknown): void {
    const handler = (args: Record<string, unknown>): RpcResult<unknown> => ({ ok: true, value: value(args) })
    this.handlers.set(`terminal/${method}`, handler)
  }

  /** Script a failing verb result. */
  onError(method: string, error: WireError): void {
    const handler = (): RpcResult<unknown> => ({ ok: false, error: error as never })
    this.handlers.set(`terminal/${method}`, handler)
  }

  /** Drop the scripting for one verb (falls back to an undefined success). */
  off(method: string): void {
    this.handlers.delete(`terminal/${method}`)
  }

  /** The RPC face handed to the controller. */
  readonly call = async (
    channel: string,
    endpoint: string,
    payload: unknown,
  ): Promise<RpcResult<unknown>> => {
    this.calls.push({ channel, endpoint, args: (payload as { args: Record<string, unknown> }).args })
    const handler = this.handlers.get(endpoint)
    if (handler === undefined) return { ok: true, value: undefined }
    return handler((payload as { args: Record<string, unknown> }).args)
  }
}

/** The harness: controller plus its three scripted wire deps. */
function rig() {
  const rpc = new FakeRpc()
  const terminal = new FrameHub<TerminalBinding, TerminalStreamFrame>()
  const hold = new FrameHub<HoldBinding, HoldStreamFrame>()
  const controller = new TerminalPanelController({ rpc, events: { terminal: terminal.stream, hold: hold.stream } })
  /** The open the controller is currently consuming. */
  const current = (): StreamOpen<TerminalBinding, TerminalStreamFrame> => {
    const open = terminal.opens[terminal.opens.length - 1]
    if (open === undefined) throw new Error('no terminal stream open')
    return open
  }
  return { rpc, terminal, hold, controller, current }
}

/** The element at one recorded index, failing loudly when short. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`missing recording at ${index}`)
  return item
}

/** Drain the microtask chain behind one verb's RPC/stream round. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
}

/** A terminal info fixture with the host defaults. */
function info(id: string, overrides: Partial<WebTerminalInfo> = {}): WebTerminalInfo {
  const shell: TerminalShell = { path: '/bin/bash', args: [], name: 'bash' }
  return {
    id: id as WebTerminalId, title: `term ${id}`, shell, cwd: '/tmp', cols: 80, rows: 24,
    state: 'running', exitCode: null, ...overrides,
  }
}

/** The environment fixture the RPC returns. */
const environment: TerminalEnvironment = { cwd: '/tmp', maxInputBytes: 4096, maxCols: 500, maxRows: 200, scrollback: 1000 }

/** One session identity. */
const session = 'sess-1' as SessionId

/** A stream error with the details slot the RpcError shape requires. */
function wireError(code: string, message: string): RpcError {
  return { code, message, details: {} } as never
}

/** The slow-follower failure message the host emits. */
const BUFFER_MESSAGE = 'Terminal output consumer exceeded its buffer; reconnect to recover the current screen'

/** A recording surface: the xterm.js sink double. */
function recordingSurface(): TerminalSurface & { screens: string[]; writes: string[] } {
  const surface = { screens: [] as string[], writes: [] as string[] }
  return {
    screens: surface.screens,
    writes: surface.writes,
    reset: (screen: string) => { surface.screens.push(screen) },
    write: (data: string) => { surface.writes.push(data) },
  }
}

/** Wire a full session load: environment, shells, and the given list. */
function scriptSession(rpc: FakeRpc, terminals: WebTerminalInfo[]): void {
  rpc.on('environment', () => environment)
  rpc.on('shells', () => [{ path: '/bin/bash', args: [], name: 'bash' }, { path: '/bin/zsh', args: [], name: 'zsh' }])
  rpc.on('list', () => terminals)
}

/** Bind a session, mount the recording surface, and deliver one snapshot. */
async function attachedTerminals() {
  const harness = rig()
  scriptSession(harness.rpc, [info('t1')])
  harness.controller.bindSession(session)
  await settle()
  const surface = recordingSurface()
  harness.controller.bindSurface(surface)
  const open = harness.current()
  open.feed({ type: 'snapshot', sequence: 0, screen: '', info: info('t1', { controllerId: open.payload.attachmentId }) })
  await settle()
  return { ...harness, surface }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TerminalPanelController session binding', () => {
  it('binds a session, loads environment, shells, and the list, then reports ready', async () => {
    const { rpc, controller } = rig()
    scriptSession(rpc, [info('t1'), info('t2', { state: 'exited', exitCode: 0 })])
    controller.bindSession(session)
    expect(controller.state.getSnapshot().ready).toBe(false)
    await settle()
    const snapshot = controller.state.getSnapshot()
    expect(snapshot).toMatchObject({ session, ready: true, environment })
    expect(snapshot.terminals).toEqual([info('t1'), info('t2', { state: 'exited', exitCode: 0 })])
    expect(snapshot.shells.map(shell => shell.path)).toEqual(['/bin/bash', '/bin/zsh'])
    expect(rpc.calls.map(call => [call.channel, call.endpoint])).toEqual([
      ['/api', 'terminal/environment'],
      ['/api', 'terminal/shells'],
      ['/api', 'terminal/list'],
    ])
    expect(at(rpc.calls, 0).args).toEqual({ agentId: session })
    expect(at(rpc.calls, 2).args).toEqual({ sessionId: session })
  })

  it('ignores environment and shells failures while still settling the list', async () => {
    const { rpc, controller } = rig()
    rpc.onError('environment', { code: 'internal', message: 'env failed' })
    rpc.onError('shells', { code: 'internal', message: 'shells failed' })
    rpc.on('list', () => [info('t1')])
    controller.bindSession(session)
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ ready: true, environment: undefined, shells: [] })
  })

  it('surfaces a list failure as the error banner', async () => {
    const { rpc, controller } = rig()
    rpc.onError('list', { code: 'internal', message: 'list failed' })
    controller.bindSession(session)
    await settle()
    expect(controller.state.getSnapshot().error).toBe('list failed')
  })

  it('rebinding the same session is a no-op and clearing drops everything', async () => {
    const { rpc, controller } = rig()
    scriptSession(rpc, [info('t1')])
    controller.bindSession(session)
    await settle()
    controller.bindSession(session)
    await settle()
    expect(rpc.calls.filter(call => call.endpoint === 'terminal/list')).toHaveLength(1)
    controller.bindSession(undefined)
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ session: undefined, ready: false, terminals: [], activeId: undefined })
    expect(rpc.calls.filter(call => call.endpoint === 'terminal/list')).toHaveLength(1)
  })

  it('a load racing a session switch does not publish into the new session', async () => {
    const { rpc, controller } = rig()
    let listCalls = 0
    rpc.on('list', () => { listCalls += 1; return listCalls === 1 ? [info('t1')] : [info('t2')] })
    controller.bindSession(session)
    controller.bindSession('sess-2' as SessionId)
    await settle()
    expect(controller.state.getSnapshot().session).toBe('sess-2' as SessionId)
    // Only the second load's list lands: the stale first load never publishes.
    expect(controller.state.getSnapshot().terminals).toEqual([info('t2')])
  })

  it('dispose during an in-flight load drops its publication', async () => {
    const { rpc, controller } = rig()
    rpc.on('list', () => [info('t1')])
    controller.bindSession(session)
    controller.dispose()
    await settle()
    expect(controller.state.getSnapshot().terminals).toEqual([])
  })
})

describe('TerminalPanelController follow stream', () => {
  it('activates the first listed terminal, holds only running ones, and renders the snapshot', async () => {
    const { rpc, terminal, hold, controller, current } = rig()
    scriptSession(rpc, [info('t1', { state: 'exited', exitCode: 0 }), info('t2')])
    controller.bindSession(session)
    await settle()
    expect(terminal.opens).toHaveLength(1)
    expect(at(terminal.opens, 0).payload).toMatchObject({ sessionId: session, id: 't1' as WebTerminalId })
    expect(hold.opens.map(open => open.payload.id)).toEqual(['t2' as WebTerminalId])
    const surface = recordingSurface()
    controller.bindSurface(surface)
    const open = current()
    expect(open.payload.id).toBe('t1' as WebTerminalId)
    open.feed({ type: 'snapshot', sequence: 3, screen: 'prompt $ ', info: info('t1', { controllerId: open.payload.attachmentId }) })
    await settle()
    expect(surface.screens).toEqual(['prompt $ '])
    expect(controller.state.getSnapshot()).toMatchObject({
      activeId: 't1' as WebTerminalId, attached: true, inputOwned: true, error: undefined,
    })
  })

  it('a demoting snapshot (foreign controller) renders read-only', async () => {
    const { rpc, controller, current } = rig()
    scriptSession(rpc, [info('t1')])
    controller.bindSession(session)
    await settle()
    controller.bindSurface(recordingSurface())
    current().feed({ type: 'snapshot', sequence: 0, screen: '', info: info('t1', { controllerId: 'other' as TerminalAttachmentId }) })
    await settle()
    expect(controller.state.getSnapshot().inputOwned).toBe(false)
  })

  it('writes ordered deltas and folds state frames into ownership and holds', async () => {
    const { terminal, hold, controller, current, surface } = await attachedTerminals()
    expect(surface.screens).toEqual([''])
    const open = current()
    open.feed({ type: 'output', sequence: 1, data: 'bc' })
    open.feed({ type: 'output', sequence: 2, data: 'de' })
    open.feed({ type: 'state', info: info('t1', { controllerId: 'other' as TerminalAttachmentId, state: 'exited', exitCode: 1 }) })
    await settle()
    expect(surface.writes).toEqual(['bc', 'de'])
    expect(controller.state.getSnapshot()).toMatchObject({ inputOwned: false })
    // The exited active terminal no longer needs its window hold.
    expect(at(hold.opens, 0).signal.aborted).toBe(true)
    expect(terminal.opens).toHaveLength(2)
  })

  it('a sequence gap schedules a reattach that recovers with a fresh snapshot', async () => {
    const harness = await attachedTerminals()
    const first = harness.current()
    first.feed({ type: 'output', sequence: 5, data: 'skipped' })
    await settle()
    expect(harness.controller.state.getSnapshot().reattaching).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(harness.terminal.opens).toHaveLength(3)
    const reopened = harness.current()
    expect(reopened.payload.id).toBe('t1' as WebTerminalId)
    expect(reopened.payload.attachmentId).not.toBe(first.payload.attachmentId)
    reopened.feed({ type: 'snapshot', sequence: 5, screen: 'recovered', info: info('t1') })
    await settle()
    expect(harness.controller.state.getSnapshot()).toMatchObject({ reattaching: false, reattachFailed: false, attached: true })
    expect(harness.surface.screens).toEqual(['', 'recovered'])
  })

  it('the slow-follower failure climbs the backoff ladder and exhausts into a banner', async () => {
    const harness = await attachedTerminals()
    const ladder = [250, 500, 1000, 2000, 4000]
    for (const rung of ladder) {
      // Each retry opens a fresh stream that itself fails before any snapshot
      // lands — recovery only resets the ladder once a snapshot arrives.
      harness.current().feed({ type: 'stream/error', error: wireError('internal', BUFFER_MESSAGE) })
      await settle()
      expect(harness.controller.state.getSnapshot().reattaching).toBe(true)
      await vi.advanceTimersByTimeAsync(rung)
      expect(harness.terminal.opens).toHaveLength(2 + ladder.indexOf(rung) + 1)
    }
    // Two initial opens plus five timer-driven retries; the stream breaking
    // once more finds the ladder exhausted and surfaces the banner instead.
    expect(harness.terminal.opens).toHaveLength(2 + ladder.length)
    harness.current().feed({ type: 'stream/error', error: wireError('internal', BUFFER_MESSAGE) })
    await settle()
    expect(harness.controller.state.getSnapshot()).toMatchObject({ reattachFailed: true, reattaching: false })
    expect(harness.terminal.opens).toHaveLength(2 + ladder.length)
    // A recovering snapshot resets the ladder from any rung.
    harness.controller.takeInput()
    await settle()
    expect(harness.controller.state.getSnapshot()).toMatchObject({ reattachFailed: false, reattaching: false })
    harness.current().feed({ type: 'snapshot', sequence: 0, screen: 'back', info: info('t1') })
    await settle()
    expect(harness.controller.state.getSnapshot()).toMatchObject({ attached: true, reattaching: false })
    harness.current().feed({ type: 'stream/error', error: wireError('internal', BUFFER_MESSAGE) })
    await settle()
    await vi.advanceTimersByTimeAsync(250)
    expect(harness.terminal.opens).toHaveLength(4 + ladder.length)
  })

  it('a transport failure of the stream schedules the same recovery', async () => {
    const harness = await attachedTerminals()
    harness.current().fail(new Error('sse dropped'))
    await settle()
    expect(harness.controller.state.getSnapshot().reattaching).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(harness.terminal.opens).toHaveLength(3)
  })

  it('a scheduled reattach whose terminal was switched away never fires', async () => {
    const harness = await attachedTerminals()
    const first = harness.current()
    first.feed({ type: 'stream/error', error: wireError('internal', BUFFER_MESSAGE) })
    await settle()
    harness.controller.activate('t9' as WebTerminalId)
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.terminal.opens.filter(open => open.payload.id === 't1' as WebTerminalId)).toHaveLength(2)
  })

  it('stream loss of the terminal clears attachment and refreshes the list', async () => {
    const harness = await attachedTerminals()
    harness.current().feed({ type: 'stream/error', error: wireError('terminal-unavailable', 'gone') })
    await settle()
    expect(harness.controller.state.getSnapshot()).toMatchObject({ attached: false, inputOwned: false })
    expect(harness.rpc.calls.filter(call => call.endpoint === 'terminal/list')).toHaveLength(2)
  })

  it('a hard stream error surfaces the message and detaches', async () => {
    const harness = await attachedTerminals()
    harness.current().feed({ type: 'stream/error', error: wireError('internal', 'boom') })
    await settle()
    expect(harness.controller.state.getSnapshot()).toMatchObject({ error: 'boom', attached: false })
  })

  it('a cleanly ending stream drops the attached facts without reattaching', async () => {
    const harness = await attachedTerminals()
    harness.current().end()
    await settle()
    expect(harness.controller.state.getSnapshot().attached).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.terminal.opens).toHaveLength(2)
  })

  it('re-activating the current attached terminal is a no-op; an aborted pump never reattaches', async () => {
    const harness = await attachedTerminals()
    const open = harness.current()
    harness.controller.activate('t1' as WebTerminalId)
    expect(harness.terminal.opens).toHaveLength(2)
    harness.controller.bindSurface(undefined)
    await settle()
    // The aborted stream may still deliver; the pump ignores it silently.
    open.feed({ type: 'output', sequence: 1, data: 'late' })
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.terminal.opens).toHaveLength(2)
    expect(harness.controller.state.getSnapshot().attached).toBe(false)
  })

  it('activating with no terminals clears the active facts', async () => {
    const { rpc, controller } = rig()
    scriptSession(rpc, [info('t1')])
    controller.bindSession(session)
    await settle()
    rpc.on('list', () => [])
    controller.activate(undefined)
    await settle()
    expect(controller.state.getSnapshot().activeId).toBe('t1' as WebTerminalId)
    controller.refresh()
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ activeId: undefined, attached: false, inputOwned: false })
  })
})

describe('TerminalPanelController verbs', () => {
  it('writes input only while owning the attachment', async () => {
    const harness = await attachedTerminals()
    const attachmentId = harness.current().payload.attachmentId
    harness.rpc.on('write', () => undefined)
    harness.controller.write('ls\r')
    await settle()
    const writeCall = harness.rpc.calls.find(call => call.endpoint === 'terminal/write')
    expect(writeCall?.args).toEqual({ agentId: session, id: 't1' as WebTerminalId, attachmentId, data: 'ls\r' })
    harness.current().feed({ type: 'state', info: info('t1', { controllerId: 'other' as TerminalAttachmentId }) })
    await settle()
    harness.controller.write('ignored\r')
    await settle()
    expect(harness.rpc.calls.filter(call => call.endpoint === 'terminal/write')).toHaveLength(1)
  })

  it('a read-only write failure demotes ownership; other failures banner', async () => {
    const harness = await attachedTerminals()
    harness.rpc.onError('write', { code: 'terminal-control-unavailable', message: 'stale', details: { reason: 'read-only' } })
    harness.controller.write('x')
    await settle()
    expect(harness.controller.state.getSnapshot().inputOwned).toBe(false)
    harness.rpc.onError('write', { code: 'internal', message: 'write exploded' })
    harness.current().feed({ type: 'state', info: info('t1', { controllerId: harness.current().payload.attachmentId }) })
    await settle()
    harness.controller.write('y')
    await settle()
    expect(harness.controller.state.getSnapshot().error).toBe('write exploded')
  })

  it('resizes clamp to the environment and push only when dimensions differ', async () => {
    const harness = await attachedTerminals()
    harness.rpc.on('resize', () => undefined)
    harness.controller.resize(1000, -3)
    await settle()
    const resizeCall = harness.rpc.calls.find(call => call.endpoint === 'terminal/resize')
    expect(resizeCall?.args).toMatchObject({
      cols: 500, rows: 1, id: 't1' as WebTerminalId, attachmentId: harness.current().payload.attachmentId,
    })
    // Same dimensions as the terminal already has: no second call.
    harness.controller.resize(80, 24)
    await settle()
    expect(harness.rpc.calls.filter(call => call.endpoint === 'terminal/resize')).toHaveLength(1)
  })

  it('a read-only resize failure demotes ownership', async () => {
    const harness = await attachedTerminals()
    harness.rpc.onError('resize', { code: 'terminal-control-unavailable', message: 'stale', details: { reason: 'read-only' } })
    harness.controller.resize(120, 40)
    await settle()
    expect(harness.controller.state.getSnapshot().inputOwned).toBe(false)
  })

  it('create sends the minted id, clamped dimensions, and chosen shell, then activates', async () => {
    const { rpc, controller } = rig()
    scriptSession(rpc, [info('t1')])
    controller.bindSession(session)
    await settle()
    rpc.on('create', args => info((args.request as { id: string }).id, { title: 'fresh' }))
    controller.create('/bin/zsh')
    await settle()
    const createCall = rpc.calls.find(call => call.endpoint === 'terminal/create')
    const request = createCall?.args.request as { id: string; cols: number; rows: number; shellPath: string }
    expect(createCall?.args.agentId).toBe(session)
    expect(request.id).toMatch(/^t-[\w-]+$/)
    expect(request).toMatchObject({ cols: 80, rows: 24, shellPath: '/bin/zsh' })
    expect(controller.state.getSnapshot().activeId).toBe(request.id as WebTerminalId)
  })

  it('create without a shell omits shellPath and the id mint survives a crypto-less global', async () => {
    vi.stubGlobal('crypto', {})
    const { rpc, controller } = rig()
    scriptSession(rpc, [])
    controller.bindSession(session)
    await settle()
    rpc.on('create', args => info((args.request as { id: string }).id))
    controller.create(undefined)
    await settle()
    const request = rpc.calls.find(call => call.endpoint === 'terminal/create')?.args.request as { id: string }
    expect('shellPath' in request).toBe(false)
    expect(request.id).toMatch(/^t-[\w-]+$/)
  })

  it('create failures banner and the id mint also survives a missing crypto', async () => {
    vi.stubGlobal('crypto', undefined)
    const { rpc, controller } = rig()
    scriptSession(rpc, [])
    controller.bindSession(session)
    await settle()
    rpc.onError('create', { code: 'terminal-limit-reached', message: 'too many', details: { limit: 8 } })
    controller.create(undefined)
    await settle()
    expect(controller.state.getSnapshot().error).toBe('too many')
  })

  it('closing the active terminal stops rendering it first and reloads the list', async () => {
    const harness = await attachedTerminals()
    harness.rpc.on('close', () => undefined)
    harness.controller.close('t1' as WebTerminalId)
    await settle()
    const closeCall = harness.rpc.calls.find(call => call.endpoint === 'terminal/close')
    expect(closeCall?.args).toEqual({ agentId: session, id: 't1' as WebTerminalId })
    expect(harness.rpc.calls.filter(call => call.endpoint === 'terminal/list')).toHaveLength(2)
    expect(harness.controller.state.getSnapshot()).toMatchObject({ attached: false, inputOwned: false })
  })

  it('close failures banner but still refresh the list', async () => {
    const harness = await attachedTerminals()
    harness.rpc.onError('close', { code: 'internal', message: 'close failed' })
    harness.controller.close('t1' as WebTerminalId)
    await settle()
    expect(harness.controller.state.getSnapshot().error).toBe('close failed')
    expect(harness.rpc.calls.filter(call => call.endpoint === 'terminal/list')).toHaveLength(2)
  })

  it('rename trims, validates bounds, and upserts the echoed info', async () => {
    const { rpc, controller } = rig()
    scriptSession(rpc, [info('t1')])
    controller.bindSession(session)
    await settle()
    rpc.on('rename', args => info('t1', { title: args.title as string }))
    controller.rename('t1' as WebTerminalId, '  build  ')
    await settle()
    const renameCall = rpc.calls.find(call => call.endpoint === 'terminal/rename')
    expect(renameCall?.args).toEqual({ agentId: session, id: 't1' as WebTerminalId, title: 'build' })
    expect(at(controller.state.getSnapshot().terminals, 0).title).toBe('build')
    rpc.off('rename')
    controller.rename('t1' as WebTerminalId, '   ')
    controller.rename('t1' as WebTerminalId, 'x'.repeat(121))
    await settle()
    expect(rpc.calls.filter(call => call.endpoint === 'terminal/rename')).toHaveLength(1)
    rpc.onError('rename', { code: 'internal', message: 'rename failed' })
    controller.rename('t1' as WebTerminalId, 'ok')
    await settle()
    expect(controller.state.getSnapshot().error).toBe('rename failed')
  })

  it('verbs without a session are inert', async () => {
    const { rpc, controller, terminal } = rig()
    controller.create(undefined)
    controller.close('t1' as WebTerminalId)
    controller.rename('t1' as WebTerminalId, 'x')
    controller.refresh()
    controller.write('x')
    controller.resize(10, 10)
    controller.takeInput()
    controller.bindSurface(recordingSurface())
    await settle()
    expect(rpc.calls).toEqual([])
    expect(terminal.opens).toEqual([])
  })

  it('closing a non-active terminal leaves the rendered stream alone', async () => {
    const { rpc, hold, controller } = rig()
    scriptSession(rpc, [info('t1'), info('t2')])
    controller.bindSession(session)
    await settle()
    rpc.on('close', () => undefined)
    const activeId = controller.state.getSnapshot().activeId
    const other = activeId === ('t1' as WebTerminalId) ? 't2' : 't1'
    controller.close(other as WebTerminalId)
    await settle()
    // The active terminal's hold stays open; the closed one is refreshed away.
    expect(controller.state.getSnapshot().attached).toBe(false)
    expect(hold.opens.some(open => open.payload.id === other as WebTerminalId && open.signal.aborted)).toBe(false)
    expect(rpc.calls.filter(call => call.endpoint === 'terminal/list')).toHaveLength(2)
  })

  it('a close racing a session switch skips the stale list reload', async () => {
    const harness = await attachedTerminals()
    harness.controller.close('t1' as WebTerminalId)
    harness.controller.bindSession(undefined)
    await settle()
    expect(harness.rpc.calls.filter(call => call.endpoint === 'terminal/list')).toHaveLength(1)
  })

  it('dispose makes every later verb inert, including input takeover', async () => {
    const harness = await attachedTerminals()
    harness.controller.dispose()
    harness.controller.takeInput()
    await settle()
    expect(harness.terminal.opens).toHaveLength(2)
  })

  it('failing an aborted stream is silent; ending a superseded one keeps the new attachment', async () => {
    const harness = await attachedTerminals()
    const first = harness.current()
    harness.controller.bindSurface(undefined)
    first.fail(new Error('aborted transport died'))
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.terminal.opens).toHaveLength(2)
    harness.controller.bindSurface(recordingSurface())
    await settle()
    const live = harness.current()
    live.feed({ type: 'snapshot', sequence: 0, screen: 'live', info: info('t1') })
    await settle()
    // Supersede the live attachment, then let the old stream complete: its
    // pump exits normally without touching the new attachment's facts.
    harness.controller.takeInput()
    await settle()
    live.end()
    await settle()
    const reopened = harness.current()
    reopened.feed({ type: 'snapshot', sequence: 0, screen: 'still live', info: info('t1') })
    await settle()
    expect(harness.controller.state.getSnapshot()).toMatchObject({ attached: true, reattaching: false })
    expect(harness.terminal.opens).toHaveLength(4)
  })

  it('a pending reattach never fires after the active terminal left the list', async () => {
    const harness = await attachedTerminals()
    harness.current().feed({ type: 'output', sequence: 7, data: 'gap' })
    await settle()
    expect(harness.controller.state.getSnapshot().reattaching).toBe(true)
    harness.rpc.on('list', () => [])
    harness.controller.refresh()
    await settle()
    expect(harness.controller.state.getSnapshot().activeId).toBeUndefined()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.terminal.opens).toHaveLength(2)
  })

  it('disposal clears a pending reattach timer', async () => {
    const harness = await attachedTerminals()
    harness.current().feed({ type: 'output', sequence: 7, data: 'gap' })
    await settle()
    harness.controller.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.terminal.opens).toHaveLength(2)
  })

  it('clamps to the protocol ceilings before the environment answers', async () => {
    const harness = rig()
    harness.rpc.onError('environment', { code: 'internal', message: 'env pending' })
    harness.rpc.on('list', () => [info('t1')])
    harness.controller.bindSession(session)
    await settle()
    harness.rpc.on('resize', () => undefined)
    const surface = recordingSurface()
    harness.controller.bindSurface(surface)
    const open = harness.current()
    open.feed({ type: 'snapshot', sequence: 0, screen: '', info: info('t1', { controllerId: open.payload.attachmentId }) })
    await settle()
    harness.controller.resize(100_000, 100_000)
    await settle()
    const resizeCall = harness.rpc.calls.find(call => call.endpoint === 'terminal/resize')
    expect(resizeCall?.args).toMatchObject({ cols: 500, rows: 200 })
  })

  it('takeInput re-attaches with a fresh attachment id', async () => {
    const harness = await attachedTerminals()
    const before = harness.current().payload.attachmentId
    harness.controller.takeInput()
    await settle()
    expect(harness.terminal.opens).toHaveLength(3)
    expect(harness.current().payload.attachmentId).not.toBe(before)
  })

  it('bindSurface with an active terminal re-attaches the fresh surface', async () => {
    const { rpc, terminal, controller } = rig()
    scriptSession(rpc, [info('t1')])
    controller.bindSession(session)
    await settle()
    controller.bindSurface(undefined)
    expect(terminal.opens).toHaveLength(1)
    controller.bindSurface(recordingSurface())
    await settle()
    expect(terminal.opens).toHaveLength(2)
  })
})

describe('TerminalPanelController holds', () => {
  it('drops holds whose terminals left the running set and aborts all on dispose', async () => {
    const { rpc, hold, controller } = rig()
    scriptSession(rpc, [info('t1'), info('t2')])
    controller.bindSession(session)
    await settle()
    expect(hold.opens.map(open => open.payload.id)).toEqual(['t1' as WebTerminalId, 't2' as WebTerminalId])
    rpc.on('list', () => [info('t1'), info('t2', { state: 'exited', exitCode: 0 })])
    controller.refresh()
    await settle()
    expect(at(hold.opens, 1).signal.aborted).toBe(true)
    expect(at(hold.opens, 0).signal.aborted).toBe(false)
    controller.dispose()
    expect(at(hold.opens, 0).signal.aborted).toBe(true)
  })

  it('a hold stream error refreshes the list; ends and failures just drop the hold', async () => {
    const { rpc, hold, controller } = rig()
    let listCalls = 0
    rpc.on('list', () => {
      listCalls += 1
      // The fourth load (after the hold error) reports the terminal closed.
      return listCalls <= 3 ? [info('t1')] : [info('t1', { state: 'exited', exitCode: 0 })]
    })
    controller.bindSession(session)
    await settle()
    // A live transport failure drops the hold without a list refresh.
    at(hold.opens, 0).fail(new Error('hold transport died'))
    await settle()
    expect(rpc.calls.filter(call => call.endpoint === 'terminal/list')).toHaveLength(1)
    // Re-listing re-opens the hold; its retained frame keeps it open, a clean
    // end drops it, and its stream error is the refreshing case.
    controller.refresh()
    await settle()
    expect(hold.opens).toHaveLength(2)
    at(hold.opens, 1).feed({ type: 'retained' })
    await settle()
    at(hold.opens, 1).end()
    await settle()
    controller.refresh()
    await settle()
    expect(hold.opens).toHaveLength(3)
    at(hold.opens, 2).feed({ type: 'stream/error', error: wireError('terminal-unavailable', 'closing') })
    await settle()
    expect(rpc.calls.filter(call => call.endpoint === 'terminal/list')).toHaveLength(4)
    // The refreshed list no longer reports the terminal running: no new hold.
    expect(hold.opens).toHaveLength(3)
  })
})
