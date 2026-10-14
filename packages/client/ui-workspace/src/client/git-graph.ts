/**
 * Commit-graph swimlane model and row geometry for the Changes section,
 * ported from VS Code's source-control history graph
 * (src/vs/workbench/contrib/scm/browser/history/scmHistory.ts of
 * https://github.com/microsoft/vscode, MIT license,
 * Copyright (c) Microsoft Corporation).
 *
 * The model layer walks the topo-ordered commit window and assigns each row
 * input/output swimlanes; the shape layer turns one row into pure SVG
 * path/circle descriptions that the component maps onto the DOM. Rows are
 * fixed 22px swimlanes with exact-pixel geometry, so segments from
 * consecutive rows join into one continuous drawing.
 */

/** Palette size: indices 0-4 rotate across unlabeled lanes, 5-6 pin refs. */
export const COMMIT_GRAPH_PALETTE = 7
/** Palette index for the current-ref (HEAD) label color. */
export const COMMIT_GRAPH_REF_COLOR = 5
/** Palette index for the remote-ref (upstream) label color. */
export const COMMIT_GRAPH_REF_REMOTE_COLOR = 6

/** Count of rotating lane colors, occupying palette indices 0..4. */
const ROTATING_COLORS = 5

/** Horizontal distance between neighboring swimlane centers, in px. */
export const GRAPH_SWIMLANE_WIDTH = 11
/** Fixed row height: two half-swimlanes, in px. */
export const GRAPH_SWIMLANE_HEIGHT = 22
/** Curve radius of lane-shift S-curves, in px. */
const GRAPH_CURVE_RADIUS = 5
/** Base node circle radius, in px. */
const GRAPH_CIRCLE_RADIUS = 4
/** Node halo ring stroke width, in px. */
const GRAPH_CIRCLE_STROKE_WIDTH = 2

/** One occupied swimlane: the commit hash it flows toward, plus its color. */
export interface CommitGraphLane {
  target: string
  color: number
}

/** One commit's swimlane view model, VS Code's ISCMHistoryItemViewModel. */
export interface CommitGraphRow {
  hash: string
  /** Full parent hashes, first parent first; empty for a root commit. */
  parents: string[]
  /** True when this commit carries the HEAD decoration. */
  head: boolean
  /** Lanes entering this row, cloned from the previous row's outputs. */
  inputSwimlanes: CommitGraphLane[]
  /** Lanes leaving this row toward their targets. */
  outputSwimlanes: CommitGraphLane[]
}

/** Minimal commit shape the layout consumes; refs pin label colors. */
export interface CommitGraphCommit {
  hash: string
  parents: string[]
  refs?: ReadonlyArray<{ kind: string; current: boolean }> | undefined
}

/**
 * Label color of one commit: its first current (HEAD-checked-out) ref pins
 * the ref color, otherwise its first remote ref pins the remote-ref color,
 * otherwise the commit is unlabeled and lanes rotate colors.
 * @param commit - commit whose refs decide the label color.
 * @returns palette index, or undefined when unlabeled.
 */
function labelColor(commit: CommitGraphCommit): number | undefined {
  for (const ref of commit.refs ?? []) {
    if (ref.current) return COMMIT_GRAPH_REF_COLOR
    if (ref.kind === 'remote') return COMMIT_GRAPH_REF_REMOTE_COLOR
  }
  return undefined
}

/**
 * Build the swimlane view model over the visible commit window, newest first.
 * @param commits - topo-ordered commits with their parents and decorations.
 * @returns one row per commit; row N's inputs are row N-1's outputs.
 */
export function layoutCommitGraph(commits: ReadonlyArray<CommitGraphCommit>): CommitGraphRow[] {
  let colorIndex = -1
  const byHash = new Map(commits.map(commit => [commit.hash, commit]))
  const rows: CommitGraphRow[] = []
  for (const commit of commits) {
    const label = labelColor(commit)
    const input = rows.at(-1)?.outputSwimlanes.map(lane => ({ ...lane })) ?? []
    const output: CommitGraphLane[] = []
    let firstParentAdded = false
    const [firstParent] = commit.parents
    if (firstParent !== undefined) {
      for (const lane of input) {
        if (lane.target === commit.hash) {
          if (!firstParentAdded) {
            output.push({ target: firstParent, color: label ?? lane.color })
            firstParentAdded = true
          }
          continue
        }
        output.push({ ...lane })
      }
    } else {
      // Root commit: its own lane(s) end here while pass-through lanes keep
      // flowing. VS Code drops them all (its loop only runs with parents);
      // keeping the others is a deliberate divergence so sibling branches
      // never vanish mid-window.
      for (const lane of input) {
        if (lane.target === commit.hash) continue
        output.push({ ...lane })
      }
    }
    for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index++) {
      const parent = commit.parents[index] as string
      let color: number | undefined
      if (index === 0) color = label
      else {
        const parentCommit = byHash.get(parent)
        color = parentCommit === undefined ? undefined : labelColor(parentCommit)
      }
      if (color === undefined) {
        colorIndex = (colorIndex + 1) % ROTATING_COLORS
        color = colorIndex
      }
      output.push({ target: parent, color })
    }
    rows.push({
      hash: commit.hash,
      parents: commit.parents,
      head: commit.refs?.some(ref => ref.kind === 'head') === true,
      inputSwimlanes: input,
      outputSwimlanes: output,
    })
  }
  return rows
}

/** One drawn SVG path segment of a row's graph. */
export interface CommitGraphPath {
  d: string
  color: number
  strokeWidth: number
}

/** One drawn SVG circle: the node and its decoration rings. */
export interface CommitGraphCircle {
  cx: number
  cy: number
  r: number
  strokeWidth: number
  color: number
  /** `color` fills with the lane color; `background` punches a hole. */
  fill: 'color' | 'background'
}

/** Pure geometry of one commit row's graph cell. */
export interface CommitGraphRowShapes {
  paths: CommitGraphPath[]
  circles: CommitGraphCircle[]
  width: number
  height: number
}

/** Lane-center x coordinate of one lane index. */
function laneX(index: number): number {
  return GRAPH_SWIMLANE_WIDTH * (index + 1)
}

/**
 * Turn one row's swimlane model into SVG geometry, VS Code's
 * renderSCMHistoryItemGraph as a pure function.
 * @param row - the row to draw.
 * @returns paths and circles plus the cell's pixel size.
 */
export function commitGraphRowShapes(row: CommitGraphRow): CommitGraphRowShapes {
  const input = row.inputSwimlanes
  const output = row.outputSwimlanes
  const inputIndex = input.findIndex(lane => lane.target === row.hash)
  const nodeIndex = inputIndex !== -1 ? inputIndex : input.length
  const nodeColor = nodeIndex < output.length ? (output[nodeIndex] as CommitGraphLane).color
    : nodeIndex < input.length ? (input[nodeIndex] as CommitGraphLane).color : COMMIT_GRAPH_REF_COLOR

  const paths: CommitGraphPath[] = []
  const line = (d: string, color: number, strokeWidth = 1): void => {
    paths.push({ d, color, strokeWidth })
  }

  let outputIndex = 0
  for (let index = 0; index < input.length; index++) {
    const lane = input[index] as CommitGraphLane
    const color = lane.color
    if (lane.target === row.hash) {
      if (index !== nodeIndex) {
        // Duplicate lane converging onto the node: quarter arc, then across.
        line(`M ${laneX(index)} 0 A ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_WIDTH} 0 0 1 ${laneX(index) - GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_WIDTH} H ${laneX(nodeIndex)}`, color)
      } else if (row.parents.length > 0) {
        // The node's lane is replaced in place by its first parent; a root
        // commit's lane instead dies, compacting later lanes one slot left.
        outputIndex++
      }
    } else if (outputIndex < output.length && lane.target === output[outputIndex]?.target) {
      if (index === outputIndex) {
        line(`M ${laneX(index)} 0 V ${GRAPH_SWIMLANE_HEIGHT}`, color)
      } else {
        // Pass-through lane compacting left: vertical, S-curve, vertical.
        line(`M ${laneX(index)} 0 V ${GRAPH_SWIMLANE_HEIGHT / 2 - GRAPH_CURVE_RADIUS} A ${GRAPH_CURVE_RADIUS} ${GRAPH_CURVE_RADIUS} 0 0 1 ${laneX(index) - GRAPH_CURVE_RADIUS} ${GRAPH_SWIMLANE_HEIGHT / 2} H ${laneX(outputIndex) + GRAPH_CURVE_RADIUS} A ${GRAPH_CURVE_RADIUS} ${GRAPH_CURVE_RADIUS} 0 0 0 ${laneX(outputIndex)} ${GRAPH_SWIMLANE_HEIGHT / 2 + GRAPH_CURVE_RADIUS} V ${GRAPH_SWIMLANE_HEIGHT}`, color)
      }
      outputIndex++
    }
  }

  // Merge parents beyond the first connect their lanes into the node.
  for (let index = 1; index < row.parents.length; index++) {
    const parent = row.parents[index] as string
    let parentOutputIndex = -1
    for (let scan = output.length - 1; scan >= 0; scan--) {
      if (output[scan]?.target === parent) {
        parentOutputIndex = scan
        break
      }
    }
    if (parentOutputIndex === -1) continue
    const color = (output[parentOutputIndex] as CommitGraphLane).color
    line(`M ${GRAPH_SWIMLANE_WIDTH * parentOutputIndex} ${GRAPH_SWIMLANE_HEIGHT / 2} A ${GRAPH_SWIMLANE_WIDTH} ${GRAPH_SWIMLANE_WIDTH} 0 0 1 ${laneX(parentOutputIndex)} ${GRAPH_SWIMLANE_HEIGHT} M ${GRAPH_SWIMLANE_WIDTH * parentOutputIndex} ${GRAPH_SWIMLANE_HEIGHT / 2} H ${laneX(nodeIndex)}`, color)
  }

  if (inputIndex !== -1) line(`M ${laneX(nodeIndex)} 0 V ${GRAPH_SWIMLANE_HEIGHT / 2}`, (input[inputIndex] as CommitGraphLane).color)
  if (row.parents.length > 0) {
    line(`M ${laneX(nodeIndex)} ${GRAPH_SWIMLANE_HEIGHT / 2} V ${GRAPH_SWIMLANE_HEIGHT}`, nodeColor)
  }

  const circles: CommitGraphCircle[] = []
  const circle = (r: number, strokeWidth: number, fill: 'color' | 'background'): void => {
    circles.push({ cx: laneX(nodeIndex), cy: GRAPH_SWIMLANE_WIDTH, r, strokeWidth, color: nodeColor, fill })
  }
  if (row.head) {
    circle(GRAPH_CIRCLE_RADIUS + 3, GRAPH_CIRCLE_STROKE_WIDTH, 'color')
    circle(GRAPH_CIRCLE_STROKE_WIDTH, GRAPH_CIRCLE_RADIUS, 'background')
  } else if (row.parents.length > 1) {
    circle(GRAPH_CIRCLE_RADIUS + 2, GRAPH_CIRCLE_STROKE_WIDTH, 'color')
    circle(GRAPH_CIRCLE_RADIUS - 1, GRAPH_CIRCLE_STROKE_WIDTH, 'color')
  } else {
    circle(GRAPH_CIRCLE_RADIUS + 1, GRAPH_CIRCLE_STROKE_WIDTH, 'color')
  }

  return {
    paths,
    circles,
    width: GRAPH_SWIMLANE_WIDTH * (Math.max(input.length, output.length, 1) + 1),
    height: GRAPH_SWIMLANE_HEIGHT,
  }
}

/** Pure geometry of the lane gutter filling an expanded commit's detail. */
export interface CommitGraphPlaceholderShapes {
  /** Vertical lines: lane-center x, color, and whether emphasized. */
  lines: Array<{ x: number; color: number; emphasized: boolean }>
  width: number
}

/**
 * Geometry of the lane lines flowing through an expanded commit's detail
 * block, VS Code's renderSCMHistoryGraphPlaceholder as a pure function.
 * @param row - the expanded row; its output lanes flow through the gutter.
 * @returns one vertical line per lane plus the gutter's pixel width.
 */
export function commitGraphPlaceholderShapes(row: CommitGraphRow): CommitGraphPlaceholderShapes {
  const [firstParent] = row.parents
  const emphasized = firstParent === undefined ? -1 : row.outputSwimlanes.findIndex(lane => lane.target === firstParent)
  return {
    lines: row.outputSwimlanes.map((lane, index) => ({
      x: laneX(index),
      color: lane.color,
      emphasized: index === emphasized,
    })),
    width: GRAPH_SWIMLANE_WIDTH * (row.outputSwimlanes.length + 1),
  }
}
