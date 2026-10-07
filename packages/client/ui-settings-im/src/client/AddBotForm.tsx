/**
 * The inline connect form, rendered from the platform descriptor: one input
 * per field (credentials as password inputs with a show/hide toggle, choice
 * lists as selects, hints under the input), an optional alias, and the
 * Connect action with its progress and the host's refusal inline.
 */
import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatPlatformField, ChatPlatformView } from '@deepseek-ai/dsh-api-remotes/client'
import { canConnect, errorText, type ImTranslate } from './format.ts'
import type { ConnectForm } from './stores.ts'
import controls from './controls.module.css'
import css from './AddBotForm.module.css'

/** Props of the connect form. */
export interface AddBotFormProps {
  /** The platform being connected. */
  platform: ChatPlatformView
  /** The form draft from the store. */
  form: ConnectForm
  /** Record a typed field value. */
  setValue: (key: string, value: string) => void
  /** Record the typed alias. */
  setAlias: (alias: string) => void
  /** Connect with the current draft. */
  onSubmit: () => void
  /** Close the form, discarding the draft. */
  onCancel: () => void
  /** Bound translator. */
  t: ImTranslate
}

/** Props of one descriptor-driven field. */
interface FieldInputProps {
  field: ChatPlatformField
  value: string
  disabled: boolean
  autoFocus: boolean
  onChange: (value: string) => void
  t: ImTranslate
}

/** One descriptor field: select for a choice list, text or password input otherwise. */
function FieldInput({ field, value, disabled, autoFocus, onChange, t }: FieldInputProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const [shown, setShown] = useState(false)
  const describedBy = field.hint === undefined ? undefined : hintId
  return (
    <div className={controls.field}>
      <label className={clsx(controls.label, field.required && controls.required)} htmlFor={id}>{field.label}</label>
      {field.options === undefined
        ? (
          <div className={controls.inputRow}>
            <input
              id={id}
              className={controls.input}
              type={field.secret && !shown ? 'password' : 'text'}
              value={value}
              placeholder={field.placeholder}
              required={field.required}
              disabled={disabled}
              autoFocus={autoFocus}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={describedBy}
              onChange={(event) => { onChange(event.target.value) }}
            />
            {field.secret
              ? (
                <button
                  type="button"
                  className={controls.textButton}
                  aria-pressed={shown}
                  aria-label={t(shown ? 'form.hideField' : 'form.showField', { field: field.label })}
                  onClick={() => { setShown(visible => !visible) }}
                >
                  {t(shown ? 'form.hide' : 'form.show')}
                </button>
              )
              : null}
          </div>
        )
        : (
          <select
            id={id}
            className={controls.select}
            value={value === '' ? field.options[0]?.value : value}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-describedby={describedBy}
            onChange={(event) => { onChange(event.target.value) }}
          >
            {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )}
      {field.hint === undefined ? null : <p id={hintId} className={controls.hint}>{field.hint}</p>}
    </div>
  )
}

/**
 * Render the connect form.
 * @param props - the platform descriptor, the draft, the edit callbacks, and the translator.
 * @returns the form element.
 */
export function AddBotForm({ platform, form, setValue, setAlias, onSubmit, onCancel, t }: AddBotFormProps) {
  const aliasId = useId()
  const aliasHintId = `${aliasId}-hint`
  const ready = canConnect(platform.fields, form.values)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (ready && !form.pending) onSubmit()
  }
  return (
    <form
      className={css.form}
      aria-label={t('form.title', { platform: platform.label })}
      aria-busy={form.pending}
      noValidate
      onSubmit={submit}
    >
      <h3 className={css.title}>{t('form.title', { platform: platform.label })}</h3>
      <div className={css.fields}>
        {platform.fields.map((field, index) => (
          <FieldInput
            key={field.key}
            field={field}
            value={form.values[field.key] ?? ''}
            disabled={form.pending}
            autoFocus={index === 0}
            onChange={(value) => { setValue(field.key, value) }}
            t={t}
          />
        ))}
        <div className={controls.field}>
          <label className={controls.label} htmlFor={aliasId}>{t('form.alias')}</label>
          <input
            id={aliasId}
            className={controls.input}
            value={form.alias}
            placeholder={t('form.aliasPlaceholder')}
            disabled={form.pending}
            autoComplete="off"
            aria-describedby={aliasHintId}
            onChange={(event) => { setAlias(event.target.value) }}
          />
          <p id={aliasHintId} className={controls.hint}>{t('form.aliasHint')}</p>
        </div>
      </div>
      {form.error === null ? null : <p className={controls.error} role="alert">{errorText(t, form.error)}</p>}
      <span className={controls.srOnly} role="status">{form.pending ? t('form.submitting') : ''}</span>
      <div className={css.footer}>
        <Button variant="outline" disabled={form.pending} onClick={onCancel}>{t('form.cancel')}</Button>
        <Button variant="primary" type="submit" disabled={!ready || form.pending}>
          {form.pending ? t('form.submitting') : t('form.submit')}
        </Button>
      </div>
    </form>
  )
}
