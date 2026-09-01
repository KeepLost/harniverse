/** Client-safe supervision projection types. */

export interface SupervisionOption {
  value: 'supervised' | 'unsupervised'
  name: string
  description: string
}

export interface SupervisionSelect {
  options: SupervisionOption[]
  currentValue: 'supervised' | 'unsupervised'
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    supervision: SupervisionSelect
  }
}
