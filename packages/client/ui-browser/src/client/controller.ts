/**
 * The browser panel controller: a DOM-free state machine that owns the
 * session's host browser pages, the exclusive control attachment over the
 * active page, and the bounded reattach recovery. Pixels never pass through
 * the published snapshot — the view registers an image sink through
 * `bindSurface` and receives screencast frames verbatim, so a 30-per-second
 * frame rate cannot become 30 React renders per second. All wire traffic goes
 * through the shared `/api` logical channel (`browser/<verb>` endpoints) and
 * the api-client `browser` event stream; nothing here is model-visible.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  BrowserStreamFrame, IApiClient, RpcResult, SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  BrowserAttachmentId, BrowserImageFrame, BrowserInputEvent, BrowserNavigationAction,
  HostBrowserEnvironment, HostBrowserPageId, HostBrowserPageInfo,
} from '@deepseek-ai/dsh-api-browser-controller/types'

/** Shared logical RPC channel the browser Remote endpoints ride on. */
const API_CHANNEL = '/api'

/** Browser Remote endpoint prefix on the shared channel. */
const BROWSER_PREFIX = 'browser/'

/** Reattach backoff ladder (milliseconds); exhaustion after the last rung. */
const REATTACH_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const

/** Viewport used before the panel has measured its own surface. */
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800

/** Smallest viewport the host accepts. */
const MIN_DIMENSION = 200

/** Default ceilings before the environment RPC answers. */
const DEFAULT_MAX_WIDTH = 2560
const DEFAULT_MAX_HEIGHT = 1600

/** Wire identity of one controlled page: the verb arguments every move shares. */
interface PageControl {
  readonly agentId: SessionId
  readonly id: HostBrowserPageId
  readonly attachmentId: BrowserAttachmentId
}

/** The image sink the panel view registers. */
export interface BrowserSurface {
  /** Render one complete screencast image. */
  render: (image: BrowserImageFrame) => void
}

/** Wire deps of the controller: the connection RPC caller plus the page stream. */
export interface BrowserPanelDeps {
  /** Generic logical RPC channel caller over the connection transport. */
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
  }
  /** Host browser page stream (payload-direct). */
  readonly events: Pick<IApiClient['events'], 'browser'>
}

/** Published panel state; every member is plain data for the render layer. */
export interface BrowserPanelState {
  /** Bound session; undefined while the panel shows its no-session notice. */
  readonly session: SessionId | undefined
  /** Whether the initial list and environment load has settled. */
  readonly ready: boolean
  /** Latest known pages of the session, in host order. */
  readonly pages: readonly HostBrowserPageInfo[]
  /** Page the stream renders; undefined when none is active. */
  readonly activeId: HostBrowserPageId | undefined
  /** Whether the stream delivered its baseline (the image is current). */
  readonly attached: boolean
  /** Whether this client's attachment controls the page. */
  readonly inputOwned: boolean
  /** Host bounds and navigation policy; undefined until the environment RPC settles. */
  readonly environment: HostBrowserEnvironment | undefined
  /** General RPC failure banner text, if any. */
  readonly error: string | undefined
  /** Refused navigation or page failure, shown beside the address bar. */
  readonly navigationError: string | undefined
  /** Whether a reattach is scheduled or in flight. */
  readonly reattaching: boolean
  /** Whether the bounded reattach ladder was exhausted. */
  readonly reattachFailed: boolean
}

/**
 * Mint a caller-side identity acceptable to the host's `^[\w-]{1,128}$` check.
 * @param prefix - identity prefix naming the identity's role.
 * @returns the minted identity string.
 */
function mintId(prefix: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}-${uuid}`
}

/**
 * The browser panel controller over one session's browser Remote surface.
 * Created once per plugin fiber; survives center-view remounts (pages keep
 * running while the panel is closed) and dies with `dispose`.
 */
export class BrowserPanelController {
  /** Published panel state (the render layer's single source of truth). */
  readonly state: SnapshotStore<BrowserPanelState>

  private readonly deps: BrowserPanelDeps
  private disposed = false
  private surface: BrowserSurface | undefined
  private attachment: { id: HostBrowserPageId; attachmentId: BrowserAttachmentId } | undefined
  private followAbort: AbortController | undefined
  private reattachAttempts = 0
  private reattachTimer: ReturnType<typeof setTimeout> | undefined
  private viewport = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  private queuedUrl: string | undefined

  /**
   * @param deps - the connection RPC caller and the browser page stream.
   */
  constructor(deps: BrowserPanelDeps) {
    this.deps = deps
    this.state = createSnapshotStore<BrowserPanelState>(this.blank(undefined))
  }

  /**
   * Bind the panel to a session (or clear it). Rebinding drops all list and
   * stream state; the new session loads from scratch.
   * @param sessionId - current session identity, or undefined with none.
   */
  bindSession(sessionId: SessionId | undefined): void {
    if (this.state.getSnapshot().session === sessionId) return
    this.clearStreamState()
    this.state.set(this.blank(sessionId))
    if (sessionId === undefined) return
    void this.loadSession(sessionId)
  }

  /**
   * Make one page the rendered one (undefined picks the list's first).
   * Switching re-opens the stream, which per the host contract claims the
   * exclusive control attachment.
   * @param id - page to render and follow, or undefined for the first.
   */
  activate(id: HostBrowserPageId | undefined): void {
    const snapshot = this.state.getSnapshot()
    const target = id ?? snapshot.pages[0]?.id
    if (target === undefined) {
      this.detachStream()
      this.patchState({ activeId: undefined, attached: false, inputOwned: false })
      return
    }
    if (target === snapshot.activeId && this.attachment !== undefined && !snapshot.reattachFailed) return
    this.attach(target, true)
  }

  /** Refresh the page list from the host. */
  refresh(): void {
    const { session } = this.state.getSnapshot()
    if (session !== undefined) void this.loadList(session)
  }

  /**
   * Navigate the active page, opening one first when the panel is empty. The
   * destination is reviewed on the host, so a refusal arrives as an RPC error
   * rather than being decided here.
   * @param url - requested destination as the user typed it.
   */
  navigate(url: string): void {
    const trimmed = url.trim()
    if (trimmed === '') return
    const { session, activeId } = this.state.getSnapshot()
    if (session === undefined) return
    this.patchState({ navigationError: undefined })
    const control = this.control()
    if (control !== undefined) {
      this.dispatchNavigation(control, trimmed)
      return
    }
    // The attachment is what carries navigation authority, and it only exists
    // once the stream's baseline frame arrives: park the destination and let
    // that frame flush it.
    this.queuedUrl = trimmed
    if (activeId === undefined) this.create()
  }

  /**
   * Move the active page through history, reload, or stop loading.
   * @param action - requested navigation move.
   */
  act(action: BrowserNavigationAction): void {
    const control = this.control()
    if (control === undefined) return
    void this.call<HostBrowserPageInfo>('act', { ...control, action })
      .then((result) => { this.onPageResult(result) })
  }

  /**
   * Open a page for this session and activate it.
   */
  create(): void {
    const { session } = this.state.getSnapshot()
    if (session === undefined) return
    const request = {
      id: mintId('p'),
      width: this.clampWidth(this.viewport.width),
      height: this.clampHeight(this.viewport.height),
    }
    void this.call<HostBrowserPageInfo>('create', { agentId: session, request }).then((result) => {
      if (!result.ok) {
        this.patchState({ error: result.error.message })
        this.queuedUrl = undefined
        return
      }
      this.upsert(result.value)
      this.activate(result.value.id)
    })
  }

  /**
   * Close one page (idempotent host verb) and stop rendering it first.
   * @param id - page to close.
   */
  close(id: HostBrowserPageId): void {
    const { session, activeId } = this.state.getSnapshot()
    if (session === undefined) return
    if (activeId === id) {
      this.detachStream()
      this.patchState({ attached: false, inputOwned: false })
    }
    void this.call('close', { agentId: session, id }).then((result) => {
      if (!result.ok) this.patchState({ error: result.error.message })
      const bound = this.state.getSnapshot().session
      if (bound !== undefined) void this.loadList(bound)
    })
  }

  /**
   * Forward one input event to the active page; ignored unless this client
   * controls it.
   * @param event - page-space input event.
   */
  input(event: BrowserInputEvent): void {
    const control = this.control()
    if (control === undefined) return
    void this.call('input', { ...control, event }).then((result) => {
      if (result.ok) return
      if (result.error.code === 'browser-control-unavailable') {
        this.patchState({ inputOwned: false })
        return
      }
      this.patchState({ error: result.error.message })
    })
  }

  /**
   * Record the panel's measured viewport and push it to the page when this
   * client controls it.
   * @param width - CSS-pixel width of the render surface.
   * @param height - CSS-pixel height of the render surface.
   */
  resize(width: number, height: number): void {
    this.viewport = { width, height }
    this.pushResize()
  }

  /** Take (back) the control attachment by re-opening the stream. */
  takeInput(): void {
    const { activeId } = this.state.getSnapshot()
    if (activeId === undefined) return
    this.attach(activeId, true)
  }

  /**
   * Register (or release) the image sink. Registering re-attaches so the
   * newest frame arrives immediately; releasing detaches so another window
   * may take control.
   * @param surface - image sink, or undefined when the view unmounts.
   */
  bindSurface(surface: BrowserSurface | undefined): void {
    this.surface = surface
    if (surface === undefined) {
      this.detachStream()
      this.patchState({ attached: false, inputOwned: false })
      return
    }
    const { session, activeId } = this.state.getSnapshot()
    if (session !== undefined && activeId !== undefined) this.attach(activeId, true)
  }

  /** Stop all streams and timers; the controller stays inert afterwards. */
  dispose(): void {
    this.disposed = true
    this.clearStreamState()
  }

  /** The panel's state with no session facts. */
  private blank(session: SessionId | undefined): BrowserPanelState {
    return {
      session,
      ready: false,
      pages: [],
      activeId: undefined,
      attached: false,
      inputOwned: false,
      environment: undefined,
      error: undefined,
      navigationError: undefined,
      reattaching: false,
      reattachFailed: false,
    }
  }

  /** Load one session's pages plus its best-effort environment. */
  private async loadSession(sessionId: SessionId): Promise<void> {
    void this.call<HostBrowserEnvironment>('environment', { agentId: sessionId }).then((result) => {
      if (result.ok) this.patchState({ environment: result.value })
    })
    await this.loadList(sessionId)
    if (this.state.getSnapshot().session === sessionId) this.patchState({ ready: true })
  }

  /** Fetch the page list and repair the active selection. */
  private async loadList(sessionId: SessionId): Promise<void> {
    const result = await this.call<HostBrowserPageInfo[]>('list', { sessionId })
    if (this.state.getSnapshot().session !== sessionId || this.disposed) return
    if (!result.ok) {
      this.patchState({ error: result.error.message })
      return
    }
    this.patchState({ pages: [...result.value] })
    const { activeId } = this.state.getSnapshot()
    const stillListed = activeId !== undefined && result.value.some(info => info.id === activeId)
    if (!stillListed) this.activate(undefined)
  }

  /**
   * Open the stream for one page with a fresh attachment.
   * @param id - page to follow.
   * @param fresh - true for an explicit user-initiated attach: clears stale
   * banners and restarts the reattach ladder.
   */
  private attach(id: HostBrowserPageId, fresh = false): void {
    if (this.reattachTimer !== undefined) {
      clearTimeout(this.reattachTimer)
      this.reattachTimer = undefined
    }
    const { session } = this.state.getSnapshot()
    if (session === undefined || this.disposed) return
    this.followAbort?.abort()
    const controller = new AbortController()
    this.followAbort = controller
    const attachmentId = mintId('att') as BrowserAttachmentId
    this.attachment = { id, attachmentId }
    if (fresh) {
      this.reattachAttempts = 0
      this.patchState({
        activeId: id, attached: false, inputOwned: false, reattachFailed: false, reattaching: false, error: undefined,
      })
    } else {
      this.patchState({ activeId: id, attached: false, inputOwned: false, reattachFailed: false })
    }
    void this.pump(session, id, attachmentId, controller)
  }

  /** Consume one page stream until it detaches, fails, or is superseded. */
  private async pump(
    session: SessionId,
    id: HostBrowserPageId,
    attachmentId: BrowserAttachmentId,
    controller: AbortController,
  ): Promise<void> {
    try {
      const stream = this.deps.events.browser({ sessionId: session, id, attachmentId }, controller.signal)
      for await (const frame of stream) {
        if (controller.signal.aborted || this.attachment?.attachmentId !== attachmentId) return
        if (!this.onFrame(attachmentId, frame.payload)) return
      }
    } catch {
      if (controller.signal.aborted) return
      this.scheduleReattach(id)
      return
    }
    if (this.attachment?.attachmentId === attachmentId) {
      this.patchState({ attached: false, inputOwned: false })
    }
  }

  /**
   * Fold one stream frame into state and the surface.
   * @returns false when the stream must stop (page gone or reattaching).
   */
  private onFrame(attachmentId: BrowserAttachmentId, frame: BrowserStreamFrame): boolean {
    if (frame.type === 'snapshot') {
      if (frame.image !== undefined) this.surface?.render(frame.image)
      this.upsert(frame.info)
      const owned = frame.info.controllerId === attachmentId
      this.patchState({
        attached: true,
        inputOwned: owned,
        reattaching: false,
        reattachFailed: false,
        error: undefined,
      })
      this.reattachAttempts = 0
      this.pushResize()
      this.flushQueuedUrl()
      return true
    }
    if (frame.type === 'image') {
      this.surface?.render(frame.image)
      return true
    }
    if (frame.type === 'stream/error') {
      this.onStreamError(frame.error.code, frame.error.message)
      return false
    }
    this.upsert(frame.info)
    this.patchState({ inputOwned: frame.info.controllerId === attachmentId })
    return true
  }

  /** Classify one stream failure: gone page or hard error. */
  private onStreamError(code: string, message: string): void {
    if (code === 'browser-unavailable') {
      this.patchState({ attached: false, inputOwned: false })
      this.refresh()
      return
    }
    this.patchState({ error: message, attached: false, inputOwned: false })
  }

  /** Dispatch the destination parked while the attachment was established. */
  private flushQueuedUrl(): void {
    const url = this.queuedUrl
    const control = this.control()
    if (url === undefined || control === undefined) return
    this.queuedUrl = undefined
    this.dispatchNavigation(control, url)
  }

  /**
   * Send one navigation to the host and fold its answer into state.
   * @param control - the control attachment authorizing the navigation.
   * @param url - destination as the user typed it.
   */
  private dispatchNavigation(control: PageControl, url: string): void {
    void this.call<HostBrowserPageInfo>('navigate', { ...control, url })
      .then((result) => { this.onPageResult(result) })
  }

  /** Fold one page-returning RPC result into the list or an error banner. */
  private onPageResult(result: RpcResult<HostBrowserPageInfo>): void {
    if (result.ok) {
      this.upsert(result.value)
      return
    }
    if (result.error.code === 'browser-navigation-refused') {
      this.patchState({ navigationError: result.error.message })
      return
    }
    if (result.error.code === 'browser-control-unavailable') {
      this.patchState({ inputOwned: false })
      return
    }
    this.patchState({ error: result.error.message })
  }

  /**
   * Schedule the bounded reattach recovery: re-attach with a fresh attachment
   * id after each backoff rung; exhaustion surfaces a banner.
   */
  private scheduleReattach(id: HostBrowserPageId | undefined): void {
    // Only a live pump schedules; it never runs with the attachment cleared
    // or after dispose tore the streams down.
    /* v8 ignore next 2 -- unreachable through the public verbs */
    if (id === undefined || this.disposed) return
    // The pending timer is the only pump consumer; a second failure cannot
    // arrive between schedule and fire because the failed pump returned.
    /* v8 ignore next -- unreachable through the public verbs */
    if (this.reattachTimer !== undefined) return
    if (this.reattachAttempts >= REATTACH_BACKOFF_MS.length) {
      this.patchState({ reattaching: false, reattachFailed: true })
      return
    }
    const delay = REATTACH_BACKOFF_MS[this.reattachAttempts]
    this.reattachAttempts += 1
    this.patchState({ reattaching: true })
    this.reattachTimer = setTimeout(() => {
      this.reattachTimer = undefined
      if (this.disposed || this.state.getSnapshot().activeId !== id) return
      this.attach(id)
    }, delay)
  }

  /**
   * The authority every page-affecting verb needs: the bound session, the
   * rendered page, and this client's control attachment over it. Undefined
   * whenever the panel may not act — no session, no page, or another window
   * holds control.
   */
  private control(): PageControl | undefined {
    const { session, activeId, inputOwned } = this.state.getSnapshot()
    const attachment = this.attachment
    if (session === undefined || activeId === undefined || !inputOwned || attachment === undefined) return undefined
    return { agentId: session, id: activeId, attachmentId: attachment.attachmentId }
  }

  /** Send the measured viewport when it differs from the page's. */
  private pushResize(): void {
    const control = this.control()
    if (control === undefined) return
    const info = this.state.getSnapshot().pages.find(entry => entry.id === control.id)
    // loadList repairs the active selection against the list before any frame
    // can push a viewport, so the info is always found here.
    /* v8 ignore next -- unreachable through the public verbs */
    if (info === undefined) return
    const width = this.clampWidth(this.viewport.width)
    const height = this.clampHeight(this.viewport.height)
    if (info.width === width && info.height === height) return
    void this.call<HostBrowserPageInfo>('resize', { ...control, width, height })
      .then((result) => { this.onPageResult(result) })
  }

  /** Clamp width into the host-validated range. */
  private clampWidth(width: number): number {
    const max = this.state.getSnapshot().environment?.maxWidth ?? DEFAULT_MAX_WIDTH
    return Math.min(Math.max(Math.trunc(width), MIN_DIMENSION), max)
  }

  /** Clamp height into the host-validated range. */
  private clampHeight(height: number): number {
    const max = this.state.getSnapshot().environment?.maxHeight ?? DEFAULT_MAX_HEIGHT
    return Math.min(Math.max(Math.trunc(height), MIN_DIMENSION), max)
  }

  /** Upsert one page info into the list. */
  private upsert(info: HostBrowserPageInfo): void {
    const { pages } = this.state.getSnapshot()
    const index = pages.findIndex(entry => entry.id === info.id)
    this.patchState({
      pages: index < 0
        ? [...pages, info]
        : pages.map((entry, position) => position === index ? info : entry),
    })
  }

  /** Call one browser Remote verb through the shared `/api` channel. */
  private async call<T>(method: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
    const result = await this.deps.rpc.call(API_CHANNEL, `${BROWSER_PREFIX}${method}`, { args })
    return result as RpcResult<T>
  }

  /** Apply one partial state update. */
  private patchState(patch: Partial<BrowserPanelState>): void {
    this.state.update((draft) => { Object.assign(draft, patch) })
  }

  /** Abort the stream without touching the published list. */
  private detachStream(): void {
    this.followAbort?.abort()
    this.followAbort = undefined
    this.attachment = undefined
  }

  /** Abort every stream and timer without touching the published list. */
  private clearStreamState(): void {
    this.detachStream()
    if (this.reattachTimer !== undefined) {
      clearTimeout(this.reattachTimer)
      this.reattachTimer = undefined
    }
    this.queuedUrl = undefined
    this.reattachAttempts = 0
  }
}
