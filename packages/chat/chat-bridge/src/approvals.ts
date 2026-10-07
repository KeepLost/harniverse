/**
 * Pending approvals and questions: short run-unique ids, timeouts, answer
 * parsing, and the texts shown to people. Routing and delivery belong to the
 * bridge; this module holds the state machine for one request.
 * @module @deepseek-ai/dsh-chat-bridge/approvals
 */

import { randomBytes } from 'node:crypto'
import type { ChatRoute, SentRef } from '@deepseek-ai/dsh-chat-adapter'
import type { QuestionItem } from '@deepseek-ai/dsh-chat-harniverse-client'
import { truncate } from './render.ts'

/** A chat position addressed through one bot. */
export interface Target {
  platform: string
  botId: string
  route: ChatRoute
}

/** One delivered card or text fallback, kept so it can be settled. */
export interface Card {
  target: Target
  ref: SentRef
  /** Whether the card is plain text (settled by editing) instead of an interaction prompt. */
  plain: boolean
}

/** Fields every pending entry carries. */
export interface PendingBase {
  /** Short id unique to this process run. */
  id: string
  sessionId: string
  remoteHost: string | undefined
  /** Identity keys allowed to answer. */
  answerers: ReadonlySet<string>
  cards: Card[]
  timer: ReturnType<typeof setTimeout> | undefined
  /** Set while an answer is being delivered, so a concurrent answer cannot double-respond. */
  claimed?: boolean
}

/** A pending tool approval. */
export interface PendingApproval extends PendingBase {
  kind: 'approval'
  rpcId: string
  approvalId: string
}

/** A pending user question. */
export interface PendingQuestion extends PendingBase {
  kind: 'question'
  rpcId: string
  questions: QuestionItem[]
}

/** A pending entry of either kind. */
export type Pending = PendingApproval | PendingQuestion

/** Pending entries by id, with run-unique ids and per-entry timeouts. */
export class PendingTable {
  private readonly entries = new Map<string, Pending>()
  private readonly run = randomBytes(2).toString('hex')
  private counter = 0

  /**
   * Register an entry and arm its timeout.
   * @param entry - the entry without an id or timer.
   * @param timeoutMs - time until `onTimeout` fires.
   * @param onTimeout - invoked with the entry when nobody answered in time.
   * @returns the stored entry.
   */
  add<T extends Pending>(entry: Omit<T, 'id' | 'timer'>, timeoutMs: number, onTimeout: (entry: Pending) => void): T {
    this.counter += 1
    const id = `${this.run}${String(this.counter)}`
    const stored = { ...entry, id, timer: undefined } as unknown as T
    stored.timer = setTimeout(() => { onTimeout(stored) }, timeoutMs)
    stored.timer.unref()
    this.entries.set(id, stored)
    return stored
  }

  /**
   * Look an entry up without removing it.
   * @param id - the id from the card.
   * @returns the entry, or undefined when answered, expired, or never issued.
   */
  get(id: string): Pending | undefined {
    return this.entries.get(id)
  }

  /**
   * Remove an entry and cancel its timeout.
   * @param id - the id from the card.
   * @returns the removed entry, or undefined when it was not pending.
   */
  take(id: string): Pending | undefined {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    this.entries.delete(id)
    clearTimeout(entry.timer)
    return entry
  }

  /**
   * Select pending entries.
   * @param predicate - keeps the entries it accepts.
   * @returns every entry matching the predicate, oldest first.
   */
  filter(predicate: (entry: Pending) => boolean): Pending[] {
    return [...this.entries.values()].filter(predicate)
  }

  /**
   * Remove every entry and cancel all timeouts.
   * @returns the removed entries.
   */
  clear(): Pending[] {
    const all = [...this.entries.values()]
    for (const entry of all) clearTimeout(entry.timer)
    this.entries.clear()
    return all
  }
}

/** Facts shown on an approval card. */
export interface ApprovalFacts {
  toolName: string
  /** Raw tool arguments JSON, when the matching tool call was observed. */
  argumentsJson?: string
  reason?: string
  requester: string
  sessionLabel: string
}

/**
 * Compose the approval text.
 * @param id - pending id the answer commands reference.
 * @param facts - what is being requested and by whom.
 * @param buttons - whether the platform renders buttons; otherwise the text names the commands.
 * @returns the card body.
 */
export function approvalBody(id: string, facts: ApprovalFacts, buttons: boolean): string {
  const lines = [`Approval needed for ${facts.toolName} (session ${facts.sessionLabel}, requested by ${facts.requester}).`]
  if (facts.argumentsJson !== undefined) lines.push(`Arguments: ${truncate(facts.argumentsJson, 300)}`)
  if (facts.reason !== undefined) lines.push(`Reason: ${truncate(facts.reason, 300)}`)
  if (!buttons) lines.push(`Reply /approve ${id} or /reject ${id}.`)
  return lines.join('\n')
}

/**
 * Compose the question text.
 * @param id - pending id the answer command references.
 * @param questions - the questions in order.
 * @param buttons - whether options are also offered as buttons.
 * @returns the card body.
 */
export function questionBody(id: string, questions: readonly QuestionItem[], buttons: boolean): string {
  const lines = questions.flatMap((question, index) => [
    `Q${String(index + 1)}. ${question.header === undefined ? '' : `${question.header}: `}${question.question}`,
    ...question.detail === undefined ? [] : [question.detail],
    ...(question.options ?? []).map((option, position) => `  ${String(position + 1)}) ${option.label}${option.description === undefined ? '' : ` - ${option.description}`}`),
    ...question.multiSelect === true ? ['  (several options allowed, separate numbers with commas)'] : [],
  ])
  if (!buttons) lines.push(`Reply /answer ${id} ${questions.map((_, index) => `<answer ${String(index + 1)}>`).join(' ; ')}`)
  return lines.join('\n')
}

/** Answer payload of a `question/requested` response. */
export interface QuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/**
 * Parse `/answer` arguments: one answer per question separated by `;`.
 * Option numbers (comma separated) select options; anything else is a free-text answer.
 * @param questions - the pending questions.
 * @param input - the text after the pending id.
 * @returns the answers, or a message explaining what is wrong.
 */
export function parseAnswers(questions: readonly QuestionItem[], input: string): QuestionAnswer | string {
  const parts = input.split(';').map(part => part.trim())
  if (parts.length !== questions.length || parts.some(part => part === '')) {
    return `Expected ${String(questions.length)} non-empty answer(s) separated by ";".`
  }
  const answers: QuestionAnswer['answers'] = []
  for (const [index, question] of questions.entries()) {
    /* v8 ignore next -- the length check above makes `parts` and `questions` the same size */
    const part = parts.at(index) ?? ''
    const options = question.options ?? []
    const numbers = part.split(',').map(token => token.trim())
    if (options.length > 0 && numbers.every(token => /^\d+$/.test(token))) {
      const chosen = numbers.flatMap((token) => {
        const option = options[Number(token) - 1]
        return option === undefined ? [] : [option.label]
      })
      if (chosen.length !== numbers.length) return `Answer ${String(index + 1)} names an option that does not exist.`
      if (question.multiSelect !== true && chosen.length > 1) return `Answer ${String(index + 1)} allows one option.`
      answers.push({ id: question.id, selected: chosen })
    } else {
      answers.push({ id: question.id, selected: [], custom: part })
    }
  }
  return { answers }
}
