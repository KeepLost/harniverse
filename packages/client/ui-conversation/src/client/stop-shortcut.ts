/** Fixed Escape routing into the current Conversation turn's scoped cancellation. */
import type { ISessions, SessionBinding, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { StopSequence } from './stop-sequence.ts'

/**
 * Maximum time between the two independent Escape presses. Upstream derives
 * this from the shortcuts plugin's validated Config; this port owns a fixed
 * window by decision (no configurable shortcut registry).
 */
const STOP_SEQUENCE_MS = 500

/**
 * Dialogs and menus that own foreground keyboard input while open. Same
 * marker contract as upstream's modal layer: aria-modal dialogs plus open
 * menus, whatever their owning plugin.
 */
const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="menu"]'

/**
 * Read the latest still-open turn off a Session binding's chat timeline.
 * @param binding - live Session binding.
 * @returns the turn number when its start is loaded and it remains open, otherwise undefined.
 */
function openTurnOf(binding: SessionBinding): number | undefined {
  const timeline = binding.session.getSnapshot().chat.timeline
  const latest = timeline.turnOrder.at(-1)
  const turn = latest === undefined ? undefined : timeline.turns.get(latest)
  return turn?.status === 'open' && turn.start !== undefined ? turn.turn : undefined
}

/**
 * Subscribe fixed input to the same Session cancellation used by the stop button.
 *
 * One window keydown listener in the capture phase owns the whole eligibility
 * chain (upstream routes the same predicate through its shortcuts service):
 * a bare, non-repeated, non-composing Escape that no earlier handler consumed,
 * with no modal or menu open, addressed to an element of one Conversation
 * occurrence (the terminal's xterm surface, iframes, approval takeovers, and
 * inert subtrees never arm the sequence), while the occurrence's Session runs
 * a live, still-open turn and holds no pending interaction.
 *
 * @param sessions - live Session identities and lifecycle sources.
 * @param cancel - scoped stop operation that preserves Queue and reports failures.
 * @returns disposer releasing the input subscription, pending watches and expiry timer.
 */
export function installStopShortcut(sessions: ISessions, cancel: (sessionId: SessionId) => void): () => void {
  let unwatch = (): void => {}
  const sequence = new StopSequence(STOP_SEQUENCE_MS, () => {
    unwatch()
    unwatch = () => {}
  })
  const reset = (): void => { sequence.reset() }
  const keydown = (event: KeyboardEvent): void => {
    // Any key that is not an eligible bare Escape clears the pending press.
    // oxlint-disable-next-line typescript/no-deprecated -- keyCode 229 covers engines without isComposing.
    if (event.code !== 'Escape' || event.repeat || event.isComposing || event.keyCode === 229
      || event.defaultPrevented || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
      || document.querySelector(MODAL_SELECTOR) !== null) { reset(); return }
    const target = event.target
    if (!(target instanceof Element)) { reset(); return }
    const occurrence = target.closest<HTMLElement>('[data-conversation-session]')
    const region = target.closest('[data-conversation-region]')
    if (occurrence === null || region === null || !occurrence.contains(region)
      || target.closest('[data-approval-key], iframe, .xterm, [inert]') !== null) { reset(); return }
    const sessionId = occurrence.dataset.conversationSession as SessionId
    const binding = sessions.binding(sessionId)
    if (binding === undefined) { reset(); return }
    // The cancellation target must stay a running turn of this same binding:
    // a turn end, a pending approval/question takeover, a subagent whose
    // parent owns the stop, or a removed Session all disarm the press.
    const currentTurn = (): number | undefined => {
      const session = binding.session.getSnapshot()
      if (!session.running || session.removed
        || (session.subagent !== null && session.subagent.address.mode !== 'continuable')
        || session.pending.length > 0) return undefined
      return openTurnOf(binding)
    }
    const turn = currentTurn()
    if (turn === undefined) { reset(); return }
    event.preventDefault()
    const stopped = sequence.press({ sessionId, turn, generation: binding, region, cancel: () => { cancel(sessionId) } })
    if (stopped) return
    const changed = (): void => {
      if (sessions.binding(sessionId) !== binding || currentTurn() !== turn) reset()
    }
    const dispose = binding.session.subscribe(changed)
    unwatch = () => { dispose() }
  }
  window.addEventListener('keydown', keydown, true)
  return () => {
    window.removeEventListener('keydown', keydown, true)
    reset()
  }
}
