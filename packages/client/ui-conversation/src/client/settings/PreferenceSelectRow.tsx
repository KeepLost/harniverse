/**
 * The shared General Settings row shape: a labelled preference plus the pill
 * selector that changes it. Both conversation preferences present the same way,
 * so the shell lives here and each row keeps only its own vocabulary.
 */
import { useState } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PreferenceRow.module.css'

/** One selectable value with the copy the reader sees. */
export interface PreferenceOption<T extends string> {
  id: T
  label: string
}

/** Everything the shell renders; the owning row resolves every string. */
export interface PreferenceSelectRowProps<T extends string> {
  title: string
  description: string
  options: readonly PreferenceOption<T>[]
  /** Currently stored value; its option supplies the selector's own label. */
  selected: T
  /** Copy for {@link PreferenceSelectRowProps.selected}, resolved by the owner. */
  selectedLabel: string
  onSelect: (value: T) => void
}

/**
 * Render one preference row.
 * @param props - the row's copy, its options, and the selection callback.
 * @returns the preference row.
 */
export function PreferenceSelectRow<T extends string>({
  title, description, options, selected, selectedLabel, onSelect,
}: PreferenceSelectRowProps<T>) {
  const [open, setOpen] = useState(false)

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{title}</div>
        <div className={css.desc}>{description}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={options.map(option => ({ id: option.id, label: option.label }))}
        selectedId={selected}
        onSelect={(id) => {
          setOpen(false)
          onSelect(id as T)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            {selectedLabel}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
