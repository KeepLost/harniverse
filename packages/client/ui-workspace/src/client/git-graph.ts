/**
 * Commit-graph lane layout for the Changes section: assigns every visible
 * commit a lane, derives the connector geometry between adjacent rows, and
 * keeps one palette index per lane so a branch keeps its color while it stays
 * visible. Pure data over the topo-ordered commit list the Host returns; the
 * component renders the geometry, never recomputes it.
 */

/** Connector geometry of one commit row, in lane-index units. */
export interface CommitGraphEdge {
  /** Lane the connector starts from: the previous row's layout for `upper` and `through`, the node lane for `lower`. */
  from: number
  /** Lane the connector ends in: this row's node lane for `upper`, the next row's layout for `lower` and `through`. */
  to: number
  /** Which vertical span the connector covers: into the node, out of the node, or the full row alongside it. */
  half: 'upper' | 'lower' | 'through'
  /** Palette index coloring the connector. */
  color: number
}

/** One commit's node position plus the connectors around it. */
export interface CommitGraphRow {
  hash: string
  /** Lane of the commit's node circle. */
  lane: number
  /** Palette index for the node circle. */
  color: number
  edges: CommitGraphEdge[]
}

/** Complete layout over the visible commit window. */
export interface CommitGraphLayout {
  rows: CommitGraphRow[]
  /** Widest lane count the window reaches; rows share this width. */
  laneCount: number
}

/** Lane palette size; colors are assigned per lane from the target hash. */
export const COMMIT_GRAPH_PALETTE = 7

/** One occupied lane: the commit it still waits for, plus its stable color. */
interface LaneSlot {
  target: string | null
  color: number
}

/** Palette index for one hash: stable across windows and reloads. */
function laneColor(hash: string): number {
  let sum = 0
  for (let index = Math.max(0, hash.length - 4); index < hash.length; index++) sum += hash.charCodeAt(index)
  return sum % COMMIT_GRAPH_PALETTE
}

/**
 * Lay out the visible commit window.
 * @param commits - topo-ordered commits (newest first) with their parent hashes.
 * @returns one row per commit plus the shared lane width.
 */
export function layoutCommitGraph(commits: ReadonlyArray<{ hash: string; parents: string[] }>): CommitGraphLayout {
  const lanes: Array<LaneSlot | null> = []
  const rows: CommitGraphRow[] = []
  let laneCount = 0
  for (const commit of commits) {
    // Lanes waiting for this commit converge on its node.
    const occupied: number[] = []
    for (let index = 0; index < lanes.length; index++) {
      const lane = lanes[index]
      if (lane !== null && lane !== undefined && lane.target === commit.hash) occupied.push(index)
    }
    let nodeLane: number
    let nodeColor: number
    const nodeSlot = occupied.length > 0 ? lanes[occupied[0] as number] : undefined
    if (nodeSlot !== undefined && nodeSlot !== null) {
      nodeLane = occupied[0] as number
      nodeColor = nodeSlot.color
    } else {
      nodeLane = lanes.indexOf(null)
      if (nodeLane === -1) {
        nodeLane = lanes.length
        lanes.push(null)
      }
      nodeColor = laneColor(commit.hash)
    }
    const edges: CommitGraphEdge[] = []
    // index of each pre-row lane after this row's mutations; converging lanes
    // leave the layout and map to the node.
    const mapping: number[] = lanes.map((_lane, index) => index)
    const seen = new Set<string>([commit.hash])
    for (const index of occupied.slice(1)) {
      const slot = lanes[index]
      /* v8 ignore next -- occupied indices name live lanes; nothing nulled them since the scan. */
      if (slot === undefined || slot === null) continue
      lanes[index] = null
      mapping[index] = -1
      edges.push({ from: index, to: nodeLane, half: 'upper', color: slot.color })
    }
    if (occupied.length > 0 && rows.length > 0) {
      edges.push({ from: nodeLane, to: nodeLane, half: 'upper', color: nodeColor })
    }
    // The first parent continues the node's own lane.
    const [firstParent, ...extraParents] = commit.parents
    if (firstParent !== undefined) {
      seen.add(firstParent)
      lanes[nodeLane] = { target: firstParent, color: nodeColor }
      edges.push({ from: nodeLane, to: nodeLane, half: 'lower', color: nodeColor })
    } else {
      lanes[nodeLane] = null
      mapping[nodeLane] = -1
    }
    // Each additional parent either joins an existing lane or opens a fresh
    // one beside the node, shifting later lanes one slot to the right.
    let inserts = 0
    for (const parent of extraParents) {
      if (seen.has(parent)) continue
      seen.add(parent)
      const existing = lanes.findIndex(lane => lane !== null && lane.target === parent)
      if (existing !== -1) {
        const existingSlot = lanes[existing]
        /* v8 ignore next -- findIndex matched a live lane targeting the parent. */
        if (existingSlot === undefined || existingSlot === null) continue
        edges.push({ from: nodeLane, to: existing, half: 'lower', color: existingSlot.color })
        continue
      }
      const insertAt = nodeLane + 1 + inserts
      inserts++
      const color = laneColor(parent)
      lanes.splice(insertAt, 0, { target: parent, color })
      for (let index = 0; index < mapping.length; index++) {
        const mapped = mapping[index]
        if (mapped !== undefined && mapped >= insertAt) mapping[index] = mapped + 1
      }
      mapping.push(-1)
      edges.push({ from: nodeLane, to: insertAt, half: 'lower', color })
    }
    // Pass-through lanes: every pre-row lane that neither converged nor is the
    // node keeps flowing, possibly shifted by an insertion.
    if (rows.length > 0) {
      for (let index = 0; index < mapping.length; index++) {
        const mapped = mapping[index]
        if (mapped === undefined || mapped === -1) continue
        const lane = lanes[mapped]
        // A vacated slot from an earlier row keeps its identity mapping; it
        // flows nowhere and must not draw a pass-through.
        if (lane === undefined || lane === null) continue
        const wasNode = index === nodeLane || occupied.includes(index)
        if (wasNode) continue
        edges.push({ from: index, to: mapped, half: 'through', color: lane.color })
      }
    }
    while (lanes.at(-1) === null) lanes.pop()
    laneCount = Math.max(laneCount, lanes.length)
    rows.push({ hash: commit.hash, lane: nodeLane, color: nodeColor, edges })
  }
  return { rows, laneCount: Math.max(laneCount, 1) }
}
