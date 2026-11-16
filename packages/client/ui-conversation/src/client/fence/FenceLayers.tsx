/** Chat's language layers for Markdown fences: display math and unified-diff rows. */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { FenceCodeBlock, FenceMathBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownCodeLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarkdownDelegateFenceInfo } from '@deepseek-ai/dsh-client-ui-primitives'

/** Props of the math layer: the fence and the next inner content. */
export interface MathFenceLayerProps extends MarkdownDelegateFenceInfo {
  /** The plain code block this layer replaces or decorates. */
  children: ReactNode
}

/** Props of the diff layer: the fence and the conversation locale seat. */
export interface DiffFenceLayerProps extends MarkdownDelegateFenceInfo, PropsLocale<'conversation'> {
  /** The plain code block this layer replaces or decorates. */
  children: ReactNode
}

/**
 * Show a `math` fence as display TeX once its document settles; while it
 * streams, the inner code block shows the source so a partial formula never
 * renders as an error.
 * @param props - the fence and the inner content.
 * @returns the formula, or the inner content while streaming.
 */
export function MathFenceLayer({ code, streaming, children }: MathFenceLayerProps): ReactNode {
  return streaming ? children : <FenceMathBlock code={code} />
}

/**
 * Show a `diff` or `patch` fence as unified-diff rows in place of the inner code block.
 * @param props - the fence, the inner content, and the conversation locale seat.
 * @returns the diff code block.
 */
export function DiffFenceLayer({ lang, code, streaming, t }: DiffFenceLayerProps): ReactNode {
  const labels = useMemo<MarkdownCodeLabels>(() => ({ copyLabel: t('copy'), copiedLabel: t('copied') }), [t])
  return <FenceCodeBlock lang={lang} code={code} streaming={streaming} labels={labels} diff />
}
