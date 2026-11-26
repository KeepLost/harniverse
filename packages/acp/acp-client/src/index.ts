/**
 * Version-neutral Agent Client Protocol client core. Any conforming agent is
 * one `AcpAgentDefinition`; `connectAcpAgent` starts it over the subprocess
 * seam, negotiates the protocol, authenticates, and returns a connection whose
 * sessions stream normalized updates. Consumers own what they derive from
 * those facts.
 * @module @deepseek-ai/dsh-acp-client
 */

export type {
  AcpAgentDefinition,
  AcpAgentInfo,
  AcpAgentProfile,
  AcpAgentRequest,
  AcpCapabilities,
  AcpConnection,
  AcpContentBlock,
  AcpExit,
  AcpPlanEntry,
  AcpPermissionAnswer,
  AcpPermissionAnswerer,
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpProfileCustomize,
  AcpPromptBlock,
  AcpPromptOptions,
  AcpProtocol,
  AcpSession,
  AcpSessionInfo,
  AcpStopReason,
  AcpToolCallPatch,
  AcpTurn,
  AcpTurnEnd,
  AcpUpdate,
  AcpUsage,
  AcpWorkState,
} from './types.ts'
export {
  AcpError,
  acpErrorKindForCode,
  isAcpError,
  toAcpError,
  type AcpErrorKind,
  type AcpErrorOptions,
} from './errors.ts'
export { isRecord, normalizeUpdate, parseSessionUpdate, toStopReason, toWorkState } from './update.ts'
export { DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, disposeAcpChild } from './transport.ts'
export { allowAnswer, policyAnswerer, rejectAnswerer, type AcpPermissionPolicy } from './permission.ts'
export { selectProfile, type AcpProfileSelection } from './profile.ts'
export { DEFAULT_CLIENT_INFO, connectAcpAgent, type AcpConnectOptions } from './connection.ts'
