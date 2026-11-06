/**
 * Loader-fixture user-questions provider: answers every question from
 * `$DSH_STUB_APPROVAL` (`allow` or `deny`) and counts the asks in
 * `askCount`; when the variable is unset no provider registers, which is
 * exactly the no-approval-source deployment the default-deny leg pins.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer, AskUserQuestionRequest, UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'

/** Answered asks so far, read by the driver in the same process. */
export const askCount = { current: 0 }

export function apply(ctx: Context): void {
  const verdict = process.env.DSH_STUB_APPROVAL
  if (verdict !== 'allow' && verdict !== 'deny') return
  const provider: UserQuestionProvider = {
    ask: async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
      askCount.current += 1
      const id = request.questions[0]!.id
      return { answers: [{ id, selected: [verdict === 'allow' ? 'Allow' : 'Deny'] }] }
    },
  }
  ctx.userQuestions.registerProvider(provider)
}

export const name = 'stub-questions'
export const inject = ['userQuestions']
