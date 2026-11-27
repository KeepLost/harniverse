/**
 * Version-neutral Agent Client Protocol client core. Any conforming agent is
 * one `AcpAgentDefinition`; `connectAcpAgent` starts it over the subprocess
 * seam, negotiates the protocol, and returns a connection whose sessions
 * stream normalized updates. Sign-in completes when the agent first demands
 * it. Consumers own what they derive from those facts.
 * @module @deepseek-ai/dsh-acp-client
 */

export type {
  AcpAgentDefinition,
  AcpAgentInfo,
  AcpAgentProfile,
  AcpAgentRequest,
  AcpCapabilities,
  AcpCommand,
  AcpConfigChoice,
  AcpConfigOption,
  AcpConfigValue,
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
  AcpQuestionAnswer,
  AcpQuestionAnswerer,
  AcpQuestionChoice,
  AcpQuestionField,
  AcpQuestionRequest,
  AcpQuestionValue,
  AcpSession,
  AcpSessionInfo,
  AcpSessionMode,
  AcpSessionModes,
  AcpSessionRequestOptions,
  AcpSignInHooks,
  AcpStopReason,
  AcpTerminalSignIn,
  AcpToolCallPatch,
  AcpTurn,
  AcpTurnEnd,
  AcpUpdate,
  AcpUsage,
  AcpWorkState,
} from './types.ts'
export type { AcpAuthMethod } from './types.ts'
export {
  AcpError,
  acpErrorKindForCode,
  isAcpAuthRequired,
  isAcpError,
  isAcpNotFound,
  toAcpError,
  type AcpErrorKind,
  type AcpErrorOptions,
} from './errors.ts'
export { readConfigOption, readConfigOptions, readSessionModes } from './options.ts'
export { isRecord, normalizeUpdate, parseSessionUpdate, toStopReason, toWorkState } from './update.ts'
export { DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, disposeAcpChild } from './transport.ts'
export { allowAnswer, policyAnswerer, rejectAnswerer, type AcpPermissionPolicy } from './permission.ts'
export { selectProfile, type AcpProfileSelection } from './profile.ts'
export { KNOWN_AGENTS, knownAgent, type AcpKnownAgent } from './catalog.ts'
export { DEFAULT_CLIENT_INFO, connectAcpAgent, type AcpConnectOptions } from './connection.ts'
