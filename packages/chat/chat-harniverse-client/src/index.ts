/**
 * The chat bridge's only `/api` client service (`ctx.harniverseClient`): Grant
 * authentication, a closed endpoint table, `Idempotency-Key`, principal
 * capture, respond, upload, and a resumable event mux.
 * @module @deepseek-ai/dsh-chat-harniverse-client
 */

import HarniverseClient, { Config, DEFAULT_GRANT_ID_REF, DEFAULT_SIGNING_KEY_REF, MAX_MUX_RENEW_AFTER_MS } from './client.ts'

export default HarniverseClient
export { Config, DEFAULT_GRANT_ID_REF, DEFAULT_SIGNING_KEY_REF, MAX_MUX_RENEW_AFTER_MS }
export { HarniverseMux, TOKEN_EXPIRED_CLOSE_CODE } from './mux.ts'
export { HarniverseError, type HarniverseErrorCode, type HarniverseErrorDetails } from './errors.ts'
export { internals } from './internals.ts'
export {
  CARRIER_ENDPOINTS, isTypertEndpoint, isUnaryMethod, TYPERT_ENDPOINTS, UNARY_ENDPOINTS,
  type TypertEndpoint, type UnaryMethod, type UnaryValue,
} from './endpoints.ts'
export type {
  CallOptions, HarniversePrincipal, HostDescription, MuxDelivery, MuxFrame, MuxOptions, MuxSocket,
  MuxState, QuestionItem, RespondReceipt, RespondResult, MuxSessionEvent, UploadedAttachment,
} from './types.ts'
