/** Answered-question Chat data folded from ask_user_question tool events. */
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** One asked question as the call arguments carry it. */
export interface QuestionReplyQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
}

/** One structured answer as the tool result carries it. */
export interface QuestionReplyAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** Presentation data of one submitted answer batch. */
export interface QuestionReplyData {
  readonly callId: string
  /** A submitted answer batch, including individually skipped questions. */
  readonly outcome: 'answered'
  readonly questions: readonly QuestionReplyQuestion[]
  readonly answers: readonly QuestionReplyAnswer[]
  /** Model-facing result text, shown when the payload is unreadable. */
  readonly text: string
  readonly time: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One answered ask_user_question batch. */
    'question-reply': QuestionReplyData
  }
}

interface QuestionReplyState extends QuestionReplyData {
  readonly seq: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Answer values of one question in display order: the selected option labels
 * followed by a non-blank custom answer.
 * @param data - Projected reply holding the recorded answers.
 * @param id - Question id to read.
 * @returns The values, empty when the user skipped that question.
 */
export function replyAnswerValues(data: QuestionReplyData, id: string): string[] {
  const answer = data.answers.find(item => item.id === id)
  const custom = answer?.custom?.trim() ?? ''
  return [...(answer?.selected ?? []), ...(custom === '' ? [] : [custom])]
}

/**
 * Clipboard text of one answer batch: every question with the answer the user
 * gave, without question details or unselected options.
 * @param data - Projected reply to copy.
 * @param t - Bound `question` namespace translator owning the answer labels.
 * @returns One block per question, or the model-facing text when the payload was unreadable.
 */
export function replyClipboardText(data: QuestionReplyData, t: PropsLocale<'question'>['t']): string {
  if (data.questions.length === 0) return data.text
  return data.questions.map((question) => {
    const values = replyAnswerValues(data, question.id)
    const heading = question.header !== undefined && question.header !== question.question
      ? `${question.header} — ${question.question}`
      : question.question
    const answer = values.length === 0
      ? t('reply.skipped')
      : `${t('reply.answerLabel')}${values.join(', ')}`
    return `${heading}\n${answer}`
  }).join('\n\n')
}

function jsonRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch (error) {
    // Malformed tool JSON remains visible through the generic Tool node.
    void error
    return null
  }
}

/** Read the question list of one call; null when the arguments pair unsafely. */
function callQuestions(value: unknown): readonly QuestionReplyQuestion[] | null {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length === 0) return null
  const ids = new Set<string>()
  const questions: QuestionReplyQuestion[] = []
  for (const question of value.questions) {
    if (!isRecord(question) || typeof question.id !== 'string' || typeof question.question !== 'string'
      || ids.has(question.id)) return null
    ids.add(question.id)
    questions.push({
      id: question.id,
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
    })
  }
  return questions
}

/** Fold one settled result into reply data; undefined keeps the generic Tool presentation. */
function resultReply(
  questions: readonly QuestionReplyQuestion[],
  event: SessionEvent<'tool/result'>,
): QuestionReplyState | undefined {
  const block = event.data.message.content[0]
  if (block.isError === true) return undefined
  const content = block.content
  if (content.length !== 1 || content[0]?.type !== 'text') return undefined
  const text = content[0].text
  const value = jsonRecord(text)
  if (value === null || !Array.isArray(value.answers) || value.answers.length !== questions.length) {
    return undefined
  }
  const ids = new Set(questions.map(question => question.id))
  const answers: QuestionReplyAnswer[] = []
  for (const answer of value.answers) {
    if (!isRecord(answer) || typeof answer.id !== 'string' || !ids.delete(answer.id)
      || !Array.isArray(answer.selected) || !answer.selected.every(item => typeof item === 'string')
      || (answer.custom !== undefined && typeof answer.custom !== 'string')) return undefined
    answers.push({
      id: answer.id,
      selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })
  }
  return {
    seq: event.seq,
    time: event.time,
    callId: String(event.data.message.source.callId),
    outcome: 'answered',
    questions,
    answers,
    text,
  }
}

/** Reply data retained until a matching tool result records a complete answer batch. */
interface AnsweredQuestionState {
  readonly questions: readonly QuestionReplyQuestion[] | null
  readonly reply: QuestionReplyState | undefined
}

/**
 * ask_user_question answers paired by call id. Pending, failed, and malformed
 * results retain their generic Tool presentation; work is bounded by this
 * call's answer batch.
 */
export const answeredQuestionDefinition: ConversationNodeDefinition<AnsweredQuestionState> = {
  kind: 'answered-user-question',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
      return { id: String(event.data.callId), role: 'start' }
    }
    // Native results omit the tool name; update-only matches also keep a
    // result-only tail pending for older history prepends.
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String(event.data.message.source.callId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool/call') {
      throw new Error('answered-user-question start requires tool/call')
    }
    return { questions: callQuestions(jsonRecord(match.event.data.arguments)), reply: undefined }
  },
  update: (context, match) => {
    if (match.event.type !== 'tool/result' || context.state.questions === null) return context.state
    return { ...context.state, reply: resultReply(context.state.questions, match.event) }
  },
  buildViewNode: (context) => {
    const reply = context.state?.reply
    if (reply === undefined) {
      const current = context.current.get('chat')
      return current == null ? null : { ...current, visibility: 'hidden' }
    }
    const { seq, ...data } = reply
    return {
      key: context.key,
      kind: 'question-reply',
      id: context.id,
      target: 'chat',
      anchorSeq: seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data,
    }
  },
}
