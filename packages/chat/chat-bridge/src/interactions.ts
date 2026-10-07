/**
 * Approval and question routing. Approvals go to the owners' private chats; a
 * member may also answer their own session's approvals only when the config
 * grants it. Only `allowed-once` and `rejected` exist over IM. Questions go to
 * the chat that started the turn. Every request times out into a rejection or
 * cancellation.
 * @module @deepseek-ai/dsh-chat-bridge/interactions
 */

import type { MuxFrame, RespondResult } from '@deepseek-ai/dsh-chat-harniverse-client'
import {
  approvalBody, parseAnswers, PendingTable, questionBody,
  type Pending, type PendingApproval, type PendingQuestion, type Target,
} from './approvals.ts'
import type { LiveSession } from './live.ts'
import type { Actor, Config } from './members.ts'
import type { Log, Messenger } from './messenger.ts'
import type { BridgeClient } from './ports.ts'

/** One owner the bridge can reach. */
export interface OwnerRoute {
  key: string
  /** The owner's private chat, when the platform can address them. */
  target: Target | undefined
}

/** What the interaction layer needs from the bridge. */
export interface InteractionDeps {
  config: Pick<Config, 'approvalTimeoutMs' | 'questionTimeoutMs'>
  messenger: Messenger
  client: Pick<BridgeClient, 'respond'>
  session(sessionId: string): LiveSession | undefined
  owners(): OwnerRoute[]
  actor(key: string): Actor | undefined
  log: Log
}

type ApprovalFrame = Extract<MuxFrame, { type: 'approval/requested' }>
type QuestionFrame = Extract<MuxFrame, { type: 'question/requested' }>

const REJECT_TIMEOUT_TEXT = 'Timed out and rejected.'

/** Pending approvals and questions, their cards, and their resolution. */
export class Interactions {
  /** Every pending approval and question. */
  readonly table = new PendingTable()

  constructor(private readonly deps: InteractionDeps) {}

  /**
   * Route a new approval request.
   * @param rpcId - the server-request id answers must reference.
   * @param frame - the request.
   * @param remoteHost - remote runtime of the stream, when any.
   */
  async approvalRequested(rpcId: string, frame: ApprovalFrame, remoteHost: string | undefined): Promise<void> {
    const live = this.deps.session(frame.sessionId)
    if (live === undefined) return
    const origin = live.turn?.origin
    const owners = this.deps.owners()
    const initiator = origin === undefined ? undefined : this.deps.actor(origin.actorKey)
    const mayAnswer = initiator !== undefined && initiator.role === 'member' && initiator.answerOwnApprovals
    const targets = owners.flatMap(owner => owner.target === undefined ? [] : [owner.target])
    if (mayAnswer && origin !== undefined) targets.push({ platform: origin.platform, botId: origin.botId, route: origin.route })
    if (targets.length === 0) {
      await this.respondQuiet(rpcId, this.approvalResult(frame, 'rejected'), remoteHost)
      if (origin !== undefined) await this.tell(origin, 'No owner is reachable, so the tool request was rejected.')
      return
    }
    const answerers = new Set(owners.map(owner => owner.key))
    if (mayAnswer && origin !== undefined) answerers.add(origin.actorKey)
    const pending = this.table.add<PendingApproval>({
      kind: 'approval', rpcId, approvalId: frame.approvalId, sessionId: frame.sessionId, remoteHost,
      answerers, cards: [],
    }, this.deps.config.approvalTimeoutMs, (entry) => { void this.timeout(entry) })
    const tool = live.toolCalls.get(frame.callId ?? '')
    for (const target of targets) {
      const adapter = this.deps.messenger.adapterFor(target)
      const buttons = adapter?.capabilities.interactionButtons === true && adapter.sendInteraction !== undefined
      const body = approvalBody(pending.id, {
        toolName: frame.toolName,
        ...tool === undefined ? {} : { argumentsJson: tool.arguments },
        ...frame.reason === undefined ? {} : { reason: frame.reason },
        requester: origin?.label ?? 'another client',
        sessionLabel: frame.sessionId.slice(-8),
      }, buttons)
      const card = await this.deps.messenger.card(target, 'approval', body, [
        { id: `approve:${pending.id}`, label: 'Approve once' },
        { id: `reject:${pending.id}`, label: 'Reject' },
      ])
      if (card !== undefined) pending.cards.push(card)
    }
    if (origin !== undefined && initiator?.role === 'member' && !mayAnswer) await this.tell(origin, 'The tool request was forwarded to the owner for approval.')
  }

  /**
   * Route a new question.
   * @param rpcId - the server-request id the answer must reference.
   * @param frame - the request.
   * @param remoteHost - remote runtime of the stream, when any.
   */
  async questionRequested(rpcId: string, frame: QuestionFrame, remoteHost: string | undefined): Promise<void> {
    const live = this.deps.session(frame.sessionId)
    if (live === undefined) return
    const origin = live.turn?.origin
    const owners = this.deps.owners()
    const targets: Target[] = origin === undefined
      ? owners.flatMap(owner => owner.target === undefined ? [] : [owner.target])
      : [{ platform: origin.platform, botId: origin.botId, route: origin.route }]
    if (targets.length === 0) {
      await this.respondQuiet(rpcId, this.cancelled('no chat is reachable for the question'), remoteHost)
      return
    }
    const answerers = new Set(owners.map(owner => owner.key))
    if (origin !== undefined) answerers.add(origin.actorKey)
    const pending = this.table.add<PendingQuestion>({
      kind: 'question', rpcId, questions: frame.questions, sessionId: frame.sessionId, remoteHost,
      answerers, cards: [],
    }, this.deps.config.questionTimeoutMs, (entry) => { void this.timeout(entry) })
    const single = frame.questions.length === 1 ? frame.questions.at(0) : undefined
    const options = single?.multiSelect === true ? [] : single?.options ?? []
    for (const target of targets) {
      const adapter = this.deps.messenger.adapterFor(target)
      const buttons = options.length > 0 && adapter?.capabilities.interactionButtons === true && adapter.sendInteraction !== undefined
      const card = await this.deps.messenger.card(target, 'question', questionBody(pending.id, frame.questions, buttons),
        options.map((option, index) => ({ id: `answer:${pending.id}:${String(index + 1)}`, label: option.label })))
      if (card !== undefined) pending.cards.push(card)
    }
  }

  /**
   * Settle cards of an approval answered elsewhere (for example in the web UI).
   * @param frame - the `approval/resolved` frame.
   */
  async approvalResolved(frame: Extract<MuxFrame, { type: 'approval/resolved' }>): Promise<void> {
    const [entry] = this.table.filter(pending => pending.kind === 'approval' && pending.sessionId === frame.sessionId && pending.approvalId === frame.approvalId)
    if (entry !== undefined) await this.close(entry, 'answered', `Answered elsewhere: ${frame.outcome}.`)
  }

  /**
   * Settle cards of a question answered or cancelled elsewhere.
   * @param frame - the `question/resolved` frame.
   */
  async questionResolved(frame: Extract<MuxFrame, { type: 'question/resolved' }>): Promise<void> {
    const [entry] = this.table.filter(pending => pending.kind === 'question' && pending.rpcId === frame.questionRpcId)
    if (entry !== undefined) await this.close(entry, 'answered', `Question ${frame.outcome} elsewhere.`)
  }

  /**
   * Answer an approval.
   * @param id - the pending id from the card.
   * @param allow - approve once (true) or reject (false).
   * @param actorKey - the answering identity.
   * @returns a short reply for the answerer.
   */
  async answerApproval(id: string, allow: boolean, actorKey: string): Promise<string> {
    const entry = this.table.get(id)
    if (entry?.kind !== 'approval') return 'That request is no longer pending.'
    if (!entry.answerers.has(actorKey)) return 'You cannot answer this request.'
    const outcome = allow ? 'allowed-once' : 'rejected'
    const done = await this.deliver(entry, this.approvalResult(entry, outcome))
    if (done !== undefined) return done
    await this.close(entry, 'answered', allow ? 'Approved once.' : 'Rejected.')
    return allow ? 'Approved once.' : 'Rejected.'
  }

  /**
   * Answer a question.
   * @param id - the pending id from the card.
   * @param answer - a chosen option number (button) or the typed `/answer` text.
   * @param actorKey - the answering identity.
   * @returns a short reply for the answerer.
   */
  async answerQuestion(id: string, answer: { option: number } | { text: string }, actorKey: string): Promise<string> {
    const entry = this.table.get(id)
    if (entry?.kind !== 'question') return 'That question is no longer pending.'
    if (!entry.answerers.has(actorKey)) return 'You cannot answer this question.'
    const parsed = parseAnswers(entry.questions, 'option' in answer ? String(answer.option) : answer.text)
    if (typeof parsed === 'string') return parsed
    const done = await this.deliver(entry, { ok: true, value: { sessionId: entry.sessionId, answer: parsed } })
    if (done !== undefined) return done
    await this.close(entry, 'answered', 'Answered.')
    return 'Answer sent.'
  }

  /**
   * Expire everything bound to a restarted runtime: a Host restart cancels its pending requests.
   * @param remoteHost - the restarted stream's remote host, or undefined for the local Host.
   */
  async hostRestarted(remoteHost: string | undefined): Promise<void> {
    for (const entry of this.table.filter(pending => pending.remoteHost === remoteHost)) {
      await this.close(entry, 'expired', 'Expired: the Harniverse host restarted.')
    }
  }

  /** Cancel every timer and leave the delivered cards as they are. */
  dispose(): void {
    this.table.clear()
  }

  // ---- internals ----

  private approvalResult(request: { sessionId: string; approvalId: string }, outcome: 'allowed-once' | 'rejected'): RespondResult {
    return { ok: true, value: { sessionId: request.sessionId, approvalId: request.approvalId, outcome } }
  }

  private cancelled(message: string): RespondResult {
    return { ok: false, error: { code: 'cancelled', message, details: {} } }
  }

  /** Send the response. Returns an error text for the answerer when it failed, otherwise undefined. */
  private async deliver(entry: Pending, result: RespondResult): Promise<string | undefined> {
    if (entry.claimed === true) return 'That request is already being answered.'
    entry.claimed = true
    try {
      const receipt = await this.deps.client.respond(
        entry.rpcId,
        result,
        entry.remoteHost === undefined ? {} : { remoteHost: entry.remoteHost },
      )
      entry.claimed = false
      if (!receipt.accepted) this.deps.log.info(`chat-bridge: respond ${entry.rpcId} not accepted (${receipt.reason})`)
      return undefined
    } catch (error) {
      entry.claimed = false
      this.deps.log.warn(`responding to ${entry.rpcId} failed`, error)
      return 'Could not reach the Harniverse service; try again.'
    }
  }

  private async respondQuiet(rpcId: string, result: RespondResult, remoteHost: string | undefined): Promise<void> {
    try {
      await this.deps.client.respond(rpcId, result, remoteHost === undefined ? {} : { remoteHost })
    } catch (error) {
      this.deps.log.warn(`responding to ${rpcId} failed`, error)
    }
  }

  private async close(entry: Pending, state: 'answered' | 'expired', text: string): Promise<void> {
    this.table.take(entry.id)
    await this.deps.messenger.settle(entry.cards, state, text)
  }

  private async timeout(entry: Pending): Promise<void> {
    if (entry.claimed === true) return
    const result = entry.kind === 'approval' ? this.approvalResult(entry, 'rejected') : this.cancelled('the question timed out')
    await this.respondQuiet(entry.rpcId, result, entry.remoteHost)
    await this.close(entry, 'expired', entry.kind === 'approval' ? REJECT_TIMEOUT_TEXT : 'Timed out and cancelled.')
    const origin = this.deps.session(entry.sessionId)?.turn?.origin
    if (origin !== undefined) await this.tell(origin, entry.kind === 'approval' ? 'The tool request timed out and was rejected.' : 'The question timed out and was cancelled.')
  }

  private async tell(origin: { platform: string; botId: string; route: Target['route'] }, text: string): Promise<void> {
    const adapter = this.deps.messenger.adapterFor(origin)
    if (adapter !== undefined) await this.deps.messenger.reply(adapter, origin.route, text)
  }
}
