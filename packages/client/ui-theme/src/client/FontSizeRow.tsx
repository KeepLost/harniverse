/**
 * Font-size preference row registered into the General section item slot:
 * title + one compact segmented control of the three content font-size tiers
 * (小 14 / 中 16 / 大 18 px). Registered by this package — the theme feature
 * owns the content font-size setting the same way it owns the appearance
 * preference. Selection follows the persisted setting, never the click echo.
 */
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContentFontSize } from '../theme-settings.ts'
import type { ThemeKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createFontSizeRowStore } from './settings-store.ts'
import css from './FontSizeRow.module.css'

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface FontSizeRowInjected {
  /** Switch the content font size (one of the offered tiers, in px). */
  setContentFontSize: (px: ContentFontSize) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type FontSizeRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createFontSizeRowStore>>
  & PropsLocale<'settings.theme'> & FontSizeRowInjected

/** Tier order and copy keys; the px value is the persisted setting itself. */
const TIERS: readonly { px: ContentFontSize; labelKey: ThemeKey }[] = [
  { px: 14, labelKey: 'fontSize.small' },
  { px: 16, labelKey: 'fontSize.medium' },
  { px: 18, labelKey: 'fontSize.large' },
]

/**
 * Render the font-size row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function FontSizeRow({ t, setContentFontSize, useStore }: FontSizeRowComponentProps) {
  const fontSize = useStore(s => s.fontSize)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('fontSize.title')}</div>
      <div className={css.segmentRow} role="group" aria-label={t('fontSize.title')}>
        {TIERS.map(({ px, labelKey }) => (
          <button
            key={px}
            type="button"
            className={clsx(css.segment, fontSize === px && css.selected)}
            aria-pressed={fontSize === px}
            onClick={() => { setContentFontSize(px) }}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
