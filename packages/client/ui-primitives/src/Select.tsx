// Select: native <select> atom styled like Input. Settings and dialogs use it for
// short enum pickers; the OS popup list stays native (accessible, searchable,
// touch-friendly), only the closed control carries the theme.

import { forwardRef, type SelectHTMLAttributes } from 'react'
import clsx from 'clsx'
import css from './Select.module.css'

/**
 * Render a themed native select.
 * @param props.className - consumer-owned layout (width, flex); the atom sets none.
 * @param ref - the native select element.
 * @returns the select element; every native select attribute and its `<option>` children pass through.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={clsx(css.select, className)} {...rest}>
        {children}
      </select>
    )
  },
)
