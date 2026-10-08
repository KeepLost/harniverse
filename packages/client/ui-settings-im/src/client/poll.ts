/**
 * Visibility-aware interval reader behind the section's snapshot poll.
 * @module @deepseek-ai/dsh-client-ui-settings-im/poll
 */

/**
 * Run a read now and then every interval while the page is visible; a hidden
 * page skips its ticks and reads again the moment it becomes visible.
 * @param run - the read; its outcome is the caller's concern.
 * @param intervalMs - tick spacing in milliseconds.
 * @returns the disposer that ends the polling.
 */
export function startPolling(run: () => void, intervalMs: number): () => void {
  const tick = (): void => {
    if (document.visibilityState !== 'hidden') run()
  }
  const timer = setInterval(tick, intervalMs)
  document.addEventListener('visibilitychange', tick)
  tick()
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', tick)
  }
}
