/**
 * Mini window drawn on a gallery card: sidebar, message bars, and an accent
 * dot, all painted from the skin's own tokens through custom properties.
 */
import clsx from 'clsx'
import type { CSSProperties } from 'react'
import css from './SkinPreview.module.css'

/** Props of {@link SkinPreview}. */
export interface SkinPreviewProps {
  /** Per-skin custom properties from `previewStyle`. */
  style: CSSProperties
}

/**
 * Render the decorative preview.
 * @param props - per-skin style.
 * @returns the preview element (hidden from assistive technology).
 */
export function SkinPreview({ style }: SkinPreviewProps) {
  return (
    <span className={css.preview} style={style} aria-hidden="true">
      <span className={css.side} />
      <span className={css.main}>
        <span className={css.bar} />
        <span className={clsx(css.bar, css.short)} />
        <span className={css.accent} />
      </span>
    </span>
  )
}
