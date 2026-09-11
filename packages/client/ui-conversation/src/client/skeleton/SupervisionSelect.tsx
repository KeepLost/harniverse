import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { SupervisionSelect as SupervisionSelectValue } from '@deepseek-ai/dsh-supervision/client'
import { IconChevronDownOutline14, IconPlayOutline16, IconUserOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import css from './PermissionSelect.module.css'

/* Mode glyphs: a person for the mode that stops to ask a human, a run arrow for
   the one that carries on alone. They are what identifies the chip once the
   composer row is too narrow to keep the label (PermissionSelect.module.css
   container rule), so a host-configured mode outside this set keeps its text. */
const supervisionGlyphs: Record<string, ReactNode> = {
  supervised: <IconUserOutline16 />,
  unsupervised: <IconPlayOutline16 />,
}

export interface SupervisionSelectProps {
  value: SupervisionSelectValue | undefined
  locked: boolean
  command: (line: string) => Promise<boolean>
  t: ComposerBarProps['t']
}

/**
 * Display name of one mode. The host names its own modes (as it does for
 * access presets), so the value is only the fallback for a mode that arrives
 * without one.
 * @param value - the supervision projection.
 * @param option - mode value to name.
 * @returns the host's name for that mode, or the raw value.
 */
function label(value: SupervisionSelectValue, option: string): string {
  return value.options.find(candidate => candidate.value === option)?.name ?? option
}

/** Independent human-interaction mode selector beside the Access selector. */
export function SupervisionSelect({ value, locked, command, t }: SupervisionSelectProps) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    if (!locked && value !== undefined) return
    setOpen(false)
    setPending(null)
  }, [locked, value])

  if (value === undefined) return null
  const currentValue = pending ?? value.currentValue
  const current = value.options.find(option => option.value === currentValue)
  const items: MenuEntry[] = value.options.map((option) => {
    const icon = supervisionGlyphs[option.value]
    return { id: option.value, label: option.name, ...icon === undefined ? {} : { icon } }
  })
  const select = (id: string): void => {
    setOpen(false)
    if (id === value.currentValue) return
    setPending(id)
    void command(`/supervision ${id}`).catch(() => false).then(() => { setPending(null) })
  }
  const glyph = supervisionGlyphs[currentValue]

  return (
    <Menu
      open={open}
      items={items}
      selectedId={currentValue}
      onSelect={select}
      onClose={() => { setOpen(false) }}
      side="top"
      anchor={
        <button
          type="button"
          className={css.trigger}
          aria-label={`Supervision mode: ${label(value, currentValue)}`}
          title={current?.description ?? t('input.accessMode', { name: label(value, currentValue) })}
          disabled={locked || pending !== null}
          onClick={() => { setOpen(!open) }}
        >
          {glyph !== undefined && <span className={css.triggerIcon} aria-hidden>{glyph}</span>}
          <span className={css.triggerLabel}>{label(value, currentValue)}</span>
          <span className={clsx(css.chevron, open && css.chevronOpen)} aria-hidden><IconChevronDownOutline14 /></span>
        </button>
      }
    />
  )
}
