import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { SupervisionSelect as SupervisionSelectValue } from '@deepseek-ai/dsh-supervision/client'
import { IconChevronDownOutline14, IconPlayOutline16, IconUserOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import { en } from '../locales.ts'
import css from './PermissionSelect.module.css'

/* Mode glyphs: a person for the mode that stops to ask a human, a run arrow for
   the one that carries on alone. They are what identifies the chip once the
   composer row is too narrow to keep the label (PermissionSelect.module.css
   container rule), so a host-configured mode outside this set keeps its text. */
const supervisionGlyphs: Record<string, ReactNode> = {
  supervised: <IconUserOutline16 />,
  unsupervised: <IconPlayOutline16 />,
}

/** Built-in mode machine values → their English product labels. */
const BUILT_IN_SUPERVISION_NAMES: Record<string, string> = {
  supervised: en['supervision.mode.supervised'],
  unsupervised: en['supervision.mode.unsupervised'],
}

/** True when the host did not customize the built-in mode's name. */
function builtIn(option: { value: string; name: string }): string | undefined {
  const label = BUILT_IN_SUPERVISION_NAMES[option.value]
  return label !== undefined && (option.name === option.value || option.name === label)
    ? option.value
    : undefined
}

export interface SupervisionSelectProps {
  value: SupervisionSelectValue | undefined
  locked: boolean
  command: (line: string) => Promise<boolean>
  t: ComposerBarProps['t']
}

/**
 * Product label of one mode: built-in machine values render under their
 * locale product names when the host did not customize them; everything else
 * passes through the host's own name (or the raw value when absent).
 * @param value - the supervision projection.
 * @param option - mode value to name.
 * @param t - the owning bar's locale seat.
 * @returns the localized built-in label, the host's name, or the raw value.
 */
function label(value: SupervisionSelectValue, option: string, t: ComposerBarProps['t']): string {
  const candidate = value.options.find(entry => entry.value === option)
  if (candidate !== undefined && builtIn(candidate) === option) {
    if (option === 'supervised') return t('supervision.mode.supervised')
    if (option === 'unsupervised') return t('supervision.mode.unsupervised')
  }
  return candidate?.name ?? option
}

/**
 * Explainer of one mode: built-in machine values localize; a host-configured
 * mode keeps its host description.
 * @param value - the supervision projection.
 * @param option - mode value to describe.
 * @param t - the owning bar's locale seat.
 * @returns the localized built-in description or the host's description.
 */
function description(
  value: SupervisionSelectValue, option: string, t: ComposerBarProps['t'],
): string | undefined {
  const candidate = value.options.find(entry => entry.value === option)
  if (candidate !== undefined && builtIn(candidate) === option) {
    if (option === 'supervised') return t('supervision.mode.supervised.description')
    if (option === 'unsupervised') return t('supervision.mode.unsupervised.description')
  }
  return candidate?.description
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
  const items: MenuEntry[] = value.options.map((option) => {
    const icon = supervisionGlyphs[option.value]
    return { id: option.value, label: label(value, option.value, t), ...icon === undefined ? {} : { icon } }
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
          aria-label={t('input.supervisionMode', { name: label(value, currentValue, t) })}
          title={description(value, currentValue, t) ?? t('input.supervisionMode', { name: label(value, currentValue, t) })}
          disabled={locked || pending !== null}
          onClick={() => { setOpen(!open) }}
        >
          {glyph !== undefined && <span className={css.triggerIcon} aria-hidden>{glyph}</span>}
          <span className={css.triggerLabel}>{label(value, currentValue, t)}</span>
          <span className={clsx(css.chevron, open && css.chevronOpen)} aria-hidden><IconChevronDownOutline14 /></span>
        </button>
      }
    />
  )
}
