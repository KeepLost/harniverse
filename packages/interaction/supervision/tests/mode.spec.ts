import { describe, expect, it } from 'vitest'
import {
  effectiveSupervisionMode,
  setSupervisionMode,
  SUPERVISION_MODES,
} from '../src/index.ts'
import type { Session } from '@deepseek-ai/dsh-session'

describe('supervision mode', () => {
  it('folds the last durable mode event', () => {
    expect(effectiveSupervisionMode([])).toBeUndefined()
    expect(effectiveSupervisionMode([
      { type: 'supervision/mode', data: { mode: 'supervised' } },
      { type: 'supervision/mode', data: { mode: 'unsupervised' } },
    ] as never)).toBe('unsupervised')
  })

  it('appends a whole-value mode event', () => {
    const appended: unknown[] = []
    const append = (type: string, data: unknown): unknown => {
      appended.push({ type, data })
      return { type, data }
    }
    const session = { append } as unknown as Session
    setSupervisionMode(session, 'unsupervised')
    expect(appended).toEqual([{ type: 'supervision/mode', data: { mode: 'unsupervised' } }])
    expect(SUPERVISION_MODES).toEqual(['supervised', 'unsupervised'])
  })
})
