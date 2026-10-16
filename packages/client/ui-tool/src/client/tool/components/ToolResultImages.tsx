/** Inline tool-result images: every image block a settled result carries,
 * rendered as the model-side view (the projected request-image bytes the
 * session-authorized loader resolves). */

import { ImageGallery } from '@deepseek-ai/dsh-client-ui-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ToolResultImages.module.css'

/**
 * The conversation-namespace image labels, resolved locally: the bridge lives
 * in ui-conversation, whose internals another plugin may not import, so the
 * atom's label shape is rebuilt here over the same shared keys.
 */
function imageLabels(t: TranslateNS<'conversation'>): Parameters<typeof ImageGallery>[0]['labels'] {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: label => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: { dialog: t('image.preview'), close: t('image.closePreview') },
  }
}

/**
 * Render a settled result's images, sized by the attachment atoms' gallery
 * rule (one lone image large, several as tiles).
 * @param props - the result's image references, the model-side loader, and the locale seat.
 * @returns the gallery, or null when the result carries no images.
 */
export function ToolResultImages({ images, loadModelImage, t }: {
  images: readonly ImageAttachmentRef[]
  loadModelImage: (attachment: ImageAttachmentRef) => Promise<string>
  t: TranslateNS<'conversation'>
}) {
  if (images.length === 0) return null
  return (
    <div className={css.root}>
      <ImageGallery
        images={images.map(attachment => ({ attachment }))}
        load={loadModelImage}
        align="start"
        labels={imageLabels(t)}
      />
    </div>
  )
}
