/**
 * The host browser controller over a real WebSocket CDP endpoint: process
 * launch, flat-session attachment, screencast following, reviewed navigation,
 * input forwarding, and Session-scoped cleanup.
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserController, type Config } from '../src/index.ts'
import type { BrowserAttachmentId, BrowserFrame, HostBrowserPageId } from '../src/types.ts'
import { fakeSubprocess, startFakeBrowser, type FakeBrowser } from './fake-browser.ts'

const roots: Context[] = []
const browsers: FakeBrowser[] = []
afterEach(async () => {
  // The suite spies on process.getuid; leaving it stubbed would decide the
  // sandbox for every later case in this file.
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(browsers.splice(0).map(browser => browser.close()))
})

const config: Config = {
  executablePath: undefined,
  browserCandidates: ['google-chrome', 'chromium'],
  sandbox: 'chromium',
  allowedHosts: [],
  allowPrivateAddresses: false,
  maxPages: 2,
  maxWidth: 2000,
  maxHeight: 1200,
  screencastQuality: 55,
  screencastEveryNthFrame: 1,
  navigationTimeoutMs: 30_000,
  launchTimeoutMs: 1000,
  disposeGraceMs: 50,
}

const pageId = 'page-one' as HostBrowserPageId
const attachmentId = 'att-one' as BrowserAttachmentId
const request = { id: pageId, width: 800, height: 600 }
const signal = (): AbortSignal => new AbortController().signal

/**
 * Read the private profile directory out of one browser command line.
 * @param argv - the launched argv.
 * @returns the profile directory path.
 */
function profileOf(argv: readonly string[]): string {
  const flag = argv.find(entry => entry.startsWith('--user-data-dir='))
  if (flag === undefined) throw new Error('the browser was launched without a private profile')
  return flag.slice('--user-data-dir='.length)
}

/**
 * Build a controller over a fake browser endpoint.
 * @param overrides - config overrides for the case.
 * @param endpoint - endpoint line the launcher observes; undefined reports none.
 * @returns the bench handles.
 */
async function fixture(overrides: Partial<Config> = {}, endpoint: 'ready' | 'absent' = 'ready') {
  const browser = await startFakeBrowser()
  browsers.push(browser)
  const ctx = new Context()
  roots.push(ctx)
  const effects = vi.spyOn(ctx.fiber, 'effect')
  ctx.provide('sandboxPolicy', { workspaceRoot: '/workspace' } as never)
  const subprocess = fakeSubprocess(endpoint === 'ready' ? browser.endpoint : undefined)
  ctx.provide('subprocess', subprocess.runtime as never)
  const controller = new BrowserController(ctx, { ...config, ...overrides })
  const agent = { id: 'session' as SessionId, ctx, session: { id: 'session' as SessionId, header: {} } } as unknown as Agent
  const disposeEffect = (label: string): Promise<void> => {
    const index = effects.mock.calls.findIndex(call => call[1] === label)
    const result = effects.mock.results[index]
    if (result?.type !== 'return' || typeof result.value !== 'function') throw new Error(`Missing effect: ${label}`)
    return (result.value as () => Promise<void>)()
  }
  return { browser, ctx, controller, subprocess, agent, disposeEffect }
}

/**
 * Open one attachment and read its baseline frame.
 * @param controller - the controller under test.
 * @param agent - owning Session.
 * @param abort - attachment lifetime.
 * @returns the iterator and its first frame.
 */
async function attach(controller: BrowserController, agent: Agent, abort: AbortController) {
  const stream = controller.follow(agent, pageId, attachmentId, abort.signal)[Symbol.asyncIterator]()
  const first = await stream.next()
  return { stream, baseline: first.value as BrowserFrame }
}

describe('BrowserController environment', () => {
  it('reports the operator policy and the resolved executable', async () => {
    const { controller, agent, subprocess } = await fixture({ allowedHosts: ['example.com'], allowPrivateAddresses: true })
    expect(await controller.environment(agent, signal())).toEqual({
      available: true,
      maxPages: 2,
      maxWidth: 2000,
      maxHeight: 1200,
      allowedHosts: ['example.com'],
      allowPrivateAddresses: true,
    })
    expect(subprocess.probes).toEqual(['google-chrome'])
  })

  it('probes every candidate and reports an unusable surface when none resolves', async () => {
    const { controller, agent, subprocess } = await fixture()
    subprocess.resolvable.clear()
    expect(await controller.environment(agent, signal())).toMatchObject({
      available: false,
      unavailableReason: 'No browser executable was found in this execution environment',
    })
    expect(subprocess.probes).toEqual(['google-chrome', 'chromium'])
  })

  it('probes only the configured executable when one is set', async () => {
    const { controller, agent, subprocess } = await fixture({ executablePath: '/opt/brave' })
    subprocess.resolvable.add('/opt/brave')
    expect(await controller.environment(agent, signal())).toMatchObject({ available: true })
    expect(subprocess.probes).toEqual(['/opt/brave'])
  })

  it('requires the Session execution providers', async () => {
    const { controller } = await fixture()
    const bare = new Context()
    roots.push(bare)
    const agent = { id: 'lonely' as SessionId, ctx: bare, session: { header: {} } } as unknown as Agent
    await expect(controller.environment(agent, signal())).rejects.toThrow('requires subprocess and sandbox policy providers')
  })

  it('honours request cancellation before probing', async () => {
    const { controller, agent } = await fixture()
    const abort = new AbortController()
    abort.abort(new Error('caller left'))
    await expect(controller.environment(agent, abort.signal)).rejects.toThrow('caller left')
  })
})

describe('BrowserController page lifecycle', () => {
  it('launches one browser for the Session and opens a page in it', async () => {
    const { controller, agent, browser, subprocess } = await fixture()
    const info = await controller.create(agent, request, signal())
    expect(info).toMatchObject({ id: pageId, url: '', width: 800, height: 600, state: 'ready', loading: false })
    const argv = subprocess.spawns[0]?.argv ?? []
    expect(argv[0]).toBe('/usr/bin/google-chrome')
    expect(argv).toContain('--headless=new')
    expect(argv).toContain('--remote-debugging-port=0')
    expect(argv.some(entry => entry.startsWith('--user-data-dir='))).toBe(true)
    expect(argv).not.toContain('--no-sandbox')
    expect(subprocess.spawns[0]).toMatchObject({ cwd: '/workspace', ambientEnv: 'scrubbed' })
    const methods = browser.commands.map(command => command.method)
    expect(methods).toEqual([
      'Target.setDiscoverTargets', 'Target.createTarget', 'Target.attachToTarget', 'Page.enable',
      'Emulation.setDeviceMetricsOverride', 'Page.startScreencast',
    ])
    expect(browser.commands.at(-1)).toMatchObject({
      sessionId: 'flat-session',
      params: { format: 'jpeg', quality: 55, maxWidth: 800, maxHeight: 600, everyNthFrame: 1 },
    })
    await controller.create(agent, { ...request, id: 'page-two' as HostBrowserPageId }, signal())
    expect(subprocess.spawns).toHaveLength(1)
    expect(controller.list(agent.id).map(page => page.id)).toEqual([pageId, 'page-two'])
  })

  it('passes --no-sandbox only when the operator selects it', async () => {
    const { controller, agent, subprocess } = await fixture({ sandbox: 'none' })
    await controller.create(agent, request, signal())
    expect(subprocess.spawns[0]?.argv).toContain('--no-sandbox')
  })

  it('drops the sandbox by default exactly where Chromium cannot start with one', async () => {
    // Chromium's zygote refuses to start as root unless the flag is present, so
    // a root deployment on the shipped default would have no usable panel.
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    const asRoot = await fixture({ sandbox: 'auto' })
    await asRoot.controller.create(asRoot.agent, request, signal())
    expect(asRoot.subprocess.spawns[0]?.argv).toContain('--no-sandbox')
    vi.spyOn(process, 'getuid').mockReturnValue(1000)
    const asUser = await fixture({ sandbox: 'auto' })
    await asUser.controller.create(asUser.agent, request, signal())
    expect(asUser.subprocess.spawns[0]?.argv).not.toContain('--no-sandbox')
  })

  it('keeps the sandbox as root when the operator demands it', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    const { controller, agent, subprocess } = await fixture({ sandbox: 'chromium' })
    await controller.create(agent, request, signal())
    expect(subprocess.spawns[0]?.argv).not.toContain('--no-sandbox')
  })

  it('reports a launch that fails without raising an error value', async () => {
    const { controller, agent, subprocess } = await fixture()
    vi.spyOn(subprocess.runtime, 'spawn').mockImplementation(() => { throw 'the provider refused' })
    await expect(controller.create(agent, request, signal())).rejects.toMatchObject({
      code: 'browser-unavailable',
      message: 'The Session browser could not start: the provider refused',
    })
  })

  it('reports what the browser said when it refused to start', async () => {
    // Without this the panel shows the gateway's opaque internal failure and
    // the one actionable line — the browser's own refusal — is lost.
    const { controller, agent, subprocess } = await fixture({}, 'absent')
    subprocess.prelude = 'ERROR:zygote_host_impl_linux.cc(101) Running as root without --no-sandbox is not supported'
    const creating = controller.create(agent, request, signal())
    await vi.waitFor(() => { expect(subprocess.handles).toHaveLength(1) })
    subprocess.handles[0]?.endStderr()
    await expect(creating).rejects.toMatchObject({
      code: 'browser-unavailable',
      message: expect.stringContaining('Running as root without --no-sandbox is not supported') as unknown as string,
    })
  })

  it('returns the same page for a repeated identity and joins an in-flight open', async () => {
    const { controller, agent, browser } = await fixture()
    const [first, second] = await Promise.all([
      controller.create(agent, request, signal()),
      controller.create(agent, request, signal()),
    ])
    expect(second).toEqual(first)
    expect(browser.commands.filter(command => command.method === 'Target.createTarget')).toHaveLength(1)
    expect(await controller.create(agent, request, signal())).toEqual(first)
  })

  it('rejects an invalid identity, an oversized viewport, and a page beyond the limit', async () => {
    const { controller, agent } = await fixture()
    await expect(controller.create(agent, { ...request, id: 'bad id' as HostBrowserPageId }, signal()))
      .rejects.toThrow('Invalid browser page identity')
    await expect(controller.create(agent, { ...request, width: 5000 }, signal()))
      .rejects.toThrow('Browser viewport exceeds the configured limits')
    await expect(controller.create(agent, { ...request, height: 10 }, signal()))
      .rejects.toThrow('Browser viewport exceeds the configured limits')
    await controller.create(agent, request, signal())
    await controller.create(agent, { ...request, id: 'page-two' as HostBrowserPageId }, signal())
    await expect(controller.create(agent, { ...request, id: 'page-three' as HostBrowserPageId }, signal()))
      .rejects.toMatchObject({ code: 'browser-limit-reached', details: { limit: 2 } })
  })

  it('lists nothing for a Session that never opened a page', async () => {
    const { controller } = await fixture()
    expect(controller.list('never-seen' as SessionId)).toEqual([])
  })

  it('closes the page, releases the browser process, and refuses the identity afterwards', async () => {
    const { controller, agent, browser, subprocess } = await fixture()
    await controller.create(agent, request, signal())
    await controller.close(agent, pageId)
    expect(browser.commands.filter(command => command.method === 'Target.closeTarget')).toHaveLength(1)
    expect(controller.list(agent.id)).toEqual([])
    // The last page going away takes the browser process with it.
    expect(subprocess.spawns).toHaveLength(1)
    await expect(controller.create(agent, request, signal())).rejects.toMatchObject({ code: 'browser-unavailable' })
    await expect(controller.close(agent, pageId)).resolves.toBeUndefined()
  })

  it('deletes the browser profile directory when the last page closes', async () => {
    const { controller, agent, subprocess } = await fixture()
    await controller.create(agent, request, signal())
    const profileDir = profileOf(subprocess.spawns[0]?.argv ?? [])
    expect(existsSync(profileDir)).toBe(true)
    await controller.close(agent, pageId)
    expect(existsSync(profileDir)).toBe(false)
  })

  it('abandons every page when the browser process exits on its own', async () => {
    const { controller, agent, subprocess } = await fixture()
    await controller.create(agent, request, signal())
    const abort = new AbortController()
    const { stream } = await attach(controller, agent, abort)
    subprocess.handles[0]?.exit()
    await vi.waitFor(() => { expect(controller.list(agent.id)).toEqual([]) })
    const closing = await stream.next()
    expect(closing.value).toMatchObject({ type: 'state', info: { state: 'closed' } })
    await stream.return?.()
  })

  it('tears down pages and the process when the controller plugin is disposed', async () => {
    const { controller, agent, disposeEffect, subprocess } = await fixture()
    await controller.create(agent, request, signal())
    await disposeEffect('browser-controller.processes')
    expect(controller.list(agent.id)).toEqual([])
    expect(subprocess.spawns).toHaveLength(1)
    await expect(controller.create(agent, request, signal())).rejects.toThrow('Browser controller disposed')
  })
})

describe('BrowserController launch failures', () => {
  it('reports an unavailable surface when no executable resolves', async () => {
    const { controller, agent, subprocess } = await fixture()
    subprocess.resolvable.clear()
    await expect(controller.create(agent, request, signal())).rejects.toMatchObject({
      code: 'browser-unavailable',
      message: 'No browser executable was found in this execution environment',
    })
  })

  it('times out when the browser never reports its endpoint, and a later create retries the launch', async () => {
    const { controller, agent, subprocess, browser } = await fixture({ launchTimeoutMs: 20 }, 'absent')
    await expect(controller.create(agent, request, signal())).rejects.toThrow('did not report a DevTools endpoint within 20ms')
    subprocess.endpoint = browser.endpoint
    await expect(controller.create(agent, request, signal())).resolves.toMatchObject({ id: pageId })
    expect(subprocess.spawns).toHaveLength(2)
  })

  it('reports a browser that exits before publishing an endpoint', async () => {
    const { controller, agent, subprocess } = await fixture({}, 'absent')
    const creating = controller.create(agent, request, signal())
    await vi.waitFor(() => { expect(subprocess.handles).toHaveLength(1) })
    subprocess.handles[0]?.endStderr()
    await expect(creating).rejects.toThrow('exited before reporting a DevTools endpoint')
  })

  it('reports the launch abort when the caller leaves mid-launch', async () => {
    const { controller, agent, subprocess } = await fixture({}, 'absent')
    const abort = new AbortController()
    const creating = controller.create(agent, request, abort.signal)
    await vi.waitFor(() => { expect(subprocess.handles).toHaveLength(1) })
    abort.abort(new Error('panel closed'))
    await expect(creating).rejects.toThrow('The browser launch was aborted')
  })

  it('keeps Session cleanup retryable when the browser tree refuses to quiesce', async () => {
    const { ctx, controller, subprocess, disposeEffect } = await fixture()
    let owned: Agent | undefined
    const fiber = ctx.plugin((child: Context) => {
      owned = { id: 'owned' as SessionId, ctx: child, session: { id: 'owned' as SessionId, header: {} } } as unknown as Agent
    })
    await fiber.await()
    if (owned === undefined) throw new Error('Agent plugin did not load')
    await controller.create(owned, request, signal())
    const profileDir = profileOf(subprocess.spawns[0]?.argv ?? [])
    subprocess.failWaitForExit = true
    await fiber.dispose()
    // The failed cleanup keeps the profile directory on the Session's discard
    // list rather than losing it, so the retry still removes it.
    expect(existsSync(profileDir)).toBe(true)
    subprocess.failWaitForExit = false
    await expect(disposeEffect('browser-controller.processes')).resolves.toBeUndefined()
    expect(existsSync(profileDir)).toBe(false)
    expect(controller.list(owned.id)).toEqual([])
  })

  it('reports every Session whose cleanup failed when the controller is disposed', async () => {
    const { controller, agent, subprocess, disposeEffect } = await fixture()
    await controller.create(agent, request, signal())
    subprocess.failWaitForExit = true
    const failure = await disposeEffect('browser-controller.processes').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toBe('Host browser cleanup failed')
    // The reported failure leaves the profile on the Session's discard list for
    // the next disposal rather than losing it; nothing else retries here.
    const profileDir = profileOf(subprocess.spawns[0]?.argv ?? [])
    expect(existsSync(profileDir)).toBe(true)
    await rm(profileDir, { recursive: true, force: true })
  })

  it('reports a browser with no diagnostic stream to read the endpoint from', async () => {
    const { controller, agent, subprocess } = await fixture()
    subprocess.withoutStderr = true
    await expect(controller.create(agent, request, signal()))
      .rejects.toThrow('The browser process exposed no diagnostic stream')
  })

  it('reads the endpoint from a decoded diagnostic stream and past unrelated output', async () => {
    const { controller, agent, subprocess } = await fixture()
    subprocess.stringChunks = true
    subprocess.prelude = 'Fontconfig error: no writable cache directories'
    await expect(controller.create(agent, request, signal())).resolves.toMatchObject({ id: pageId })
  })

  it('reports a launch whose signal aborted before the browser started', async () => {
    const { controller, agent } = await fixture({}, 'absent')
    const abort = new AbortController()
    abort.abort(new Error('panel closed'))
    await expect(controller.create(agent, request, abort.signal)).rejects.toThrow()
  })

  it('keeps the other pages and the browser when one of two pages closes', async () => {
    const { controller, agent, subprocess } = await fixture()
    const second = 'page-two' as HostBrowserPageId
    await controller.create(agent, request, signal())
    await controller.create(agent, { ...request, id: second }, signal())
    await controller.close(agent, pageId)
    expect(controller.list(agent.id)).toHaveLength(1)
    expect(existsSync(profileOf(subprocess.spawns[0]?.argv ?? []))).toBe(true)
  })

  it('closes a page once when two closes race, and releases the browser only once', async () => {
    const { controller, agent, browser, subprocess } = await fixture()
    await controller.create(agent, request, signal())
    await Promise.all([controller.close(agent, pageId), controller.close(agent, pageId)])
    expect(browser.commands.filter(command => command.method === 'Target.closeTarget')).toHaveLength(1)
    expect(existsSync(profileOf(subprocess.spawns[0]?.argv ?? []))).toBe(false)
  })

  it('discards a page whose creation failed while its identity was being closed', async () => {
    const { controller, agent, subprocess } = await fixture({}, 'absent')
    const creating = controller.create(agent, request, signal()).catch((error: unknown) => error)
    await vi.waitFor(() => { expect(subprocess.handles).toHaveLength(1) })
    const closing = controller.close(agent, pageId)
    // The close is already waiting on the allocation when the launch fails.
    subprocess.handles[0]?.endStderr()
    expect(await creating).toBeInstanceOf(Error)
    await expect(closing).resolves.toBeUndefined()
    expect(controller.list(agent.id)).toEqual([])
  })

  it('abandons the Session when the browser process fails instead of exiting', async () => {
    const { controller, agent, subprocess } = await fixture()
    await controller.create(agent, request, signal())
    subprocess.handles[0]?.fail()
    await vi.waitFor(() => { expect(controller.list(agent.id)).toEqual([]) })
  })

  it('discards a launch that is still pending when the Session is disposed', async () => {
    const { ctx, controller, subprocess } = await fixture({}, 'absent')
    let owned: Agent | undefined
    const fiber = ctx.plugin((child: Context) => {
      owned = { id: 'owned' as SessionId, ctx: child, session: { id: 'owned' as SessionId, header: {} } } as unknown as Agent
    })
    await fiber.await()
    if (owned === undefined) throw new Error('Agent plugin did not load')
    const creating = controller.create(owned, request, signal()).catch((error: unknown) => error)
    await vi.waitFor(() => { expect(subprocess.handles).toHaveLength(1) })
    await fiber.dispose()
    expect(await creating).toBeInstanceOf(Error)
    expect(controller.list(owned.id)).toEqual([])
  })

  it('releases a Session whose browser already exited on its own', async () => {
    const { ctx, controller, subprocess } = await fixture()
    let owned: Agent | undefined
    const fiber = ctx.plugin((child: Context) => {
      owned = { id: 'owned' as SessionId, ctx: child, session: { id: 'owned' as SessionId, header: {} } } as unknown as Agent
    })
    await fiber.await()
    if (owned === undefined) throw new Error('Agent plugin did not load')
    const agent = owned
    await controller.create(agent, request, signal())
    const profileDir = profileOf(subprocess.spawns[0]?.argv ?? [])
    subprocess.handles[0]?.exit()
    await vi.waitFor(() => { expect(controller.list(agent.id)).toEqual([]) })
    await fiber.dispose()
    expect(existsSync(profileDir)).toBe(false)
  })

  it('surfaces a browser that refuses to open a page', async () => {
    const { controller, agent, browser } = await fixture()
    browser.replies.set('Target.createTarget', () => ({}))
    await expect(controller.create(agent, request, signal())).rejects.toMatchObject({
      code: 'browser-unavailable', message: 'The browser refused to open a page',
    })
  })

  it('surfaces a browser that refuses to attach a session', async () => {
    const { controller, agent, browser } = await fixture()
    browser.replies.set('Target.attachToTarget', () => ({}))
    await expect(controller.create(agent, request, signal())).rejects.toMatchObject({
      code: 'browser-unavailable', message: 'The browser refused to attach to the page',
    })
  })
})

describe('BrowserController attachment', () => {
  it('claims control, replays the newest image, and streams later frames', async () => {
    const { controller, agent, browser } = await fixture()
    await controller.create(agent, request, signal())
    const abort = new AbortController()
    const { stream, baseline } = await attach(controller, agent, abort)
    expect(baseline.type).toBe('snapshot')
    expect(baseline.type === 'snapshot' && baseline.info.id).toBe(pageId)
    expect(baseline.type === 'snapshot' && baseline.info.controllerId).toBe(attachmentId)
    browser.emit('Page.screencastFrame', {
      data: 'Zmlyc3Q=', metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 9,
    }, 'flat-session')
    expect((await stream.next()).value).toEqual({
      type: 'image', image: { data: 'Zmlyc3Q=', width: 800, height: 600 },
    })
    // Acknowledgement is what keeps frames coming.
    await vi.waitFor(() => {
      expect(browser.commands.filter(command => command.method === 'Page.screencastFrameAck')).toMatchObject([
        { params: { sessionId: 9 } },
      ])
    })
    browser.emit('Target.targetInfoChanged', {
      targetInfo: { targetId: 'target-1', url: 'https://example.com/docs', title: 'Docs' },
    })
    expect((await stream.next()).value).toMatchObject({
      type: 'state', info: { url: 'https://example.com/docs', title: 'Docs' },
    })
    await stream.return?.()
  })

  it('replays the newest image to a second attachment and demotes the first', async () => {
    const { controller, agent, browser } = await fixture()
    await controller.create(agent, request, signal())
    const first = new AbortController()
    const { stream } = await attach(controller, agent, first)
    browser.emit('Page.screencastFrame', { data: 'cGl4', metadata: {}, sessionId: 1 }, 'flat-session')
    expect((await stream.next()).value).toMatchObject({ type: 'image' })
    const second = new AbortController()
    const later = controller.follow(agent, pageId, 'att-two' as BrowserAttachmentId, second.signal)[Symbol.asyncIterator]()
    const baseline = (await later.next()).value as BrowserFrame
    expect(baseline).toMatchObject({
      type: 'snapshot',
      info: { controllerId: 'att-two' },
      image: { data: 'cGl4', width: 800, height: 600 },
    })
    expect((await stream.next()).value).toMatchObject({ type: 'state', info: { controllerId: 'att-two' } })
    await stream.return?.()
    await later.return?.()
  })

  it('drops the controller record when the controlling attachment leaves', async () => {
    const { controller, agent } = await fixture()
    await controller.create(agent, request, signal())
    const abort = new AbortController()
    const { stream } = await attach(controller, agent, abort)
    await stream.return?.()
    expect(controller.list(agent.id)[0]).not.toHaveProperty('controllerId')
  })

  it('rejects an invalid attachment identity and an unknown page', async () => {
    const { controller, agent } = await fixture()
    await controller.create(agent, request, signal())
    expect(() => controller.follow(agent, pageId, 'bad id' as BrowserAttachmentId, signal()))
      .toThrow('Invalid browser attachment identity')
    expect(() => controller.follow(agent, 'missing' as HostBrowserPageId, attachmentId, signal()))
      .toThrow('The page no longer exists in this Session')
  })

  it('refuses an attachment whose signal already aborted', async () => {
    const { controller, agent } = await fixture()
    await controller.create(agent, request, signal())
    const abort = new AbortController()
    abort.abort(new Error('window closed'))
    const stream = controller.follow(agent, pageId, attachmentId, abort.signal)[Symbol.asyncIterator]()
    await expect(stream.next()).rejects.toThrow('window closed')
  })
})

describe('BrowserController navigation and input', () => {
  /** Open a page with one controlling attachment. */
  async function controlled(overrides: Partial<Config> = {}) {
    const bench = await fixture(overrides)
    await bench.controller.create(bench.agent, request, signal())
    const abort = new AbortController()
    const { stream } = await attach(bench.controller, bench.agent, abort)
    return { ...bench, abort, stream }
  }

  it('navigates to a reviewed destination and publishes the committed URL', async () => {
    const { controller, agent, browser, stream } = await controlled()
    const info = await controller.navigate(agent, pageId, attachmentId, 'example.com/docs')
    expect(info).toMatchObject({ url: 'https://example.com/docs', loading: true })
    expect(browser.commands.at(-1)).toMatchObject({
      method: 'Page.navigate', sessionId: 'flat-session', params: { url: 'https://example.com/docs' },
    })
    expect((await stream.next()).value).toMatchObject({ type: 'state', info: { loading: true } })
    await stream.return?.()
  })

  it('refuses a destination the operator policy rejects', async () => {
    const { controller, agent, browser, stream } = await controlled()
    await expect(controller.navigate(agent, pageId, attachmentId, 'http://127.0.0.1:8080')).rejects.toMatchObject({
      code: 'browser-navigation-refused',
    })
    expect(browser.commands.some(command => command.method === 'Page.navigate')).toBe(false)
    await stream.return?.()
  })

  it('rejects an oversized navigation target before touching the browser', async () => {
    const { controller, agent, stream } = await controlled()
    await expect(controller.navigate(agent, pageId, attachmentId, `https://example.com/${'x'.repeat(4096)}`))
      .rejects.toThrow('exceeds 4096 characters')
    await stream.return?.()
  })

  it("records the browser's own navigation failure", async () => {
    const { controller, agent, browser, stream } = await controlled()
    browser.replies.set('Page.navigate', () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }))
    const info = await controller.navigate(agent, pageId, attachmentId, 'https://nowhere.example')
    expect(info).toMatchObject({ loading: false, error: 'net::ERR_NAME_NOT_RESOLVED' })
    await stream.return?.()
  })

  it('clears the loading state when the page stalls past the navigation timeout', async () => {
    const { controller, agent, stream } = await controlled({ navigationTimeoutMs: 5 })
    await controller.navigate(agent, pageId, attachmentId, 'https://slow.example')
    await vi.waitFor(() => {
      expect(controller.list(agent.id)[0]).toMatchObject({
        loading: false, error: 'The page did not finish loading within 5ms',
      })
    })
    await stream.return?.()
  })

  it('clears the loading state when the page finishes loading and refreshes history', async () => {
    const { controller, agent, browser, stream } = await controlled()
    await controller.navigate(agent, pageId, attachmentId, 'https://example.com')
    expect((await stream.next()).value).toMatchObject({ type: 'state', info: { loading: true } })
    browser.emit('Page.loadEventFired', {}, 'flat-session')
    await vi.waitFor(() => {
      expect(controller.list(agent.id)[0]).toMatchObject({ loading: false, canGoBack: true, canGoForward: false })
    })
    await stream.return?.()
  })

  it('reads the settled title the browser announces no event for', async () => {
    const { controller, agent, browser, stream } = await controlled()
    // A loading page's targetInfo carries the url as its title; the parsed
    // <title> arrives without an event, so the host queries it on completion.
    browser.replies.set('Target.getTargetInfo', () => ({
      targetInfo: { targetId: 'target-1', url: 'https://example.com/docs', title: 'Docs' },
    }))
    browser.emit('Page.loadEventFired', {}, 'flat-session')
    await vi.waitFor(() => {
      expect(controller.list(agent.id)[0]).toMatchObject({ url: 'https://example.com/docs', title: 'Docs' })
    })
    await stream.return?.()
  })

  it('keeps the page usable when the settled title cannot be read', async () => {
    const { controller, agent, browser, stream } = await controlled()
    browser.failures.set('Target.getTargetInfo', 'target is gone')
    browser.emit('Page.loadEventFired', {}, 'flat-session')
    await vi.waitFor(() => { expect(controller.list(agent.id)[0]).toMatchObject({ loading: false, title: '' }) })
    await stream.return?.()
  })

  it('tracks in-document navigation and started loading', async () => {
    const { controller, agent, browser, stream } = await controlled()
    browser.emit('Page.frameStartedLoading', {}, 'flat-session')
    await vi.waitFor(() => { expect(controller.list(agent.id)[0]).toMatchObject({ loading: true }) })
    browser.emit('Page.navigatedWithinDocument', { url: 'https://example.com/#anchor' }, 'flat-session')
    await vi.waitFor(() => { expect(controller.list(agent.id)[0]).toMatchObject({ url: 'https://example.com/#anchor' }) })
    browser.emit('Page.frameNavigated', { frame: { url: 'https://example.com/next' } }, 'flat-session')
    await vi.waitFor(() => { expect(controller.list(agent.id)[0]).toMatchObject({ url: 'https://example.com/next' }) })
    await stream.return?.()
  })

  it('ignores subframe navigations and events from another page session', async () => {
    const { controller, agent, browser, stream } = await controlled()
    browser.emit('Page.frameNavigated', { frame: { url: 'https://ads.example', parentId: 'main' } }, 'flat-session')
    browser.emit('Page.frameNavigated', { frame: { url: 'https://other.example' } }, 'other-session')
    browser.emit('Target.targetInfoChanged', { targetInfo: { targetId: 'target-9', url: 'https://other.example' } })
    await Promise.resolve()
    expect(controller.list(agent.id)[0]).toMatchObject({ url: '' })
    await stream.return?.()
  })

  it('moves through history by entry id and refuses a missing entry', async () => {
    const { controller, agent, browser, stream } = await controlled()
    await controller.act(agent, pageId, attachmentId, 'back')
    expect(browser.commands.at(-1)).toMatchObject({ method: 'Page.navigateToHistoryEntry', params: { entryId: 10 } })
    browser.replies.set('Page.getNavigationHistory', () => ({ currentIndex: 0, entries: [{ id: 10 }] }))
    await expect(controller.act(agent, pageId, attachmentId, 'back')).rejects.toMatchObject({
      code: 'browser-navigation-refused', message: 'The page has no back history entry',
    })
    browser.replies.set('Page.getNavigationHistory', () => ({ currentIndex: 0, entries: [{ id: 10 }, { id: 11 }] }))
    await controller.act(agent, pageId, attachmentId, 'forward')
    expect(browser.commands.at(-1)).toMatchObject({ method: 'Page.navigateToHistoryEntry', params: { entryId: 11 } })
    await stream.return?.()
  })

  it('tolerates a history reply the browser could not answer', async () => {
    const { controller, agent, browser, stream } = await controlled()
    browser.replies.set('Page.getNavigationHistory', () => ({}))
    await expect(controller.act(agent, pageId, attachmentId, 'back')).resolves.toMatchObject({ id: pageId })
    browser.emit('Page.frameStoppedLoading', {}, 'flat-session')
    await vi.waitFor(() => { expect(controller.list(agent.id)[0]).toMatchObject({ loading: false }) })
    await stream.return?.()
  })

  it('reloads and stops loading', async () => {
    const { controller, agent, browser, stream } = await controlled()
    await controller.act(agent, pageId, attachmentId, 'reload')
    expect(browser.commands.at(-1)).toMatchObject({ method: 'Page.reload' })
    expect(controller.list(agent.id)[0]).toMatchObject({ loading: true })
    await controller.act(agent, pageId, attachmentId, 'stop')
    expect(browser.commands.at(-1)).toMatchObject({ method: 'Page.stopLoading' })
    expect(controller.list(agent.id)[0]).toMatchObject({ loading: false })
    await stream.return?.()
  })

  it('forwards pointer, wheel, key, and text input', async () => {
    const { controller, agent, browser, stream } = await controlled()
    await controller.input(agent, pageId, attachmentId, {
      kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 2,
    })
    expect(browser.commands.at(-1)).toMatchObject({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 2 },
    })
    await controller.input(agent, pageId, attachmentId, {
      kind: 'mouse', type: 'mouseMoved', x: 1, y: 2, button: 'none',
    })
    expect(browser.commands.at(-1)).toMatchObject({ params: { clickCount: 0, modifiers: 0 } })
    await controller.input(agent, pageId, attachmentId, { kind: 'wheel', x: 5, y: 6, deltaX: 0, deltaY: -120 })
    expect(browser.commands.at(-1)).toMatchObject({
      method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', deltaY: -120, button: 'none' },
    })
    await controller.input(agent, pageId, attachmentId, {
      kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a',
    })
    expect(browser.commands.at(-1)).toMatchObject({
      method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', text: 'a', unmodifiedText: 'a' },
    })
    await controller.input(agent, pageId, attachmentId, {
      kind: 'key', type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    })
    expect(browser.commands.at(-1)).toMatchObject({
      params: { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    })
    await controller.input(agent, pageId, attachmentId, { kind: 'text', text: 'pasted' })
    expect(browser.commands.at(-1)).toMatchObject({ method: 'Input.insertText', params: { text: 'pasted' } })
    await stream.return?.()
  })

  it('rejects malformed input payloads before they reach the browser', async () => {
    const { controller, agent, browser, stream } = await controlled()
    const before = browser.commands.length
    await expect(controller.input(agent, pageId, attachmentId, {
      kind: 'mouse', type: 'mouseMoved', x: Number.NaN, y: 0, button: 'none',
    })).rejects.toThrow('pointer coordinates must be finite')
    await expect(controller.input(agent, pageId, attachmentId, {
      kind: 'wheel', x: 0, y: 0, deltaX: Number.POSITIVE_INFINITY, deltaY: 0,
    })).rejects.toThrow('wheel coordinates must be finite')
    await expect(controller.input(agent, pageId, attachmentId, { kind: 'text', text: 'x'.repeat(4097) }))
      .rejects.toThrow('Inserted text exceeds 4096 characters')
    await expect(controller.input(agent, pageId, attachmentId, {
      kind: 'key', type: 'keyDown', key: 'k'.repeat(65), code: 'KeyK',
    })).rejects.toThrow('Key names are at most 64 characters')
    expect(browser.commands).toHaveLength(before)
    await stream.return?.()
  })

  it('resizes the viewport and restarts the screencast within the new bounds', async () => {
    const { controller, agent, browser, stream } = await controlled()
    const info = await controller.resize(agent, pageId, attachmentId, 1024, 768)
    expect(info).toMatchObject({ width: 1024, height: 768 })
    const methods = browser.commands.slice(-3).map(command => command.method)
    expect(methods).toEqual(['Emulation.setDeviceMetricsOverride', 'Page.stopScreencast', 'Page.startScreencast'])
    expect(browser.commands.at(-1)).toMatchObject({ params: { maxWidth: 1024, maxHeight: 768 } })
    await expect(controller.resize(agent, pageId, attachmentId, 10, 10)).rejects.toThrow('exceeds the configured limits')
    await stream.return?.()
  })

  it('refuses control verbs from an attachment that does not hold control', async () => {
    const { controller, agent, stream } = await controlled()
    const other = 'att-other' as BrowserAttachmentId
    for (const attempt of [
      () => controller.navigate(agent, pageId, other, 'https://example.com'),
      () => controller.act(agent, pageId, other, 'reload'),
      () => controller.resize(agent, pageId, other, 900, 700),
      () => controller.input(agent, pageId, other, { kind: 'text', text: 'x' }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        code: 'browser-control-unavailable', details: { reason: 'read-only' },
      })
    }
    await stream.return?.()
  })

  it('refuses control verbs once the page is closed', async () => {
    const { controller, agent, subprocess, stream } = await controlled()
    subprocess.handles[0]?.exit()
    await vi.waitFor(() => { expect(controller.list(agent.id)).toEqual([]) })
    await expect(controller.navigate(agent, pageId, attachmentId, 'https://example.com')).rejects.toMatchObject({
      code: 'browser-unavailable',
    })
    await stream.return?.()
  })
})
