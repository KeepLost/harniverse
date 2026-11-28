import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tools/types'
import type {
  ConversationNode, RunningToolCall, ToolCallBlock, ToolResultNode,
} from '../contract/conversation-snapshot.ts'

interface ProjectedBlock {
  source: ToolCallBlock
  children: readonly ToolCallBlock[]
  value: ToolCallBlock
}

/** Fixed wire-safety ceiling for every recursive Tool call consumer. */
export const MAX_TOOL_CALL_TREE_DEPTH = 256

function sameReferences<T>(
  left: readonly T[],
  right: readonly T[],
): boolean {
  return left.length === right.length
    && left.every((block, index) => block === right[index])
}

/**
 * Owns Code Dispatch pairing and projects its private parent index into the
 * recursive Tool call contract exposed by conversation snapshots.
 */
export class ToolCallTree {
  /** Children of each parent by child call id, in first-attachment order; mutated in place. */
  private readonly childrenByParent = new Map<string, Map<string, ToolCallBlock>>()
  private readonly depthByCall = new Map<string, number>()
  private readonly projectedByCall = new Map<string, ProjectedBlock>()
  private revision = 0
  private nodesCache: {
    source: readonly ConversationNode[]
    revision: number
    value: readonly ConversationNode[]
  } | null = null
  private runningCache: {
    source: readonly RunningToolCall[]
    revision: number
    value: readonly RunningToolCall[]
  } | null = null

  /** Forget all event-derived child calls before replaying a new window. */
  reset(): void {
    this.childrenByParent.clear()
    this.depthByCall.clear()
    this.projectedByCall.clear()
    this.revision++
  }

  /**
   * Fold one event when it belongs to the Code Dispatch lifecycle.
   * @param event - Session event from the current live or history window.
   * @returns Whether the event was consumed as a child-call lifecycle event.
   */
  apply(event: SessionEvent): boolean {
    if (event.type === 'tool/code-dispatch-start') {
      const data = event.data
      const siblings = this.childrenByParent.get(data.parentCallId)
      if (siblings?.has(data.subCallId)) return true
      const running: RunningToolCall = {
        phase: 'start',
        callId: data.subCallId,
        name: data.name,
        argsRaw: JSON.stringify(data.arguments),
        turn: 0,
        step: 0,
        time: event.time,
        callView: null,
        subCalls: [],
      }
      if (!this.acceptEdge(data.parentCallId, data.subCallId)) return true
      this.attach(data.parentCallId, running)
      this.revision++
      return true
    }
    if (event.type !== 'tool/code-dispatch') return false
    const data = event.data
    const started = this.childrenByParent.get(data.parentCallId)?.get(data.subCallId)
    if (started === undefined && !this.acceptEdge(data.parentCallId, data.subCallId)) return true
    const settled: ToolResultNode = {
      kind: 'tool-result',
      seq: event.seq,
      time: event.time,
      callId: data.subCallId,
      call: { name: data.name, argsRaw: JSON.stringify(data.arguments) },
      callTime: started?.time ?? null,
      content: data.content,
      isError: data.isError,
      callView: null,
      resultView: null,
      subCalls: [],
    }
    this.attach(data.parentCallId, settled)
    this.revision++
    return true
  }

  /**
   * Attach recursively projected children to all settled roots in a node list.
   * @param nodes - Cache-stable base conversation nodes.
   * @returns The original list when no root changed, otherwise a structurally shared list.
   */
  projectNodes(nodes: readonly ConversationNode[]): readonly ConversationNode[] {
    if (this.nodesCache?.source === nodes && this.nodesCache.revision === this.revision) {
      return this.nodesCache.value
    }
    const projected = nodes.map((node): ConversationNode => {
      if (node.kind !== 'tool-result') return node
      return this.projectBlock(node) as ToolResultNode
    })
    const value = sameReferences(nodes, projected) ? nodes : projected
    this.nodesCache = { source: nodes, revision: this.revision, value }
    return value
  }

  /**
   * Attach recursively projected children to all running root calls.
   * @param calls - Cache-stable base running calls.
   * @returns The original list when no root changed, otherwise a structurally shared list.
   */
  projectRunningCalls(calls: readonly RunningToolCall[]): readonly RunningToolCall[] {
    if (this.runningCache?.source === calls && this.runningCache.revision === this.revision) {
      return this.runningCache.value
    }
    const projected = calls.map(call => this.projectBlock(call) as RunningToolCall)
    const value = sameReferences(calls, projected) ? calls : projected
    this.runningCache = { source: calls, revision: this.revision, value }
    return value
  }

  private projectBlock(block: ToolCallBlock): ToolCallBlock {
    const attached = this.childrenByParent.get(block.callId)
    const children = attached === undefined ? block.subCalls : [...attached.values()]
    const projectedChildren = children.map(child => this.projectBlock(child))
    const childValue = sameReferences(children, projectedChildren)
      ? children
      : projectedChildren
    const cached = this.projectedByCall.get(block.callId)
    if (cached?.source === block && sameReferences(cached.children, childValue)) {
      return cached.value
    }
    const value: ToolCallBlock = block.subCalls === childValue
      ? block
      : { ...block, subCalls: childValue }
    this.projectedByCall.set(block.callId, {
      source: block,
      children: childValue,
      value,
    })
    return value
  }

  /**
   * Accept an edge only when every recursive consumer can traverse it safely.
   * Host-minted ids exclude cycles and current bindings emit one level; a
   * malformed wire/history edge is consumed without hiding the rest of the session.
   */
  private acceptEdge(parentCallId: string, subCallId: string): boolean {
    if (this.wouldCreateCycle(parentCallId, subCallId)) return false
    const pending = [{
      callId: subCallId,
      depth: (this.depthByCall.get(parentCallId) ?? 1) + 1,
    }]
    const updates = new Map<string, number>()
    for (const candidate of pending) {
      const knownDepth = updates.get(candidate.callId)
        ?? this.depthByCall.get(candidate.callId)
        ?? 1
      if (candidate.depth <= knownDepth) continue
      if (candidate.depth > MAX_TOOL_CALL_TREE_DEPTH) return false
      updates.set(candidate.callId, candidate.depth)
      for (const child of this.childrenByParent.get(candidate.callId)?.values() ?? []) {
        pending.push({ callId: child.callId, depth: candidate.depth + 1 })
      }
    }
    for (const [callId, depth] of updates) this.depthByCall.set(callId, depth)
    return true
  }

  /** Record one child under its parent, keeping first-attachment order on replacement. */
  private attach(parentCallId: string, child: ToolCallBlock): void {
    let siblings = this.childrenByParent.get(parentCallId)
    if (siblings === undefined) {
      siblings = new Map()
      this.childrenByParent.set(parentCallId, siblings)
    }
    siblings.set(child.callId, child)
  }

  private wouldCreateCycle(parentCallId: string, subCallId: string): boolean {
    if (parentCallId === subCallId) return true
    const pending = [subCallId]
    const visited = new Set(pending)
    for (const callId of pending) {
      for (const child of this.childrenByParent.get(callId)?.values() ?? []) {
        if (child.callId === parentCallId) return true
        if (visited.has(child.callId)) continue
        visited.add(child.callId)
        pending.push(child.callId)
      }
    }
    return false
  }
}
