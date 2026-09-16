// @vitest-environment jsdom
/** Request context derivation and its panel wiring in the trajectory ledger. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import { deriveRequestContext } from '../src/client/request-context.ts'
import { RequestContextPanel } from '../src/client/RequestContextPanel.tsx'
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

describe('RequestContextPanel', () => {
  it('renders one locating row per segment and reports clicks', () => {
    const onLocate = vi.fn()
    render(<RequestContextPanel
      segments={[
        { kind: 'summary', seq: 5, role: 'compaction', shadowedItemCount: 3, shadowedTokenCount: 900 },
        { kind: 'message', seq: 6, role: 'user' },
      ]}
      onLocate={onLocate}
    />)
    fireEvent.click(screen.getByTitle('Locate #5 in the trajectory'))
    expect(onLocate).toHaveBeenCalledWith(5)
    fireEvent.click(screen.getByTitle('Locate #6 in the trajectory'))
    expect(onLocate).toHaveBeenCalledWith(6)
    expect(screen.getByText('replaced 3 items (~900 tokens)')).toBeTruthy()
  })

  it('states an empty composition plainly', () => {
    render(<RequestContextPanel segments={[]} onLocate={() => {}} />)
    expect(screen.getByText('No context items before this request.')).toBeTruthy()
  })
})

describe('TrajectoryTable request context tab', () => {
  const FOLD_PROPS = {
    collapsedTurns: new Set<number>(),
    onToggleTurn: () => {},
    collapsedAssistants: new Set<string>(),
    onToggleAssistant: () => {},
  }

  const TURNS: readonly TrajectoryTurnModel[] = [{
    turn: 1,
    groups: [{
      title: 'Step 1',
      cells: [{
        index: 1,
        kind: 'message',
        sourceSeq: 3,
        text: 'after compaction',
        timeSeconds: 0.5,
      }],
    }],
  }]

  function renderTable(): void {
    render(<TrajectoryTable
      turns={TURNS}
      requestNumbers={[{
        seq: 4,
        turn: 1,
        step: 1,
        group: 'Step 1',
        number: 1,
      }]}
      contextNodes={[
        node({ kind: 'user', seq: 1 }),
        node({
          kind: 'compaction', seq: 2, summary: 'summarized',
          summaryEventSeq: 2, shadowedItemCount: 1, shadowedTokenCount: 10,
        }),
        node({ kind: 'user', seq: 3 }),
      ]}
      {...FOLD_PROPS}
    />)
  }

  it('derives the composition for the selected request and locates a segment row', () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    renderTable()

    fireEvent.click(screen.getByRole('button', { name: 'Request #1' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Context' }))

    const rows = screen.getAllByTitle(/Locate #/)
    expect(rows).toHaveLength(2)
    expect(screen.getByText('replaced 1 item (~10 tokens)')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Locate #3 in the trajectory'))
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }))
  })
})
