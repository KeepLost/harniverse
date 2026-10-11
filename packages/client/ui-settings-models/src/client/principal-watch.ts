/**
 * The principal-change plumbing every settings page store installs: one
 * subscription to the shared authorized settings mirror, fenced against
 * mirror-internal churn, that resets the page and reloads whatever a live
 * page would want back. Both stores here reset on every principal change but
 * only reload when the page had already loaded something — an idle page stays
 * idle, because nothing it showed was invalidated.
 *
 * @module dsh-client-ui-settings-models/client/principal-watch
 */

import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'

/** What {@link watchPrincipal} needs from the owning page store. */
export interface PrincipalWatchOwner {
  /** Whether the page currently shows anything a principal change invalidates. */
  isLive: () => boolean
  /** Clears every settings-derived value. */
  reset: () => void
  /** Starts a fresh load. */
  reload: () => void
}

/**
 * Install the principal-change watch for a settings page store.
 * @param face - the shared authorized settings description.
 * @param owner - the reset and reload hooks of the owning store.
 * @returns the stop handle for the store's `dispose`.
 */
export function watchPrincipal(face: SettingsDescribeFace, owner: PrincipalWatchOwner): () => void {
  let fence = face.writeFence()
  let reloadAfterPrincipal = false
  return face.subscribe(() => {
    const next = face.writeFence()
    if (next === fence) return
    fence = next
    reloadAfterPrincipal ||= owner.isLive()
    owner.reset()
    if (!reloadAfterPrincipal || !face.isCurrent(next)) return
    reloadAfterPrincipal = false
    owner.reload()
  })
}

/** State shape every settings page shares on its load path. */
export interface PageErrorState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}

/**
 * Fold a failed page load into its state unless a newer load already landed.
 * @param live - whether the failed load is still the page's current one.
 * @param store - the page store to update.
 * @param error - the failure to name.
 */
export function staleLoadFailed(live: boolean, store: { update(fn: (s: PageErrorState) => void): void }, error: unknown): void {
  if (!live) return
  store.update((s) => {
    s.status = 'error'
    s.error = error instanceof Error ? error.message : String(error)
  })
}
