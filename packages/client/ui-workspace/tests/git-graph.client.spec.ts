import { describe, expect, it } from 'vitest'
import { layoutCommitGraph } from '../src/client/git-graph.ts'

/** Commit helper: 40-char hashes keep lanes distinguishable. */
function commit(hash: string, parents: string[]): { hash: string; parents: string[] } {
  return { hash, parents }
}

const H = (letter: string): string => letter.repeat(40)

describe('commit graph layout', () => {
  it('lays a linear chain onto one lane with straight connectors', () => {
    const layout = layoutCommitGraph([commit(H('a'), [H('b')]), commit(H('b'), [H('c')]), commit(H('c'), [])])
    expect(layout.laneCount).toBe(1)
    expect(layout.rows.map(row => row.lane)).toEqual([0, 0, 0])
    const head = layout.rows[0]!
    expect(head.edges).toEqual([{ from: 0, to: 0, half: 'lower', color: head.color }])
    const middle = layout.rows[1]!
    expect(middle.edges).toEqual([
      { from: 0, to: 0, half: 'upper', color: middle.color },
      { from: 0, to: 0, half: 'lower', color: middle.color },
    ])
    const root = layout.rows[2]!
    expect(root.edges).toEqual([{ from: 0, to: 0, half: 'upper', color: root.color }])
  })

  it('opens a lane beside the node for a merge and shifts pass-throughs', () => {
    // a (head) merges b and side; below the merge both lanes flow to base.
    const layout = layoutCommitGraph([
      commit(H('a'), [H('b'), H('s')]),
      commit(H('b'), [H('g')]),
      commit(H('s'), [H('g')]),
      commit(H('g'), []),
    ])
    expect(layout.laneCount).toBe(2)
    const head = layout.rows[0]!
    const first = layout.rows[1]!
    const side = layout.rows[2]!
    const base = layout.rows[3]!
    expect(head.lane).toBe(0)
    // The branch to the side parent opens lane 1 beside the node.
    const headLower = head.edges.filter(edge => edge.half === 'lower')
    expect(headLower).toHaveLength(2)
    expect(headLower.find(edge => edge.to === 0)?.from).toBe(0)
    expect(headLower.find(edge => edge.to === 1)?.from).toBe(0)
    // Row b keeps its node on lane 0 while lane 1 passes through.
    expect(first.lane).toBe(0)
    const firstThrough = first.edges.find(edge => edge.half === 'through')
    expect(firstThrough).toMatchObject({ from: 1, to: 1 })
    expect(side.lane).toBe(1)
    expect(side.edges.find(edge => edge.half === 'through')).toMatchObject({ from: 0, to: 0 })
    // Both lanes converge on the base node's lane.
    expect(base.lane).toBe(0)
    const baseUpper = base.edges.filter(edge => edge.half === 'upper')
    expect(baseUpper.map(edge => edge.from)).toEqual(expect.arrayContaining([0, 1]))
    expect(baseUpper.every(edge => edge.to === 0)).toBe(true)
  })

  it('reuses a lane already targeting an extra parent instead of opening one', () => {
    const layout = layoutCommitGraph([
      commit(H('m'), [H('x'), H('y')]),
      commit(H('y'), [H('z')]),
      commit(H('x'), [H('z')]),
      commit(H('z'), []),
    ])
    // y occupies lane 1 below the merge; z's row merges lanes 0 and 1.
    const mergeIntoZ = layout.rows[3]!
    expect(mergeIntoZ.lane).toBe(0)
    const upperIntoZ = mergeIntoZ.edges.filter(edge => edge.half === 'upper')
    expect(upperIntoZ.map(edge => edge.from)).toEqual(expect.arrayContaining([0, 1]))
    expect(upperIntoZ.every(edge => edge.to === 0)).toBe(true)
    expect(layout.laneCount).toBe(2)
  })

  it('starts a second visible head in a free lane and joins it at the common child', () => {
    const layout = layoutCommitGraph([
      commit(H('d'), [H('g')]),
      commit(H('e'), [H('g')]),
      commit(H('g'), []),
    ])
    expect(layout.rows.map(row => row.lane)).toEqual([0, 1, 0])
    const fork = layout.rows[1]!
    expect(fork.edges.find(edge => edge.half === 'lower')).toMatchObject({ from: 1, to: 1, color: fork.color })
    // d's lane toward g keeps flowing through the second head's row.
    expect(fork.edges.find(edge => edge.half === 'through')).toMatchObject({ from: 0, to: 0 })
    expect(layout.laneCount).toBe(2)
  })

  it('ends a root commit without lower connectors and trims its lane', () => {
    const layout = layoutCommitGraph([commit(H('r'), [])])
    expect(layout.rows[0]!.edges).toEqual([])
    expect(layout.laneCount).toBe(1)
  })

  it('keeps lane colors stable per hash across the palette', () => {
    const layout = layoutCommitGraph([commit(H('a'), []), commit(H('b'), [])])
    for (const row of layout.rows) {
      expect(row.color).toBeGreaterThanOrEqual(0)
      expect(row.color).toBeLessThan(7)
    }
    expect(new Set(layout.rows.map(row => row.color)).size).toBe(layout.rows.length)
  })

  it('reuses a vacated lane slot for a later unoccupied head', () => {
    const layout = layoutCommitGraph([
      commit(H('a'), [H('b'), H('c')]),
      commit(H('b'), []),
      commit(H('c'), [H('d')]),
      commit(H('h'), [H('e')]),
    ])
    // b's root death vacates lane 0; h (no incoming lane) reuses the slot.
    const head = layout.rows[3]!
    expect(head.lane).toBe(0)
    // b's row draws only c's pass-through; the vacated slot itself is gone.
    const through = layout.rows[1]!.edges.filter(edge => edge.half === 'through')
    expect(through).toHaveLength(1)
    expect(through[0]).toMatchObject({ from: 1, to: 1 })
    expect(layout.rows[2]!.edges.filter(edge => edge.half === 'through')).toHaveLength(0)
  })

  it('connects an extra parent to a lane another row already opened', () => {
    const layout = layoutCommitGraph([
      commit(H('c'), [H('d')]),
      commit(H('a'), [H('b'), H('d')]),
      commit(H('d'), []),
      commit(H('b'), []),
    ])
    const merge = layout.rows[1]!
    const lowerToExisting = merge.edges.find(edge => edge.half === 'lower' && edge.to === 0)
    expect(lowerToExisting).toMatchObject({ from: 1, to: 0 })
    expect(layout.laneCount).toBe(2)
  })

  it('skips a repeated parent instead of opening a second lane', () => {
    const layout = layoutCommitGraph([commit(H('x'), [H('g'), H('g')])])
    const row = layout.rows[0]!
    expect(row.edges.filter(edge => edge.half === 'lower')).toHaveLength(1)
    expect(layout.laneCount).toBe(1)
  })
})
