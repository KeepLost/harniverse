/** Provider-neutral cross-session message delivery capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-relay': {
      kind: 'session-relay'
      form: 'relay'
      senderSessionId: SessionId
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionDelivery: SessionDelivery
  }
}

/** One ordinary-session next-turn delivery request. */
export interface SessionDeliveryRequest {
  sender: Agent
  targetSessionId: SessionId
  content: ContentBlock[]
  signal: AbortSignal
}

/** Inbox acceptance receipt; it does not imply a reply or turn completion. */
export interface SessionDeliveryReceipt {
  accepted: true
  messageId: MessageId
}

/** One ordinary-session unload request. */
export interface SessionUnloadRequest {
  sender: Agent
  targetSessionId: SessionId
  signal: AbortSignal
}

/** Idempotent unload receipt. */
export interface SessionUnloadReceipt {
  unloaded: boolean
}

/** Create one ordinary persistent session using the caller's current workspace. */
export interface SessionCreateRequest {
  sender: Agent
  profileId?: string
  signal: AbortSignal
}

/** Publication receipt for a newly created session. */
export interface SessionCreateReceipt {
  sessionId: SessionId
  agentProfile?: string
}

/** Service Definition for ordinary-session message delivery. */
export abstract class SessionDelivery extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionDelivery')
  }

  /**
   * Deliver a message as a later FIFO turn and return after inbox acceptance.
   * @param request - exact live sender, target identity, content, and admission cancellation.
   * @returns acceptance receipt without target completion or reply.
   */
  abstract deliver(request: SessionDeliveryRequest): Promise<SessionDeliveryReceipt>

  /**
   * Unload an idle ordinary session without interrupting queued or owned work.
   * @param request - exact live sender, target identity, and cancellation.
   * @returns whether a live target was detached.
   */
  abstract unload(request: SessionUnloadRequest): Promise<SessionUnloadReceipt>

  /**
   * Create and publish a fully composed ordinary session.
   * @param request - exact live sender, optional Agent Profile, and cancellation.
   * @returns the durable Session identity after composition and publication.
   */
  abstract create(request: SessionCreateRequest): Promise<SessionCreateReceipt>
}

export default SessionDelivery
