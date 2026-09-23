/**
 * The browser panel controller as a state machine over scripted wire deps: the
 * page stream is a hub-fed frame queue and the `/api` RPC caller records every
 * call, so each spec drives one behavior — the session load, the exclusive
 * control attachment (baseline, images, demotion), the parked destination a
 * fresh page needs, the bounded reattach ladder, and the verb wire shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RpcId,
  type BrowserStreamFrame,
  type RpcError,
  type RpcRequest,
  type RpcResult,
  type SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  BrowserAttachmentId, BrowserImageFrame, HostBrowserEnvironment, HostBrowserPageId, HostBrowserPageInfo,
} from '@deepseek-ai/dsh-api-browser-controller/types'
import { BrowserPanelController, type BrowserPanelDeps, type BrowserSurface } from '../src/client/controller.ts'

/** Page stream binding as the client events face takes it. */
type BrowserBinding = Parameters<BrowserPanelDeps['events']['browser']>[0]

/** Wire error shape carried by stream/error frames and RPC failures. */
interface WireError { code: string; message: string; details?: unknown }

/** One programmable stream open: frames queue up until the pump consumes. */
interface StreamOpen {
  /** Binding the controller passed when opening the stream. */
  readonly payload: BrowserBinding
  /** Abort signal the controller bound the stream lifetime to. */
  readonly signal: AbortSignal
  /** Deliver one frame to the consumer. */
  feed: (frame: BrowserStreamFrame) => void
  /** Complete the stream as the carrier would on a clean detach. */
  end: () => void
  /** Fail the stream as the carrier would on a transport error. */
  fail: (error: unknown) => void
}

/**
 * A hub of scripted streams: each open becomes an entry whose frames the spec
 * feeds explicitly; consumers pull RpcRequest-wrapped frames.
 */
class FrameHub {
  /** Every open in arrival order. */
  readonly opens: StreamOpen[] = []
  private counter = 0

  /** The stream face handed to the controller. */
  readonly stream = (payload: BrowserBinding, signal: AbortSignal): AsyncIterable<RpcRequest<BrowserStreamFrame>> => {
    let notify: (() => void) | undefined
    let failure: { error: unknown } | undefined
    let finished = false
    const queue: RpcRequest<BrowserStreamFrame>[] = []
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
        next: async (): Promise<IteratorResult<RpcRequest<BrowserStreamFrame>>> => {
          for (;;) {
            const next = queue.shift()
            if (next !== undefined) return { value: next, done: false }
            if (failure !== undefined) throw failure.error
            if (finished) return { value: undefined, done: true }
            await new Promise<void>((resolve) => { notify = resolve })
          }
        },
        return: async (): Promise<IteratorResult<RpcRequest<BrowserStreamFrame>>> => ({ value: undefined, done: true }),
      }),
    }
  }
}

/** Recorded `/api` call with its decoded verb arguments. */
interface RecordedCall { channel: string; endpoint: string; args: Record<string, unknown> }

/** Scripted `/api` RPC caller: routes `browser/<verb>` to spec handlers. */
class FakeRpc {
  /** Every call in arrival order. */
  readonly calls: RecordedCall[] = []
  private readonly handlers = new Map<string, (args: Record<string, unknown>) => RpcResult<unknown>>()

  /** Script a successful verb result. */
  on(method: string, value: (args: Record<string, unknown>) => unknown): void {
    const handler = (args: Record<string, unknown>): RpcResult<unknown> => ({ ok: true, value: value(args) })
    this.handlers.set(`browser/${method}`, handler)
  }

  /** Script a failing verb result. */
  onError(method: string, error: WireError): void {
    const handler = (): RpcResult<unknown> => ({ ok: false, error: error as never })
    this.handlers.set(`browser/${method}`, handler)
  }

  /** The RPC face handed to the controller. */
  readonly call = async (channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> => {
    this.calls.push({ channel, endpoint, args: (payload as { args: Record<string, unknown> }).args })
    const handler = this.handlers.get(endpoint)
    if (handler === undefined) return { ok: true, value: undefined }
    return handler((payload as { args: Record<string, unknown> }).args)
  }

  /** Every recorded call to one verb. */
  of(method: string): RecordedCall[] {
    return this.calls.filter(call => call.endpoint === `browser/${method}`)
  }
}

/** The harness: controller plus its scripted wire deps. */
function rig() {
  const rpc = new FakeRpc()
  const hub = new FrameHub()
  const controller = new BrowserPanelController({ rpc, events: { browser: hub.stream } })
  /** The open the controller is currently consuming. */
  const current = (): StreamOpen => {
    const open = hub.opens[hub.opens.length - 1]
    if (open === undefined) throw new Error('no browser stream open')
    return open
  }
  return { rpc, hub, controller, current }
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

/** A page info fixture at the controller's default viewport. */
function page(id: string, overrides: Partial<HostBrowserPageInfo> = {}): HostBrowserPageInfo {
  return {
    id: id as HostBrowserPageId,
    url: '',
    title: '',
    width: 1280,
    height: 800,
    loading: false,
    state: 'ready',
    canGoBack: false,
    canGoForward: false,
    ...overrides,
  }
}

/** The environment fixture the RPC returns. */
const environment: HostBrowserEnvironment = {
  available: true, maxPages: 4, maxWidth: 2560, maxHeight: 1600, allowedHosts: [], allowPrivateAddresses: false,
}

/** One session identity. */
const session = 'sess-1' as SessionId

/** One screencast image fixture. */
const image: BrowserImageFrame = { data: 'AAA', width: 1280, height: 800 }

/** A stream error with the details slot the RpcError shape requires. */
function wireError(code: string, message: string): RpcError {
  return { code, message, details: {} } as never
}

/** A recording surface: the panel's `<img>` sink double. */
function recordingSurface(): BrowserSurface & { images: BrowserImageFrame[] } {
  const images: BrowserImageFrame[] = []
  return { images, render: (frame) => { images.push(frame) } }
}

/** Wire a session load returning the given pages. */
function scriptSession(rpc: FakeRpc, pages: HostBrowserPageInfo[]): void {
  rpc.on('environment', () => environment)
  rpc.on('list', () => pages)
}

/** Bind a session with one page, mount the surface, and grant control. */
async function controlled() {
  const harness = rig()
  scriptSession(harness.rpc, [page('p1')])
  harness.controller.bindSession(session)
  await settle()
  const surface = recordingSurface()
  harness.controller.bindSurface(surface)
  const open = harness.current()
  open.feed({ type: 'snapshot', info: page('p1', { controllerId: open.payload.attachmentId }), image })
  await settle()
  return { ...harness, surface, attachmentId: open.payload.attachmentId }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('BrowserPanelController session binding', () => {
  it('binds a session, loads the environment and the page list, then reports ready', async () => {
    const { rpc, controller } = rig()
    scriptSession(rpc, [page('p1'), page('p2', { url: 'https://example.test/', title: 'Example' })])
    controller.bindSession(session)
    expect(controller.state.getSnapshot().ready).toBe(false)
    await settle()
    const snapshot = controller.state.getSnapshot()
    expect(snapshot).toMatchObject({ session, ready: true, environment })
    expect(snapshot.pages.map(entry => entry.id)).toEqual(['p1', 'p2'])
    expect(rpc.calls.map(call => [call.channel, call.endpoint])).toEqual([
      ['/api', 'browser/environment'],
      ['/api', 'browser/list'],
    ])
    expect(at(rpc.calls, 0).args).toEqual({ agentId: session })
    expect(at(rpc.calls, 1).args).toEqual({ sessionId: session })
  })

  it('ignores an environment failure while still settling the list', async () => {
    const { rpc, controller } = rig()
    rpc.onError('environment', { code: 'internal', message: 'env failed' })
    rpc.on('list', () => [page('p1')])
    controller.bindSession(session)
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ ready: true, environment: undefined })
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
    scriptSession(rpc, [page('p1')])
    controller.bindSession(session)
    await settle()
    controller.bindSession(session)
    await settle()
    expect(rpc.of('list')).toHaveLength(1)
    controller.bindSession(undefined)
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({
      session: undefined, ready: false, pages: [], activeId: undefined,
    })
    expect(rpc.of('list')).toHaveLength(1)
  })

  it('a load racing a session switch does not publish into the new session', async () => {
    const { rpc, controller } = rig()
    let listCalls = 0
    rpc.on('list', () => { listCalls += 1; return listCalls === 1 ? [page('p1')] : [page('p2')] })
    controller.bindSession(session)
    controller.bindSession('sess-2' as SessionId)
    await settle()
    expect(controller.state.getSnapshot().session).toBe('sess-2' as SessionId)
    expect(controller.state.getSnapshot().pages.map(entry => entry.id)).toEqual(['p2'])
  })

  it('dispose during an in-flight load drops its publication', async () => {
    const { rpc, controller } = rig()
    rpc.on('list', () => [page('p1')])
    controller.bindSession(session)
    controller.dispose()
    await settle()
    expect(controller.state.getSnapshot().pages).toEqual([])
  })

  it('refresh on an unbound panel calls nothing', async () => {
    const { rpc, controller } = rig()
    controller.refresh()
    await settle()
    expect(rpc.calls).toEqual([])
  })
})

describe('BrowserPanelController control attachment', () => {
  it('activates the first listed page and renders its baseline image', async () => {
    const { controller, surface, attachmentId } = await controlled()
    expect(surface.images).toEqual([image])
    expect(controller.state.getSnapshot()).toMatchObject({
      activeId: 'p1' as HostBrowserPageId, attached: true, inputOwned: true, error: undefined,
    })
    expect(attachmentId).toMatch(/^att-/u)
  })

  it('a baseline without a held image attaches with nothing rendered', async () => {
    const { rpc, controller, current } = rig()
    scriptSession(rpc, [page('p1')])
    controller.bindSession(session)
    await settle()
    const surface = recordingSurface()
    controller.bindSurface(surface)
    const open = current()
    open.feed({ type: 'snapshot', info: page('p1', { controllerId: open.payload.attachmentId }) })
    await settle()
    expect(surface.images).toEqual([])
    expect(controller.state.getSnapshot().attached).toBe(true)
  })

  it('a demoting baseline (foreign controller) attaches read-only', async () => {
    const { rpc, controller, current } = rig()
    scriptSession(rpc, [page('p1')])
    controller.bindSession(session)
    await settle()
    controller.bindSurface(recordingSurface())
    current().feed({
      type: 'snapshot', info: page('p1', { controllerId: 'other' as BrowserAttachmentId }),
    })
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ attached: true, inputOwned: false })
  })

  it('renders image frames and folds state frames into ownership and the list', async () => {
    const { controller, surface, current, attachmentId } = await controlled()
    const second: BrowserImageFrame = { data: 'BBB', width: 1280, height: 800 }
    current().feed({ type: 'image', image: second })
    current().feed({
      type: 'state',
      info: page('p1', { url: 'https://example.test/', title: 'Example', controllerId: attachmentId, canGoBack: true }),
    })
    await settle()
    expect(surface.images).toEqual([image, second])
    const snapshot = controller.state.getSnapshot()
    expect(snapshot.inputOwned).toBe(true)
    expect(at(snapshot.pages, 0)).toMatchObject({ url: 'https://example.test/', title: 'Example', canGoBack: true })
    // A state frame naming another controller demotes this attachment.
    current().feed({ type: 'state', info: page('p1', { controllerId: 'other' as BrowserAttachmentId }) })
    await settle()
    expect(controller.state.getSnapshot().inputOwned).toBe(false)
  })

  it('takeInput re-opens the stream with a fresh attachment identity', async () => {
    const { controller, hub, current } = await controlled()
    const opens = hub.opens.length
    const first = current().payload.attachmentId
    controller.takeInput()
    await settle()
    expect(hub.opens).toHaveLength(opens + 1)
    expect(current().payload.attachmentId).not.toBe(first)
    expect(at(hub.opens, opens - 1).signal.aborted).toBe(true)
    expect(controller.state.getSnapshot()).toMatchObject({ attached: false, inputOwned: false })
  })

  it('a verb arriving after dispose opens no stream', async () => {
    const { controller, hub } = await controlled()
    const opens = hub.opens.length
    controller.dispose()
    controller.takeInput()
    await settle()
    expect(hub.opens).toHaveLength(opens)
  })

  it('a superseded stream ending does not report the live attachment as detached', async () => {
    const { controller, hub } = await controlled()
    const stale = at(hub.opens, hub.opens.length - 1)
    controller.takeInput()
    await settle()
    const open = at(hub.opens, hub.opens.length - 1)
    open.feed({ type: 'snapshot', info: page('p1', { controllerId: open.payload.attachmentId }) })
    await settle()
    stale.end()
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ attached: true, inputOwned: true })
  })

  it('takeInput without an active page does nothing', async () => {
    const { controller, hub } = rig()
    controller.takeInput()
    await settle()
    expect(hub.opens).toEqual([])
  })

  it('activating the already-followed page is a no-op, and switching re-attaches', async () => {
    const { rpc, controller, hub, current } = rig()
    scriptSession(rpc, [page('p1'), page('p2')])
    controller.bindSession(session)
    await settle()
    controller.bindSurface(recordingSurface())
    current().feed({ type: 'snapshot', info: page('p1', { controllerId: current().payload.attachmentId }) })
    await settle()
    const opens = hub.opens.length
    controller.activate('p1' as HostBrowserPageId)
    await settle()
    expect(hub.opens).toHaveLength(opens)
    controller.activate('p2' as HostBrowserPageId)
    await settle()
    expect(hub.opens).toHaveLength(opens + 1)
    expect(current().payload.id).toBe('p2' as HostBrowserPageId)
  })

  it('activating with an empty list detaches and clears the active page', async () => {
    const { rpc, controller, hub } = rig()
    scriptSession(rpc, [])
    controller.bindSession(session)
    await settle()
    expect(hub.opens).toEqual([])
    expect(controller.state.getSnapshot()).toMatchObject({
      activeId: undefined, attached: false, inputOwned: false, pages: [],
    })
  })

  it('binding a surface re-attaches, and releasing it detaches so another window may take control', async () => {
    const { controller, hub, current } = await controlled()
    expect(hub.opens).toHaveLength(2)
    controller.bindSurface(undefined)
    await settle()
    expect(at(hub.opens, 1).signal.aborted).toBe(true)
    expect(controller.state.getSnapshot()).toMatchObject({ attached: false, inputOwned: false })
    // A later frame on the abandoned stream reaches no sink.
    expect(() => { current().feed({ type: 'image', image }) }).not.toThrow()
  })

  it('a surface bound with no active page opens no stream', async () => {
    const { rpc, controller, hub } = rig()
    scriptSession(rpc, [])
    controller.bindSession(session)
    await settle()
    controller.bindSurface(recordingSurface())
    await settle()
    expect(hub.opens).toEqual([])
  })

  it('a clean stream end reports the page as no longer attached', async () => {
    const { controller, current } = await controlled()
    current().end()
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ attached: false, inputOwned: false })
  })

  it('frames arriving after a supersede are ignored', async () => {
    const { controller, hub, surface } = await controlled()
    const stale = at(hub.opens, 1)
    controller.takeInput()
    await settle()
    stale.feed({ type: 'image', image: { data: 'stale', width: 1, height: 1 } })
    await settle()
    expect(surface.images.map(frame => frame.data)).toEqual(['AAA'])
  })

  it('a vanished page (browser-unavailable) drops the attachment and reloads the list', async () => {
    const { rpc, controller, current } = await controlled()
    const before = rpc.of('list').length
    current().feed({ type: 'stream/error', error: wireError('browser-unavailable', 'The page no longer exists') })
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ attached: false, inputOwned: false })
    expect(rpc.of('list').length).toBe(before + 1)
  })

  it('any other stream error becomes the error banner', async () => {
    const { controller, current } = await controlled()
    current().feed({ type: 'stream/error', error: wireError('internal', 'browser service is absent') })
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({
      error: 'browser service is absent', attached: false, inputOwned: false,
    })
  })
})

describe('BrowserPanelController reattach recovery', () => {
  it('walks the backoff ladder, then reports the exhausted stream', async () => {
    const { controller, hub, current } = await controlled()
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      current().fail(new Error('transport lost'))
      await settle()
      expect(controller.state.getSnapshot().reattaching).toBe(true)
      await vi.advanceTimersByTimeAsync(delay)
      await settle()
    }
    // Six opens: the baseline plus one per rung.
    expect(hub.opens).toHaveLength(7)
    current().fail(new Error('transport lost'))
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ reattaching: false, reattachFailed: true })
  })

  it('a baseline after a reattach clears the recovery state and restarts the ladder', async () => {
    const { controller, current } = await controlled()
    current().fail(new Error('transport lost'))
    await settle()
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    const open = current()
    open.feed({ type: 'snapshot', info: page('p1', { controllerId: open.payload.attachmentId }), image })
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({
      attached: true, inputOwned: true, reattaching: false, reattachFailed: false,
    })
  })

  it('an aborted stream never schedules a reattach', async () => {
    const { controller, hub, current } = await controlled()
    const open = current()
    controller.bindSurface(undefined)
    open.fail(new Error('aborted by the panel'))
    await settle()
    await vi.advanceTimersByTimeAsync(4000)
    expect(hub.opens).toHaveLength(2)
    expect(controller.state.getSnapshot().reattaching).toBe(false)
  })

  it('a scheduled reattach is dropped when the panel moved on', async () => {
    const { rpc, controller, hub, current } = rig()
    scriptSession(rpc, [page('p1'), page('p2')])
    controller.bindSession(session)
    await settle()
    controller.bindSurface(recordingSurface())
    const open = current()
    open.feed({ type: 'snapshot', info: page('p1', { controllerId: open.payload.attachmentId }) })
    await settle()
    current().fail(new Error('transport lost'))
    await settle()
    controller.activate('p2' as HostBrowserPageId)
    await settle()
    const opens = hub.opens.length
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    expect(hub.opens).toHaveLength(opens)
  })

  it('a reattach whose page vanished in the meantime is dropped when it fires', async () => {
    const { rpc, controller, hub, current } = await controlled()
    current().fail(new Error('transport lost'))
    await settle()
    rpc.on('list', () => [])
    controller.close('p1' as HostBrowserPageId)
    await settle()
    expect(controller.state.getSnapshot().activeId).toBeUndefined()
    const opens = hub.opens.length
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    expect(hub.opens).toHaveLength(opens)
  })

  it('dispose cancels a pending reattach', async () => {
    const { controller, hub, current } = await controlled()
    current().fail(new Error('transport lost'))
    await settle()
    controller.dispose()
    await vi.advanceTimersByTimeAsync(250)
    await settle()
    expect(hub.opens).toHaveLength(2)
  })

  it('attaching after exhaustion retries even when the page is unchanged', async () => {
    const { controller, hub, current } = await controlled()
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      current().fail(new Error('transport lost'))
      await settle()
      await vi.advanceTimersByTimeAsync(delay)
      await settle()
    }
    current().fail(new Error('transport lost'))
    await settle()
    expect(controller.state.getSnapshot().reattachFailed).toBe(true)
    const opens = hub.opens.length
    controller.activate('p1' as HostBrowserPageId)
    await settle()
    expect(hub.opens).toHaveLength(opens + 1)
  })
})

describe('BrowserPanelController navigation', () => {
  it('navigates the controlled page and folds the answer into the list', async () => {
    const { rpc, controller, attachmentId } = await controlled()
    rpc.on('navigate', args => page('p1', { url: String(args['url']), loading: true, controllerId: attachmentId }))
    controller.navigate('  https://example.test/  ')
    await settle()
    expect(at(rpc.of('navigate'), 0).args).toEqual({
      agentId: session, id: 'p1', attachmentId, url: 'https://example.test/',
    })
    expect(at(controller.state.getSnapshot().pages, 0)).toMatchObject({ url: 'https://example.test/', loading: true })
  })

  it('a blank destination and an unbound panel send nothing', async () => {
    const { rpc, controller } = await controlled()
    controller.navigate('   ')
    controller.bindSession(undefined)
    controller.navigate('https://example.test/')
    await settle()
    expect(rpc.of('navigate')).toEqual([])
  })

  it('navigating an empty panel opens a page first, then flushes the parked destination', async () => {
    const { rpc, controller, hub } = rig()
    scriptSession(rpc, [])
    rpc.on('create', args => page((args['request'] as { id: string }).id))
    controller.bindSession(session)
    await settle()
    controller.bindSurface(recordingSurface())
    controller.navigate('example.test')
    await settle()
    const created = at(rpc.of('create'), 0)
    const request = created.args['request'] as { id: string; width: number; height: number }
    expect(request).toMatchObject({ width: 1280, height: 800 })
    expect(request.id).toMatch(/^p-/u)
    // No navigation before the stream grants control.
    expect(rpc.of('navigate')).toEqual([])
    const open = at(hub.opens, 0)
    rpc.on('navigate', args => page(request.id, { url: String(args['url']) }))
    open.feed({ type: 'snapshot', info: page(request.id, { controllerId: open.payload.attachmentId }) })
    await settle()
    expect(at(rpc.of('navigate'), 0).args).toMatchObject({ url: 'example.test' })
  })

  it('a read-only page parks the destination until control returns', async () => {
    const { rpc, controller, current } = rig()
    scriptSession(rpc, [page('p1')])
    controller.bindSession(session)
    await settle()
    controller.bindSurface(recordingSurface())
    current().feed({ type: 'snapshot', info: page('p1', { controllerId: 'other' as BrowserAttachmentId }) })
    await settle()
    controller.navigate('https://example.test/')
    await settle()
    expect(rpc.of('navigate')).toEqual([])
    expect(rpc.of('create')).toEqual([])
    rpc.on('navigate', args => page('p1', { url: String(args['url']) }))
    controller.takeInput()
    await settle()
    const open = current()
    open.feed({ type: 'snapshot', info: page('p1', { controllerId: open.payload.attachmentId }) })
    await settle()
    expect(at(rpc.of('navigate'), 0).args).toMatchObject({ url: 'https://example.test/' })
  })

  it('a parked destination waits through a baseline that does not grant control', async () => {
    const { rpc, controller, current } = rig()
    scriptSession(rpc, [page('p1')])
    controller.bindSession(session)
    await settle()
    controller.bindSurface(recordingSurface())
    current().feed({ type: 'snapshot', info: page('p1', { controllerId: 'other' as BrowserAttachmentId }) })
    await settle()
    controller.navigate('https://example.test/')
    await settle()
    // A second read-only baseline keeps the destination parked.
    controller.takeInput()
    await settle()
    current().feed({ type: 'snapshot', info: page('p1', { controllerId: 'other' as BrowserAttachmentId }) })
    await settle()
    expect(rpc.of('navigate')).toEqual([])
  })

  it('a refused destination becomes the navigation notice, not the error banner', async () => {
    const { rpc, controller } = await controlled()
    rpc.onError('navigate', { code: 'browser-navigation-refused', message: 'destination is not permitted' })
    controller.navigate('http://10.0.0.1/')
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({
      navigationError: 'destination is not permitted', error: undefined,
    })
    // The next attempt clears the stale notice.
    rpc.on('navigate', () => page('p1'))
    controller.navigate('https://example.test/')
    await settle()
    expect(controller.state.getSnapshot().navigationError).toBeUndefined()
  })

  it('a lost attachment demotes the panel instead of raising a banner', async () => {
    const { rpc, controller } = await controlled()
    rpc.onError('navigate', { code: 'browser-control-unavailable', message: 'another window controls the page' })
    controller.navigate('https://example.test/')
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ inputOwned: false, error: undefined })
  })

  it('any other navigation failure raises the error banner', async () => {
    const { rpc, controller } = await controlled()
    rpc.onError('navigate', { code: 'internal', message: 'navigate blew up' })
    controller.navigate('https://example.test/')
    await settle()
    expect(controller.state.getSnapshot().error).toBe('navigate blew up')
  })

  it('history and reload moves ride the attachment, and are refused without control', async () => {
    const { rpc, controller, current } = await controlled()
    rpc.on('act', () => page('p1', { canGoForward: true }))
    controller.act('back')
    await settle()
    expect(at(rpc.of('act'), 0).args).toMatchObject({ action: 'back', id: 'p1' })
    expect(at(controller.state.getSnapshot().pages, 0).canGoForward).toBe(true)
    current().feed({ type: 'state', info: page('p1', { controllerId: 'other' as BrowserAttachmentId }) })
    await settle()
    controller.act('reload')
    await settle()
    expect(rpc.of('act')).toHaveLength(1)
  })

  it('an unbound panel moves no history', async () => {
    const { rpc, controller } = rig()
    controller.act('forward')
    await settle()
    expect(rpc.of('act')).toEqual([])
  })
})

describe('BrowserPanelController pages', () => {
  it('creates a page, activates it, and appends it to the list', async () => {
    const { rpc, controller, hub } = rig()
    scriptSession(rpc, [])
    rpc.on('create', args => page((args['request'] as { id: string }).id, { title: 'New' }))
    controller.bindSession(session)
    await settle()
    controller.create()
    await settle()
    const snapshot = controller.state.getSnapshot()
    expect(snapshot.pages).toHaveLength(1)
    expect(snapshot.activeId).toBe(at(snapshot.pages, 0).id)
    expect(hub.opens).toHaveLength(1)
  })

  it('a refused creation raises the banner and forgets the parked destination', async () => {
    const { rpc, controller } = rig()
    scriptSession(rpc, [])
    rpc.onError('create', { code: 'browser-limit-reached', message: 'page limit reached' })
    controller.bindSession(session)
    await settle()
    controller.navigate('https://example.test/')
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ error: 'page limit reached', pages: [] })
    expect(rpc.of('navigate')).toEqual([])
  })

  it('an unbound panel creates nothing', async () => {
    const { rpc, controller } = rig()
    controller.create()
    await settle()
    expect(rpc.of('create')).toEqual([])
  })

  it('closing the rendered page detaches first, then reloads the list', async () => {
    const { rpc, controller, hub } = await controlled()
    let pages = [page('p1')]
    rpc.on('list', () => pages)
    pages = []
    controller.close('p1' as HostBrowserPageId)
    expect(at(hub.opens, 1).signal.aborted).toBe(true)
    await settle()
    expect(at(rpc.of('close'), 0).args).toEqual({ agentId: session, id: 'p1' })
    expect(controller.state.getSnapshot()).toMatchObject({ pages: [], activeId: undefined, attached: false })
  })

  it('closing a background page keeps the rendered one attached', async () => {
    const { rpc, controller, hub, current } = rig()
    scriptSession(rpc, [page('p1'), page('p2')])
    controller.bindSession(session)
    await settle()
    controller.bindSurface(recordingSurface())
    const open = current()
    open.feed({ type: 'snapshot', info: page('p1', { controllerId: open.payload.attachmentId }) })
    await settle()
    rpc.on('list', () => [page('p1')])
    controller.close('p2' as HostBrowserPageId)
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ activeId: 'p1' as HostBrowserPageId, attached: true })
    expect(hub.opens.filter(entry => !entry.signal.aborted)).toHaveLength(1)
  })

  it('a failing close still raises the banner and reloads the list', async () => {
    const { rpc, controller } = await controlled()
    rpc.onError('close', { code: 'internal', message: 'close blew up' })
    const before = rpc.of('list').length
    controller.close('p1' as HostBrowserPageId)
    await settle()
    expect(controller.state.getSnapshot().error).toBe('close blew up')
    expect(rpc.of('list').length).toBe(before + 1)
  })

  it('an unbound panel closes nothing', async () => {
    const { rpc, controller } = rig()
    controller.close('p1' as HostBrowserPageId)
    await settle()
    expect(rpc.of('close')).toEqual([])
  })

  it('a close racing a session switch skips the list reload', async () => {
    const { rpc, controller } = await controlled()
    const before = rpc.of('list').length
    controller.close('p1' as HostBrowserPageId)
    controller.bindSession(undefined)
    await settle()
    expect(rpc.of('list').length).toBe(before)
  })
})

describe('BrowserPanelController input and viewport', () => {
  it('forwards every input kind to the controlled page', async () => {
    const { rpc, controller } = await controlled()
    controller.input({ kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 })
    controller.input({ kind: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: 120 })
    controller.input({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' })
    controller.input({ kind: 'text', text: 'pasted' })
    await settle()
    expect(rpc.of('input').map(call => (call.args['event'] as { kind: string }).kind))
      .toEqual(['mouse', 'wheel', 'key', 'text'])
    expect(at(rpc.of('input'), 0).args).toMatchObject({ agentId: session, id: 'p1' })
  })

  it('a read-only page and an unbound panel forward nothing', async () => {
    const { rpc, controller, current } = await controlled()
    current().feed({ type: 'state', info: page('p1', { controllerId: 'other' as BrowserAttachmentId }) })
    await settle()
    controller.input({ kind: 'text', text: 'ignored' })
    controller.bindSession(undefined)
    controller.input({ kind: 'text', text: 'ignored' })
    await settle()
    expect(rpc.of('input')).toEqual([])
  })

  it('a lost attachment demotes the panel on the next input', async () => {
    const { rpc, controller } = await controlled()
    rpc.onError('input', { code: 'browser-control-unavailable', message: 'another window controls the page' })
    controller.input({ kind: 'text', text: 'lost' })
    await settle()
    expect(controller.state.getSnapshot()).toMatchObject({ inputOwned: false, error: undefined })
    // Demoted: the panel stops forwarding until control returns.
    controller.input({ kind: 'text', text: 'dropped' })
    await settle()
    expect(rpc.of('input')).toHaveLength(1)
  })

  it('an input failure other than lost control raises the error banner', async () => {
    const { rpc, controller } = await controlled()
    rpc.onError('input', { code: 'internal', message: 'input blew up' })
    controller.input({ kind: 'text', text: 'boom' })
    await settle()
    expect(controller.state.getSnapshot().error).toBe('input blew up')
  })

  it('publishes a changed viewport, clamped to the host bounds, and skips an unchanged one', async () => {
    const { rpc, controller } = await controlled()
    rpc.on('resize', args => page('p1', { width: Number(args['width']), height: Number(args['height']) }))
    controller.resize(1280, 800)
    await settle()
    expect(rpc.of('resize')).toEqual([])
    controller.resize(900.7, 4000)
    await settle()
    expect(at(rpc.of('resize'), 0).args).toMatchObject({ width: 900, height: 1600 })
    controller.resize(10, 10)
    await settle()
    expect(at(rpc.of('resize'), 1).args).toMatchObject({ width: 200, height: 200 })
  })

  it('clamps against the built-in ceilings before the environment answers', async () => {
    const { rpc, controller, current } = rig()
    rpc.onError('environment', { code: 'internal', message: 'env failed' })
    rpc.on('list', () => [page('p1', { width: 10, height: 10 })])
    rpc.on('resize', args => page('p1', { width: Number(args['width']), height: Number(args['height']) }))
    controller.bindSession(session)
    await settle()
    controller.bindSurface(recordingSurface())
    const open = current()
    open.feed({ type: 'snapshot', info: page('p1', { width: 10, height: 10, controllerId: open.payload.attachmentId }) })
    await settle()
    controller.resize(9000, 9000)
    await settle()
    expect(at(rpc.of('resize'), rpc.of('resize').length - 1).args).toMatchObject({ width: 2560, height: 1600 })
  })

  it('a read-only or unattached panel publishes no viewport', async () => {
    const { rpc, controller } = rig()
    scriptSession(rpc, [page('p1')])
    controller.bindSession(session)
    await settle()
    controller.resize(640, 480)
    await settle()
    expect(rpc.of('resize')).toEqual([])
  })
})

describe('BrowserPanelController identities', () => {
  it('mints host-acceptable identities without crypto.randomUUID', async () => {
    vi.stubGlobal('crypto', {})
    const { rpc, controller, hub } = rig()
    scriptSession(rpc, [])
    rpc.on('create', args => page((args['request'] as { id: string }).id))
    controller.bindSession(session)
    await settle()
    controller.create()
    await settle()
    const created = (at(rpc.of('create'), 0).args['request'] as { id: string }).id
    expect(created).toMatch(/^p-[\w-]+$/u)
    expect(at(hub.opens, 0).payload.attachmentId).toMatch(/^att-[\w-]+$/u)
  })
})
