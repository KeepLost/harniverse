/**
 * Turn-boundary session projection: folds `turn/*` and `step/*` events into
 * the open-turn and last-boundary facts a scoped tool reads mid-turn.
 *
 * @module @deepseek-ai/dsh-agent-loop/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnBoundaryProjection } from './projection-types.ts'

// Zod's nullable object output includes readonly-irrelevant variance; the
// public interface is the authority, so the schema only validates wire shape.
const turnBoundarySchema = z.object({
  openTurnStartSeq: z.number().int().nonnegative().nullable(),
  lastStepStartSeq: z.number().int().nonnegative().nullable(),
  lastStepBoundary: z.object({
    kind: z.enum(['start', 'end']),
    seq: z.number().int().nonnegative(),
  }).strict().nullable(),
  lastTurn: z.number().int().nonnegative(),
}).strict() as unknown as z.ZodType<TurnBoundaryProjection>

/** Host projection of agent turn and step boundaries. */
export const turnBoundaryProjectionDefinition: ProjectionDefinition<'turnBoundary', TurnBoundaryProjection> = {
  key: 'turnBoundary',
  stateVersion: 1,
  schema: turnBoundarySchema,
  init: () => ({
    openTurnStartSeq: null,
    lastStepStartSeq: null,
    lastStepBoundary: null,
    lastTurn: 0,
  }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return {
          ...state,
          openTurnStartSeq: event.seq,
          lastTurn: event.data.turn,
        }
      case 'turn/end':
        return {
          ...state,
          openTurnStartSeq: null,
        }
      case 'step/start':
        return {
          ...state,
          lastStepStartSeq: event.seq,
          lastStepBoundary: { kind: 'start', seq: event.seq },
        }
      case 'step/end':
        return {
          ...state,
          lastStepBoundary: { kind: 'end', seq: event.seq },
        }
      default:
        return state
    }
  },
  view: state => state,
}
