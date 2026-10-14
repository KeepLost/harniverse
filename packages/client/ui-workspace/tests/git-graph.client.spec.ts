import { describe, expect, it } from 'vitest'
import {
  COMMIT_GRAPH_REF_COLOR, COMMIT_GRAPH_REF_REMOTE_COLOR, GRAPH_SWIMLANE_HEIGHT, GRAPH_SWIMLANE_WIDTH,
  commitGraphPlaceholderShapes, commitGraphRowShapes, layoutCommitGraph,
} from '../src/client/git-graph.ts'

/** Commit helper: optional decoration refs pin label colors. */
function commit(hash: string, parents: string[], refs?: Array<{ kind: string; name?: string; current: boolean }>) {
  return { hash, parents, refs }
}

const currentRef = (name: string) => [{ kind: 'local', name, current: true } as { kind: string; current: boolean }]
const remoteRef = (name: string) => [{ kind: 'remote', name, current: false } as { kind: string; current: boolean }]
const headRef = () => [{ kind: 'head', name: 'HEAD', current: true } as { kind: string; current: boolean }]

describe('commit graph swimlane layout', () => {
  it('returns no rows for an empty window', () => {
    expect(layoutCommitGraph([])).toEqual([])
  })

  it('places a single commit on no lanes', () => {
    const rows = layoutCommitGraph([commit('a', [])])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.inputSwimlanes).toHaveLength(0)
    expect(rows[0]!.outputSwimlanes).toHaveLength(0)
  })

  it('keeps a linear chain on one rotating color', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b']), commit('b', ['c']), commit('c', ['d']), commit('d', ['e']), commit('e', []),
    ])
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row.inputSwimlanes).toHaveLength(row === rows[0] ? 0 : 1)
      expect(row.outputSwimlanes).toHaveLength(row === rows.at(-1) ? 0 : 1)
    }
    expect(rows[0]!.outputSwimlanes[0]).toEqual({ target: 'b', color: 0 })
    expect(rows[3]!.outputSwimlanes[0]).toEqual({ target: 'e', color: 0 })
    expect(rows[4]!.inputSwimlanes[0]).toEqual({ target: 'e', color: 0 })
  })

  it('opens a second lane for a merge whose topic holds one commit', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b']),
      commit('b', ['c', 'd']),
      commit('d', ['c']),
      commit('c', ['e']),
      commit('e', ['f']),
    ])
    expect(rows[1]!.outputSwimlanes).toEqual([
      { target: 'c', color: 0 },
      { target: 'd', color: 1 },
    ])
    // d joins the c lane as a duplicate below its own row.
    expect(rows[2]!.outputSwimlanes).toEqual([
      { target: 'c', color: 0 },
      { target: 'c', color: 1 },
    ])
    // c consumes both converging lanes into one continuation.
    expect(rows[3]!.outputSwimlanes).toEqual([{ target: 'e', color: 0 }])
  })

  it('keeps two lanes flowing across a multi-commit topic branch', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b', 'c']),
      commit('c', ['d']),
      commit('b', ['e']),
      commit('e', ['f']),
      commit('f', ['d']),
      commit('d', ['g']),
    ])
    expect(rows[0]!.outputSwimlanes).toEqual([
      { target: 'b', color: 0 },
      { target: 'c', color: 1 },
    ])
    expect(rows[1]!.outputSwimlanes).toEqual([
      { target: 'b', color: 0 },
      { target: 'd', color: 1 },
    ])
    expect(rows[4]!.outputSwimlanes).toEqual([
      { target: 'd', color: 0 },
      { target: 'd', color: 1 },
    ])
    expect(rows[5]!.outputSwimlanes).toEqual([{ target: 'g', color: 0 }])
  })

  it('branches again from a merge commit, rotating a third color', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b', 'c']),
      commit('c', ['b']),
      commit('b', ['d', 'e']),
      commit('e', ['f']),
      commit('f', ['g']),
      commit('d', ['h']),
    ])
    expect(rows[2]!.outputSwimlanes).toEqual([
      { target: 'd', color: 0 },
      { target: 'e', color: 2 },
    ])
    expect(rows[3]!.outputSwimlanes).toEqual([
      { target: 'd', color: 0 },
      { target: 'f', color: 2 },
    ])
    expect(rows[5]!.outputSwimlanes).toEqual([
      { target: 'h', color: 0 },
      { target: 'g', color: 2 },
    ])
  })

  it('opens several lanes from one commit and converges them all', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b', 'c']),
      commit('c', ['d']),
      commit('b', ['e', 'f']),
      commit('f', ['g']),
      commit('e', ['g']),
      commit('d', ['g']),
      commit('g', ['h']),
    ])
    expect(rows[2]!.outputSwimlanes).toEqual([
      { target: 'e', color: 0 },
      { target: 'd', color: 1 },
      { target: 'f', color: 2 },
    ])
    expect(rows[6]!.inputSwimlanes).toEqual([
      { target: 'g', color: 0 },
      { target: 'g', color: 1 },
      { target: 'g', color: 2 },
    ])
    expect(rows[6]!.outputSwimlanes).toEqual([{ target: 'h', color: 0 }])
  })

  it('pins label colors from current and remote refs', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b'], currentRef('topic')),
      commit('b', ['c']),
      commit('c', ['d'], remoteRef('origin/topic')),
      commit('d', ['e']),
      commit('e', ['f', 'g']),
      commit('g', ['h'], remoteRef('origin/main')),
    ])
    // The current-ref label colors the lane below a.
    expect(rows[0]!.outputSwimlanes[0]).toEqual({ target: 'b', color: COMMIT_GRAPH_REF_COLOR })
    // The remote-ref label recolors the lane below c.
    expect(rows[2]!.outputSwimlanes[0]).toEqual({ target: 'd', color: COMMIT_GRAPH_REF_REMOTE_COLOR })
    // e is unlabeled: its lane keeps the remote color, and its extra parent g
    // inherits g's own remote label instead of rotating.
    expect(rows[4]!.outputSwimlanes).toEqual([
      { target: 'f', color: COMMIT_GRAPH_REF_REMOTE_COLOR },
      { target: 'g', color: COMMIT_GRAPH_REF_REMOTE_COLOR },
    ])
    expect(rows[5]!.outputSwimlanes[1]).toEqual({ target: 'h', color: COMMIT_GRAPH_REF_REMOTE_COLOR })
  })

  it('recolors the first-parent lane at a labeled HEAD and rotates unlabeled extra parents', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b'], remoteRef('origin/main')),
      commit('b', ['c', 'z']),
      commit('c', ['e'], [...headRef(), ...currentRef('main')]),
      commit('d', ['e']),
      commit('e', ['f']),
      commit('f', ['g']),
    ])
    expect(rows[0]!.outputSwimlanes[0]).toEqual({ target: 'b', color: COMMIT_GRAPH_REF_REMOTE_COLOR })
    // b's extra parent z is nowhere in the window: the rotation supplies it.
    expect(rows[1]!.outputSwimlanes).toEqual([
      { target: 'c', color: COMMIT_GRAPH_REF_REMOTE_COLOR },
      { target: 'z', color: 0 },
    ])
    // c is the labeled HEAD: its first-parent lane takes the ref color.
    expect(rows[2]!.outputSwimlanes[0]).toEqual({ target: 'e', color: COMMIT_GRAPH_REF_COLOR })
    expect(rows[4]!.outputSwimlanes[0]).toEqual({ target: 'f', color: COMMIT_GRAPH_REF_COLOR })
    expect(rows[2]!.head).toBe(true)
    expect(rows[0]!.head).toBe(false)
  })

  it('treats a non-current, non-remote ref as unlabeled', () => {
    const rows = layoutCommitGraph([commit('a', ['b'], [{ kind: 'tag', name: 'v1.0.0', current: false }])])
    expect(rows[0]!.outputSwimlanes[0]).toEqual({ target: 'b', color: 0 })
  })

  it('keeps sibling lanes flowing below a root commit and lets its own lane die', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b', 'c']),
      commit('c', []),
      commit('b', []),
    ])
    // c is a root: its own lane ends, a's lane toward b keeps flowing.
    expect(rows[1]!.outputSwimlanes).toEqual([{ target: 'b', color: 0 }])
    expect(rows[2]!.inputSwimlanes).toEqual([{ target: 'b', color: 0 }])
  })
})

describe('commit graph row shapes', () => {
  it('draws a head row as a stem plus a ringed node', () => {
    const rows = layoutCommitGraph([commit('a', ['b'], headRef())])
    const shapes = commitGraphRowShapes(rows[0]!)
    expect(shapes.width).toBe(GRAPH_SWIMLANE_WIDTH * 2)
    expect(shapes.height).toBe(GRAPH_SWIMLANE_HEIGHT)
    expect(shapes.paths).toEqual([
      { d: `M ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_HEIGHT / 2} V ${GRAPH_SWIMLANE_HEIGHT}`, color: COMMIT_GRAPH_REF_COLOR, strokeWidth: 1 },
    ])
    expect(shapes.circles).toEqual([
      { cx: GRAPH_SWIMLANE_WIDTH, cy: GRAPH_SWIMLANE_WIDTH, r: 7, strokeWidth: 2, color: COMMIT_GRAPH_REF_COLOR, fill: 'color' },
      { cx: GRAPH_SWIMLANE_WIDTH, cy: GRAPH_SWIMLANE_WIDTH, r: 2, strokeWidth: 4, color: COMMIT_GRAPH_REF_COLOR, fill: 'background' },
    ])
  })

  it('draws a root row as a stem into a plain node with no lower stem', () => {
    const rows = layoutCommitGraph([commit('a', ['b']), commit('b', [])])
    const shapes = commitGraphRowShapes(rows[1]!)
    expect(shapes.paths).toEqual([
      { d: `M ${GRAPH_SWIMLANE_WIDTH} 0 V ${GRAPH_SWIMLANE_HEIGHT / 2}`, color: 0, strokeWidth: 1 },
    ])
    expect(shapes.circles).toEqual([
      { cx: GRAPH_SWIMLANE_WIDTH, cy: GRAPH_SWIMLANE_WIDTH, r: 5, strokeWidth: 2, color: 0, fill: 'color' },
    ])
  })

  it('falls back to the ref color for a lone root node with no lanes', () => {
    const rows = layoutCommitGraph([commit('a', [])])
    const shapes = commitGraphRowShapes(rows[0]!)
    expect(shapes.paths).toEqual([])
    expect(shapes.circles[0]!.color).toBe(COMMIT_GRAPH_REF_COLOR)
    expect(shapes.width).toBe(GRAPH_SWIMLANE_WIDTH * 2)
  })

  it('draws a merge row as a double node with the extra-parent connector', () => {
    const rows = layoutCommitGraph([commit('a', ['b', 'c']), commit('c', ['b']), commit('b', [])])
    const merge = commitGraphRowShapes(rows[0]!)
    expect(merge.circles).toEqual([
      { cx: GRAPH_SWIMLANE_WIDTH, cy: GRAPH_SWIMLANE_WIDTH, r: 6, strokeWidth: 2, color: 0, fill: 'color' },
      { cx: GRAPH_SWIMLANE_WIDTH, cy: GRAPH_SWIMLANE_WIDTH, r: 3, strokeWidth: 2, color: 0, fill: 'color' },
    ])
    // The second parent's lane receives the `-\` connector into the node.
    expect(merge.paths).toContainEqual({
      d: `M ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_HEIGHT / 2} A ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_WIDTH} 0 0 1 ${GRAPH_SWIMLANE_WIDTH * 2} ${GRAPH_SWIMLANE_HEIGHT} M ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_HEIGHT / 2} H ${GRAPH_SWIMLANE_WIDTH}`,
      color: 1,
      strokeWidth: 1,
    })
    expect(merge.width).toBe(GRAPH_SWIMLANE_WIDTH * 3)
  })

  it('draws the convergence arc when a duplicate lane joins the node', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b', 'c']),
      commit('c', ['b']),
      commit('b', []),
    ])
    // b arrives with lanes [b, b]: the second converges onto the node.
    const shapes = commitGraphRowShapes(rows[2]!)
    expect(shapes.paths).toContainEqual({
      d: `M ${GRAPH_SWIMLANE_WIDTH * 2} 0 A ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_WIDTH} 0 0 1 ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_WIDTH} H ${GRAPH_SWIMLANE_WIDTH}`,
      color: 1,
      strokeWidth: 1,
    })
  })

  it('compacts a surviving lane left with an S-curve when a root lane dies', () => {
    const rows = layoutCommitGraph([
      commit('a', ['c', 'b']),
      commit('c', []),
      commit('b', []),
    ])
    // a's outputs are [c, b]; c is a root on lane 0, so b's lane — one slot
    // right in the input — compacts left through c's row with an S-curve.
    const root = commitGraphRowShapes(rows[1]!)
    expect(root.paths).toContainEqual({
      d: `M ${GRAPH_SWIMLANE_WIDTH * 2} 0 V 6 A 5 5 0 0 1 ${GRAPH_SWIMLANE_WIDTH * 2 - 5} ${GRAPH_SWIMLANE_HEIGHT / 2} H ${GRAPH_SWIMLANE_WIDTH + 5} A 5 5 0 0 0 ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_HEIGHT / 2 + 5} V ${GRAPH_SWIMLANE_HEIGHT}`,
      color: 1,
      strokeWidth: 1,
    })
  })

  it('scans past later lanes when connecting a middle parent of an octopus merge', () => {
    const rows = layoutCommitGraph([commit('a', ['x', 'y', 'z'])])
    const shapes = commitGraphRowShapes(rows[0]!)
    // y's connector is found left of z's freshly opened lane: it arcs from
    // one lane-width left of y's center into the node's row bottom.
    expect(shapes.paths).toContainEqual({
      d: `M ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_HEIGHT / 2} A ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_WIDTH} 0 0 1 ${GRAPH_SWIMLANE_WIDTH * 2} ${GRAPH_SWIMLANE_HEIGHT} M ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_HEIGHT / 2} H ${GRAPH_SWIMLANE_WIDTH}`,
      color: 1,
      strokeWidth: 1,
    })
  })

  it('skips pass-through and merge connectors whose lane left the output', () => {
    // Hand-built rows exercise the geometry's tolerance of partial views:
    // a lane whose target no longer flows below the row draws nothing.
    const orphan = commitGraphRowShapes({
      hash: 'a',
      parents: ['x', 'y'],
      head: false,
      inputSwimlanes: [{ target: 'x', color: 0 }, { target: 'y', color: 1 }],
      outputSwimlanes: [{ target: 'x', color: 0 }],
    })
    // The y pass-through has no output slot left to match: not drawn, while
    // x's lane runs the full row height and the node opens below the input.
    expect(orphan.paths.map(path => path.d)).toEqual([
      `M ${GRAPH_SWIMLANE_WIDTH} 0 V ${GRAPH_SWIMLANE_HEIGHT}`,
      `M ${GRAPH_SWIMLANE_WIDTH * 3} ${GRAPH_SWIMLANE_HEIGHT / 2} V ${GRAPH_SWIMLANE_HEIGHT}`,
    ])
    const missing = commitGraphRowShapes({
      hash: 'a',
      parents: ['x', 'q'],
      head: false,
      inputSwimlanes: [],
      outputSwimlanes: [{ target: 'x', color: 0 }],
    })
    // q never reached the output: its connector is skipped entirely.
    expect(missing.paths).toHaveLength(1)
  })

  it('passes a straight lane through when input and output indices agree', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b', 'c']),
      commit('c', ['b']),
      commit('b', []),
    ])
    // c's row: lane 0 (toward b) passes straight through on the same index.
    const shapes = commitGraphRowShapes(rows[1]!)
    expect(shapes.paths).toContainEqual({
      d: `M ${GRAPH_SWIMLANE_WIDTH} 0 V ${GRAPH_SWIMLANE_HEIGHT}`,
      color: 0,
      strokeWidth: 1,
    })
  })
})

describe('commit graph placeholder shapes', () => {
  it('emphasizes the first-parent lane and sizes to the lane count', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b', 'c']),
      commit('c', ['b']),
      commit('b', []),
    ])
    const shapes = commitGraphPlaceholderShapes(rows[0]!)
    expect(shapes.lines).toEqual([
      { x: GRAPH_SWIMLANE_WIDTH, color: 0, emphasized: true },
      { x: GRAPH_SWIMLANE_WIDTH * 2, color: 1, emphasized: false },
    ])
    expect(shapes.width).toBe(GRAPH_SWIMLANE_WIDTH * 3)
  })

  it('emphasizes nothing below a root commit', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b', 'c']),
      commit('c', ['b']),
      commit('b', []),
    ])
    const shapes = commitGraphPlaceholderShapes(rows[2]!)
    expect(shapes.lines).toEqual([])
    expect(shapes.width).toBe(GRAPH_SWIMLANE_WIDTH * 1)
  })

  it('emphasizes the continuation lane when a fresh head opens below other lanes', () => {
    const rows = layoutCommitGraph([
      commit('a', ['b', 'c']),
      commit('c', ['b']),
      commit('b', []),
    ])
    // c replaces its own lane with the shared parent b; the placeholder
    // below the expanded row emphasizes that first-parent lane.
    const shapes = commitGraphPlaceholderShapes(rows[1]!)
    expect(shapes.lines.map(line => line.emphasized)).toEqual([true, false])
  })
})
