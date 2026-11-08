import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ImageLightbox.module.css'

/** Lightbox strings the owner resolves from its own locale namespace. */
export interface ImageLightboxLabels {
  /** Accessible name of the preview dialog. */
  dialog: string
  /** Accessible label of the close control. */
  close: string
  /** Accessible label of the copy-image control. */
  copyImage?: string
  /** Accessible label of the download control. */
  download?: string
  /** Accessible label of the save-as control (Desktop only). */
  saveAs?: string
}

/** Original-file commands the owner resolves for the opened preview; every member is optional. */
export interface ImageLightboxActions {
  /** Copy the decoded original to the clipboard. */
  copy?: () => void
  /** Download the original bytes. */
  download?: () => void
  /** Save the original through the Desktop picker. */
  saveAs?: () => void
}

/**
 * Document-level original-image preview opened by clicking a thumbnail.
 * Closes on Escape, backdrop press, or the close control, and restores focus
 * to the opener on unmount. Rendered through a body portal: an opener inside
 * a transformed or filtered ancestor would otherwise trap the fixed backdrop
 * in that ancestor's box instead of covering the viewport.
 *
 * @param props.src - the original image URL.
 * @param props.alt - the image's alt text.
 * @param props.labels - dialog, close-control, and optional action strings.
 * @param props.actions - optional original-file commands; a control renders per member.
 * @param props.onClose - dismiss callback owned by the opener.
 * @returns the modal preview dialog.
 */
export function ImageLightbox({ src, alt, labels, actions, onClose }: {
  src: string
  alt: string
  labels: ImageLightboxLabels
  actions?: ImageLightboxActions
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [onClose])

  return createPortal(
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialog}
    >
      <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
      <img className={css.image} src={src} alt={alt} />
      {actions !== undefined && (actions.copy !== undefined || actions.download !== undefined || actions.saveAs !== undefined)
        && <div className={css.actions} role="toolbar" aria-label={labels.dialog}>
          {actions.copy !== undefined && labels.copyImage !== undefined
            && <button type="button" className={css.action} onClick={actions.copy}>{labels.copyImage}</button>}
          {actions.download !== undefined && labels.download !== undefined
            && <button type="button" className={css.action} onClick={actions.download}>{labels.download}</button>}
          {actions.saveAs !== undefined && labels.saveAs !== undefined
            && <button type="button" className={css.action} onClick={actions.saveAs}>{labels.saveAs}</button>}
        </div>}
      <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>
        <IconCloseOutline16 size={16} />
      </button>
    </div>,
    document.body,
  )
}
