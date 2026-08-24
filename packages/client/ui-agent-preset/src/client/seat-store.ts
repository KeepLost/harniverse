/**
 * Hero-chip controller: which preset the NEXT session gets.
 *
 * A pick creates a new Session with that immutable Profile. It is staged until
 * the created Session becomes current, so the chip can bridge asynchronous
 * Workspace connection without mutating an existing Session.
 *
 * The stage is forgotten once applied: the next new session starts from the
 * deployment default again, matching the workspace picker beside it.
 */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SessionId, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import { messageOf, presetOptions } from './settings-store.ts'
import type { AgentPresetOption } from './settings-store.ts'

/** Hero-chip snapshot. */
export interface AgentPresetSeatState {
  /** Presets the deployment supplies; empty means the chip renders nothing. */
  options: readonly AgentPresetOption[]
  /** The staged choice, empty until the roster loads. */
  current: string
  /** A rejected apply's message, cleared by the next attempt. */
  error: string | null
  busy: boolean
  /**
   * One-shot cue that the chip should introduce itself (the creator-draft
   * entry staged the pick from another screen, so the user never touched the
   * chip); the renderer clears it via `introduced()` once played.
   */
  introduce: boolean
}

const INITIAL: AgentPresetSeatState = {
  options: [], current: '', error: null, busy: false, introduce: false,
}

/** One session's identity and whether it has started. */
export interface SeatSessionSummary {
  /** The session the chip would apply its staged choice to. */
  id: SessionId
  /** Whether the Session has started a turn. */
  blank: boolean
  /** The immutable Agent Profile the Session runs. */
  agentProfile?: string
}

/** Stages the next session's preset and applies it when one appears. */
export class AgentPresetSeatController {
  /** Chip snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSeatState> = createSnapshotStore(INITIAL)

  /**
   * The deployment default, so a consumed stage can fall back to it without
   * re-reading the roster.
   */
  private fallback = ''

  /** Set while a pick is waiting for a session; cleared once applied. */
  private staged: string | undefined

  constructor(
    private readonly api: Pick<IApiClient, 'agentPresets'>,
    /** The session the hero is about to hand over to, when there is one. */
    private readonly currentSession: () => SeatSessionSummary | undefined,
    /** Start a distinct Session using the selected immutable Profile. */
    private readonly startSession: ((agentProfile: string) => void) | undefined,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  private set(patch: Partial<AgentPresetSeatState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /** Clear prior-principal roster and staged Profile selection synchronously. */
  reset(): void {
    this.fallback = ''
    this.staged = undefined
    this.store.set(INITIAL)
  }

  /**
   * Read the roster and open the chip on the deployment default.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const fence = this.describeFace.writeFence()
    try {
      const response = await this.api.agentPresets.list({})
      if (!this.describeFace.acceptResponse(response, fence)) return
      if (!response.result.ok) {
        this.set({ error: response.result.error.message })
        return
      }
      const { presets } = response.result.value
      this.fallback = presets.find(preset => preset.isDefault)?.id ?? presets[0]?.id ?? ''
      this.set({
        options: presetOptions(presets),
        // Staged pick first, then the composition the current session
        // already carries, then the deployment default. The middle term is
        // what keeps a late-landing load from regressing the display after
        // an applied stage was consumed — the chip mounts (and loads) only
        // once the flow's session is current, so the reply can arrive after
        // apply() already composed it.
        current: this.staged ?? this.currentSession()?.agentProfile ?? this.fallback,
        error: null,
      })
    } catch (error) {
      if (!this.describeFace.isCurrent(fence)) return
      this.set({ error: messageOf(error) })
    }
  }

  /**
   * Stage one Profile and create a distinct Session for it.
   * @param id - the preset to stage.
   * @returns once the stage settled, and the apply too when one happened.
   */
  select(id: string): Promise<void> {
    if (this.store.getSnapshot().busy) return Promise.resolve()
    this.stage(id)
    this.set({ busy: true })
    this.startSession?.(id)
    return Promise.resolve()
  }

  /**
   * Stage a pick WITHOUT the immediate apply, for a flow that starts the
   * receiving session after the pick (the settings section's creator entry).
   * `select()`'s immediate apply would meet the still-current running session
   * and drop the stage as unservable; staging alone leaves it for the
   * list-change applier, which fires when the started session becomes
   * current.
   * @param id - the preset to stage.
   * @param introduce - true when the stage came from another screen and the
   * chip should announce itself on the session it lands on.
   */
  stage(id: string, introduce = false): void {
    this.staged = id
    this.set({ current: id, error: null, introduce })
  }

  /** Acknowledge the introduction cue once the chip has played it. */
  introduced(): void {
    if (!this.store.getSnapshot().introduce) return
    this.set({ introduce: false })
  }

  /**
   * Consume the staged choice once its newly created Session becomes current.
   *
   * Called both by `select()` and by whoever observes the current session
   * changing, because the session may appear either before or after the pick.
   * @returns once reconciliation settles, or immediately when there is nothing to do.
   */
  apply(): Promise<void> {
    const staged = this.staged
    const session = this.currentSession()
    if (staged === undefined || session === undefined) return Promise.resolve()
    if (session.agentProfile === staged) {
      this.staged = undefined
      this.set({ busy: false, current: staged })
      return Promise.resolve()
    }
    return Promise.resolve()
  }
}
