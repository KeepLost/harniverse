// @vitest-environment jsdom
/** Live context derivation and its ContextStrip band under the Trajectory ledger. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import { deriveRequestContext } from '../src/client/request-context.ts'
import { ContextStrip, type ContextStripSegment } from '../src/client/ContextStrip.tsx'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import type { TrajectoryTurnModel } from '../src/client/layout.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function node(partial: Record<string, unknown>): ConversationNode {
  return partial as ConversationNode
}

describe('deriveRequestContext', () => {
  const NODES: readonly ConversationNode[] = [
    node({ kind: 'user', seq: 1 }),
    node({ kind: 'assistant', seq: 2 }),
    node({ kind: 'command', seq: 3, commandId: 'c1' }),
    node({ kind: 'user', seq: 4 }),
    node({
      kind: 'compaction', seq: 5, summary: 'summarized',
      summaryEventSeq: 5, shadowedItemCount: 3, shadowedTokenCount: 900,
    }),
    node({ kind: 'user', seq: 6 }),
    node({ kind: 'tool-result', seq: 7 }),
    node({ kind: 'steering', seq: 8 }),
    node({ kind: 'context', seq: 9 }),
    node({ kind: 'model-retry', seq: 10 }),
    node({ kind: 'turn-error', seq: 11 }),
  ]

  it('keeps only surface nodes before the anchor', () => {
    expect(deriveRequestContext(NODES, 7)).toEqual([
      { kind: 'summary', seq: 5, role: 'compaction', shadowedItemCount: 3, shadowedTokenCount: 900 },
      { kind: 'message', seq: 6, role: 'user' },
    ])
  })

  it('absorbs pre-summary items into the landed compaction segment', () => {
    expect(deriveRequestContext(NODES, 6)).toEqual([
      { kind: 'summary', seq: 5, role: 'compaction', shadowedItemCount: 3, shadowedTokenCount: 900 },
    ])
  })

  it('maps steering and context injections onto the visible surface', () => {
    expect(deriveRequestContext(NODES, 10)).toEqual([
      { kind: 'summary', seq: 5, role: 'compaction', shadowedItemCount: 3, shadowedTokenCount: 900 },
      { kind: 'message', seq: 6, role: 'user' },
      { kind: 'message', seq: 7, role: 'tool' },
      { kind: 'message', seq: 8, role: 'user' },
      { kind: 'message', seq: 9, role: 'context' },
    ])
  })

  it('treats an absent anchor as the streaming frontier', () => {
    const segments = deriveRequestContext(NODES, undefined)
    expect(segments).toHaveLength(5)
    expect(segments[0]).toEqual({
      kind: 'summary', seq: 5, role: 'compaction', shadowedItemCount: 3, shadowedTokenCount: 900,
    })
  })

  it('omits unknown shadow counts when the summary event fell out of the window', () => {
    const nodes: readonly ConversationNode[] = [
      node({ kind: 'user', seq: 1 }),
      node({
        kind: 'compaction', seq: 2, summary: null,
        summaryEventSeq: null, shadowedItemCount: null, shadowedTokenCount: null,
      }),
    ]
    expect(deriveRequestContext(nodes, 3)).toEqual([
      { kind: 'summary', seq: 2, role: 'compaction' },
    ])
  })
})

describe('ContextStrip', () => {
  const SEGMENTS = [
    { kind: 'summary' as const, seq: 5, role: 'compaction', shadowedItemCount: 3 },
    { kind: 'message' as const, seq: 6, role: 'user' },
  ]
  const DESCRIBE = (segment: ContextStripSegment): string =>
    segment.kind === 'summary' ? `summary #${segment.seq}` : `message #${segment.seq}`

  it('stamps each block with its surface role for role-coded styling', () => {
    render(<ContextStrip
      segments={SEGMENTS} onLocate={() => {}} title="Current context" empty="No live context" describe={DESCRIBE}
    />)
    const blocks = screen.getAllByRole('button')
    expect(blocks[0]?.getAttribute('data-role')).toBe('summary')
    expect(blocks[1]?.getAttribute('data-role')).toBe('user')
  })

  it('renders one block per segment and reports clicks by seq', () => {
    const onLocate = vi.fn()
    render(<ContextStrip
      segments={SEGMENTS}
      onLocate={onLocate}
      title="Current context"
      empty="No live context"
      describe={DESCRIBE}
    />)
    const blocks = screen.getAllByRole('button')
    expect(blocks).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'summary #5' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'message #6' }))
    expect(onLocate).toHaveBeenCalledWith(6)
  })

  it('renders an empty band with the caption for an empty context', () => {
    render(<ContextStrip
      segments={[]} onLocate={() => {}} title="Current context" empty="No live context" describe={DESCRIBE}
    />)
    expect(screen.getByText('No live context')).toBeTruthy()
    expect(screen.getByTestId('context-strip')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

describe('TrajectoryTable inspectSeq handoff', () => {
  const FOLD_PROPS = {
    collapsedTurns: new Set<number>(),
    onToggleTurn: () => {},
    collapsedAssistants: new Set<string>(),
    onToggleAssistant: () => {},
  }

  it('opens and scrolls to the record owning the requested seq', async () => {
    const TURNS: readonly TrajectoryTurnModel[] = [{
      turn: 1,
      groups: [{
        title: 'Step 1',
        cells: [{ index: 1, kind: 'message', sourceSeq: 7, text: 'target row', timeSeconds: 0.1 }],
      }],
    }]
    const applied = vi.fn()
    render(<TrajectoryTable turns={TURNS} inspectSeq={7} onInspectApplied={applied} {...FOLD_PROPS} />)
    await waitFor(() => {
      expect(screen.getAllByText('target row').length).toBeGreaterThanOrEqual(2)
    })
    expect(applied).toHaveBeenCalled()
  })
})
