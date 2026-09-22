/**
 * The terminal panel controller: a DOM-free state machine that owns the
 * session's terminal list, the exclusive input attachment over the active
 * terminal, window holds for every running terminal, and the bounded
 * slow-follower recovery. The panel view consumes its published snapshot
 * through the inject `hooks` compartment and drives it through plain verbs;
 * the xterm.js surface registers itself through `bindSurface` and receives
 * snapshot/output frames verbatim. All wire traffic goes through the shared
 * `/api` logical channel (`terminal/<verb>` endpoints) and the api-client
 * `terminal`/`hold` event streams — nothing here is model-visible.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  HoldStreamFrame, IApiClient, RpcResult, SessionId, TerminalStreamFrame,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  TerminalAttachmentId, TerminalEnvironment, TerminalShell, WebTerminalId, WebTerminalInfo,
} from '@deepseek-ai/dsh-api-terminal-controller/types'

/** Shared logical RPC channel the terminal Remote endpoints ride on. */
const API_CHANNEL = '/api'

/** Terminal Remote endpoint prefix on the shared channel. */
const TERMINAL_PREFIX = 'terminal/'

/** Reattach backoff ladder (milliseconds); exhaustion after the last rung. */
const REATTACH_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const

/** Default dimension ceilings before the environment RPC answers. */
const DEFAULT_MAX_COLS = 500
const DEFAULT_MAX_ROWS = 200

/** Creation dimensions when no fitted dimensions are known yet. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** Host-allowed terminal title bounds (1–120 characters after trimming). */
const TITLE_MAX = 120

/** Slow-follower failure marker in the host's stream error message. */
const BUFFER_EXCEEDED = 'exceeded its buffer'

/**
 * Appearance revision the view re-resolves its xterm.js presentation on.
 * xterm.js takes colors and metrics as JavaScript values rather than CSS, so a
 * palette or content-font-size change cannot reach the rendered screen through
 * the cascade alone; the revision is the notification that it must be re-read.
 */
export interface TerminalAppearance {
  /** Monotonic counter of theme snapshots published since the panel loaded. */
  readonly revision: number
}

/** The xterm.js-facing frame sink the panel view registers. */
export interface TerminalSurface {
  /** Replace the rendered screen with a recovery snapshot. */
  reset: (screen: string) => void
  /** Append one ordered output delta. */
  write: (data: string) => void
}

/** Wire deps of the controller: the connection RPC caller plus the two streams. */
export interface TerminalPanelDeps {
  /** Generic logical RPC channel caller over the connection transport. */
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
  }
  /** Terminal attachment and window-hold event streams (payload-direct). */
  readonly events: Pick<IApiClient['events'], 'terminal' | 'hold'>
}

/** Published panel state; every member is plain data for the render layer. */
export interface TerminalPanelState {
  /** Bound session; undefined while the panel shows its no-session notice. */
  readonly session: SessionId | undefined
  /** Whether the initial list/environment/shells load has settled. */
  readonly ready: boolean
  /** Latest known terminals of the session, in host order. */
  readonly terminals: readonly WebTerminalInfo[]
  /** Terminal the follow stream renders; undefined when none is active. */
  readonly activeId: WebTerminalId | undefined
  /** Whether the follow stream delivered its snapshot (screen is current). */
  readonly attached: boolean
  /** Whether this client's attachment owns the terminal input. */
  readonly inputOwned: boolean
  /** Verified shells for new terminals; empty until discovery settles. */
  readonly shells: readonly TerminalShell[]
  /** Session terminal limits; undefined until the environment RPC settles. */
  readonly environment: TerminalEnvironment | undefined
  /** General RPC failure banner text, if any. */
  readonly error: string | undefined
  /** Whether a slow-follower reattach is scheduled or in flight. */
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
 * The terminal panel controller over one session's terminal Remote surface.
 * Created once per plugin fiber; survives center-view remounts (holds and the
 * list keep running while the panel is closed) and dies with `dispose`.
 */
export class TerminalPanelController {
  /** Published panel state (the render layer's single source of truth). */
  readonly state: SnapshotStore<TerminalPanelState>

  private readonly deps: TerminalPanelDeps
  private disposed = false
  private surface: TerminalSurface | undefined
  private attachment: { id: WebTerminalId; attachmentId: TerminalAttachmentId } | undefined
  private followAbort: AbortController | undefined
  private lastSequence = -1
  private reattachAttempts = 0
  private reattachTimer: ReturnType<typeof setTimeout> | undefined
  private readonly holds = new Map<WebTerminalId, AbortController>()
  private fitDims: { cols: number; rows: number } = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }

  /**
   * @param deps - the connection RPC caller and the terminal/hold streams.
   */
  constructor(deps: TerminalPanelDeps) {
    this.deps = deps
    this.state = createSnapshotStore<TerminalPanelState>({
      session: undefined,
      ready: false,
      terminals: [],
      activeId: undefined,
      attached: false,
      inputOwned: false,
      shells: [],
      environment: undefined,
      error: undefined,
      reattaching: false,
      reattachFailed: false,
    })
  }

  /**
   * Bind the panel to a session (or clear it). Rebinding drops all list,
   * follow, and hold state; the new session loads from scratch.
   * @param sessionId - current session identity, or undefined with none.
   */
  bindSession(sessionId: SessionId | undefined): void {
    if (this.state.getSnapshot().session === sessionId) return
    this.clearStreamState()
    this.state.set({
      session: sessionId,
      ready: false,
      terminals: [],
      activeId: undefined,
      attached: false,
      inputOwned: false,
      shells: [],
      environment: undefined,
      error: undefined,
      reattaching: false,
      reattachFailed: false,
    })
    if (sessionId === undefined) return
    void this.loadSession(sessionId)
  }

  /**
   * Make one terminal the rendered one (undefined picks the list's first).
   * Switching re-opens the follow stream, which per the host contract claims
   * the exclusive input attachment. An explicit switch also clears any stale
   * recovery banners and starts a fresh reattach ladder.
   * @param id - terminal to render and follow, or undefined for the first.
   */
  activate(id: WebTerminalId | undefined): void {
    const snapshot = this.state.getSnapshot()
    const target = id ?? snapshot.terminals[0]?.id
    if (target === undefined) {
      this.followAbort?.abort()
      this.followAbort = undefined
      this.attachment = undefined
      this.patchState({ activeId: undefined, attached: false, inputOwned: false })
      return
    }
    if (target === snapshot.activeId && this.attachment !== undefined && !snapshot.reattachFailed) return
    this.attach(target, true)
  }

  /** Refresh the terminal list from the host. */
  refresh(): void {
    const { session } = this.state.getSnapshot()
    if (session !== undefined) void this.loadList(session)
  }

  /**
   * Create a terminal (idempotent per minted identity) and activate it.
   * @param shellPath - chosen shell path, or undefined for the default shell.
   */
  create(shellPath: string | undefined): void {
    const { session } = this.state.getSnapshot()
    if (session === undefined) return
    const request = {
      ...(shellPath === undefined ? {} : { shellPath }),
      id: mintId('t'),
      cols: this.clampCols(this.fitDims.cols),
      rows: this.clampRows(this.fitDims.rows),
    }
    void this.call<WebTerminalInfo>('create', { agentId: session, request }).then((result) => {
      if (!result.ok) {
        this.patchState({ error: result.error.message })
        return
      }
      this.upsert(result.value)
      this.activate(result.value.id)
    })
  }

  /**
   * Close one terminal (idempotent host verb) and stop rendering it first.
   * @param id - terminal to close.
   */
  close(id: WebTerminalId): void {
    const { session, activeId } = this.state.getSnapshot()
    if (session === undefined) return
    if (activeId === id) {
      this.followAbort?.abort()
      this.followAbort = undefined
      this.attachment = undefined
      this.patchState({ attached: false, inputOwned: false })
    }
    void this.call('close', { agentId: session, id }).then((result) => {
      if (!result.ok) this.patchState({ error: result.error.message })
      const bound = this.state.getSnapshot().session
      if (bound !== undefined) void this.loadList(bound)
    })
  }

  /**
   * Rename one terminal after trimming; the host validates the same bounds.
   * @param id - terminal to rename.
   * @param title - requested display title.
   */
  rename(id: WebTerminalId, title: string): void {
    const trimmed = title.trim()
    if (trimmed === '' || trimmed.length > TITLE_MAX) return
    const { session } = this.state.getSnapshot()
    if (session === undefined) return
    void this.call<WebTerminalInfo>('rename', { agentId: session, id, title: trimmed }).then((result) => {
      if (!result.ok) {
        this.patchState({ error: result.error.message })
        return
      }
      this.upsert(result.value)
    })
  }

  /**
   * Deliver raw input to the active terminal; ignored unless this client
   * holds the exclusive input attachment.
   * @param data - input text, including control characters.
   */
  write(data: string): void {
    const { session, activeId, inputOwned } = this.state.getSnapshot()
    const attachment = this.attachment
    if (session === undefined || activeId === undefined || !inputOwned || attachment === undefined) return
    void this.call('write', { agentId: session, id: activeId, attachmentId: attachment.attachmentId, data })
      .then((result) => {
        if (result.ok) return
        if (result.error.code === 'terminal-control-unavailable') {
          this.patchState({ inputOwned: false })
          return
        }
        this.patchState({ error: result.error.message })
      })
  }

  /**
   * Record the container's fitted dimensions and push them to the PTY when
   * this client controls the terminal.
   * @param cols - fitted column count.
   * @param rows - fitted row count.
   */
  resize(cols: number, rows: number): void {
    this.fitDims = { cols, rows }
    this.pushResize()
  }

  /**
   * Take (back) the input attachment by re-opening the follow stream with a
   * fresh attachment id — also the manual recovery after a broken stream.
   */
  takeInput(): void {
    const { activeId } = this.state.getSnapshot()
    if (activeId === undefined) return
    this.attach(activeId, true)
  }

  /**
   * Register (or release) the xterm.js surface. Registering re-attaches with
   * a fresh snapshot; releasing detaches so other windows may take input.
   * @param surface - frame sink, or undefined when the view unmounts.
   */
  bindSurface(surface: TerminalSurface | undefined): void {
    this.surface = surface
    if (surface === undefined) {
      this.followAbort?.abort()
      this.followAbort = undefined
      this.attachment = undefined
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

  /** Load one session's list plus its best-effort environment and shells. */
  private async loadSession(sessionId: SessionId): Promise<void> {
    void this.call<TerminalEnvironment>('environment', { agentId: sessionId }).then((result) => {
      if (result.ok) this.patchState({ environment: result.value })
    })
    void this.call<TerminalShell[]>('shells', { agentId: sessionId }).then((result) => {
      if (result.ok) this.patchState({ shells: result.value })
    })
    await this.loadList(sessionId)
    if (this.state.getSnapshot().session === sessionId) this.patchState({ ready: true })
  }

  /** Fetch the terminal list, repair the active selection, and sync holds. */
  private async loadList(sessionId: SessionId): Promise<void> {
    const result = await this.call<WebTerminalInfo[]>('list', { sessionId })
    if (this.state.getSnapshot().session !== sessionId || this.disposed) return
    if (!result.ok) {
      this.patchState({ error: result.error.message })
      return
    }
    this.patchState({ terminals: [...result.value] })
    const { activeId } = this.state.getSnapshot()
    const stillListed = activeId !== undefined && result.value.some(info => info.id === activeId)
    if (!stillListed) this.activate(undefined)
    this.syncHolds()
  }

  /**
   * Open the follow stream for one terminal with a fresh attachment.
   * @param id - terminal to follow.
   * @param fresh - true for an explicit user-initiated attach: clears stale
   * banners and restarts the reattach ladder (ladder retries stay unreset so
   * the bounded recovery still exhausts).
   */
  private attach(id: WebTerminalId, fresh = false): void {
    if (this.reattachTimer !== undefined) {
      clearTimeout(this.reattachTimer)
      this.reattachTimer = undefined
    }
    const { session } = this.state.getSnapshot()
    if (session === undefined || this.disposed) return
    this.followAbort?.abort()
    const controller = new AbortController()
    this.followAbort = controller
    const attachmentId = mintId('att') as TerminalAttachmentId
    this.attachment = { id, attachmentId }
    this.lastSequence = -1
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

  /** Consume one follow stream until it detaches, fails, or is superseded. */
  private async pump(
    session: SessionId,
    id: WebTerminalId,
    attachmentId: TerminalAttachmentId,
    controller: AbortController,
  ): Promise<void> {
    try {
      const stream = this.deps.events.terminal({ sessionId: session, id, attachmentId }, controller.signal)
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
   * @returns false when the stream must stop (terminal gone or reattaching).
   */
  private onFrame(attachmentId: TerminalAttachmentId, frame: TerminalStreamFrame): boolean {
    if (frame.type === 'snapshot') {
      this.lastSequence = frame.sequence
      this.surface?.reset(frame.screen)
      this.upsert(frame.info)
      this.patchState({
        attached: true,
        inputOwned: frame.info.controllerId === attachmentId,
        reattaching: false,
        reattachFailed: false,
        error: undefined,
      })
      this.reattachAttempts = 0
      this.pushResize()
      return true
    }
    if (frame.type === 'output') {
      if (frame.sequence !== this.lastSequence + 1) {
        this.scheduleReattach(this.attachment?.id)
        return false
      }
      this.lastSequence = frame.sequence
      this.surface?.write(frame.data)
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

  /** Classify one stream failure: gone terminal, slow follower, or hard error. */
  private onStreamError(code: string, message: string): void {
    if (code === 'terminal-unavailable') {
      this.patchState({ attached: false, inputOwned: false })
      this.refresh()
      return
    }
    if (message.includes(BUFFER_EXCEEDED)) {
      this.scheduleReattach(this.attachment?.id)
      return
    }
    this.patchState({ error: message, attached: false, inputOwned: false })
  }

  /**
   * Schedule the bounded slow-follower recovery: re-attach with a fresh
   * attachment id after each backoff rung; exhaustion surfaces a banner.
   */
  private scheduleReattach(id: WebTerminalId | undefined): void {
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

  /** Send the fitted dimensions when they differ from the terminal's. */
  private pushResize(): void {
    const { session, activeId, inputOwned } = this.state.getSnapshot()
    const attachment = this.attachment
    if (session === undefined || activeId === undefined || attachment === undefined || !inputOwned) return
    const info = this.state.getSnapshot().terminals.find(entry => entry.id === activeId)
    // loadList repairs the active selection against the list before any
    // frame can push dimensions, so the info is always found here.
    /* v8 ignore next -- unreachable through the public verbs */
    if (info === undefined) return
    const cols = this.clampCols(this.fitDims.cols)
    const rows = this.clampRows(this.fitDims.rows)
    if (info.cols === cols && info.rows === rows) return
    void this.call('resize', {
      agentId: session,
      id: activeId,
      attachmentId: attachment.attachmentId,
      cols,
      rows,
    }).then((result) => {
      if (result.ok || result.error.code !== 'terminal-control-unavailable') return
      this.patchState({ inputOwned: false })
    })
  }

  /** Clamp columns into the host-validated range. */
  private clampCols(cols: number): number {
    const max = this.state.getSnapshot().environment?.maxCols ?? DEFAULT_MAX_COLS
    return Math.min(Math.max(Math.trunc(cols), 2), max)
  }

  /** Clamp rows into the host-validated range. */
  private clampRows(rows: number): number {
    const max = this.state.getSnapshot().environment?.maxRows ?? DEFAULT_MAX_ROWS
    return Math.min(Math.max(Math.trunc(rows), 1), max)
  }

  /** Open holds for every listed running terminal; drop the stale ones. */
  private syncHolds(): void {
    const { session, terminals } = this.state.getSnapshot()
    // Every caller runs right after a session-bound list or upsert; no public
    // verb reaches here with the session cleared.
    /* v8 ignore next 4 -- unreachable through the public verbs */
    if (session === undefined) {
      for (const controller of this.holds.values()) controller.abort()
      this.holds.clear()
      return
    }
    const wanted = new Set(terminals.filter(info => info.state === 'running').map(info => info.id))
    for (const [id, controller] of this.holds) {
      if (wanted.has(id)) continue
      controller.abort()
      this.holds.delete(id)
    }
    for (const id of wanted) {
      if (!this.holds.has(id)) void this.openHold(session, id)
    }
  }

  /** Consume one window-hold stream for its open lifetime. */
  private async openHold(session: SessionId, id: WebTerminalId): Promise<void> {
    const controller = new AbortController()
    this.holds.set(id, controller)
    try {
      const stream = this.deps.events.hold({ sessionId: session, id }, controller.signal)
      for await (const frame of stream) {
        const payload: HoldStreamFrame = frame.payload
        if (payload.type === 'stream/error') {
          this.holds.delete(id)
          this.refresh()
          return
        }
        // 'retained': the host exposes no further retention state to render.
      }
      this.holds.delete(id)
    } catch {
      this.holds.delete(id)
    }
  }

  /** Upsert one terminal info into the list and refresh holds. */
  private upsert(info: WebTerminalInfo): void {
    const { terminals } = this.state.getSnapshot()
    const index = terminals.findIndex(entry => entry.id === info.id)
    this.patchState({
      terminals: index < 0
        ? [...terminals, info]
        : terminals.map((entry, position) => position === index ? info : entry),
    })
    this.syncHolds()
  }

  /** Call one terminal Remote verb through the shared `/api` channel. */
  private async call<T>(method: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
    const result = await this.deps.rpc.call(API_CHANNEL, `${TERMINAL_PREFIX}${method}`, { args })
    return result as RpcResult<T>
  }

  /** Apply one partial state update. */
  private patchState(patch: Partial<TerminalPanelState>): void {
    this.state.update((draft) => { Object.assign(draft, patch) })
  }

  /** Abort every stream and timer without touching the published list. */
  private clearStreamState(): void {
    this.followAbort?.abort()
    this.followAbort = undefined
    this.attachment = undefined
    if (this.reattachTimer !== undefined) {
      clearTimeout(this.reattachTimer)
      this.reattachTimer = undefined
    }
    for (const controller of this.holds.values()) controller.abort()
    this.holds.clear()
    this.reattachAttempts = 0
  }
}
