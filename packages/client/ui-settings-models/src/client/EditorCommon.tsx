/**
 * Field and footer pieces the policy editors share: both cards carry a named
 * entry and end in the same commit row, so the duplicated chrome lives here
 * once.
 *
 * @module dsh-client-ui-settings-models/client/EditorCommon
 */

import type { ReactNode } from 'react'
import { EditorFooter } from './EditorFooter.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link EntryNameField}. */
export interface EntryNameFieldProps {
  /** Stable DOM id for the input; the editor prefixes its own kind. */
  id: string
  /** The entry's display name. */
  value: string
  /** Updates the display name. */
  onChange: (value: string) => void
  /** Localizer for the field's labels. */
  t: (key: keyof typeof en) => string
  /** Whether input is refused, as the owning card judges it. */
  disabled: boolean
}

/** Renders the display-name field every policy editor opens with. */
export function EntryNameField(props: EntryNameFieldProps): ReactNode {
  return (
    <div className={styles['field']}>
      <label className={styles['fieldLabel']} htmlFor={props.id}>{props.t('entryName')}</label>
      <input
        id={props.id}
        className={styles['input']}
        value={props.value}
        placeholder={props.t('entryNamePlaceholder')}
        disabled={props.disabled}
        onChange={(event) => { props.onChange(event.currentTarget.value) }}
      />
    </div>
  )
}

/** Props of {@link PolicyEditorFooter}. */
export interface PolicyEditorFooterProps {
  /** Localizer for the row's labels. */
  t: (key: keyof typeof en) => string
  /** Whether a commit is in flight. */
  busy: boolean
  /** Whether the commit is refused, as judged by the owning card. */
  submitDisabled: boolean
  /** Dismiss the card without committing. */
  onCancel: () => void
  /** Run the card's commit. */
  onSubmit: () => void
}

/** Renders the commit row both policy editors close with. */
export function PolicyEditorFooter(props: PolicyEditorFooterProps): ReactNode {
  return (
    <EditorFooter
      t={props.t}
      busy={props.busy}
      submitDisabled={props.submitDisabled}
      submitLabel="apply"
      submitBusyLabel="applying"
      onCancel={props.onCancel}
      onSubmit={props.onSubmit}
    />
  )
}
