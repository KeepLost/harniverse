/**
 * One-line display text helpers shared by the importer's title and preview.
 * @module @deepseek-ai/dsh-session-import/text
 */

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * The leading graphemes of one text, never splitting a user-perceived character.
 * @param text - the text to bound.
 * @param max - the grapheme budget.
 * @returns at most `max` leading graphemes of `text`.
 */
export function leadingGraphemes(text: string, max: number): string {
  let kept = ''
  let count = 0
  for (const { segment } of graphemes.segment(text)) {
    if (count === max) break
    kept += segment
    count++
  }
  return kept
}
