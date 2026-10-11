/**
 * Model-profile hero-chip controller: which Model Profile the NEXT session
 * runs under.
 *
 * A Model Profile is mutable per session, so the chip's pick applies live to
 * the current blank session (`session.selectModelProfile`) instead of minting
 * a new one — the one thing that separates it from the agent-preset chip
 * beside it. When no session is current at all, the pick stages and starts a
 * distinct session carrying the profile, and reconciliation finishes the job
 * if that flow reused a blank session born under a different profile.
 */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One roster row the chip offers. */
export interface ModelProfileOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly unrestricted: boolean
}

/** Hero-chip snapshot. */
export interface ModelProfileSeatState {
  /** Profiles the host serves; the built-in unrestricted always leads. */
  options: readonly ModelProfileOption[]
  /** The choice the next session gets, empty until the roster loads. */
  current: string
  /** A rejected apply's message, cleared by the next attempt. */
  error: string | null
  busy: boolean
}

const INITIAL: ModelProfileSeatState = { options: [], current: '', error: null, busy: false }

/** One session's identity and start state, as the chip needs them. */
export interface SeatSessionSummary {
  /** The session the hero would hand over to. */
  id: SessionId
  /** Whether the session has started a turn. */
  blank: boolean
}

/** Stages and applies the next session's Model Profile. */
export class ModelProfileSeatController {
  /** Chip snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<ModelProfileSeatState> = createSnapshotStore(INITIAL)

  /** The deployment default, so a consumed stage can fall back without a re-read. */
  private fallback = ''

  /** Set while a pick is waiting for its session; cleared once applied. */
  private staged: string | undefined

  /** Profile id of the current session, when the host answered; undefined while unknown. */
  private sessionProfile: string | undefined

  /** The session whose profile `sessionProfile` describes. */
  private trackedSession: SessionId | undefined

  /** Latest operation wins; an older response never overwrites a newer one. */
  private generation = 0

  constructor(
    private readonly api: Pick<IApiClient, 'llm' | 'sessions'>,
    /** The session the hero is about to hand over to, when there is one. */
    private readonly currentSession: () => SeatSessionSummary | undefined,
    /** Start a distinct Session carrying the selected Model Profile. */
    private readonly startSession: (modelProfile: string) => void,
  ) {}

  private set(patch: Partial<ModelProfileSeatState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /** Clear roster, staged pick, and session facts synchronously. */
  reset(): void {
    this.generation += 1
    this.fallback = ''
    this.staged = undefined
    this.sessionProfile = undefined
    this.trackedSession = undefined
    this.store.set(INITIAL)
  }

  /** The display choice: a pending stage, then the session's own profile, then the default. */
  private syncDisplay(): void {
    this.set({ current: this.staged ?? this.sessionProfile ?? this.fallback })
  }

  /**
   * Read the roster and the default profile id.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    try {
      const { result } = await this.api.llm.modelProfiles({})
      if (generation !== this.generation) return
      if (!result.ok) {
        this.set({ error: result.error.message })
        return
      }
      this.fallback = result.value.defaultProfileId
      this.set({ options: result.value.profiles, error: null })
      this.syncDisplay()
    } catch (error: unknown) {
      if (generation !== this.generation) return
      this.set({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Re-read the current session's profile when the session itself moved. The
   * chip's own applies update the fact directly, so this only crosses the
   * wire for a session it has not tracked yet.
   * @returns once the tracked profile reflects the host, when it re-read.
   */
  async refreshSession(): Promise<void> {
    const session = this.currentSession()
    if (session === undefined) {
      this.sessionProfile = undefined
      this.trackedSession = undefined
      this.syncDisplay()
      return
    }
    if (this.trackedSession === session.id) return
    this.trackedSession = session.id
    const generation = ++this.generation
    try {
      const { result } = await this.api.sessions.models({ sessionId: session.id })
      if (generation !== this.generation) return
      this.sessionProfile = result.ok ? result.value.profile?.id : undefined
      this.syncDisplay()
    } catch {
      // The profile display falls back to the deployment default; the pick
      // surface stays usable and the next session move retries the read.
      if (generation !== this.generation) return
      this.sessionProfile = undefined
      this.syncDisplay()
    }
  }

  /**
   * Stage one profile and apply it: live on the current blank session, or by
   * starting a distinct session when none is current.
   * @param id - the profile to stage.
   */
  select(id: string): void {
    if (this.store.getSnapshot().busy) return
    this.staged = id
    this.set({ current: id, error: null })
    const session = this.currentSession()
    if (session === undefined) {
      this.startSession(id)
      return
    }
    // A started session keeps its profile; the chip only rewrites a blank one.
    if (!session.blank) return
    void this.applyStaged(id, session)
  }

  /**
   * Consume the staged choice: reconcile it against the session it landed
   * on, switching the profile live when the session was born or reused under
   * a different one. Called by whoever observes the current session changing.
   * @returns once reconciliation settles.
   */
  async apply(): Promise<void> {
    const staged = this.staged
    if (staged === undefined) return
    const session = this.currentSession()
    if (session === undefined) return
    if (!session.blank) {
      // The session moved on before the stage could serve it; a retroactive
      // switch would surprise a running conversation, so the stage dies.
      this.staged = undefined
      this.set({ busy: false })
      this.syncDisplay()
      return
    }
    if (this.sessionProfile === staged) {
      this.staged = undefined
      this.set({ busy: false, current: staged })
      return
    }
    await this.applyStaged(staged, session)
  }

  private async applyStaged(staged: string, session: SeatSessionSummary): Promise<void> {
    this.set({ busy: true })
    try {
      const call = this.api.sessions.selectModelProfile?.({ sessionId: session.id, profileId: staged })
      if (call === undefined) throw new Error('session.selectModelProfile is unavailable')
      const { result } = await call
      if (!result.ok) {
        this.staged = undefined
        this.set({ busy: false, error: `${result.error.code}: ${result.error.message}` })
        this.syncDisplay()
        return
      }
      this.staged = undefined
      this.sessionProfile = staged
      this.trackedSession = session.id
      this.set({ busy: false, current: staged, error: null })
    } catch (error: unknown) {
      this.staged = undefined
      this.set({ busy: false, error: error instanceof Error ? error.message : String(error) })
      this.syncDisplay()
    }
  }
}
