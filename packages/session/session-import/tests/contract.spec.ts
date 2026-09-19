/**
 * Tests for the foreign-session import contract: classification, archival
 * recognition, posture parsing, and the resume exclusion guard.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ArchivalSessionError,
  assertNotResumable,
  classifyForeignSessionFormatVersion,
  DEFAULT_IMPORT_SUPERVISION_MODE,
  importRecordOf,
  isArchivalSession,
  parseImportPosture,
} from '@deepseek-ai/dsh-session-import'

function marker(format = 'official-v3', artifactName = 'source.jsonl'): SessionEvent {
  return {
    type: 'import/record',
    seq: 0,
    time: 0,
    data: { source: { format, artifactName }, posture: { supervisionMode: 'supervised' } },
  } as SessionEvent
}

function turnStart(seq: number): SessionEvent {
  return { type: 'turn/start', seq, time: 0, data: {} } as SessionEvent
}

describe('classifyForeignSessionFormatVersion', () => {
  it('names the official generations and this build, refusing everything else', () => {
    expect(classifyForeignSessionFormatVersion(0)).toBe('current')
    expect(classifyForeignSessionFormatVersion(1)).toBe('official-v1')
    expect(classifyForeignSessionFormatVersion(2)).toBe('official-v2')
    expect(classifyForeignSessionFormatVersion(3)).toBe('official-v3')
    for (const refused of [4, 100, -1, 1.5, '3', null, undefined, true]) {
      expect(classifyForeignSessionFormatVersion(refused)).toBe('unknown')
    }
  })
})

describe('parseImportPosture', () => {
  it('defaults to supervised and validates explicit modes', () => {
    expect(parseImportPosture(undefined)).toEqual({ supervisionMode: 'supervised' })
    expect(DEFAULT_IMPORT_SUPERVISION_MODE).toBe('supervised')
    expect(parseImportPosture({ supervisionMode: 'unsupervised' })).toEqual({ supervisionMode: 'unsupervised' })
    expect(() => parseImportPosture({ supervisionMode: 'sometimes' })).toThrow(TypeError)
  })
})

describe('archival recognition and exclusion', () => {
  it('recognizes a session whose first event is the marker', () => {
    expect(isArchivalSession([marker(), turnStart(1)])).toBe(true)
    expect(isArchivalSession([turnStart(0), marker()])).toBe(false)
    expect(isArchivalSession([])).toBe(false)
    expect(importRecordOf([marker('official-v2', 'x.jsonl')])?.source).toEqual({ format: 'official-v2', artifactName: 'x.jsonl' })
    expect(importRecordOf([turnStart(0)])).toBeUndefined()
  })

  it('refuses live use of archival history through the guard', () => {
    expect(() => { assertNotResumable([turnStart(0)]) }).not.toThrow()
    expect(() => { assertNotResumable([]) }).not.toThrow()
    const error = new ArchivalSessionError('x')
    expect(error.name).toBe('ArchivalSessionError')
    expect(() => { assertNotResumable([marker(), turnStart(1)]) }).toThrow(ArchivalSessionError)
  })
})
