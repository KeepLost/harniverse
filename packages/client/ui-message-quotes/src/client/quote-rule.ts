/**
 * The `quote` sent-user-text rule. Recognition is the explicit-blockquote
 * scanner in [quote-text.ts](./quote-text.ts): one or more consecutive lines
 * each carrying up to three leading spaces and a `>` marker, so inline
 * greater-than signs and indented code stay ordinary text. The excerpt keeps
 * deeper markers literally; it is never re-interpreted as Markdown.
 */
import type { SentUserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { messageQuoteRanges, quoteTextOf, type MessageQuoteRange } from './quote-text.ts'
import { QuotedUserText } from './QuotedUserText.tsx'

/** The seam-carried payload for one recognized blockquote: the decoded excerpt. */
export interface QuoteRunData {
  readonly text: string
}

/**
 * Create the blockquote matcher over the conversation's sent-user-text seam.
 * The matcher memoizes one text's ranges, so the seam's advancing-offset
 * queries rescan nothing.
 * @returns the `quote` rule.
 */
export function createQuoteRule(): SentUserTextRule {
  let memoText: string | undefined
  let memoRanges: readonly MessageQuoteRange[] = []
  return {
    id: 'quote',
    nextMatch: (text, from) => {
      if (text !== memoText) {
        memoText = text
        memoRanges = messageQuoteRanges(text)
      }
      const range = memoRanges.find(range => range.start >= from)
      return range === undefined
        ? undefined
        : { start: range.start, end: range.end, data: { text: quoteTextOf(text.slice(range.start, range.end)) } }
    },
    Render: QuotedUserText,
  }
}
