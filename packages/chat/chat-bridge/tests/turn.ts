/** Drive a chat-started turn through the fake mux. */

import type { Harness } from './helpers.ts'

/** An open turn and the means to feed it events. */
export interface Turn {
  mux: ReturnType<Harness['client']['mux']>
  sessionId: string
  seq: number
  next(type: string, data?: Record<string, unknown>): Promise<void>
}

/** Prompt as `userId` and claim the prompt into turn 1, leaving the turn open. */
export async function begin(h: Harness, userId = '200', text = 'question'): Promise<Turn> {
  await h.say(userId, text)
  const sessionId = String(h.client.of('session.create').at(-1)?.payload.sessionId)
  const rpcId = String(h.client.of('session.prompt').at(-1)?.options.rpcId)
  const mux = h.client.mux(h.client.of('session.create').at(-1)?.options.remoteHost)
  const turn: Turn = {
    mux, sessionId, seq: 0,
    next: (type, data = {}) => mux.event(sessionId, turn.seq++, type, data),
  }
  await turn.next('turn/start', { turn: 1 })
  await turn.next('user/message', { id: 'inbox-1', source: { kind: 'user', rpcId } })
  return turn
}

export const delta = (text: string): Record<string, unknown> => ({ turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } })

export async function finish(turn: Turn, reason: Record<string, unknown> = { kind: 'completed' }): Promise<void> {
  await turn.next('turn/end', { turn: 1, reason })
}
