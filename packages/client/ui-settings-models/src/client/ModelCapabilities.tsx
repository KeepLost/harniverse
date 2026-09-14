/**
 * The capability declaration of one model row: whether it accepts images,
 * whether it reasons, which thinking levels it offers, the level a selection
 * starts from, and — for an OpenAI-compatible endpoint — how the thinking
 * switch is spelled on the wire.
 *
 * Every control writes a profile field the adapter's schema already owns, so
 * the declaration is servable the moment it is saved; nothing here invents a
 * client-side capability that the host does not enforce.
 */

import type { ReactNode } from 'react'
import type { ModelDraft } from './ModelListEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Every pi-ai thinking level, in escalation order. */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** The chat-template formats a form may name, mirroring the adapter's offer. */
const FORMATS = [
  'openai', 'deepseek', 'openrouter', 'together', 'zai', 'qwen', 'string-thinking', 'ant-ling', 'chat-template',
] as const

/** The variable kinds a chat-template kwarg may carry. */
const KWARG_KINDS = ['literal', 'thinking.enabled', 'thinking.effort'] as const

/** One kwargs row as the form drafts it. */
interface KwargDraft {
  name: string
  kind: (typeof KWARG_KINDS)[number]
  literal: string
  omitWhenOff: boolean
}

/** Props of {@link ModelCapabilities}. */
export interface ModelCapabilitiesProps {
  /** The row as currently drafted. */
  model: ModelDraft
  /** Apply a patch of profile-shaped values; `undefined` drops the key. */
  patch: (next: Record<string, unknown>) => void
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control. */
  disabled: boolean
  /**
   * Wire protocol the form's provider names, when it names one. Compat
   * switches exist only on `openai-completions`, so the dispatch controls
   * stay hidden for a protocol whose reasoning lives in the protocol itself.
   */
  api?: string | undefined
}

/** The row's `input` field as the checkbox reads it. */
function acceptsImages(model: ModelDraft): boolean {
  return Array.isArray(model['input']) && model['input'].includes('image')
}

/** The row's declared efforts dict, or undefined for absent/false. */
function effortsOf(model: ModelDraft): Record<string, string | null> | undefined {
  const value = model['reasoningEfforts']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, string | null>
}

/** The wire spelling a level's text field holds, or its canonical default. */
function wireOf(efforts: Record<string, string | null>, level: string): string {
  const stored = efforts[level]
  if (typeof stored === 'string' && stored.length > 0) return stored
  return level === 'off' ? '' : level
}

/** The kwargs rows the form drafts from a stored compat object. */
function kwargsOf(model: ModelDraft): KwargDraft[] {
  const compat = model['compat']
  if (typeof compat !== 'object' || compat === null) return []
  const stored = (compat as Record<string, unknown>)['chatTemplateKwargs']
  if (typeof stored !== 'object' || stored === null) return []
  return Object.entries(stored as Record<string, unknown>).map(([name, value]) => {
    if (typeof value === 'object' && value !== null && '$var' in value) {
      const variable = value as { $var: string; omitWhenOff?: boolean }
      return {
        name,
        kind: variable.$var === 'thinking.enabled' ? 'thinking.enabled' as const : 'thinking.effort' as const,
        literal: '',
        omitWhenOff: variable.omitWhenOff === true,
      }
    }
    return {
      name,
      kind: 'literal' as const,
      literal: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '',
      omitWhenOff: false,
    }
  })
}

/**
 * Render the capability declaration of one model row.
 * @param props - the drafted row, its patch channel, copy, and disable state.
 * @returns the capability controls.
 */
export function ModelCapabilities(props: ModelCapabilitiesProps): ReactNode {
  const { model, patch, t, disabled } = props
  const efforts = effortsOf(model)
  const declared = efforts !== undefined
  const storedFormat = typeof model['compat'] === 'object' && model['compat'] !== null
    ? (model['compat'] as Record<string, unknown>)['thinkingFormat']
    : undefined
  const format = typeof storedFormat === 'string' ? storedFormat : ''
  const defaultEffort = typeof model['defaultReasoningEffort'] === 'string'
    ? model['defaultReasoningEffort']
    : ''
  const kwargs = kwargsOf(model)
  const dispatchable = props.api === 'openai-completions'

  /** Rewrite the efforts dict from the checkbox set and wire texts. */
  const writeEfforts = (next: Record<string, string | null>): void => {
    patch(Object.keys(next).length === 0 ? { reasoningEfforts: undefined } : { reasoningEfforts: next })
  }

  const toggleLevel = (level: string, checked: boolean): void => {
    const next = { ...(efforts ?? {}) }
    if (checked) {
      // Empty text means the canonical spelling: "off" sends nothing, every
      // other level sends its own name until a wire value is typed.
      next[level] = level === 'off' ? null : wireOf(next, level)
    } else {
      // Rebuilt rather than deleted: the lint boundary keeps dynamic-key
      // deletes out of a profile the wire may carry verbatim.
      const narrowed: Record<string, string | null> = {}
      for (const [key, value] of Object.entries(next)) {
        if (key !== level) narrowed[key] = value
      }
      // A default pointing at the removed level has nothing to select.
      if (defaultEffort === level) patch({ defaultReasoningEffort: undefined })
      writeEfforts(narrowed)
      return
    }
    writeEfforts(next)
  }

  const setWire = (level: string, text: string): void => {
    const next = { ...(efforts ?? {}) }
    next[level] = text.length === 0 ? (level === 'off' ? null : level) : text
    writeEfforts(next)
  }

  const patchCompat = (next: Record<string, unknown>): void => {
    const current = typeof model['compat'] === 'object' && model['compat'] !== null
      ? model['compat'] as Record<string, unknown>
      : {}
    const compat: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(current)) {
      // A key the patch names — even with undefined, its drop spelling — is
      // decided below; the rebuild keeps the delete boundary static.
      if (!(key in next)) compat[key] = value
    }
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined) compat[key] = value
    }
    patch(Object.keys(compat).length === 0 ? { compat: undefined } : { compat })
  }

  const writeKwargs = (rows: readonly KwargDraft[]): void => {
    // Unnamed rows stay in the draft so their inputs keep rendering; the
    // section's row validator refuses the apply until every row is named,
    // which is the boundary that keeps an unnamed field off the wire.
    const next: Record<string, unknown> = {}
    for (const row of rows) {
      next[row.name] = row.kind === 'literal'
        ? row.literal
        : { $var: row.kind, ...row.omitWhenOff ? { omitWhenOff: true } : {} }
    }
    patchCompat(Object.keys(next).length === 0 ? { chatTemplateKwargs: undefined } : { chatTemplateKwargs: next })
  }

  return (
    <fieldset className={styles['capabilityGroup']}>
      <legend className={styles['capabilityLegend']}>{t('modelCapabilities')}</legend>
      <label className={styles['capabilityCheck']}>
        <input
          type="checkbox"
          checked={acceptsImages(model)}
          disabled={disabled}
          onChange={(event) => {
            patch(event.target.checked
              ? { input: ['text', 'image'] }
              : { input: undefined })
          }}
        />
        {t('modelImageInput')}
      </label>
      <label className={styles['capabilityCheck']}>
        <input
          type="checkbox"
          checked={declared}
          disabled={disabled}
          onChange={(event) => {
            if (!event.target.checked) {
              patch({ reasoningEfforts: undefined, defaultReasoningEffort: undefined })
              return
            }
            writeEfforts({ off: null, medium: 'medium', high: 'high' })
          }}
        />
        {t('modelReasoning')}
      </label>
      {declared
        ? (
          <div className={styles['capabilityBlock']}>
            <span className={styles['modelFieldLabel']}>{t('modelEfforts')}</span>
            <div className={styles['effortGrid']}>
              {LEVELS.map((level) => {
                const on = level in efforts
                return (
                  <div key={level} className={styles['effortRow']}>
                    <label className={styles['capabilityCheck']}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={disabled}
                        onChange={(event) => { toggleLevel(level, event.target.checked) }}
                      />
                      {level}
                    </label>
                    {on
                      ? (
                        <input
                          className={styles['effortWire']}
                          type="text"
                          value={typeof efforts[level] === 'string' ? efforts[level] : ''}
                          placeholder={level === 'off' ? t('modelEffortOffDefault') : level}
                          aria-label={`${t('modelEffortWire')} ${level}`}
                          disabled={disabled}
                          onChange={(event) => { setWire(level, event.target.value) }}
                        />
                      )
                      : null}
                  </div>
                )
              })}
            </div>
            <label className={styles['modelField']}>
              <span className={styles['modelFieldLabel']}>{t('modelDefaultEffort')}</span>
              <select
                className={`${styles['input']} ${styles['selectInput']}`}
                value={defaultEffort}
                aria-label={t('modelDefaultEffort')}
                disabled={disabled}
                onChange={(event) => {
                  patch(event.target.value === '' ? { defaultReasoningEffort: undefined } : { defaultReasoningEffort: event.target.value })
                }}
              >
                <option value="">{t('modelDefaultEffortUnset')}</option>
                <option value="default">{t('modelDefaultEffortNone')}</option>
                {LEVELS.filter(level => level in efforts).map(level => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </label>
          </div>
        )
        : null}
      {dispatchable
        ? (
          <label className={styles['modelField']}>
            <span className={styles['modelFieldLabel']}>{t('modelThinkingFormat')}</span>
            <select
              className={`${styles['input']} ${styles['selectInput']}`}
              value={format}
              aria-label={t('modelThinkingFormat')}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value
                // Leaving chat-template strands the kwargs: they are dispatched
                // only by that format, so the switch drops them with the field.
                if (next !== 'chat-template') patchCompat({ thinkingFormat: next === '' ? undefined : next, chatTemplateKwargs: undefined })
                else patchCompat({ thinkingFormat: next })
              }}
            >
              <option value="">{t('modelFormatAuto')}</option>
              {FORMATS.map(choice => <option key={choice} value={choice}>{choice}</option>)}
            </select>
          </label>
        )
        : null}
      {dispatchable && format === 'chat-template'
        ? (
          <div className={styles['capabilityBlock']}>
            <span className={styles['modelFieldLabel']}>{t('modelKwargs')}</span>
            {kwargs.map((row, at) => (
              <div key={at} className={styles['kwargRow']}>
                <input
                  className={styles['kwargName']}
                  type="text"
                  value={row.name}
                  placeholder={t('modelKwargName')}
                  aria-label={`${t('modelKwargName')} ${String(at + 1)}`}
                  disabled={disabled}
                  onChange={(event) => {
                    writeKwargs(kwargs.map((current, index) =>
                      index === at ? { ...current, name: event.target.value } : current))
                  }}
                />
                <select
                  className={`${styles['input']} ${styles['selectInput']}`}
                  value={row.kind}
                  aria-label={`${t('modelKwargKind')} ${String(at + 1)}`}
                  disabled={disabled}
                  onChange={(event) => {
                    const kind = event.target.value as KwargDraft['kind']
                    writeKwargs(kwargs.map((current, index) => index === at ? { ...current, kind } : current))
                  }}
                >
                  {KWARG_KINDS.map(kind => (
                    <option key={kind} value={kind}>
                      {kind === 'literal' ? t('modelKwargLiteral')
                        : kind === 'thinking.enabled' ? t('modelKwargThinkingEnabled')
                          : t('modelKwargThinkingEffort')}
                    </option>
                  ))}
                </select>
                {row.kind === 'literal'
                  ? (
                    <input
                      className={styles['kwargValue']}
                      type="text"
                      value={row.literal}
                      placeholder={t('modelKwargValue')}
                      aria-label={`${t('modelKwargValue')} ${String(at + 1)}`}
                      disabled={disabled}
                      onChange={(event) => {
                        writeKwargs(kwargs.map((current, index) =>
                          index === at ? { ...current, literal: event.target.value } : current))
                      }}
                    />
                  )
                  : (
                    <label className={styles['capabilityCheck']}>
                      <input
                        type="checkbox"
                        checked={row.omitWhenOff}
                        disabled={disabled}
                        onChange={(event) => {
                          writeKwargs(kwargs.map((current, index) =>
                            index === at ? { ...current, omitWhenOff: event.target.checked } : current))
                        }}
                      />
                      {t('modelKwargOmitWhenOff')}
                    </label>
                  )}
                <button
                  type="button"
                  className={styles['linkButton']}
                  disabled={disabled}
                  onClick={() => { writeKwargs(kwargs.filter((_row, index) => index !== at)) }}
                >
                  {t('removeModel')}
                </button>
              </div>
            ))}
            <button
              type="button"
              className={styles['linkButton']}
              disabled={disabled}
              onClick={() => { writeKwargs([...kwargs, { name: '', kind: 'thinking.enabled', literal: '', omitWhenOff: false }]) }}
            >
              {t('modelKwargAdd')}
            </button>
          </div>
        )
        : null}
    </fieldset>
  )
}
