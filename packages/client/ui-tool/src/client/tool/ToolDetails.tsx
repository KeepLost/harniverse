/** Card-aware output body for the selected Tool call in details. */
import { DiffBlock, ReadBlock, SearchBlock, TerminalBlock, WebBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolDetailsProps } from '../contract/slots.ts'
import { diffCardModel } from './models/diff-card-model.ts'
import { readCardModel } from './models/read-card-model.ts'
import { searchCardModel } from './models/search-card-model.ts'
import { terminalBlockLabels, terminalCardModel } from './models/terminal-card-model.ts'
import { resultImages, resultText } from './models/tool-call-model.ts'
import { webCardModel } from './models/web-card-model.ts'
import { ToolResultImages } from './components/ToolResultImages.tsx'
import css from './ToolDetails.module.css'

/** Pure details-body inputs; framework session seats stay at the slot boundary. */
interface ToolDetailsContentProps {
  block: ToolDetailsProps['block']
  cwd?: ToolDetailsProps['cwd']
  loadModelImage: ToolDetailsProps['loadModelImage']
  renderSlot?: ToolDetailsProps['renderSlot']
  t: ToolDetailsProps['t']
}

/**
 * Render the selected Tool call's structured output when its presentation
 * intent is known, otherwise preserve the flattened result text. Result
 * images render under the body as the model-side view.
 * @param props - selected call slice, workspace root, model-side image loader, and locale seat.
 * @returns the details output body.
 */
export function ToolDetails({ block, cwd, loadModelImage, renderSlot, t }: ToolDetailsContentProps) {
  const images = 'kind' in block ? resultImages(block) : []
  const gallery = renderSlot !== undefined && images.length > 0
    ? renderSlot('conversation.details.tool.images', { images, load: loadModelImage })
    : <ToolResultImages images={images} loadModelImage={loadModelImage} t={t} />
  const terminal = terminalCardModel(block, cwd)
  if (terminal !== null) {
    return (
      <>
        {terminal.description !== undefined ? (
          <div className={css.description}>{terminal.description}</div>
        ) : null}
        <TerminalBlock {...terminal.card} labels={terminalBlockLabels(t)} className={css.cardBody} />
        {gallery}
      </>
    )
  }
  const read = readCardModel(block, cwd)
  if (read !== null) return <ReadBlock {...read} className={css.read} />
  const diff = diffCardModel(block)
  if (diff !== null) return <DiffBlock {...diff.card} className={css.cardBody} />
  const search = searchCardModel(block)
  if (search !== null) {
    return (
      <>
        <SearchBlock {...search.card} className={css.cardBody} />
        {search.recovery !== undefined ? <div className={css.recovery}>{search.recovery}</div> : null}
        {gallery}
      </>
    )
  }
  const web = webCardModel(block)
  if (web !== null) {
    const body = 'kind' in block ? resultText(block) : ''
    return (
      <>
        <WebBlock {...web} className={css.web} />
        {body !== '' ? <pre className={css.code}>{body}</pre> : null}
        {gallery}
      </>
    )
  }
  if (!('kind' in block)) return <div className={css.empty}>{t('details.running')}</div>
  return (
    <>
      <pre className={css.code} data-error={block.isError || undefined}>
        {resultText(block)}
      </pre>
      {gallery}
    </>
  )
}
