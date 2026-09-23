/**
 * Session-owned host browser pages. The panel's pixels come from a real
 * browser process running beside the harness, so page traffic leaves the
 * host's own network position rather than the user's device — the whole point
 * of the surface — and the operator, not the client, owns the navigation policy.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { CdpConnection } from './cdp.ts'
import { HostBrowserPage } from './page.ts'
import type { BrowserNavigationPolicy } from './policy.ts'
import {
  DEFAULT_BROWSER_CANDIDATES, launchBrowser, resolveBrowserExecutable, sandboxDisabled,
  type BrowserSandbox,
} from './launch.ts'
import type {
  BrowserAttachmentId, BrowserCreateRequest, BrowserFrame, BrowserInputEvent, BrowserNavigationAction,
  HostBrowserEnvironment, HostBrowserPageId, HostBrowserPageInfo,
} from './types.ts'

export type * from './types.ts'
export { BrowserFollower } from './stream.ts'
export { CdpConnection, CdpError, type CdpEvent } from './cdp.ts'
export { HostBrowserPage, type BrowserPageSpec, type BrowserScreencastPolicy } from './page.ts'
export {
  isPrivateHost, reviewNavigation, type BrowserNavigationPolicy, type BrowserNavigationReview,
} from './policy.ts'
export {
  browserArgv, launchBrowser, resolveBrowserExecutable, sandboxDisabled, BrowserLaunchFailure,
  DEFAULT_BROWSER_CANDIDATES, type BrowserLaunchSpec, type BrowserSandbox, type LaunchedBrowser,
} from './launch.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-side browser pages for the browser panel, separate from the model's fetch seam. */
    browserController: BrowserController
  }
}

/** Deployment limits, executable selection, and the navigation policy. */
export interface Config {
  /** Explicit browser executable; omission probes {@link DEFAULT_BROWSER_CANDIDATES}. */
  readonly executablePath?: string | undefined
  /** Executable names or paths probed when no path is configured. */
  readonly browserCandidates: string[]
  /**
   * Whether Chromium keeps its own sandbox. The default `'auto'` keeps it
   * except where Chromium cannot start with it — a harness running as root —
   * while `'chromium'` demands it everywhere and `'none'` always drops it.
   */
  readonly sandbox: BrowserSandbox
  /** Permitted hosts; empty means every host the privacy rule allows. */
  readonly allowedHosts: string[]
  /**
   * Whether the panel may reach loopback, link-local, and private-range
   * destinations. Enabling it is what makes a workspace dev server on the
   * host's own localhost visible to the user, and it is off by default because
   * the same reachability covers the host's internal network.
   */
  readonly allowPrivateAddresses: boolean
  /** Maximum retained pages and pending allocations per Session. */
  readonly maxPages: number
  /** Maximum viewport width in CSS pixels. */
  readonly maxWidth: number
  /** Maximum viewport height in CSS pixels. */
  readonly maxHeight: number
  /** Screencast JPEG quality (1–100). */
  readonly screencastQuality: number
  /** Deliver every Nth composited frame. */
  readonly screencastEveryNthFrame: number
  /** How long a navigation may stay in flight before the panel is told it failed. */
  readonly navigationTimeoutMs: number
  /** How long to wait for the browser's DevTools endpoint at launch. */
  readonly launchTimeoutMs: number
  /** Browser process-termination grace period in milliseconds. */
  readonly disposeGraceMs: number
}

/** One Session's browser process, its control connection, and its profile. */
interface OwnedBrowser {
  readonly connection: CdpConnection
  readonly handle: SubprocessHandle
  readonly profileDir: string
}

/** Everything one Session owns: its pages, its browser, and its cleanup state. */
interface OwnedSession {
  readonly pages: Map<HostBrowserPageId, HostBrowserPage>
  readonly pending: Map<HostBrowserPageId, Promise<HostBrowserPage>>
  readonly closedIds: Set<HostBrowserPageId>
  readonly lifetime: AbortController
  /** Profile directories whose browser is gone but whose bytes remain. */
  readonly discarded: string[]
  /** In-flight or completed launch, memoized so one Session launches once. */
  browser?: Promise<OwnedBrowser>
  /**
   * The launched browser itself. Disposal reads this rather than awaiting
   * {@link OwnedSession.browser}: a launch is always settled by the time
   * cleanup runs, and a plain value cannot hand cleanup a rejection to swallow.
   */
  live?: OwnedBrowser
  cleanup?: Promise<void>
}

/** Caller-minted identity shape shared by pages and attachments. */
const IDENTITY = /^[\w-]{1,128}$/u

/** Typed Remote control of Session-owned host browser pages. */
export class BrowserController extends TypertRemoteService {
  static inject = ['subprocess', 'sandboxPolicy']

  static Config: z<Config> = z.object({
    executablePath: z.union([z.string().min(1), z.const(undefined)]),
    browserCandidates: z.array(z.string().min(1)).default([...DEFAULT_BROWSER_CANDIDATES]),
    sandbox: z.union([z.const('auto' as const), z.const('chromium' as const), z.const('none' as const)])
      .default('auto'),
    allowedHosts: z.array(z.string().min(1)).default([]),
    allowPrivateAddresses: z.boolean().default(false),
    maxPages: z.number().step(1).min(1).default(4),
    maxWidth: z.number().step(1).min(200).default(2560),
    maxHeight: z.number().step(1).min(200).default(1600),
    screencastQuality: z.number().step(1).min(1).max(100).default(60),
    screencastEveryNthFrame: z.number().step(1).min(1).default(1),
    navigationTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
    launchTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
    disposeGraceMs: z.number().step(1).min(1).default(2000),
  })

  private readonly owners = new Map<SessionId, OwnedSession>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Host context carrying typed Remote and execution providers.
   * @param config - validated browser limits, executable selection, and policy.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'browserController', { namespace: 'browser' })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Browser controller disposed'))
      const results = await Promise.allSettled(
        [...this.owners].map(([id, owner]) => this.disposeOwner(id, owner)),
      )
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'Host browser cleanup failed')
    }, 'browser-controller.processes')
  }

  /**
   * Report the panel's bounds and the operator's navigation policy, and whether
   * a browser executable exists at all (`harniverse.observe`).
   * @param agent - Session owner supplied by the Gateway.
   * @param signal - request cancellation.
   * @returns the viewport bounds, page limit, and navigation policy.
   */
  @Remote({ exportName: 'environment', requiredCapability: 'harniverse.observe' })
  async environment(agent: Agent, signal: AbortSignal): Promise<HostBrowserEnvironment> {
    signal.throwIfAborted()
    const executable = await this.executable(agent, signal)
    return {
      available: executable !== undefined,
      ...(executable === undefined
        ? { unavailableReason: 'No browser executable was found in this execution environment' }
        : {}),
      maxPages: this.config.maxPages,
      maxWidth: this.config.maxWidth,
      maxHeight: this.config.maxHeight,
      allowedHosts: [...this.config.allowedHosts],
      allowPrivateAddresses: this.config.allowPrivateAddresses,
    }
  }

  /**
   * List retained pages without resolving or activating an Agent (`harniverse.observe`).
   * @param sessionId - displayed Session identity, including offline history.
   * @returns pages retained for this Host lifetime.
   */
  @Remote({ exportName: 'list', requiredCapability: 'harniverse.observe' })
  list(sessionId: SessionId): HostBrowserPageInfo[] {
    const owner = this.owners.get(sessionId)
    if (owner === undefined) return []
    return [...owner.pages.values()].map(page => page.info)
  }

  /**
   * Open a page once for a caller-generated identity, launching the Session's
   * browser process on first use (`harniverse.operate`).
   * @param agent - Session owner supplied by the Gateway.
   * @param request - initial viewport and idempotency identity.
   * @param signal - allocation cancellation; committed pages survive disconnection.
   * @returns the existing or newly committed page.
   */
  @Remote({ exportName: 'create', requiredCapability: 'harniverse.operate' })
  async create(agent: Agent, request: BrowserCreateRequest, signal: AbortSignal): Promise<HostBrowserPageInfo> {
    this.lifetime.signal.throwIfAborted()
    if (!IDENTITY.test(request.id)) throw new Error('Invalid browser page identity')
    this.dimensions(request.width, request.height)
    const owner = this.owner(agent)
    owner.lifetime.signal.throwIfAborted()
    this.requireOpen(owner, request.id)
    const existing = owner.pages.get(request.id)
    if (existing !== undefined) return existing.info
    const pending = owner.pending.get(request.id)
    if (pending !== undefined) {
      const page = await pending
      this.requireOpen(owner, request.id)
      return page.info
    }
    if (new Set([...owner.pages.keys(), ...owner.pending.keys()]).size >= this.config.maxPages) {
      throw new RemoteError('browser-limit-reached', 'Session browser page limit reached', {
        limit: this.config.maxPages,
      })
    }
    const allocation = this.open(
      agent, owner, request, AbortSignal.any([signal, this.lifetime.signal, owner.lifetime.signal]),
    )
    owner.pending.set(request.id, allocation)
    try {
      const page = await allocation
      owner.pages.set(request.id, page)
      this.requireOpen(owner, request.id)
      return page.info
    } finally {
      owner.pending.delete(request.id)
    }
  }

  /**
   * Attach to a page without binding its lifetime to the transport.
   * Not a Remote invocation: harniverse's Gateway surface is request/response, so
   * the screencast transport broadcasts the follower frames the EventsApi browser stream drives.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - page identity.
   * @param attachmentId - new exclusive control attachment.
   * @param signal - attachment stream cancellation.
   * @returns the current page image and metadata, then later frames.
   */
  follow(
    agent: Agent, id: HostBrowserPageId, attachmentId: BrowserAttachmentId, signal: AbortSignal,
  ): AsyncIterable<BrowserFrame> {
    if (!IDENTITY.test(attachmentId)) throw new Error('Invalid browser attachment identity')
    return this.page(agent, id).follow(attachmentId, signal)
  }

  /**
   * Navigate one page to a host-reviewed destination (`harniverse.operate`).
   * @param agent - Session owner supplied by the Gateway.
   * @param id - page identity.
   * @param attachmentId - current controlling attachment.
   * @param url - requested destination as the panel supplied it.
   * @returns the page metadata after the navigation is dispatched.
   */
  @Remote({ exportName: 'navigate', requiredCapability: 'harniverse.operate' })
  async navigate(
    agent: Agent, id: HostBrowserPageId, attachmentId: BrowserAttachmentId, url: string,
  ): Promise<HostBrowserPageInfo> {
    if (url.length > 4096) throw new Error('Browser navigation target exceeds 4096 characters')
    return await this.page(agent, id).navigate(attachmentId, url)
  }

  /**
   * Move one page through history, reload it, or stop loading (`harniverse.operate`).
   * @param agent - Session owner supplied by the Gateway.
   * @param id - page identity.
   * @param attachmentId - current controlling attachment.
   * @param action - requested navigation move.
   * @returns the page metadata after the move is dispatched.
   */
  @Remote({ exportName: 'act', requiredCapability: 'harniverse.operate' })
  async act(
    agent: Agent, id: HostBrowserPageId, attachmentId: BrowserAttachmentId, action: BrowserNavigationAction,
  ): Promise<HostBrowserPageInfo> {
    return await this.page(agent, id).act(attachmentId, action)
  }

  /**
   * Forward one input event to a page (`harniverse.operate`).
   * @param agent - Session owner supplied by the Gateway.
   * @param id - page identity.
   * @param attachmentId - current controlling attachment.
   * @param event - page-space input event.
   * @returns after the browser accepts the event.
   */
  @Remote({ exportName: 'input', requiredCapability: 'harniverse.operate' })
  async input(
    agent: Agent, id: HostBrowserPageId, attachmentId: BrowserAttachmentId, event: BrowserInputEvent,
  ): Promise<void> {
    this.validateInput(event)
    await this.page(agent, id).input(attachmentId, event)
  }

  /**
   * Resize one page's emulated viewport (`harniverse.operate`).
   * @param agent - Session owner supplied by the Gateway.
   * @param id - page identity.
   * @param attachmentId - current controlling attachment.
   * @param width - CSS-pixel width.
   * @param height - CSS-pixel height.
   * @returns the page metadata with the new viewport.
   */
  @Remote({ exportName: 'resize', requiredCapability: 'harniverse.operate' })
  async resize(
    agent: Agent, id: HostBrowserPageId, attachmentId: BrowserAttachmentId, width: number, height: number,
  ): Promise<HostBrowserPageInfo> {
    this.dimensions(width, height)
    return await this.page(agent, id).resize(attachmentId, width, height)
  }

  /**
   * Close an identity to future creation and close its page; repeated closes succeed (`harniverse.operate`).
   * @param agent - Session owner supplied by the Gateway.
   * @param id - page identity.
   * @returns after the page is gone. A failure retains the page for retry.
   */
  @Remote({ exportName: 'close', requiredCapability: 'harniverse.operate' })
  async close(agent: Agent, id: HostBrowserPageId): Promise<void> {
    const owner = this.owner(agent)
    owner.closedIds.add(id)
    // create publishes the allocation before this wait settles; close owns it even if create then rejects.
    await owner.pending.get(id)?.catch(() => undefined)
    const page = owner.pages.get(id)
    if (page === undefined) return
    await page.close()
    owner.pages.delete(id)
    if (owner.pages.size === 0) await this.shutdownBrowser(owner)
  }

  /** Resolve (and remember) the Session's owner record. */
  private owner(agent: Agent): OwnedSession {
    let owner = this.owners.get(agent.id)
    if (owner === undefined) {
      owner = {
        pages: new Map(), pending: new Map(), closedIds: new Set(), lifetime: new AbortController(), discarded: [],
      }
      this.owners.set(agent.id, owner)
      const owned = owner
      agent.ctx.effect(() => async () => { await this.disposeOwner(agent.id, owned) }, 'browser-controller.owner')
    }
    return owner
  }

  /** Tear down one Session's pages and its browser process. */
  private disposeOwner(id: SessionId, owner: OwnedSession): Promise<void> {
    if (owner.cleanup !== undefined) return owner.cleanup
    owner.lifetime.abort(new Error('Browser Session owner disposed'))
    owner.cleanup = (async () => {
      await Promise.allSettled(owner.pending.values())
      for (const page of owner.pages.values()) page.abandon()
      owner.pages.clear()
      await this.shutdownBrowser(owner)
      this.owners.delete(id)
    })().catch((error: unknown) => { delete owner.cleanup; throw error })
    return owner.cleanup
  }

  /**
   * Close the connection, terminate the process tree, and delete every profile
   * directory this Session still owns — including the ones left behind by a
   * browser that exited on its own, so a failed removal is reported by the
   * disposal that owns it rather than swallowed in a background callback.
   */
  private async shutdownBrowser(owner: OwnedSession): Promise<void> {
    delete owner.browser
    const browser = owner.live
    delete owner.live
    if (browser !== undefined) {
      browser.connection.close()
      browser.handle.terminate()
      await browser.handle.waitForExit()
      owner.discarded.push(browser.profileDir)
    }
    const profiles = owner.discarded.splice(0)
    for (const profile of profiles) await rm(profile, { recursive: true, force: true })
  }

  /** Resolve one live page or reject with the panel's unavailability code. */
  private page(agent: Agent, id: HostBrowserPageId): HostBrowserPage {
    const owner = this.owners.get(agent.id)
    const page = owner?.pages.get(id)
    if (owner === undefined || page === undefined) {
      throw new RemoteError('browser-unavailable', 'The page no longer exists in this Session', {})
    }
    this.requireOpen(owner, id)
    return page
  }

  /** Reject an identity the Session already closed. */
  private requireOpen(owner: OwnedSession, id: HostBrowserPageId): void {
    if (owner.closedIds.has(id)) {
      throw new RemoteError('browser-unavailable', 'The page was closed in this Session', {})
    }
  }

  /** Reject viewports outside the configured bounds. */
  private dimensions(width: number, height: number): void {
    if (!Number.isSafeInteger(width) || width < 200 || width > this.config.maxWidth
      || !Number.isSafeInteger(height) || height < 200 || height > this.config.maxHeight) {
      throw new Error('Browser viewport exceeds the configured limits')
    }
  }

  /**
   * Validate one wire-supplied input event: coordinates and deltas must be
   * finite, and inserted text is bounded, because this payload reaches a real
   * browser's input pipeline.
   */
  private validateInput(event: BrowserInputEvent): void {
    const finite = (...values: number[]): boolean => values.every(value => Number.isFinite(value))
    if (event.kind === 'mouse' && !finite(event.x, event.y)) {
      throw new Error('Browser pointer coordinates must be finite')
    }
    if (event.kind === 'wheel' && !finite(event.x, event.y, event.deltaX, event.deltaY)) {
      throw new Error('Browser wheel coordinates must be finite')
    }
    if (event.kind === 'text' && event.text.length > 4096) throw new Error('Inserted text exceeds 4096 characters')
    if (event.kind === 'key' && event.key.length > 64) throw new Error('Key names are at most 64 characters')
  }

  /** The Session's execution providers; the Agent context selects them. */
  private execution(agent: Agent): { subprocess: SubprocessRuntime; sandboxPolicy: SandboxPolicy } {
    // The Agent context selects execution providers but does not inject consumer services.
    const subprocess = agent.ctx.get('subprocess')
    const sandboxPolicy = agent.ctx.get('sandboxPolicy')
    if (subprocess === undefined || sandboxPolicy === undefined) {
      throw new Error('The Session execution environment requires subprocess and sandbox policy providers')
    }
    return { subprocess, sandboxPolicy }
  }

  /** Probe the browser executable in the Session's execution environment. */
  private executable(agent: Agent, signal: AbortSignal): Promise<string | undefined> {
    return resolveBrowserExecutable(
      this.execution(agent).subprocess, this.config.executablePath, this.config.browserCandidates, signal,
    )
  }

  /** Launch the Session's browser process once, memoizing the connection. */
  private browser(agent: Agent, owner: OwnedSession, signal: AbortSignal): Promise<OwnedBrowser> {
    const existing = owner.browser
    if (existing !== undefined) return existing
    const launching = (async () => {
      const { subprocess, sandboxPolicy } = this.execution(agent)
      const executable = await this.executable(agent, signal)
      if (executable === undefined) {
        throw new RemoteError(
          'browser-unavailable', 'No browser executable was found in this execution environment', {},
        )
      }
      const profileDir = await mkdtemp(join(tmpdir(), 'dsh-browser-'))
      const uid = process.getuid?.()
      if (sandboxDisabled(this.config.sandbox, uid) && this.config.sandbox === 'auto') {
        this.ctx.logger.warn(
          'Running the panel browser without its own sandbox: Chromium cannot start as root with one',
        )
      }
      const launched = await launchBrowser({
        subprocess,
        executablePath: executable,
        cwd: agent.session.header.cwd ?? sandboxPolicy.workspaceRoot,
        profileDir,
        width: this.config.maxWidth,
        height: this.config.maxHeight,
        sandbox: this.config.sandbox,
        uid,
        graceMs: this.config.disposeGraceMs,
        sessionId: agent.id,
        launchTimeoutMs: this.config.launchTimeoutMs,
        signal,
      })
      const connection = await CdpConnection.open(launched.endpoint, signal)
      await connection.send('Target.setDiscoverTargets', { discover: true })
      const owned: OwnedBrowser = { connection, handle: launched.handle, profileDir }
      void launched.handle.done.then(
        () => { this.onBrowserExit(owner, owned) },
        () => { this.onBrowserExit(owner, owned) },
      )
      owner.live = owned
      return owned
    })()
    owner.browser = launching
    return launching.catch((error: unknown) => {
      // A failed launch is not remembered, so the next create retries it.
      delete owner.browser
      throw browserUnavailable(error)
    })
  }

  /**
   * Abandon every page of a browser that exited on its own and close its now
   * useless DevTools socket. The profile directory is handed to the Session's
   * discard list: this path is a process event with no caller to report a
   * removal failure to, so the removal belongs to the next shutdown.
   */
  private onBrowserExit(owner: OwnedSession, browser: OwnedBrowser): void {
    for (const page of owner.pages.values()) page.abandon()
    owner.pages.clear()
    delete owner.browser
    delete owner.live
    owner.discarded.push(browser.profileDir)
    browser.connection.close()
  }

  /** Create one browser target, attach a flat session, and start its screencast. */
  private async open(
    agent: Agent, owner: OwnedSession, request: BrowserCreateRequest, signal: AbortSignal,
  ): Promise<HostBrowserPage> {
    const browser = await this.browser(agent, owner, signal)
    signal.throwIfAborted()
    // No width/height here: a target only accepts bounds when it owns a new
    // window, and the panel's viewport is an emulation override anyway.
    const created = await browser.connection.send('Target.createTarget', { url: 'about:blank' })
    const targetId = created['targetId']
    if (typeof targetId !== 'string') {
      throw new RemoteError('browser-unavailable', 'The browser refused to open a page', {})
    }
    const attached = await browser.connection.send('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = attached['sessionId']
    if (typeof sessionId !== 'string') {
      throw new RemoteError('browser-unavailable', 'The browser refused to attach to the page', {})
    }
    const policy: BrowserNavigationPolicy = {
      allowedHosts: this.config.allowedHosts,
      allowPrivateAddresses: this.config.allowPrivateAddresses,
    }
    const page = new HostBrowserPage(browser.connection, {
      id: request.id,
      targetId,
      sessionId,
      width: request.width,
      height: request.height,
      screencast: { quality: this.config.screencastQuality, everyNthFrame: this.config.screencastEveryNthFrame },
      policy,
      navigationTimeoutMs: this.config.navigationTimeoutMs,
    })
    await page.start()
    return page
  }
}

/**
 * Present a launch or control-connection failure as a panel-readable error.
 *
 * Only a Remote failure keeps its message on the way to the browser panel;
 * anything else arrives as an opaque internal error and hides the one part the
 * user can act on — what the browser said when it refused to start. An
 * abandoned launch reports the same way: its caller is already gone.
 * @param error - failure raised while launching or connecting to the browser.
 * @returns the failure to report to the caller.
 */
function browserUnavailable(error: unknown): unknown {
  if (error instanceof RemoteError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new RemoteError('browser-unavailable', `The Session browser could not start: ${detail}`, {})
}

/** Host browser page service plugin. */
export default BrowserController
