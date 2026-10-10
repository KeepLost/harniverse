/**
 * Material row: a segmented control (off, frosted, liquid glass) and three
 * opacity sliders. The controls are disabled while the operating system asks
 * for reduced transparency or high contrast — surfaces then stay opaque and the
 * material is off whatever is chosen — and say why; without a backdrop they say
 * the choice has nothing to show through yet.
 */
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkinHooks } from './faces.ts'
import { toPercent } from './format.ts'
import type { NS } from './locales.ts'
import { Row } from './Row.tsx'
import { MATERIALS, RANGES, type SetSetting, type SkinSettings } from './settings.ts'
import { canWrite, isForcedOpaque } from './view.ts'
import css from './MaterialRow.module.css'

/** Injected business face of the material row. */
export interface MaterialRowInjected {
  hooks: SkinHooks
  /** Stage one settings field. */
  setSetting: SetSetting
}

/** Full component props. */
export type MaterialRowProps =
  PropsRuntime<'settings.appearance.item'> & PropsLocale<typeof NS> & InjectFace<MaterialRowInjected>

const SLIDERS = [
  { field: 'panelOpacity', labelKey: 'material.panel' },
  { field: 'composerOpacity', labelKey: 'material.composer' },
  { field: 'popoverOpacity', labelKey: 'material.popover' },
] as const satisfies ReadonlyArray<{ field: keyof SkinSettings; labelKey: string }>

/**
 * Render the material row.
 * @param props - composed slot props.
 * @returns the row element.
 */
export function MaterialRow({ t, useSkin, setSetting }: MaterialRowProps) {
  const settings = useSkin(view => view.settings)
  const access = useSkin(view => view.access)
  const environment = useSkin(view => view.environment)
  const backdrop = useSkin(view => view.backdrop)
  const forced = isForcedOpaque(environment)
  const writable = canWrite(access)
  const disabled = !writable || forced

  let notice: string | undefined
  if (forced) notice = t('material.reduced')
  else if (!writable) notice = t('access.readOnly')
  else if (backdrop.kind === 'none') notice = t('material.noBackdrop')

  return (
    <Row title={t('material.title')} description={t('material.desc')} notice={notice}>
      <div role="radiogroup" aria-label={t('material.label')} className={css.segments}>
        {MATERIALS.map(material => (
          <button
            key={material}
            type="button"
            role="radio"
            aria-checked={settings.material === material}
            className={clsx(css.segment, settings.material === material && css.selected)}
            disabled={disabled}
            onClick={() => { setSetting('material', material) }}
          >
            {t(`material.${material}`)}
          </button>
        ))}
      </div>
      {SLIDERS.map(({ field, labelKey }) => (
        <label key={field} className={css.slider}>
          <span>{t(labelKey)}</span>
          <input
            type="range"
            min={toPercent(RANGES[field].min)}
            max={toPercent(RANGES[field].max)}
            step={1}
            value={toPercent(settings[field])}
            disabled={disabled}
            onChange={(event) => { setSetting(field, Number(event.currentTarget.value) / 100) }}
          />
          <output>{t('material.percent', { value: toPercent(settings[field]) })}</output>
        </label>
      ))}
    </Row>
  )
}
