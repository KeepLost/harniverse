/** Welcome-notice state derived from its shared settings namespace scope. */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION,
} from '../onboarding-copy.ts'

/** State rendered by the welcome step. */
export interface WelcomeNoticeState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  acknowledged: boolean
  error: string | null
}

/** Welcome settings section accepted by the notice. */
export type WelcomeSection = Record<string, unknown>

/**
 * Decode malformed durable values as an empty section so acknowledgement is false.
 * @param section - settings namespace value.
 * @returns an object section.
 */
export function decodeWelcomeSection(section: unknown): WelcomeSection {
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    ? section as WelcomeSection
    : {}
}

/** Coordinates acknowledgement through the shared namespace scope. */
export class WelcomeNoticeStore {
  /** uSES-safe state source shared by the registered welcome step. */
  readonly store: SnapshotStore<WelcomeNoticeState> = createSnapshotStore({
    status: 'idle', acknowledged: false, error: null,
  })

  private saving = false
  private generation = 0
  private following: (() => void) | undefined

  /** @param scope - shared welcome settings namespace scope. */
  constructor(private readonly scope: SettingsScope<WelcomeSection>) {}

  /**
   * Begin following the scope and publish its current answer.
   * @returns immediate settlement after derivation.
   */
  load(): Promise<void> {
    this.following ??= this.scope.subscribe(() => { this.derive() })
    this.derive()
    return Promise.resolve()
  }

  /**
   * Persist this copy version through the scope.
   * @returns whether the shared view confirms acknowledgement.
   */
  async acknowledge(): Promise<boolean> {
    const generation = this.generation
    this.saving = true
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    try {
      await this.scope.set(WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION)
    } finally {
      if (generation === this.generation) this.saving = false
    }
    if (generation !== this.generation) return false
    this.derive()
    const { acknowledged } = this.store.getSnapshot()
    if (!acknowledged) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = 'the acknowledgement did not persist'
      })
    }
    return acknowledged
  }

  /** Stop following the shared scope. */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    const scope = this.scope.getSnapshot()
    if (this.saving && scope.status === 'ready') return
    if (this.saving) {
      this.saving = false
      this.generation += 1
    }
    if (scope.status === 'loading') {
      this.store.update((state) => {
        state.status = 'loading'
        state.acknowledged = false
        state.error = null
      })
      return
    }
    if (scope.status === 'unavailable') {
      this.store.update((state) => {
        state.status = 'error'
        state.acknowledged = false
        state.error = 'welcome acknowledgement settings are unavailable'
      })
      return
    }
    this.store.update((state) => {
      state.status = 'ready'
      state.acknowledged = scope.value?.[WELCOME_NOTICE_ACK_FIELD] === WELCOME_NOTICE_VERSION
      state.error = null
    })
  }
}
