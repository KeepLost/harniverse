import { useEffect, useState } from 'react'
import type { SupervisionSelect as SupervisionSelectValue } from '@deepseek-ai/dsh-supervision/client'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import css from './PermissionSelect.module.css'

export interface SupervisionSelectProps {
  value: SupervisionSelectValue | undefined
  locked: boolean
  command: (line: string) => Promise<boolean>
  t: ComposerBarProps['t']
}

function label(value: string): string {
  return value === 'unsupervised' ? 'Unsupervised' : 'Supervised'
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
  const items: MenuEntry[] = value.options.map(option => ({ id: option.value, label: label(option.value) }))
  const select = (id: string): void => {
    setOpen(false)
    if (id === value.currentValue) return
    setPending(id)
    void command(`/supervision ${id}`).catch(() => false).then(() => { setPending(null) })
  }

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
          aria-label={`Supervision mode: ${label(currentValue)}`}
          title={current?.description ?? t('input.accessMode', { name: label(currentValue) })}
          disabled={locked || pending !== null}
          onClick={() => { setOpen(!open) }}
        >
          <span className={css.triggerLabel}>{label(currentValue)}</span>
          <span className={css.chevron} aria-hidden><IconChevronDownOutline14 /></span>
        </button>
      }
    />
  )
}
