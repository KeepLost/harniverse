/**
 * One host browser page: a CDP flat session over a browser target, its
 * screencast stream, and its detachable followers. Page lifetime is
 * independent of follower lifetime — closing the panel stops the pixels, not
 * the page — which is the same posture the terminal takes towards its PTY.
 */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { CdpConnection } from './cdp.ts'
import { BrowserFollower } from './stream.ts'
import { reviewNavigation, type BrowserNavigationPolicy } from './policy.ts'
import type {
  BrowserAttachmentId, BrowserFrame, BrowserImageFrame, BrowserInputEvent, BrowserNavigationAction,
  HostBrowserPageId, HostBrowserPageInfo,
} from './types.ts'

/** Screencast encoding parameters resolved from the controller config. */
export interface BrowserScreencastPolicy {
  /** JPEG quality (1–100); lower trades fidelity for bandwidth. */
  readonly quality: number
  /** Deliver every Nth frame; 1 is every frame the compositor produces. */
  readonly everyNthFrame: number
}

/** Everything one page needs after its target exists. */
export interface BrowserPageSpec {
  readonly id: HostBrowserPageId
  readonly targetId: string
  readonly sessionId: string
  readonly width: number
  readonly height: number
  readonly screencast: BrowserScreencastPolicy
  readonly policy: BrowserNavigationPolicy
  readonly navigationTimeoutMs: number
}

/**
 * Drop the last failure from one page's metadata. `error` is optional under
 * `exactOptionalPropertyTypes`, so clearing it means removing the member
 * rather than assigning undefined.
 * @param info - current page metadata.
 * @returns the same metadata with no `error` member.
 */
function cleared(info: HostBrowserPageInfo): HostBrowserPageInfo {
  const { error: _error, ...rest } = info
  return rest
}

/** A live page, its followers, and the last image the host holds for recovery. */
export class HostBrowserPage {
  /** Host-owned page metadata; every mutation broadcasts a `state` frame. */
  info: HostBrowserPageInfo

  private readonly followers = new Set<BrowserFollower>()
  private readonly detach: () => void
  private controller: { id: BrowserAttachmentId; follower: BrowserFollower } | undefined
  private lastImage: BrowserImageFrame | undefined
  private operations: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private loadTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param connection - shared DevTools connection of the owning browser.
   * @param spec - target identity, flat session, viewport, and policy.
   */
  constructor(private readonly connection: CdpConnection, private readonly spec: BrowserPageSpec) {
    this.info = {
      id: spec.id,
      url: '',
      title: '',
      width: spec.width,
      height: spec.height,
      loading: false,
      state: 'ready',
      canGoBack: false,
      canGoForward: false,
    }
    this.detach = connection.on((event) => { this.onEvent(event.method, event.params, event.sessionId) })
  }

  /**
   * Enable the page domains and start the screencast.
   * @returns when the page is ready to receive navigations and input.
   */
  async start(): Promise<void> {
    await this.send('Page.enable')
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.spec.width, height: this.spec.height, deviceScaleFactor: 1, mobile: false,
    })
    await this.startScreencast()
  }

  /**
   * Attach with exclusive input control; an older attachment becomes read-only.
   * @param id - client attachment identity.
   * @param signal - attachment cancellation; never closes the page.
   * @returns the current metadata and image, then later images and metadata.
   */
  async *follow(id: BrowserAttachmentId, signal: AbortSignal): AsyncIterable<BrowserFrame> {
    signal.throwIfAborted()
    const follower = new BrowserFollower()
    const baseline = await this.enqueue(() => {
      signal.throwIfAborted()
      this.controller = { id, follower }
      this.info = { ...this.info, controllerId: id }
      this.broadcast({ type: 'state', info: this.info })
      this.followers.add(follower)
      const snapshot: BrowserFrame = {
        type: 'snapshot',
        info: this.info,
        ...(this.lastImage === undefined ? {} : { image: this.lastImage }),
      }
      return snapshot
    })
    try {
      yield baseline
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
      if (this.controller?.follower === follower) {
        this.controller = undefined
        const { controllerId: _controllerId, ...info } = this.info
        this.info = info
        this.broadcast({ type: 'state', info })
      }
    }
  }

  /**
   * Navigate to a reviewed destination.
   * @param id - current controlling attachment.
   * @param url - requested destination as the panel supplied it.
   * @returns the page metadata after the navigation is dispatched.
   */
  navigate(id: BrowserAttachmentId, url: string): Promise<HostBrowserPageInfo> {
    return this.enqueue(async () => {
      this.requireController(id)
      const review = reviewNavigation(url, this.spec.policy)
      if (!review.allowed) throw new RemoteError('browser-navigation-refused', review.reason, {})
      const result = await this.send('Page.navigate', { url: review.url })
      const errorText = result['errorText']
      if (typeof errorText === 'string') {
        this.info = { ...this.info, url: review.url, loading: false, error: errorText }
        this.clearLoadTimeout()
      } else {
        this.info = { ...cleared(this.info), url: review.url, loading: true }
        this.armLoadTimeout()
      }
      this.broadcast({ type: 'state', info: this.info })
      return this.info
    })
  }

  /**
   * Move through history, reload, or stop loading.
   * @param id - current controlling attachment.
   * @param action - requested navigation move.
   * @returns the page metadata after the move is dispatched.
   */
  act(id: BrowserAttachmentId, action: BrowserNavigationAction): Promise<HostBrowserPageInfo> {
    return this.enqueue(async () => {
      this.requireController(id)
      if (action === 'reload') await this.send('Page.reload', {})
      else if (action === 'stop') await this.send('Page.stopLoading', {})
      else await this.moveHistory(action)
      if (action === 'stop') this.clearLoadTimeout()
      else this.armLoadTimeout()
      this.info = { ...cleared(this.info), loading: action !== 'stop' }
      this.broadcast({ type: 'state', info: this.info })
      return this.info
    })
  }

  /**
   * Forward one input event to the page.
   * @param id - current controlling attachment.
   * @param event - page-space input event.
   * @returns when the browser accepts the event.
   */
  input(id: BrowserAttachmentId, event: BrowserInputEvent): Promise<void> {
    return this.enqueue(async () => {
      this.requireController(id)
      await this.dispatch(event)
    })
  }

  /**
   * Resize the emulated viewport and the screencast bounds together.
   * @param id - current controlling attachment.
   * @param width - validated CSS-pixel width.
   * @param height - validated CSS-pixel height.
   * @returns the page metadata with the new viewport.
   */
  resize(id: BrowserAttachmentId, width: number, height: number): Promise<HostBrowserPageInfo> {
    return this.enqueue(async () => {
      this.requireController(id)
      await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      this.info = { ...this.info, width, height }
      await this.send('Page.stopScreencast', {})
      await this.startScreencast(width, height)
      this.broadcast({ type: 'state', info: this.info })
      return this.info
    })
  }

  /**
   * Close the browser target and finish every follower.
   * @returns after the target is gone; failures remain retryable.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      this.detach()
      this.clearLoadTimeout()
      await this.connection.send('Target.closeTarget', { targetId: this.spec.targetId })
      this.info = { ...this.info, state: 'closed', loading: false }
      this.broadcast({ type: 'state', info: this.info })
      for (const follower of this.followers) follower.finish()
      this.followers.clear()
    })().catch((error: unknown) => { this.closing = undefined; throw error })
    return this.closing
  }

  /**
   * Abandon this page without commanding the browser: used when the browser
   * process is already gone, so a `Target.closeTarget` would only fail.
   */
  abandon(): void {
    this.detach()
    this.clearLoadTimeout()
    this.info = { ...this.info, state: 'closed', loading: false }
    this.broadcast({ type: 'state', info: this.info })
    for (const follower of this.followers) follower.finish()
    this.followers.clear()
  }

  /**
   * Bound one navigation's loading state. `Page.navigate` resolves when the
   * navigation commits, not when the page finishes loading, so a destination
   * that never settles would otherwise leave the panel's progress indicator on
   * forever; the timeout reports the stall without cancelling the page. Every
   * transition out of loading cancels the timer, so a fired timer always means
   * the navigation is still outstanding.
   */
  private armLoadTimeout(): void {
    this.clearLoadTimeout()
    this.loadTimer = setTimeout(() => {
      this.loadTimer = undefined
      this.info = {
        ...this.info,
        loading: false,
        error: `The page did not finish loading within ${this.spec.navigationTimeoutMs}ms`,
      }
      this.broadcast({ type: 'state', info: this.info })
    }, this.spec.navigationTimeoutMs)
  }

  /** Cancel any armed navigation stall timer. */
  private clearLoadTimeout(): void {
    if (this.loadTimer === undefined) return
    clearTimeout(this.loadTimer)
    this.loadTimer = undefined
  }

  /** Start (or restart) the screencast within the page's current bounds. */
  private async startScreencast(width = this.spec.width, height = this.spec.height): Promise<void> {
    await this.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.spec.screencast.quality,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: this.spec.screencast.everyNthFrame,
    })
  }

  /** Resolve the history entry one step back or forward and navigate to it. */
  private async moveHistory(action: 'back' | 'forward'): Promise<void> {
    const history = await this.send('Page.getNavigationHistory', {})
    const entries = history['entries']
    const currentIndex = history['currentIndex']
    if (!Array.isArray(entries) || typeof currentIndex !== 'number') return
    const index = action === 'back' ? currentIndex - 1 : currentIndex + 1
    const entry = entries[index] as { id?: unknown } | undefined
    if (entry === undefined || typeof entry.id !== 'number') {
      throw new RemoteError('browser-navigation-refused', `The page has no ${action} history entry`, {})
    }
    await this.send('Page.navigateToHistoryEntry', { entryId: entry.id })
  }

  /** Translate one input event into its CDP command. */
  private async dispatch(event: BrowserInputEvent): Promise<void> {
    const modifiers = event.kind === 'text' ? 0 : event.modifiers ?? 0
    if (event.kind === 'mouse') {
      await this.send('Input.dispatchMouseEvent', {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button,
        clickCount: event.clickCount ?? 0,
        modifiers,
      })
      return
    }
    if (event.kind === 'wheel') {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: event.x,
        y: event.y,
        button: 'none',
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers,
      })
      return
    }
    if (event.kind === 'key') {
      await this.send('Input.dispatchKeyEvent', {
        type: event.type,
        key: event.key,
        code: event.code,
        modifiers,
        ...(event.windowsVirtualKeyCode === undefined ? {} : {
          windowsVirtualKeyCode: event.windowsVirtualKeyCode,
          nativeVirtualKeyCode: event.windowsVirtualKeyCode,
        }),
        ...(event.text === undefined ? {} : { text: event.text, unmodifiedText: event.text }),
      })
      return
    }
    await this.send('Input.insertText', { text: event.text })
  }

  /** Fold one protocol event belonging to this page's session into state. */
  private onEvent(method: string, params: Record<string, unknown>, sessionId: string | undefined): void {
    if (method === 'Target.targetInfoChanged') {
      this.onTargetInfo(params)
      return
    }
    if (sessionId !== this.spec.sessionId) return
    if (method === 'Page.screencastFrame') {
      this.onScreencastFrame(params)
      return
    }
    if (method === 'Page.frameNavigated') {
      const frame = params['frame'] as { parentId?: unknown; url?: unknown } | undefined
      if (frame === undefined || frame.parentId !== undefined) return
      this.publish({ ...(typeof frame.url === 'string' ? { url: frame.url } : {}) })
      return
    }
    if (method === 'Page.navigatedWithinDocument') {
      this.publish({ ...(typeof params['url'] === 'string' ? { url: params['url'] } : {}) })
      return
    }
    if (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading') {
      this.publish({ loading: false })
      void this.refreshHistory()
      void this.refreshTargetInfo()
      return
    }
    if (method === 'Page.frameStartedLoading') this.publish({ loading: true })
  }

  /** Track the browser's own view of this target's url and title. */
  private onTargetInfo(params: Record<string, unknown>): void {
    const target = params['targetInfo'] as { targetId?: unknown; url?: unknown; title?: unknown } | undefined
    if (target === undefined || target.targetId !== this.spec.targetId) return
    this.publish({
      ...(typeof target.url === 'string' && target.url !== 'about:blank' ? { url: target.url } : {}),
      ...(typeof target.title === 'string' ? { title: target.title } : {}),
    })
  }

  /** Broadcast one screencast image and acknowledge it so frames keep coming. */
  private onScreencastFrame(params: Record<string, unknown>): void {
    const data = params['data']
    const ack = params['sessionId']
    if (typeof data !== 'string') return
    const metadata = (params['metadata'] ?? {}) as { deviceWidth?: unknown; deviceHeight?: unknown }
    const width = typeof metadata.deviceWidth === 'number' ? metadata.deviceWidth : this.info.width
    const height = typeof metadata.deviceHeight === 'number' ? metadata.deviceHeight : this.info.height
    this.lastImage = { data, width, height }
    this.broadcast({ type: 'image', image: this.lastImage })
    if (typeof ack === 'number') {
      // The browser stops producing frames until the previous one is
      // acknowledged; a failed ack means the page is gone, which the page's
      // own close path already reports.
      void this.send('Page.screencastFrameAck', { sessionId: ack }).catch(() => {})
    }
  }

  /**
   * Read the target's settled url and title once loading finishes.
   * `Target.targetInfoChanged` announces the intermediate titles a loading page
   * carries (the host shows the url until the document names itself), but the
   * parsed `<title>` arrives without an event, so the panel would keep the
   * placeholder forever without this query.
   */
  private async refreshTargetInfo(): Promise<void> {
    try {
      this.onTargetInfo(await this.connection.send('Target.getTargetInfo', { targetId: this.spec.targetId }))
    } catch {
      // Page metadata is presentation: a page that closed mid-query reports its
      // closure through its own lifecycle.
    }
  }

  /** Refresh the back/forward affordances from the browser's history. */
  private async refreshHistory(): Promise<void> {
    try {
      const history = await this.send('Page.getNavigationHistory', {})
      const entries = history['entries']
      const currentIndex = history['currentIndex']
      if (!Array.isArray(entries) || typeof currentIndex !== 'number') return
      this.publish({ canGoBack: currentIndex > 0, canGoForward: currentIndex < entries.length - 1 })
    } catch {
      // History is an affordance, not state the panel depends on: a page that
      // closed mid-query reports its closure through its own lifecycle.
    }
  }

  /** Apply a metadata patch and broadcast it when it changed something. */
  private publish(patch: Partial<HostBrowserPageInfo>): void {
    if (patch.loading === false) this.clearLoadTimeout()
    const next = { ...this.info, ...patch }
    if (next.url === this.info.url && next.title === this.info.title && next.loading === this.info.loading
      && next.canGoBack === this.info.canGoBack && next.canGoForward === this.info.canGoForward) return
    this.info = next
    this.broadcast({ type: 'state', info: this.info })
  }

  /** Reject a caller that does not currently control this page. */
  private requireController(id: BrowserAttachmentId): void {
    if (this.closing !== undefined || this.info.state !== 'ready') {
      throw new RemoteError('browser-control-unavailable', 'The page is not available', { reason: 'not-running' })
    }
    if (this.controller?.id !== id) {
      throw new RemoteError('browser-control-unavailable', 'The page is controlled by another attachment', { reason: 'read-only' })
    }
  }

  /** Push one frame to every follower. */
  private broadcast(frame: BrowserFrame): void {
    for (const follower of this.followers) follower.push(frame)
  }

  /** Send one command on this page's flat session. */
  private send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.connection.send(method, params, this.spec.sessionId)
  }

  /** Serialize page operations so navigation, input, and resize cannot interleave. */
  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.operations.then(operation)
    this.operations = pending.catch(() => { /* The caller owns this operation's failure; later cleanup must still run. */ })
    return pending
  }
}
