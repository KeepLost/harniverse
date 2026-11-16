// CodeBlock: one code surface for every consumer — markdown fences, the
// run_code program body, and the details panel's raw args/output — with
// shiki highlighting for the registered grammars and an identical-geometry
// plain fallback for everything else. Chrome (language banner + copy) matches
// deepsuite `@deepseek/md` code blocks; token colors stay on `--shiki-*`.

import { Fragment, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { writeClipboard } from '../clipboard.ts'
import { grammarLoadCount, highlightToHtml, subscribeGrammarLoaded } from './highlight.ts'
import { diffFenceTokens, isDiffContent, isDiffFenceLanguage, parseDiffFence } from './diff-fence.ts'
import type { DiffRow } from './diff-fence.ts'
import type { HighlightSpan } from './highlight.ts'
import css from './CodeBlock.module.css'

export interface CodeBlockProps {
  /** The source text, rendered verbatim (trailing newline trimmed for display). */
  code: string
  /** Grammar hint (markdown fence info string or a fixed caller id); unknown = plain. */
  lang?: string | undefined
  /**
   * Render unified-diff rows: row colors by marker column, and each file's
   * body tokenized in its named language. Omitted, a `diff` or `patch`
   * `lang` selects them; `true` or `false` forces the choice.
   */
  diff?: boolean | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
  /** Copy-button idle label; the owner passes localized copy (this package is cordis-free, so copy arrives via props). */
  copyLabel?: string | undefined
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel?: string | undefined
}

/** Line class per row kind; context rows keep the block's default ink. */
const DIFF_ROW_CLASS: Record<DiffRow['kind'], string | undefined> = {
  add: css.diffAdd,
  del: css.diffDel,
  hunk: css.diffHunk,
  meta: css.diffMeta,
  context: undefined,
}

/** One diff row: optional marker column, then the body with its token colors. */
function renderDiffRow(row: DiffRow, index: number, tokens: readonly HighlightSpan[] | undefined): ReactNode {
  const kindClass = DIFF_ROW_CLASS[row.kind]
  return (
    <Fragment key={index}>
      {index > 0 && '\n'}
      <span className={clsx('line', css.diffLine, kindClass)}>
        {isDiffContent(row)
          ? <Fragment>
            <span className={css.diffMarker}>{row.marker}</span>
            {tokens === undefined
              ? row.body
              : tokens.map((span, spanIndex) => <span key={spanIndex} style={span.style}>{span.text}</span>)}
          </Fragment>
          : row.raw}
      </span>
    </Fragment>
  )
}

export function CodeBlock({ code, lang, diff, className, copyLabel = '复制', copiedLabel = '复制成功' }: CodeBlockProps) {
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code
  // Re-render when a lazy grammar finishes loading, so a fence that showed plain
  // text while its language's grammar imported picks up highlighting. The
  // snapshot value is opaque; only its change across renders drives the memo.
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const diffRows = useMemo(
    () => ((diff ?? isDiffFenceLanguage(lang)) ? parseDiffFence(trimmed) : undefined),
    [trimmed, lang, diff],
  )
  // Each file's old and new sides are tokenized separately, so an unterminated
  // comment or string in a removed line cannot color the added ones.
  const diffTokens = useMemo(
    () => (diffRows === undefined ? undefined : diffFenceTokens(diffRows)),
    [diffRows, loaded],
  )
  const html = useMemo(
    () => (diffRows === undefined ? highlightToHtml(trimmed, lang) : undefined),
    [trimmed, lang, loaded, diffRows],
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    if (copied) return
    /* v8 ignore next -- both arms always mount a <pre>; trimmed is the
       typed fallback if the DOM shape ever diverges. */
    const text = rootRef.current?.querySelector('pre')?.textContent ?? trimmed
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, trimmed])

  const body = diffRows !== undefined
    ? (
      <pre className={css.diffFence}>
        <code>{diffRows.rows.map((row, index) => renderDiffRow(row, index, diffTokens?.get(index)))}</code>
      </pre>
    )
    : html === undefined
      ? (
        <pre className={css.plain}><code>{trimmed}</code></pre>
      )
      : (
        // shiki's output is a static span tree it generated from `code` (no
        // user HTML passes through), the sanctioned innerHTML consumption
        // path per shiki's own docs.
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )

  return (
    <div ref={rootRef} className={clsx(css.block, 'md-code-block', className)}>
      <div className={css.bannerWrap}>
        <div className={css.banner}>
          <div className={css.infostring}>{lang ?? ''}</div>
          <div className={css.action}>
            <button type="button" className={css.copyButton} onClick={onCopy}>
              {copied ? copiedLabel : copyLabel}
            </button>
          </div>
        </div>
      </div>
      {body}
    </div>
  )
}
