/**
 * Long-lived connection ledger. The browser's per-origin HTTP/1.1 pool holds
 * roughly six connections (shared across tabs), so every long-lived stream —
 * WebSocket downlink or hanging SSE GET — spends a slot all unrelated requests
 * then queue behind. The counts make that budget observable: a page whose
 * entity streams multiplex correctly holds a constant, small number, and the
 * warn-once line turns a new per-entity fan-out into a loud regression signal.
 */

export interface ConnectionBudgetSnapshot {
  readonly websockets: number
  readonly serverSentEvents: number
}

/** The per-origin ceiling the ledger treats as its line (browsers' HTTP/1.1 pool). */
const LONG_LIVED_LIMIT = 6

const state = { websockets: 0, serverSentEvents: 0, warned: false }

function consider(): void {
  const total = state.websockets + state.serverSentEvents
  if (state.warned || total <= LONG_LIVED_LIMIT) return
  state.warned = true
  console.warn(
    `[client-connection] ${String(total)} concurrent long-lived connections exceed the browser per-origin budget of ${String(LONG_LIVED_LIMIT)}:`
    + ' unrelated requests will queue behind them. Per-entity streams must multiplex onto the events.streams downlink.',
  )
}

/** Count one WebSocket downlink opening. */
export function noteWebSocketOpen(): void {
  state.websockets += 1
  consider()
}

/** Count one WebSocket downlink closing. */
export function noteWebSocketClose(): void {
  state.websockets = Math.max(0, state.websockets - 1)
}

/** Count one long-lived SSE stream opening (the network carrier expects zero). */
export function noteSseOpen(): void {
  state.serverSentEvents += 1
  consider()
}

/** Count one long-lived SSE stream closing. */
export function noteSseClose(): void {
  state.serverSentEvents = Math.max(0, state.serverSentEvents - 1)
}

/** Current long-lived connection counts, for tests and diagnostics.
 * @returns the live WebSocket and SSE stream totals.
 */
export function connectionBudgetSnapshot(): ConnectionBudgetSnapshot {
  return { websockets: state.websockets, serverSentEvents: state.serverSentEvents }
}
