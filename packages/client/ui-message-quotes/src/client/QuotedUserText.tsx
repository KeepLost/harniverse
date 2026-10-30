/**
 * Blockquote presentation for one recognized sent-text quote: the excerpt
 * draws with one `>` level removed, and deeper markers or inner Markdown
 * stay literal. Quoting changes only what is drawn: the message text, the
 * copy action, and the model input keep the original characters.
 */
import type { SentUserTextRunProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { QuoteRunData } from './quote-rule.ts'
import { quoteTextOf } from './quote-text.ts'
import css from './QuotedUserText.module.css'

/**
 * Draw one recognized blockquote as a styled excerpt with the marker stripped.
 * @param props - the matched range's original characters and the prepared excerpt.
 * @returns a block quote drawing the decoded text literally.
 */
export function QuotedUserText({ raw, data }: SentUserTextRunProps) {
  const text = (data as QuoteRunData | undefined)?.text ?? quoteTextOf(raw)
  return (
    <blockquote className={css.quote} data-quote="">
      {text}
    </blockquote>
  )
}
