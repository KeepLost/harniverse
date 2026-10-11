/**
 * The load-failure page every settings section falls back to: one error line
 * and one retry button, with an optional heading when the failed surface is
 * the section's only content.
 *
 * @module dsh-client-ui-settings-models/client/SectionError
 */

import type { ReactNode } from 'react'
import styles from './ModelsSection.module.css'

/** Props of {@link SectionError}. */
export interface SectionErrorProps {
  /** Page heading; omitted when the failed list is not the page's only content. */
  title?: string
  /** The error text to show under the heading. */
  message: string
  /** Retry button label. */
  retryLabel: string
  /** Re-runs the failed load. */
  onRetry: () => void
}

/** Renders the shared failure page for a settings section. */
export function SectionError(props: SectionErrorProps): ReactNode {
  return (
    <div className={styles['section']}>
      {props.title === undefined ? null : <h1 className={styles['title']}>{props.title}</h1>}
      <p className={styles['error']}>{props.message}</p>
      <button type="button" className={styles['secondaryButton']} onClick={props.onRetry}>
        {props.retryLabel}
      </button>
    </div>
  )
}
