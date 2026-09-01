/** Client-safe supervision projection types. */

/** One selectable supervision mode shown by a client projection. */
export interface SupervisionOption {
  value: 'supervised' | 'unsupervised'
  name: string
  description: string
}

/** Client projection containing the available modes and current selection. */
export interface SupervisionSelect {
  options: SupervisionOption[]
  currentValue: 'supervised' | 'unsupervised'
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    supervision: SupervisionSelect
  }
}
