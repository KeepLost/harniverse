/**
 * Accent row: twelve preset swatches, a native colour input, and a reset. The
 * accent family (hover, soft tint) follows the chosen colour; reset returns to
 * the active skin's own accent.
 */
import clsx from 'clsx'
import type { CSSProperties } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkinHooks } from './faces.ts'
import type { NS } from './locales.ts'
import { Row } from './Row.tsx'
import type { SetSetting } from './settings.ts'
import { activeSkinOf, canWrite } from './view.ts'
import css from './AccentRow.module.css'

/** Injected business face of the accent row. */
export interface AccentRowInjected {
  hooks: SkinHooks
  /** Stage one settings field. */
  setSetting: SetSetting
}

/** Full component props. */
export type AccentRowProps =
  PropsRuntime<'settings.appearance.item'> & PropsLocale<typeof NS> & InjectFace<AccentRowInjected>

/**
 * The preset accents (data, applied through a component-local custom
 * property): the product blue first, then eleven hues spread around the wheel.
 */
export const ACCENT_PRESETS = [
  '#4176e6', '#0ea5e9', '#14b8a6', '#22c55e', '#84cc16', '#f59e0b',
  '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#64748b',
] as const

/**
 * Render the accent row.
 * @param props - composed slot props.
 * @returns the row element.
 */
export function AccentRow({ t, useSkin, setSetting }: AccentRowProps) {
  const settings = useSkin(view => view.settings)
  const access = useSkin(view => view.access)
  const library = useSkin(view => view.library)
  const theme = useSkin(view => view.theme)
  const writable = canWrite(access)
  const { accent } = settings
  // With no saved accent the colour in force is the active skin's own, else the product blue.
  const shown = accent === '' ? activeSkinOf(library, theme.activeId)?.accent ?? ACCENT_PRESETS[0] : accent

  return (
    <Row
      title={t('accent.title')}
      description={t('accent.desc')}
      notice={writable ? undefined : t('access.readOnly')}
    >
      <div role="group" aria-label={t('accent.presets')} className={css.swatches}>
        {ACCENT_PRESETS.map(color => (
          <button
            key={color}
            type="button"
            className={clsx(css.swatch, accent === color && css.selected)}
            style={{ '--dsh-skin-swatch': color } as CSSProperties}
            aria-label={t('accent.swatch', { color })}
            aria-pressed={accent === color}
            disabled={!writable}
            onClick={() => { setSetting('accent', color) }}
          />
        ))}
      </div>
      <div className={css.custom}>
        <label className={css.field}>
          <span>{t('accent.custom')}</span>
          <input
            type="color"
            className={css.picker}
            value={shown}
            disabled={!writable}
            onChange={(event) => { setSetting('accent', event.currentTarget.value) }}
          />
        </label>
        <Button size="sm" variant="outline" disabled={!writable || accent === ''} onClick={() => { setSetting('accent', '') }}>
          {t('accent.reset')}
        </Button>
      </div>
    </Row>
  )
}
