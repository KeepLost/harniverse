/**
 * Layout shell shared by every Appearance skin row: a titled section with its
 * description and an optional notice above the row's own controls.
 */
import { useId, type ReactNode } from 'react'
import css from './Row.module.css'

/** Props of {@link Row}. */
export interface RowProps {
  /** Row heading. */
  title: string
  /** One-sentence description under the heading. */
  description: string
  /** Optional explanation of why the controls are limited (read-only, opaque environment, ...). */
  notice: string | undefined
  /** The row's controls. */
  children: ReactNode
}

/**
 * Render the shell of one row.
 * @param props - heading, description, notice, and controls.
 * @returns the section element.
 */
export function Row({ title, description, notice, children }: RowProps) {
  const titleId = useId()
  return (
    <section className={css.row} aria-labelledby={titleId}>
      <h3 id={titleId} className={css.title}>{title}</h3>
      <p className={css.description}>{description}</p>
      {notice === undefined ? null : <p className={css.notice} role="note">{notice}</p>}
      {children}
    </section>
  )
}
