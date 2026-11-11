/**
 * Public wire types for the MCP client bridge: probe results cross the
 * `mcpManagement` Remote boundary, so they live in this exportable types
 * module rather than the root face.
 * @module
 */

export type {
  McpProbeCleanup,
  McpProbeFailure,
  McpProbeOptions,
  McpProbeResult,
  McpProbeServerInfo,
  McpProbeStage,
  McpProbeSuccess,
} from './probe.ts'
